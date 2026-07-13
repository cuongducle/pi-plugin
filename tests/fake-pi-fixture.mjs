import fs from "node:fs";
import path from "node:path";

import { writeExecutable } from "./helpers.mjs";

export function installFakePi(binDir) {
  const statePath = path.join(binDir, "fake-pi-state.json");
  const scriptPath = path.join(binDir, "pi");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const statePath = process.env.FAKE_PI_STATE || ${JSON.stringify(statePath)};
const args = process.argv.slice(2);
const behavior = process.env.FAKE_PI_BEHAVIOR || "ok";

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { return { invocations: [], prompts: [], switchedSessions: [] }; }
}

function writeState(patch) {
  const state = { ...readState(), ...patch };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

function recordInvocation(kind) {
  const state = readState();
  state.invocations.push({ kind, args, hasZaiKey: Boolean(process.env.ZAI_API_KEY) });
  writeState(state);
}

if (args.includes("-v") || args.includes("--version")) {
  recordInvocation("version");
  console.log("0.80.6-test");
  process.exit(0);
}

if (args.includes("--list-models")) {
  recordInvocation("list-models");
  console.log("provider  model    context  max-out  thinking  images");
  if (process.env.FAKE_PI_AUTH === "1" || process.env.ZAI_API_KEY) {
    console.log("zai       glm-5.2  1M       131.1K   yes       no");
  }
  process.exit(0);
}

recordInvocation("rpc");
let lastText = "";
let activeSession = process.env.FAKE_PI_SESSION || "/tmp/fake-pi-session.jsonl";
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

function finishPrompt(prompt) {
  const isReview = prompt.includes("<structured_output_contract>");
  lastText = isReview
    ? JSON.stringify({ verdict: "approve", summary: "No material issues found.", findings: [], next_steps: [] })
    : "Handled the requested Pi task.";
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  if (args.includes("--tools") === false && args.includes("--no-tools") === false) {
    send({ type: "tool_execution_start", toolName: "write", args: { path: "src/generated.txt" } });
    send({ type: "tool_execution_end", toolName: "write", args: { path: "src/generated.txt" }, isError: false });
  }
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: lastText }] } });
  send({ type: "agent_settled" });
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "prompt") {
    const state = readState();
    state.prompts.push(message.message);
    writeState(state);
    send({ type: "response", id: message.id, success: true, data: {} });
    if (behavior === "exit-before-settle") {
      setTimeout(() => process.exit(7), 5);
    } else if (behavior === "never-settle") {
      // Keep stdin open and intentionally emit no terminal event.
    } else if (behavior === "slow") {
      setTimeout(() => finishPrompt(message.message), 60_000);
    } else {
      setTimeout(() => finishPrompt(message.message), 5);
    }
  } else if (message.type === "get_last_assistant_text") {
    send({ type: "response", id: message.id, success: true, data: { text: lastText } });
  } else if (message.type === "get_state") {
    send({ type: "response", id: message.id, success: true, data: { sessionId: activeSession, sessionFile: activeSession } });
  } else if (message.type === "switch_session") {
    activeSession = message.sessionPath;
    const state = readState();
    state.switchedSessions.push(message.sessionPath);
    writeState(state);
    send({ type: "response", id: message.id, success: true, data: {} });
  } else if (message.type === "abort") {
    send({ type: "response", id: message.id, success: true, data: {} });
    process.exit(0);
  } else {
    send({ type: "response", id: message.id, success: true, data: {} });
  }
});
`;

  writeExecutable(scriptPath, source);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "pi.cmd"), `@echo off\r\nnode "%~dp0pi" %*\r\n`, "utf8");
  }
  return { scriptPath, statePath };
}

export function buildPiEnv(binDir, overrides = {}) {
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_PI_STATE: path.join(binDir, "fake-pi-state.json"),
    FAKE_PI_AUTH: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0"
  };
  delete env.PI_PLUGIN_MODEL;
  delete env.PI_PLUGIN_PROVIDER;
  delete env.PI_PLUGIN_SETTLE_TIMEOUT_MS;
  delete env.ZAI_API_KEY;
  return { ...env, ...overrides };
}

export function readFakePiState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}
