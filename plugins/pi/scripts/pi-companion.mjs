#!/usr/bin/env node
/**
 * pi-companion — Claude Code plugin entrypoint.
 *
 * Delegates tasks/reviews to the Pi coding agent via its RPC mode.
 * The command surface is derived from openai/codex-plugin-cc: setup, task (rescue),
 * review, adversarial-review, transfer, status, result, cancel.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { writePiSessionFromClaudeTranscript } from "./lib/session-transfer.mjs";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  parseStructuredOutput,
  runPiTurn
} from "./lib/pi-rpc.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderPiSessionCommand,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2_000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/pi-companion.mjs setup [--json]",
      "  node scripts/pi-companion.mjs task [--background] [--write] [--resume|--fresh] [--model <provider/model>] [prompt]",
      "  node scripts/pi-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/pi-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [focus text]",
      "  node scripts/pi-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/pi-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/pi-companion.mjs result [job-id] [--json]",
      "  node scripts/pi-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), { ...config, aliasMap: { C: "cwd", ...(config.aliasMap ?? {}) } });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .find(Boolean);
  return line ?? fallback;
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  return normalized || null;
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")));
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) => job.jobClass === "task" && job.threadId && job.status !== "queued" && job.status !== "running"
    ) ?? null
  );
}

function ensurePiAvailable(cwd) {
  const status = binaryAvailable("pi", ["-v"], { cwd });
  if (!status.available) {
    throw new Error("Pi CLI is not installed or not on PATH. Install it (see https://pi.dev), then rerun `/pi:setup`.");
  }
  return status;
}

// ---------------------------------------------------------------------------
// job helpers
// ---------------------------------------------------------------------------

function getJobKindLabel(jobClass) {
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kindLabel: getJobKindLabel(jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(stateDir, job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(stateDir, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(stateDir, job.id)
    })
  };
}

function buildTaskMetadata({ prompt, resumeLast = false }) {
  const title = resumeLast ? "Pi Resume" : "Pi Task";
  const fallbackSummary = resumeLast ? "Continue previous task." : "Task";
  return { title, summary: shorten(prompt || fallbackSummary) };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /pi:status ${payload.jobId} for progress.\n`;
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

function getSessionRuntimeStatus() {
  return {
    mode: "direct",
    label: "direct (pi --mode rpc per task)",
    detail: "Each task spawns a fresh Pi RPC process. No shared runtime is active."
  };
}

async function buildSetupReport(cwd) {
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const piStatus = binaryAvailable("pi", ["-v"], { cwd });
  const model = process.env.PI_PLUGIN_MODEL || DEFAULT_MODEL;
  const provider = model.includes("/")
    ? model.slice(0, model.indexOf("/"))
    : process.env.PI_PLUGIN_PROVIDER || DEFAULT_PROVIDER;
  const modelSelector = model.includes("/") ? model : `${provider}/${model}`;
  const modelStatus = piStatus.available
    ? binaryAvailable("pi", ["--list-models", modelSelector], { cwd })
    : { available: false, stdout: "", detail: "Pi is unavailable" };
  const authConfigured = modelStatus.available && modelStatus.stdout.includes(provider) && modelStatus.stdout.includes(model.split("/").at(-1));

  const nextSteps = [];
  if (!piStatus.available) {
    nextSteps.push("Install Pi (see https://pi.dev), then rerun `/pi:setup`.");
  }
  if (piStatus.available && !authConfigured) {
    nextSteps.push(
      provider === "zai"
        ? "Set ZAI_API_KEY (or run `pi` and use /login) so the zai provider can reach GLM."
        : `Configure credentials for the ${provider} provider (run \`pi\` and use /login).`
    );
  }

  return {
    ready: nodeStatus.available && piStatus.available && authConfigured,
    node: nodeStatus,
    pi: piStatus,
    auth: {
      loggedIn: authConfigured,
      detail: piStatus.available
        ? authConfigured
          ? `Provider ${provider} is configured for ${modelSelector}`
          : `Provider ${provider} is not configured for ${modelSelector}`
        : piStatus.detail
    },
    sessionRuntime: getSessionRuntimeStatus(),
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const report = await buildSetupReport(cwd);
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

// ---------------------------------------------------------------------------
// task (rescue)
// ---------------------------------------------------------------------------

async function executeTaskRun(request, stateDir) {
  ensurePiAvailable(request.cwd);

  const metadata = buildTaskMetadata({ prompt: request.prompt, resumeLast: request.resumeLast });

  // Resolve a previous Pi session to resume, if requested.
  let sessionPath = null;
  if (request.resumeLast) {
    const jobs = sortJobsNewestFirst(listJobs(stateDir)).filter((job) => job.id !== request.jobId);
    const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
    const candidate = findLatestResumableTaskJob(visibleJobs);
    if (!candidate?.threadId) {
      throw new Error("No previous Pi task session was found for this repository.");
    }
    // threadId stores the Pi session file path for resume.
    sessionPath = candidate.threadId;
  }

  if (!request.prompt && !sessionPath) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runPiTurn({
    cwd: request.cwd,
    prompt: request.prompt || "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.",
    model: request.model,
    write: request.write,
    sessionPath,
    onProgress: request.onProgress
  });

  const rawOutput = result.finalMessage || "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    { rawOutput, failureMessage, reasoningSummary: result.reasoning },
    { title: metadata.title, jobId: request.jobId ?? null, write: Boolean(request.write) }
  );
  const payload = {
    status: result.status,
    threadId: result.sessionId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoning
  };

  return {
    exitStatus: result.status,
    threadId: result.sessionId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${metadata.title} finished.`)),
    jobTitle: metadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

async function runForegroundCommand(stateDir, job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(stateDir, job, { logFile: options.logFile, stderr: !options.json });
  const execution = await runTrackedJob(job, stateDir, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, stateDir, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "pi-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--state-dir", stateDir, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, stateDir, job, request) {
  const { logFile } = createTrackedProgress(stateDir, job);
  appendLogLine(logFile, "Queued for background execution.");
  const child = spawnDetachedTaskWorker(cwd, stateDir, job.id);
  const queuedRecord = { ...job, status: "queued", phase: "queued", pid: child.pid ?? null, logFile, request };
  writeJobFile(stateDir, job.id, queuedRecord);
  upsertJob(stateDir, queuedRecord);
  return { payload: { jobId: job.id, status: "queued", title: job.title, summary: job.summary, logFile }, logFile };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd", "state-dir", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  const stateDir = options["state-dir"] || resolveStateDir(cwd);
  const model = normalizeRequestedModel(options.model);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const metadata = buildTaskMetadata({ prompt, resumeLast });
  const job = createCompanionJob({ prefix: "task", title: metadata.title, workspaceRoot: cwd, jobClass: "task", summary: metadata.summary, write });

  if (options.background) {
    ensurePiAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);
    const { payload } = enqueueBackgroundTask(cwd, stateDir, job, { cwd, model, prompt, write, resumeLast, jobId: job.id });
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(stateDir, job, (progress) =>
    executeTaskRun({ cwd, model, prompt, write, resumeLast, jobId: job.id, onProgress: progress }, stateDir),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "state-dir", "job-id"] });
  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }
  const cwd = resolveCommandCwd(options);
  const stateDir = options["state-dir"] || resolveStateDir(cwd);
  const storedJob = readJobFile(resolveJobFile(stateDir, options["job-id"]));
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }
  const request = storedJob.request ?? {};
  const { logFile, progress } = createTrackedProgress(stateDir, { ...storedJob, workspaceRoot: cwd }, { logFile: storedJob.logFile ?? null });
  await runTrackedJob({ ...storedJob, workspaceRoot: cwd, logFile }, stateDir, () =>
    executeTaskRun({ ...request, onProgress: progress }, stateDir), { logFile }
  );
}

// ---------------------------------------------------------------------------
// review / adversarial-review
// ---------------------------------------------------------------------------

function buildReviewPrompt(context, focusText, reviewKind) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: reviewKind,
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

async function executeReviewRun(request, stateDir) {
  ensurePiAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, { base: request.base, scope: request.scope });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPrompt(context, focusText, reviewName);
  // Reviews run with no tools: the diff is already embedded in the prompt, so
  // a pure-LLM pass is faster and stops Pi from re-exploring the repo and
  // stalling on large diffs.
  const result = await runPiTurn({
    cwd: context.repoRoot,
    prompt,
    model: request.model,
    write: false,
    noTools: true,
    onProgress: request.onProgress
  });

  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });

  return {
    exitStatus: result.status,
    threadId: result.sessionId,
    payload: {
      review: reviewName,
      target,
      threadId: result.sessionId,
      pi: { status: result.status, stderr: result.stderr, stdout: result.finalMessage, reasoning: result.reasoning },
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError,
      reasoningSummary: result.reasoning
    },
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoning
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Pi ${reviewName}`,
    jobClass: "review"
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "state-dir"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  const stateDir = options["state-dir"] || resolveStateDir(cwd);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const metadata = {
    kind: config.reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: config.reviewName === "Review" ? "Pi Review" : `Pi ${config.reviewName}`,
    summary: `${config.reviewName} ${target.label}`
  };
  const job = createCompanionJob({ prefix: "review", title: metadata.title, workspaceRoot: cwd, jobClass: "review", summary: metadata.summary });
  await runForegroundCommand(stateDir, job, (progress) =>
    executeReviewRun({ cwd, base: options.base, scope: options.scope, model: options.model, focusText, reviewName: config.reviewName, onProgress: progress }, stateDir),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, { reviewName: "Review" });
}

async function handleAdversarialReview(argv) {
  return handleReviewCommand(argv, { reviewName: "Adversarial Review" });
}

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

async function executeTransfer(cwd, options = {}) {
  const sourcePath = options.source || process.env.PI_PLUGIN_TRANSCRIPT_PATH;
  if (!sourcePath) {
    throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  }
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }
  const { sessionPath, sessionId, turnCount } = writePiSessionFromClaudeTranscript({ sourcePath, cwd });
  return {
    payload: {
      threadId: sessionPath,
      sessionId,
      resumeCommand: renderPiSessionCommand(sessionPath),
      sourcePath,
      turnCount
    },
    rendered: [
      "Wrote a Pi session file from the Claude transcript.",
      `Pi session path: ${sessionPath}`,
      `Turns seeded: ${turnCount}`,
      `Open in Pi: ${renderPiSessionCommand(sessionPath)}`,
      ""
    ].join("\n")
  };
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "source"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, { source: options.source });
  outputCommandResult(payload, rendered, options.json);
}

// ---------------------------------------------------------------------------
// status / result / cancel
// ---------------------------------------------------------------------------

function enrichJob(job, stateDir, options = {}) {
  const storedJob = readJobFile(resolveJobFile(stateDir, job.id)) ?? {};
  const elapsed = job.startedAt ? formatDuration(Date.now() - new Date(job.startedAt).getTime()) : null;
  const duration = job.completedAt && job.startedAt ? formatDuration(new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()) : null;
  const logPreview = options.maxProgressLines ? readLogTail(storedJob.logFile ?? job.logFile, options.maxProgressLines) : [];
  return {
    ...job,
    ...storedJob,
    elapsed,
    duration,
    progressPreview: logPreview
  };
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

function readLogTail(logFile, maxLines) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }
  const content = fs.readFileSync(logFile, "utf8");
  return content.split(/\r?\n/).filter(Boolean).slice(-maxLines);
}

function buildStatusSnapshot(stateDir, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? 6;
  const jobs = sortJobsNewestFirst(filterJobsForCurrentClaudeSession(listJobs(stateDir), options));
  const running = jobs.filter((j) => j.status === "queued" || j.status === "running").map((j) => enrichJob(j, stateDir, { maxProgressLines }));
  const latestFinishedRaw = jobs.find((j) => j.status !== "queued" && j.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, stateDir, { maxProgressLines }) : null;
  const recent = (options.all ? jobs : jobs.slice(0, 10))
    .filter((j) => j.status !== "queued" && j.status !== "running" && j.id !== latestFinished?.id)
    .map((j) => enrichJob(j, stateDir, { maxProgressLines }));
  return { sessionRuntime: getSessionRuntimeStatus(), running, latestFinished, recent };
}

function buildSingleJobSnapshot(stateDir, reference) {
  const jobs = listJobs(stateDir);
  const job =
    jobs.find((j) => j.id === reference) ??
    jobs.find((j) => j.id.startsWith(reference)) ??
    jobs.find((j) => j.status === "queued" || j.status === "running") ??
    null;
  if (!job) {
    throw new Error(`No job found for "${reference}". Run /pi:status to list known jobs.`);
  }
  return { job: enrichJob(job, stateDir, { maxProgressLines: 8 }) };
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "state-dir", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });
  const cwd = resolveCommandCwd(options);
  const stateDir = options["state-dir"] || resolveStateDir(cwd);
  const reference = positionals[0] ?? "";

  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(stateDir, reference, { timeoutMs: options["timeout-ms"], pollIntervalMs: options["poll-interval-ms"] })
      : buildSingleJobSnapshot(stateDir, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }
  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }
  const report = buildStatusSnapshot(stateDir, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

async function waitForSingleJobSnapshot(stateDir, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(stateDir, reference);
  while ((snapshot.job.status === "queued" || snapshot.job.status === "running") && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(stateDir, reference);
  }
  return { ...snapshot, waitTimedOut: snapshot.job.status === "queued" || snapshot.job.status === "running", timeoutMs };
}

function resolveResultJob(stateDir, reference) {
  const jobs = listJobs(stateDir);
  if (reference) {
    const job = jobs.find((j) => j.id === reference) ?? jobs.find((j) => j.id.startsWith(reference));
    if (job) {
      return { job };
    }
    throw new Error(`No job found for "${reference}". Run /pi:status to list known jobs.`);
  }
  const finished = jobs.find((j) => j.status !== "queued" && j.status !== "running");
  if (!finished) {
    throw new Error("No finished Pi jobs found for this repository yet.");
  }
  return { job: finished };
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd", "state-dir"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const stateDir = options["state-dir"] || resolveStateDir(cwd);
  const { job } = resolveResultJob(stateDir, positionals[0] ?? "");
  const storedJob = readJobFile(resolveJobFile(stateDir, job.id)) ?? {};
  outputCommandResult({ job, storedJob }, renderStoredJobResult(job, storedJob), options.json);
}

function resolveCancelableJob(stateDir, reference) {
  const jobs = listJobs(stateDir);
  const activeJobs = jobs.filter((j) => j.status === "queued" || j.status === "running");
  const sessionScoped = filterJobsForCurrentClaudeSession(activeJobs);
  if (reference) {
    const job = activeJobs.find((j) => j.id === reference) ?? activeJobs.find((j) => j.id.startsWith(reference));
    if (job) {
      return { job };
    }
    throw new Error(`No active job found for "${reference}".`);
  }
  if (sessionScoped.length === 1) {
    return { job: sessionScoped[0] };
  }
  if (sessionScoped.length > 1) {
    throw new Error("Multiple Pi jobs are active. Pass a job id to /pi:cancel.");
  }
  if (activeJobs.length > 0) {
    throw new Error("Multiple Pi jobs are active. Pass a job id to /pi:cancel.");
  }
  throw new Error("No active Pi jobs to cancel.");
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd", "state-dir"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const stateDir = options["state-dir"] || resolveStateDir(cwd);
  const { job } = resolveCancelableJob(stateDir, positionals[0] ?? "");
  const existing = readJobFile(resolveJobFile(stateDir, job.id)) ?? {};

  // Kill the worker process tree (which holds the Pi RPC child).
  if (job.pid) {
    terminateProcessTree(job.pid);
    appendLogLine(job.logFile, `Terminated worker process tree (pid ${job.pid}).`);
  }

  const completedAt = nowIso();
  const nextJob = { ...job, status: "cancelled", phase: "cancelled", pid: null, completedAt, errorMessage: "Cancelled by user." };
  writeJobFile(stateDir, job.id, { ...existing, ...nextJob, cancelledAt: completedAt });
  upsertJob(stateDir, { id: job.id, status: "cancelled", phase: "cancelled", pid: null, completedAt, errorMessage: "Cancelled by user." });

  outputCommandResult({ jobId: job.id, status: "cancelled", title: job.title }, renderCancelReport(nextJob), options.json);
}

// ---------------------------------------------------------------------------
// task-resume-candidate
// ---------------------------------------------------------------------------

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "state-dir"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const stateDir = options["state-dir"] || resolveStateDir(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(stateDir)));
  const candidate = findLatestResumableTaskJob(jobs);
  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate: candidate
      ? { id: candidate.id, status: candidate.status, title: candidate.title ?? null, summary: candidate.summary ?? null, threadId: candidate.threadId }
      : null
  };
  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleAdversarialReview(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
