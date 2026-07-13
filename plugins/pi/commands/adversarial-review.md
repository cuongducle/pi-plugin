---
description: Run a steerable adversarial Pi review that challenges the implementation and design
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model provider/model] [focus text]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a steerable Pi review that questions the chosen implementation and design.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Pi's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking (same heuristics as `/pi:review`), then use `AskUserQuestion` exactly once with two options, recommended first:
  - `Wait for results`
  - `Run in background`

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" adversarial-review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary.

Background flow:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "Pi adversarial review",
  run_in_background: true
})
```
- Tell the user: "Pi adversarial review started in the background. Check `/pi:status` for progress."
