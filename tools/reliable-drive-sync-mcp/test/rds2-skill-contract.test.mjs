import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../../../my-chatgpt-skills/", import.meta.url);
const local = (name) => new URL(`../${name}`, import.meta.url);

async function text(url) {
  return readFile(url, "utf8");
}

test("T15 all four source skills use the single submit_event handoff", async () => {
  const algorithm = await text(new URL("algorithm-learning/SKILL.md", ROOT));
  const backend = await text(new URL("backend-project-learning/SKILL.md", ROOT));
  const interviewer = await text(new URL("conducting-java-backend-mock-interviews/SKILL.md", ROOT));
  const reviewer = await text(new URL("reviewing-java-backend-interviews/SKILL.md", ROOT));
  assert.match(algorithm, /submit_event/);
  assert.match(algorithm, /consulted/);
  assert.match(backend, /默认只读学习/);
  assert.match(interviewer, /submit_event/);
  assert.match(interviewer, /review_pending/);
  assert.match(reviewer, /submit_event/);
  assert.match(reviewer, /applyProfileChanges/);
});

test("T15 local README distinguishes D1 acceptance from asynchronous Drive archival", async () => {
  const readme = await text(local("README.md"));
  assert.match(readme, /\/v2\/query/);
  assert.match(readme, /cloud_accepted/);
  assert.match(readme, /Drive.*pending|pending.*Drive/s);
  assert.doesNotMatch(readme, /cloud_accepted[^\n]*Drive.*(完成|已同步)/);
});

test("T15 the only exposed MCP tool remains submit_event", async () => {
  const bridge = await text(local("stdio-bridge.mjs"));
  assert.match(bridge, /name: "submit_event"/);
  assert.doesNotMatch(bridge, /tools:\s*\[[^\]]*query/i);
});
