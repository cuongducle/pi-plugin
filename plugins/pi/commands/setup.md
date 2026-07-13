---
description: Check whether earendil-works/pi and the selected model are ready
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" setup --json
```

If the result says Pi is unavailable:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Pi now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Pi (Recommended)`
  - `Skip for now`
- If the user chooses install, install the supported `earendil-works/pi` package:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" setup --json
```

If Pi is already installed:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Pi is installed but the GLM provider is not configured, tell the user to set `ZAI_API_KEY` (or run `pi` and use `/login`) so the default model `zai/glm-5.2` works.
- Never ask the user to paste an API key into a tracked project file.
