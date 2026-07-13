import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "pi");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("plugin exposes the complete Pi command surface", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);

  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(marketplace.name, "pi-plugin");
  assert.equal(marketplace.plugins[0].name, "pi");
  assert.equal(marketplace.plugins[0].source, "./plugins/pi");
});

test("review commands are read-only and support provider/model selection", () => {
  for (const command of ["review", "adversarial-review"]) {
    const source = read(`commands/${command}.md`);
    assert.match(source, /review-only/i);
    assert.match(source, /Do not fix issues/i);
    assert.match(source, /Return the command stdout verbatim/i);
    assert.match(source, /--model provider\/model/);
    assert.match(source, /pi-companion\.mjs/);
    assert.match(source, /run_in_background:\s*true/);
    assert.doesNotMatch(source, /codex-companion/i);
  }
});

test("rescue routes through the Pi subagent without recursive skill invocation", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/pi-rescue.md");
  const runtimeSkill = read("skills/pi-cli-runtime/SKILL.md");

  assert.match(rescue, /subagent_type: "pi:pi-rescue"/);
  assert.match(rescue, /do not call `Skill\(pi:pi-rescue\)`/i);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <provider\/model>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(agent, /Default to a write-capable Pi run/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(runtimeSkill, /invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /zai\/glm-5\.2/);
});

test("setup installs earendil-works Pi and never recommends project-local credentials", () => {
  const setup = read("commands/setup.md");
  assert.match(setup, /@earendil-works\/pi-coding-agent/);
  assert.match(setup, /ZAI_API_KEY/);
  assert.match(setup, /zai\/glm-5\.2/);
  assert.match(setup, /Never ask the user to paste an API key into a tracked project file/i);
  assert.doesNotMatch(setup, /@openai\/codex/);
});

test("repository contains no user-facing Codex command namespace", () => {
  const files = [
    ...fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).map((name) => path.join(PLUGIN_ROOT, "commands", name)),
    path.join(PLUGIN_ROOT, "agents", "pi-rescue.md"),
    path.join(ROOT, "README.md")
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\/codex:/i, file);
    assert.doesNotMatch(source, /codex-companion\.mjs/i, file);
  }
});

test("session hooks expose transcript metadata without restoring the Codex stop gate", () => {
  const hooks = read("hooks/hooks.json");
  assert.match(hooks, /SessionStart/);
  assert.match(hooks, /SessionEnd/);
  assert.match(hooks, /session-lifecycle-hook\.mjs/);
  assert.doesNotMatch(hooks, /"Stop"/);
  assert.doesNotMatch(hooks, /review-gate/i);
});
