---
description: Cancel an active background Pi job
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" cancel "$ARGUMENTS"
```

Return the command stdout verbatim, exactly as-is. Do not paraphrase or add commentary.
