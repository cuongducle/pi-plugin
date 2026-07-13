import test from "node:test";
import assert from "node:assert/strict";

import { binaryAvailable, terminateProcessTree } from "../plugins/pi/scripts/lib/process.mjs";

test("binaryAvailable returns captured probe output", () => {
  const status = binaryAvailable(process.execPath, ["-v"]);
  assert.equal(status.available, true);
  assert.match(status.stdout, /^v\d+/);
  assert.equal(status.status, 0);
});

test("binaryAvailable reports a missing binary without throwing", () => {
  const status = binaryAvailable("definitely-not-a-real-pi-test-binary", ["-v"]);
  assert.equal(status.available, false);
  assert.match(status.detail, /not found on PATH/i);
});

test("terminateProcessTree ignores invalid process identifiers", () => {
  assert.doesNotThrow(() => terminateProcessTree(Number.NaN));
});
