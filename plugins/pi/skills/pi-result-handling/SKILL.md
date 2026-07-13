---
name: pi-result-handling
description: How the main Claude Code thread should treat the output returned by the pi rescue subagent and /pi:result
user-invocable: false
---

# Pi Result Handling

When the `pi:pi-rescue` subagent or `/pi:result` returns output:

- Do not turn a failed or incomplete Pi run into a Claude-side implementation attempt.
- If Pi returned a concrete fix, present it. Do not silently re-implement it yourself.
- If Pi was never successfully invoked (e.g. setup failure, auth error), do not generate a substitute answer at all — surface the error and tell the user to run `/pi:setup`.
- If the output is empty but the job completed, check `/pi:status <job-id>` and the job log before assuming success.
- For review results, present the structured findings (verdict, findings, next steps) as-is. Do not filter or soften them.
