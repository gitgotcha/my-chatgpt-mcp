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
  const backend = await text(new URL("software-project-learning/SKILL.md", ROOT));
  const interviewer = await text(new URL("conducting-java-backend-mock-interviews/SKILL.md", ROOT));
  const reviewer = await text(new URL("reviewing-java-backend-interviews/SKILL.md", ROOT));
  assert.match(algorithm, /submit_event/);
  assert.match(algorithm, /consulted/);
  assert.match(backend, /默认只读|项目学习模式/);
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

test("T15 source skills keep evidence and incomplete-state guardrails", async () => {
  const algorithm = await text(new URL("algorithm-learning/SKILL.md", ROOT));
  const backend = await text(new URL("software-project-learning/SKILL.md", ROOT));
  const interviewer = await text(new URL("conducting-java-backend-mock-interviews/SKILL.md", ROOT));
  const reviewer = await text(new URL("reviewing-java-backend-interviews/SKILL.md", ROOT));

  assert.match(algorithm, /没有掌握度证据时记录中性的 `consulted`/);
  assert.match(algorithm, /未完成题在下一日优先/);
  assert.match(interviewer, /账户授权失败时[\s\S]*不绕过授权继续读取历史/);
  assert.match(backend, /默认只读|项目学习模式/);
  assert.match(backend, /源码事实/);
  assert.match(interviewer, /一次只问一道主问题/);
  assert.match(interviewer, /原回答永远不被事后改写/);
  assert.match(reviewer, /applyProfileChanges: false/);
  assert.match(reviewer, /reviewVersion/);
  assert.match(algorithm, /Skill 不直接读写 Drive/);
  assert.match(interviewer, /不直接访问 Google Drive、D1、R2 或云端 HTTP/);
  assert.match(reviewer, /本地报告只保留为本地派生输出/);
});
