/**
 * Pi RPC client.
 *
 * Spawns `pi --mode rpc` and speaks the JSONL protocol over stdin/stdout.
 * Protocol reference: packages/coding-agent/docs/rpc.md
 *
 * Key rules (verified against Pi 0.80.6):
 * - Split stdout on LF only (NOT readline — U+2028/U+2029 are legal inside
 *   JSON strings and readline would wrongly split there).
 * - Only `{type:"response", id}` lines are responses; everything else is an
 *   event. Events carry no `id`.
 * - `prompt`'s success response means "accepted", not "done". Wait for
 *   `{type:"agent_settled"}` (NOT agent_end, which may be followed by retry/
 *   compaction/queued follow-ups) before reading the result.
 * - Retrieve the final answer via `get_last_assistant_text` after settled.
 * - Abort via `{type:"abort"}`; close stdin or SIGTERM to shut the child down.
 */
import { spawn } from "node:child_process";
import process from "node:process";

const DEFAULT_MODEL = process.env.PI_PLUGIN_MODEL || "glm-5.2";
const DEFAULT_PROVIDER = process.env.PI_PLUGIN_PROVIDER || "zai";
const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 30 * 60 * 1000;
const SETTLE_TIMEOUT_MS = positiveInteger(process.env.PI_PLUGIN_SETTLE_TIMEOUT_MS, DEFAULT_SETTLE_TIMEOUT_MS);

export class PiRpcClient {
  /**
   * @param {{ cwd: string, provider?: string, model?: string, tools?: string|null, write?: boolean, noTools?: boolean, onEvent?: (ev: object) => void, onProgress?: (msg: string, phase?: string|null) => void }} options
   */
  constructor(options) {
    this.cwd = options.cwd;
    this.provider = options.provider || DEFAULT_PROVIDER;
    this.model = options.model || DEFAULT_MODEL;
    this.write = Boolean(options.write);
    this.tools = options.tools ?? null;
    this.noTools = Boolean(options.noTools);
    this.onEvent = options.onEvent ?? null;
    this.onProgress = options.onProgress ?? null;
    this.child = null;
    this.requestId = 0;
    this.pending = new Map();
    this.eventListeners = [];
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.started = false;
  }

  start() {
    if (this.started) {
      return;
    }
    this.started = true;

    const args = ["--mode", "rpc"];
    // A provider-prefixed model is authoritative. Omitting --provider in that
    // case lets Pi route anthropic/foo, zai/bar, and custom providers without
    // an accidental conflict with the plugin default.
    if (!this.model.includes("/")) {
      args.push("--provider", this.provider);
    }
    args.push("--model", this.model, "--approve", "--no-extensions", "--no-skills");
    // Tool policy:
    // - write-capable (rescue --write): full built-in tools
    // - read-only task (rescue default): read/grep/find/ls (no bash, no edit)
    // - review/noTools: --no-tools so Pi cannot explore the repo and stall;
    //   the diff is already embedded in the review prompt, so a pure-LLM
    //   pass is both faster and more focused.
    if (this.noTools) {
      args.push("--no-tools");
    } else if (!this.write) {
      args.push("--tools", this.tools ?? "read,grep,find,ls");
    } else if (this.tools) {
      args.push("--tools", this.tools);
    }

    const selectedProvider = this.model.includes("/") ? this.model.split("/", 1)[0] : this.provider;
    this.emit(`Starting Pi RPC (provider ${selectedProvider}, model ${this.model}).`, "starting");

    this.child = spawn("pi", args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdoutChunk(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk;
    });
    this.child.on("exit", (code) => {
      this.exitCode = code;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`Pi RPC process exited (code ${code})`));
      }
      this.pending.clear();
    });
    this.child.on("error", (err) => {
      this.lastError = err;
    });
  }

  emit(message, phase = null) {
    this.onProgress?.(message, phase);
  }

  handleStdoutChunk(chunk) {
    this.stdoutBuffer += chunk;
    let newlineIndex;
    // LF-only split. Strip a single trailing \r to tolerate CRLF.
    while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
      let line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (!line.trim()) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    // Responses carry type:"response" + id → resolve the pending request.
    if (message.type === "response" && message.id && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.success) {
        resolve(message.data ?? {});
      } else {
        reject(new Error(message.error ?? `Pi RPC command ${message.command ?? "?"} failed`));
      }
      return;
    }
    // Everything else is an event.
    this.onEvent?.(message);
    for (const listener of this.eventListeners) {
      try {
        listener(message);
      } catch {
        // listener errors must not break the stream
      }
    }
  }

  send(command) {
    const id = `req_${++this.requestId}`;
    const fullCommand = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC request ${command.type} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify(fullCommand) + "\n");
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async prompt(message) {
    return this.send({ type: "prompt", message });
  }

  async abort() {
    return this.send({ type: "abort" });
  }

  async getState() {
    return this.send({ type: "get_state" });
  }

  async getLastAssistantText() {
    const data = await this.send({ type: "get_last_assistant_text" });
    return data?.text ?? "";
  }

  async switchSession(sessionPath) {
    return this.send({ type: "switch_session", sessionPath });
  }

  async getEntries() {
    return this.send({ type: "get_entries" });
  }

  async getMessages() {
    return this.send({ type: "get_messages" });
  }

  close() {
    if (!this.child) {
      return;
    }
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        this.child?.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, 200);
  }

  getStderr() {
    return this.stderrBuffer.trim();
  }
}

/**
 * Run a one-shot Pi prompt and resolve with the final assistant text.
 *
 * @param {{ cwd: string, prompt: string, provider?: string, model?: string, write?: boolean, sessionPath?: string|null, onProgress?: (msg: string, phase?: string|null) => void }} options
 * @returns {Promise<{ status: number, sessionId: string|null, finalMessage: string, reasoning: string[], touchedFiles: string[], commandExecutions: object[], error: Error|null, stderr: string }>}
 */
export async function runPiTurn(options = {}) {
  const client = new PiRpcClient({
    cwd: options.cwd,
    provider: options.provider,
    model: options.model,
    write: options.write,
    noTools: options.noTools,
    onProgress: options.onProgress
  });

  const state = {
    sessionId: null,
    finalMessage: "",
    reasoning: [],
    reasoningBuffer: "",
    touchedFiles: [],
    commandExecutions: [],
    error: null,
    settled: false
  };

  const eventNames = {
    agent_start: false,
    agent_settled: false
  };

  client.onEvent = (event) => {
    switch (event.type) {
      case "turn_start":
        options.onProgress?.("Turn started.", "starting");
        break;
      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (delta?.type === "thinking_end") {
          // Capture the full reasoning block once it completes, instead of
          // accumulating per-token deltas (which split reasoning into words).
          const text = delta.partial?.content
            ?.find((c) => c.type === "thinking")
            ?.thinking?.trim();
          if (text && !state.reasoning.includes(text)) {
            state.reasoning.push(text);
          }
        } else if (delta?.type === "thinking_delta" && delta.delta) {
          // Buffer deltas; joined into a block on thinking_end. Kept as a
          // fallback in case thinking_end never fires.
          state.reasoningBuffer = (state.reasoningBuffer ?? "") + delta.delta;
        }
        break;
      }
      case "message_end": {
        const message = event.message;
        if (message?.role === "assistant") {
          const texts = (message.content ?? [])
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text);
          if (texts.length) {
            state.finalMessage = texts.join("\n");
            options.onProgress?.(`Assistant message captured: ${shorten(state.finalMessage, 96)}`, "finalizing");
          }
        }
        break;
      }
      case "tool_execution_start": {
        const tool = event.toolName ?? "tool";
        const phase = tool === "bash" ? "verifying" : "editing";
        options.onProgress?.(`Running tool: ${tool}.`, phase);
        break;
      }
      case "tool_execution_end": {
        const tool = event.toolName ?? "tool";
        const isError = Boolean(event.isError);
        options.onProgress?.(`Tool ${tool} ${isError ? "failed" : "completed"}.`, isError ? "failed" : "running");
        if (tool === "edit" || tool === "write") {
          const path = event.args?.path ?? event.args?.file ?? null;
          if (path) {
            state.touchedFiles.push(path);
          }
        } else if (tool === "bash") {
          state.commandExecutions.push({
            command: event.args?.command ?? null,
            isError
          });
        }
        break;
      }
      case "error":
      case "extension_error": {
        const detail = event.error ?? event.message ?? "Pi error";
        state.error = new Error(typeof detail === "string" ? detail : detail.message ?? "Pi error");
        options.onProgress?.(`Pi error: ${state.error.message}`, "failed");
        break;
      }
      case "agent_start":
        eventNames.agent_start = true;
        break;
      case "agent_settled":
        eventNames.agent_settled = true;
        break;
      default:
        break;
    }
  };

  let lastError = null;

  try {
    client.start();

    if (options.sessionPath) {
      try {
        await client.switchSession(options.sessionPath);
        options.onProgress?.(`Resumed Pi session ${options.sessionPath}.`, "starting");
      } catch (error) {
        // If switch fails, continue with a fresh session.
        options.onProgress?.(`Session resume failed (${error.message}); starting fresh.`, "starting");
      }
    }

    await client.prompt(options.prompt);

    // Wait for the agent to fully settle. agent_end may fire multiple times
    // (retry/compaction), so agent_settled is the authoritative stop signal.
    await waitForSettled(client);

    // If thinking_end never fired, flush the buffered delta tokens into one
    // reasoning block so the reasoning summary is readable.
    if (state.reasoning.length === 0 && state.reasoningBuffer.trim()) {
      state.reasoning.push(state.reasoningBuffer.trim());
    }

    // get_last_assistant_text is authoritative when available.
    try {
      const text = await client.getLastAssistantText();
      if (text) {
        state.finalMessage = text;
      }
    } catch (error) {
      lastError = error;
    }

    try {
      const piState = await client.getState();
      state.sessionId = piState?.sessionId ?? piState?.sessionFile ?? null;
    } catch {
      // best effort
    }

    const status = state.error ? 1 : 0;
    return {
      status,
      sessionId: state.sessionId,
      finalMessage: state.finalMessage,
      reasoning: state.reasoning,
      touchedFiles: dedupe(state.touchedFiles),
      commandExecutions: state.commandExecutions,
      error: state.error ?? lastError,
      stderr: client.getStderr()
    };
  } finally {
    client.close();
  }
}

function waitForSettled(client) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      const index = client.eventListeners.indexOf(listener);
      if (index !== -1) {
        client.eventListeners.splice(index, 1);
      }
      client.child?.off("exit", onExit);
    };
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback(value);
    };
    const listener = (event) => {
      if (event.type === "agent_settled") {
        finish(resolve);
      }
    };
    const onExit = (code, signal) => {
      finish(reject, new Error(`Pi RPC process exited before settling (code ${code ?? "unknown"}, signal ${signal ?? "none"}).`));
    };
    client.eventListeners.push(listener);
    client.child?.once("exit", onExit);
    timer = setTimeout(() => {
      finish(reject, new Error(`Pi RPC did not settle within ${formatTimeout(SETTLE_TIMEOUT_MS)}.`));
    }, SETTLE_TIMEOUT_MS);
    timer.unref?.();
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatTimeout(ms) {
  if (ms % 60_000 === 0) {
    return `${ms / 60_000} minutes`;
  }
  return `${ms}ms`;
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

function dedupe(arr) {
  return [...new Set(arr)];
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Pi did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const errors = [];

  try {
    return { parsed: JSON.parse(rawOutput), parseError: null, rawOutput, ...fallback };
  } catch (error) {
    errors.push(error.message);
  }

  const candidates = extractJsonCandidates(rawOutput);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (looksLikeReviewObject(parsed)) {
        return { parsed, parseError: null, rawOutput, ...fallback };
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return { parsed, parseError: null, rawOutput, ...fallback };
    } catch {
      // recorded
    }
  }

  const detail = errors.length ? errors[errors.length - 1] : "no JSON object found";
  return {
    parsed: null,
    parseError: `Pi did not return valid structured JSON (${detail}).`,
    rawOutput,
    ...fallback
  };
}

function looksLikeReviewObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.verdict === "string" &&
    Array.isArray(value.findings)
  );
}

function extractJsonCandidates(text) {
  const str = String(text ?? "");
  const candidates = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fenceRe.exec(str)) !== null) {
    const body = match[1]?.trim();
    if (body) {
      candidates.push(body);
    }
  }
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          candidates.push(str.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return candidates;
}

export { DEFAULT_MODEL, DEFAULT_PROVIDER, SETTLE_TIMEOUT_MS };
