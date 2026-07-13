import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "pi-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_INDEXED_JOBS = 50;

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const pluginData = process.env[PLUGIN_DATA_ENV];
  if (pluginData) {
    return path.join(pluginData, "pi-plugin", hashWorkspace(workspaceRoot));
  }
  const hash = hashWorkspace(workspaceRoot);
  const base = path.basename(workspaceRoot).replace(/[^A-Za-z0-9._-]/g, "-");
  return path.join(FALLBACK_STATE_ROOT_DIR, `${base}-${hash}`);
}

function hashWorkspace(workspaceRoot) {
  return createHash("md5").update(workspaceRoot).digest("hex").slice(0, 16);
}

function stateFilePath(stateDir) {
  return path.join(stateDir, STATE_FILE_NAME);
}

function jobsDir(stateDir) {
  return path.join(stateDir, JOBS_DIR_NAME);
}

function ensureDirs(stateDir) {
  fs.mkdirSync(jobsDir(stateDir), { recursive: true });
}

export function readState(stateDir) {
  const file = stateFilePath(stateDir);
  const data = readJsonFile(file, null);
  if (!data || typeof data !== "object") {
    return { version: STATE_VERSION, jobs: [] };
  }
  return data;
}

export function saveState(stateDir, state) {
  ensureDirs(stateDir);
  const jobs = Array.isArray(state.jobs)
    ? [...state.jobs].sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")))
    : [];
  const retainedJobs = jobs.slice(0, MAX_INDEXED_JOBS);
  for (const job of jobs.slice(MAX_INDEXED_JOBS)) {
    removeFileIfPresent(resolveJobFile(stateDir, job.id));
    removeFileIfPresent(resolveJobLogFile(stateDir, job.id));
  }
  const data = { ...state, jobs: retainedJobs, version: STATE_VERSION };
  fs.writeFileSync(stateFilePath(stateDir), JSON.stringify(data, null, 2), "utf8");
}

export function listJobs(stateDir) {
  const state = readState(stateDir);
  return Array.isArray(state.jobs) ? state.jobs : [];
}

export function upsertJob(stateDir, jobPatch) {
  const state = readState(stateDir);
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  const index = jobs.findIndex((j) => j.id === jobPatch.id);
  if (index === -1) {
    jobs.push({ ...jobPatch });
  } else {
    jobs[index] = { ...jobs[index], ...jobPatch };
  }
  saveState(stateDir, { jobs });
}

export function generateJobId(prefix = "task") {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}-${time}${rand}`.slice(0, 24);
}

export function resolveJobFile(stateDir, jobId) {
  return path.join(jobsDir(stateDir), `${jobId}.json`);
}

export function resolveJobLogFile(stateDir, jobId) {
  return path.join(jobsDir(stateDir), `${jobId}.log`);
}

export function writeJobFile(stateDir, jobId, data) {
  ensureDirs(stateDir);
  fs.writeFileSync(resolveJobFile(stateDir, jobId), JSON.stringify(data, null, 2), "utf8");
}

export function readJobFile(jobFile) {
  return readJsonFile(jobFile, null);
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function removeFileIfPresent(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export { ensureDirs };
