---
description: Write a Pi session from the current Claude Code transcript so you can continue in Pi
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" transfer "$ARGUMENTS"
```

Return the command stdout verbatim, exactly as-is. Do not paraphrase or add commentary.

The plugin reads the Claude transcript JSONL and writes a real Pi session file (header + chained user/assistant message entries) so Pi can load the conversation history natively via `pi --session <path>`.

> [!NOTE]
> Unlike a pure prompt-seed, this writes a real Pi session file. The continuation is not byte-for-byte identical to the Claude session (tool calls/results are summarized into text), but Pi sees the full turn history.
