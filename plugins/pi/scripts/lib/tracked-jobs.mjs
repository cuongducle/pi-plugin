import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "PI_PLUGIN_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      sessionId: typeof value.sessionId === "string" && value.sessionId.trim() ? value.sessionId.trim() : null
    };
  }
  return {
    message: String(value ?? "").trim(),
    phase: null,
    sessionId: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(stateDir, jobId, title) {
  const logFile = resolveJobLogFile(stateDir, jobId);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(stateDir, jobId) {
  let lastPhase = null;
  let lastSessionId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }
    if (normalized.sessionId && normalized.sessionId !== lastSessionId) {
      lastSessionId = normalized.sessionId;
      patch.threadId = normalized.sessionId;
      changed = true;
    }
    if (!changed) {
      return;
    }

    upsertJob(stateDir, patch);
    const jobFile = resolveJobFile(stateDir, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }
    const storedJob = readJobFile(jobFile);
    writeJobFile(stateDir, jobId, { ...storedJob, ...patch });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }
  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const message = event.message;
    if (stderr && message) {
      process.stderr.write(`[pi] ${message}\n`);
    }
    appendLogLine(logFile, message);
    onEvent?.(event);
  };
}

export async function runTrackedJob(job, stateDir, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(stateDir, job.id, runningRecord);
  upsertJob(stateDir, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    writeJobFile(stateDir, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(stateDir, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    const existing = readJobFile(resolveJobFile(stateDir, job.id)) ?? runningRecord;
    writeJobFile(stateDir, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt
    });
    upsertJob(stateDir, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    throw error;
  }
}
