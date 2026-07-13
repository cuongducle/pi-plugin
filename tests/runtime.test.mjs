import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildPiEnv, installFakePi, readFakePiState } from "./fake-pi-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "pi", "scripts", "pi-companion.mjs");
const SESSION_HOOK = path.join(ROOT, "plugins", "pi", "scripts", "session-lifecycle-hook.mjs");

function makeRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "initial\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "initial"], { cwd: repo });
  return repo;
}

function runCompanion(args, { cwd, env }) {
  return run(process.execPath, [SCRIPT, ...args], { cwd, env });
}

test("setup verifies both Pi and the configured GLM-5.2 model", () => {
  const binDir = makeTempDir();
  installFakePi(binDir);
  const result = runCompanion(["setup", "--json"], { cwd: ROOT, env: buildPiEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.match(payload.auth.detail, /zai\/glm-5\.2/);
});

test("setup reports an installed Pi with missing provider credentials", () => {
  const binDir = makeTempDir();
  installFakePi(binDir);
  const result = runCompanion(["setup", "--json"], {
    cwd: ROOT,
    env: buildPiEnv(binDir, { FAKE_PI_AUTH: "0", ZAI_API_KEY: "" })
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.pi.available, true);
  assert.equal(payload.auth.loggedIn, false);
  assert.match(payload.nextSteps.join("\n"), /ZAI_API_KEY/);
});

test("setup returns a report instead of throwing when Pi is missing", { skip: process.platform === "win32" }, () => {
  const binDir = makeTempDir();
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));
  const result = runCompanion(["setup", "--json"], {
    cwd: ROOT,
    env: { ...process.env, PATH: binDir }
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.pi.available, false);
  assert.match(payload.nextSteps.join("\n"), /Install Pi/);
});

test("write tasks pass provider/model and full tool access to Pi RPC", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const stateDir = makeTempDir();
  const { statePath } = installFakePi(binDir);
  const result = runCompanion(
    ["task", "--json", "--write", "--state-dir", stateDir, "--model", "zai/glm-5.2", "implement", "the", "fix"],
    { cwd: repo, env: buildPiEnv(binDir) }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rawOutput, "Handled the requested Pi task.");

  const rpc = readFakePiState(statePath).invocations.findLast((entry) => entry.kind === "rpc");
  assert.deepEqual(rpc.args.slice(0, 4), ["--mode", "rpc", "--model", "zai/glm-5.2"]);
  assert.equal(rpc.args.includes("--provider"), false);
  assert.equal(rpc.args.includes("--no-tools"), false);
  assert.equal(rpc.args.includes("--tools"), false);
});

test("read-only tasks and reviews cannot receive write tools", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const stateDir = makeTempDir();
  const { statePath } = installFakePi(binDir);
  const env = buildPiEnv(binDir);

  const task = runCompanion(["task", "--json", "--state-dir", stateDir, "diagnose", "only"], { cwd: repo, env });
  assert.equal(task.status, 0, task.stderr);
  let rpc = readFakePiState(statePath).invocations.findLast((entry) => entry.kind === "rpc");
  assert.deepEqual(rpc.args.slice(0, 6), ["--mode", "rpc", "--provider", "zai", "--model", "glm-5.2"]);
  assert.deepEqual(rpc.args.slice(rpc.args.indexOf("--tools")), ["--tools", "read,grep,find,ls"]);

  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  const review = runCompanion(["review", "--json", "--scope", "working-tree", "--state-dir", stateDir], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);
  assert.equal(JSON.parse(review.stdout).result.verdict, "approve");
  rpc = readFakePiState(statePath).invocations.findLast((entry) => entry.kind === "rpc");
  assert.equal(rpc.args.includes("--no-tools"), true);
  assert.equal(rpc.args.includes("--tools"), false);
});

test("resume uses the Pi session path stored by the prior task", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const stateDir = makeTempDir();
  const { statePath } = installFakePi(binDir);
  const env = buildPiEnv(binDir, { PI_PLUGIN_SESSION_ID: "claude-session-1" });

  const first = runCompanion(["task", "--json", "--state-dir", stateDir, "first"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const second = runCompanion(["task", "--json", "--state-dir", stateDir, "--resume-last", "continue"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(readFakePiState(statePath).switchedSessions, ["/tmp/fake-pi-session.jsonl"]);
});

test("provider credentials are inherited but never persisted in plugin state", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const stateDir = makeTempDir();
  const { statePath } = installFakePi(binDir);
  const secret = "test-secret-must-not-be-written";
  const result = runCompanion(["task", "--json", "--write", "--state-dir", stateDir, "safe", "task"], {
    cwd: repo,
    env: buildPiEnv(binDir, { ZAI_API_KEY: secret })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakePiState(statePath).invocations.findLast((entry) => entry.kind === "rpc").hasZaiKey, true);
  const persisted = fs.readdirSync(path.join(stateDir, "jobs")).map((name) => fs.readFileSync(path.join(stateDir, "jobs", name), "utf8")).join("\n") + fs.readFileSync(path.join(stateDir, "state.json"), "utf8");
  assert.equal(persisted.includes(secret), false);
});

test("the configurable settle timeout fails a stuck Pi run promptly", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakePi(binDir);
  const result = runCompanion(["task", "--state-dir", makeTempDir(), "stuck"], {
    cwd: repo,
    env: buildPiEnv(binDir, { FAKE_PI_BEHAVIOR: "never-settle", PI_PLUGIN_SETTLE_TIMEOUT_MS: "50" })
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not settle within 50ms/);
});

test("a Pi process exit before agent_settled is reported immediately", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakePi(binDir);
  const result = runCompanion(["task", "--state-dir", makeTempDir(), "crash"], {
    cwd: repo,
    env: buildPiEnv(binDir, { FAKE_PI_BEHAVIOR: "exit-before-settle" })
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exited before settling/);
});

test("background jobs can be inspected and cancelled", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const stateDir = makeTempDir();
  installFakePi(binDir);
  const env = buildPiEnv(binDir, { FAKE_PI_BEHAVIOR: "slow", PI_PLUGIN_SESSION_ID: "claude-session-bg" });

  const launch = runCompanion(["task", "--background", "--json", "--write", "--state-dir", stateDir, "long", "task"], { cwd: repo, env });
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;

  await new Promise((resolve) => setTimeout(resolve, 150));
  const status = runCompanion(["status", jobId, "--json", "--state-dir", stateDir], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(JSON.parse(status.stdout).job.status, /queued|running/);

  const cancel = runCompanion(["cancel", jobId, "--json", "--state-dir", stateDir], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).status, "cancelled");
  const after = runCompanion(["status", jobId, "--json", "--state-dir", stateDir], { cwd: repo, env });
  assert.equal(JSON.parse(after.stdout).job.status, "cancelled");
});

test("transfer writes a real Pi session without provider credentials", () => {
  const home = makeTempDir();
  const repo = makeRepo();
  const transcript = path.join(home, "claude.jsonl");
  fs.writeFileSync(
    transcript,
    [
      { type: "user", message: { content: "Please inspect the parser." } },
      { type: "assistant", message: { content: "I found one edge case." } },
      { type: "user", message: { content: "Please inspect the parser." } }
    ].map(JSON.stringify).join("\n") + "\n"
  );
  const result = runCompanion(["transfer", "--json", "--source", transcript], {
    cwd: repo,
    env: { ...process.env, HOME: home, ZAI_API_KEY: "transfer-secret" }
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.resumeCommand, /^pi --session /);
  const session = fs.readFileSync(payload.threadId, "utf8");
  assert.match(session, /"version":3/);
  assert.match(session, /claude-code-import/);
  assert.equal(session.match(/Please inspect the parser\./g)?.length, 2);
  assert.equal(session.includes("transfer-secret"), false);
  assert.equal(session.includes("glm-5.1"), false);
});

test("SessionStart exports the Claude session and transcript for rescue/transfer", () => {
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "");
  const transcript = "/tmp/claude projects/session.jsonl";
  const result = run(process.execPath, [SESSION_HOOK, "SessionStart"], {
    cwd: ROOT,
    env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: "/tmp/pi plugin data" },
    input: JSON.stringify({ session_id: "session-with-'quote", transcript_path: transcript })
  });
  assert.equal(result.status, 0, result.stderr);
  const exports = fs.readFileSync(envFile, "utf8");
  assert.match(exports, /PI_PLUGIN_SESSION_ID/);
  assert.match(exports, /PI_PLUGIN_TRANSCRIPT_PATH/);
  assert.match(exports, /CLAUDE_PLUGIN_DATA/);
  assert.match(exports, /session-with-'"'"'quote/);
  assert.match(exports, /claude projects\/session\.jsonl/);
});
