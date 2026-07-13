# Pi plugin for Claude Code

Use [`earendil-works/pi`](https://github.com/earendil-works/pi) from Claude Code for code review, implementation, investigation, and session handoff.

This repository is a fork and adaptation of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc). It keeps the useful Claude Code command and background-job workflow while replacing the Codex app-server runtime with Pi's native JSONL RPC protocol.

## What you get

- `/pi:review` — structured, read-only review of the working tree or a branch diff
- `/pi:adversarial-review` — steerable challenge review focused on design and risk
- `/pi:rescue` — delegate diagnosis or implementation to a Pi coding-agent session
- `/pi:transfer` — convert the current Claude transcript into a resumable Pi session
- `/pi:status`, `/pi:result`, and `/pi:cancel` — manage foreground and background jobs
- `/pi:setup` — verify the Pi CLI and selected provider/model

## Requirements

- Node.js 22.19 or newer
- Claude Code with plugin support
- `@earendil-works/pi-coding-agent`
- Credentials for at least one Pi provider

Install Pi:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

## Install the plugin

After this branch is merged into the fork's default branch, add the marketplace and install the plugin in Claude Code:

```text
/plugin marketplace add cuongducle/pi-plugin
/plugin install pi@pi-plugin
/reload-plugins
/pi:setup
```

## ZAI Coding Plan and GLM-5.2

The default provider/model is `zai/glm-5.2`. Supply the credential through the process environment or Pi's own login flow. Do not put the key in this repository.

```bash
export ZAI_API_KEY="your-zai-coding-plan-key"
pi --list-models glm-5.2
```

You can also start `pi`, run `/login`, and select **ZAI Coding Plan (Global)**.

To change the plugin default without editing source:

```bash
export PI_PLUGIN_PROVIDER="zai"
export PI_PLUGIN_MODEL="glm-5.2"
```

Every command that starts an inference run also accepts an explicit model:

```text
/pi:rescue --model zai/glm-5.2 fix the failing integration test
/pi:review --model zai/glm-5.2 --base main
```

## Usage

### Review

```text
/pi:review
/pi:review --base main
/pi:review --background
/pi:adversarial-review --base main challenge the retry and rollback design
```

Review runs receive the collected diff in their prompt and start Pi with `--no-tools`. This makes the review path read-only by construction and prevents a reviewer from changing the checkout.

### Delegate a task

```text
/pi:rescue investigate why CI is failing
/pi:rescue --fresh --model zai/glm-5.2 implement the smallest safe fix
/pi:rescue --resume continue with the next failing test
/pi:rescue --background refactor the parser and run its test suite
```

The rescue subagent is a thin forwarder. Implementation tasks default to write-capable Pi runs; diagnosis, research, and review-only requests can be sent without write tools. `--fresh` starts a new Pi session and `--resume` continues the latest compatible task session for the current Claude session.

### Background jobs

```text
/pi:status
/pi:status task-abc123 --wait
/pi:result task-abc123
/pi:cancel task-abc123
```

Job state and logs are stored under Claude's plugin-data directory when available, otherwise under the operating-system temporary directory. Prompts and job metadata are stored; provider credentials are inherited only by the child process and are never copied into job records.

Write-capable Pi runs can execute shell commands with your user permissions. As with any local coding agent, do not delegate untrusted instructions or repositories when sensitive environment variables are present; Pi's tools can access the same machine and process environment.

### Transfer to Pi

```text
/pi:transfer
```

The transfer command converts user and assistant turns from the Claude transcript into a real Pi v3 session file and prints a `pi --session <path>` command. Claude tool calls are not reconstructed byte-for-byte; their visible text is preserved as conversation history.

## Runtime configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `ZAI_API_KEY` | ZAI Coding Plan credential consumed by Pi | unset |
| `PI_PLUGIN_PROVIDER` | Default Pi provider | `zai` |
| `PI_PLUGIN_MODEL` | Default Pi model | `glm-5.2` |
| `PI_PLUGIN_SETTLE_TIMEOUT_MS` | Maximum time for one Pi RPC agent run | `1800000` (30 minutes) |
| `PI_PLUGIN_TRANSCRIPT_PATH` | Explicit Claude transcript for `/pi:transfer` | supplied by Claude Code when available |

## Architecture

The companion starts one `pi --mode rpc` process per task or review. It sends protocol commands over stdin, consumes JSONL events from stdout, records progress, waits for the authoritative `agent_settled` event, and then requests the final assistant text and session path. Background work runs through a detached Node worker whose PID can be cancelled through `/pi:cancel`.

The companion itself never accepts an API key as a command argument, writes one to plugin state, or adds one to rendered output.

## Development

```bash
npm test
npm run build
npm run check-version
```

Tests use a fake Pi RPC executable; they do not call a real model or require provider credentials.

## License and attribution

Apache-2.0. The original plugin is Copyright OpenAI. Modifications for the Pi runtime are Copyright cuongducle. See [NOTICE](plugins/pi/NOTICE).
