#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { listJobs, readJobFile, resolveJobFile, resolveStateDir, upsertJob, writeJobFile } from "./lib/state.mjs";
import { nowIso, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";

const TRANSCRIPT_PATH_ENV = "PI_PLUGIN_TRANSCRIPT_PATH";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  if (!sessionId) {
    return;
  }

  const stateDir = resolveStateDir(cwd);
  for (const job of listJobs(stateDir)) {
    if (job.sessionId !== sessionId || (job.status !== "queued" && job.status !== "running")) {
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Session shutdown is best effort; state is still marked as cancelled.
    }
    const completedAt = nowIso();
    const patch = {
      id: job.id,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      completedAt,
      errorMessage: "Cancelled because the Claude session ended."
    };
    const stored = readJobFile(resolveJobFile(stateDir, job.id)) ?? job;
    writeJobFile(stateDir, job.id, { ...stored, ...patch });
    upsertJob(stateDir, patch);
  }
}

const input = readHookInput();
const eventName = process.argv[2] ?? input.hook_event_name ?? "";
if (eventName === "SessionStart") {
  handleSessionStart(input);
} else if (eventName === "SessionEnd") {
  handleSessionEnd(input);
}
