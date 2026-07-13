import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult } from "../plugins/pi/scripts/lib/render.mjs";

test("renderReviewResult renders structured Pi findings", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "needs-attention",
        summary: "One issue.",
        findings: [{ severity: "high", title: "Guard missing", body: "Empty input fails.", file: "src/app.js", line_start: 4 }],
        next_steps: ["Add a regression test."]
      },
      rawOutput: "",
      parseError: null
    },
    { reviewLabel: "Adversarial Review", targetLabel: "working tree diff" }
  );

  assert.match(output, /^# Pi Adversarial Review/);
  assert.match(output, /\[high\] Guard missing \(src\/app\.js:4\)/);
  assert.match(output, /Add a regression test/);
});

test("renderReviewResult preserves invalid raw output for diagnosis", () => {
  const output = renderReviewResult(
    { parsed: null, rawOutput: "not json", parseError: "invalid JSON" },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );
  assert.match(output, /Pi did not return valid structured JSON/);
  assert.match(output, /not json/);
});

test("renderStoredJobResult appends a resumable Pi session command", () => {
  const output = renderStoredJobResult(
    { id: "task-123", status: "completed", title: "Pi Task", threadId: "/tmp/pi-session.jsonl" },
    { threadId: "/tmp/pi-session.jsonl", rendered: "Implemented the fix.\n", result: { rawOutput: "Implemented the fix." } }
  );
  assert.match(output, /^Implemented the fix\./);
  assert.match(output, /Pi session ID: \/tmp\/pi-session\.jsonl/);
  assert.match(output, /pi --session \/tmp\/pi-session\.jsonl/);
});
