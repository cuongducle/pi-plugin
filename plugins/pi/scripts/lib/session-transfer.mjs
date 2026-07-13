/**
 * Write a Pi session JSONL file from a Claude transcript.
 *
 * Pi's session format (version 3) is a JSONL file where:
 *   line 1 = session header {"type":"session","version":3,"id","timestamp","cwd"}
 *   rest   = entries chained by parentId, mostly {"type":"message","message":{role,content,...}}
 *
 * By writing a real session file we let Pi load the conversation history natively
 * via `switch_session`, instead of summarizing it into a single prompt.
 *
 * Format reference: packages/coding-agent/docs/session-format.md
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PI_SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

function encodeCwd(cwd) {
  // Pi encodes the working directory by replacing "/" with "-", prefixed with "--".
  return cwd.replace(/\//g, "-").replace(/^(-)?/, "--");
}

function randomSessionId() {
  return crypto.randomUUID();
}

function randomEntryId() {
  return crypto.randomBytes(4).toString("hex");
}

function isoNow() {
  return new Date().toISOString();
}

function extractTurnsFromClaudeTranscript(sourcePath) {
  const raw = fs.readFileSync(sourcePath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const turns = [];

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry.type ?? entry.role;
    let text;
    if (typeof entry.message?.content === "string") {
      text = entry.message.content;
    } else if (Array.isArray(entry.message?.content)) {
      text = entry.message.content
        .map((c) => (typeof c === "string" ? c : c.text ?? ""))
        .filter(Boolean)
        .join("\n");
    } else {
      text = "";
    }
    text = String(text ?? "").trim();
    if (!text) {
      continue;
    }

    if (role === "user" || role === "human") {
      turns.push({ role: "user", text });
    } else if (role === "assistant" || role === "ai") {
      turns.push({ role: "assistant", text });
    }
  }
  return turns;
}

/**
 * Write a Pi session JSONL file from a Claude transcript and return its path.
 *
 * @param {{ sourcePath: string, cwd: string, maxTurns?: number }} options
 * @returns {{ sessionPath: string, sessionId: string, turnCount: number }}
 */
export function writePiSessionFromClaudeTranscript(options) {
  const { sourcePath, cwd } = options;
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Claude session source not found: ${sourcePath}`);
  }

  const turns = extractTurnsFromClaudeTranscript(sourcePath);
  const trimmed = turns.slice(-(options.maxTurns ?? 20));

  const sessionId = randomSessionId();
  const timestamp = isoNow();
  const sessionDir = path.join(PI_SESSIONS_DIR, encodeCwd(cwd));
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, `${timestamp.replace(/[:.]/g, "")}_${sessionId}.jsonl`);

  const lines = [];
  // Header
  lines.push(
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp,
      cwd
    })
  );

  // Message entries chained by parentId
  let parentId = null;
  const messageTimestamp = Date.now();
  for (let i = 0; i < trimmed.length; i += 1) {
    const turn = trimmed[i];
    const entryId = randomEntryId();
    const message =
      turn.role === "user"
        ? {
            role: "user",
            content: turn.text,
            timestamp: messageTimestamp + i
          }
        : {
            role: "assistant",
            content: [{ type: "text", text: turn.text }],
            api: "anthropic-messages",
            provider: "claude-code-import",
            model: "imported-session",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
            stopReason: "stop",
            timestamp: messageTimestamp + i
          };
    lines.push(
      JSON.stringify({
        type: "message",
        id: entryId,
        parentId,
        timestamp: isoNow(),
        message
      })
    );
    parentId = entryId;
  }

  fs.writeFileSync(sessionPath, lines.join("\n") + "\n", "utf8");

  return { sessionPath, sessionId, turnCount: trimmed.length };
}
