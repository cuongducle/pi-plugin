import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { listJobs, resolveJobFile, resolveJobLogFile, resolveStateDir, saveState } from "../plugins/pi/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const stateDir = resolveStateDir(workspace);
  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when provided", () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const pluginDataDir = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    assert.match(resolveStateDir(workspace), new RegExp(`^${path.join(pluginDataDir, "pi-plugin").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    if (previous == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("saveState keeps the newest 50 jobs and removes pruned artifacts", () => {
  const stateDir = makeTempDir();
  const jobs = Array.from({ length: 51 }, (_, index) => {
    const id = `job-${index}`;
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    fs.mkdirSync(path.dirname(resolveJobFile(stateDir, id)), { recursive: true });
    fs.writeFileSync(resolveJobFile(stateDir, id), "{}\n");
    fs.writeFileSync(resolveJobLogFile(stateDir, id), "log\n");
    return { id, createdAt };
  });

  saveState(stateDir, { jobs });
  assert.equal(listJobs(stateDir).length, 50);
  assert.equal(fs.existsSync(resolveJobFile(stateDir, "job-0")), false);
  assert.equal(fs.existsSync(resolveJobLogFile(stateDir, "job-0")), false);
  assert.equal(listJobs(stateDir)[0].id, "job-50");
});
