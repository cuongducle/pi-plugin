---
name: pi-prompting
description: Internal guidance for composing Pi (GLM) prompts for coding, review, diagnosis, and research tasks inside the pi Claude Code plugin
user-invocable: false
---

# GLM Prompting

Use this skill when `pi:pi-rescue` needs to ask Pi (running GLM) for help.

## When to use which tool

- Use `task` when the task is diagnosis, planning, research, or implementation and you need to control the prompt more directly.
- The rescue subagent calls `task` exactly once. Use this skill only to shape the prompt before that single call.

## Prompt principles for GLM

GLM responds best to prompts that are:

- **Direct and concrete.** State the goal, the constraints, and the desired output format up front. Avoid long preambles.
- **Scoped.** One clear objective per task. If the user asked for several things, pick the highest-value one or split into follow-ups.
- **Explicit about verification.** Tell GLM how to confirm success (e.g. "run `npm test` and ensure it passes", "the build must be green").

## Common task templates

### Diagnosis

```
Investigate why <symptom>. Reproduce it, identify the root cause, and report:
1. The minimal reproduction
2. The root cause (file + line)
3. The smallest safe fix
Do not apply the fix yet; just report.
```

### Narrow fix

```
Apply the smallest safe patch that fixes <problem> in <file>.
Constraints:
- Do not refactor unrelated code.
- Run <verify command> and ensure it passes.
- Report exactly what you changed.
```

### Review

```
Review the following diff adversarially. For each finding, give the file, line range, severity, and a concrete recommendation.
Return only valid JSON matching the review schema.
<diff>
```

## Anti-patterns to avoid

- Do not bury the actual request under generic context ("You are a helpful assistant...").
- Do not ask GLM to "do whatever you think is best" — give it a concrete stopping condition.
- Do not concatenate multiple unrelated tasks into one prompt; the rescue subagent only calls `task` once, so pick the highest-value ask.
