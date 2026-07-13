---
description: Show running and recent Pi jobs for the current repository
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" status "$ARGUMENTS"
```

Return the command stdout verbatim, exactly as-is. Do not paraphrase or add commentary.
