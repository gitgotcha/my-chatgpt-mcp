import assert from "node:assert/strict";
import test from "node:test";
import { rebuildAlgorithmProfile } from "../src/algorithm-profile-model.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";

function learningEvent(overrides = {}) {
  return {
    schemaVersion: "1.2",
    eventId: "10000000-0000-4000-8000-000000000001",
    eventKey: `${USER_ID}:qa:two-sum:2026-08-14T10:00:00.000Z`,
    eventType: "algorithm.learning.completed",
    userId: USER_ID,
    username: "Ada",
    observedAt: "2026-08-14T10:00:00.000Z",
    source: "qa",
    topic: "双指针",
    problem: { title: "两数之和", source: "Hot100", url: "" },
    evidence: "用户请求讲解两数之和。",
    outcome: "consulted",
    tags: ["hash-map"],
    confidence: "medium",
    ...overrides
  };
}

test("an empty event set produces an empty profile", () => {
  const profile = rebuildAlgorithmProfile([]);
  assert.equal(profile.headEventId, null);
  assert.deepEqual(profile.sourceEventKeys, []);
  assert.equal(profile.currentTopic, null);
  assert.deepEqual(profile.topicMastery, {});
  assert.deepEqual(profile.weaknesses, []);
  assert.deepEqual(profile.pendingProblemIds, []);
});

test("only verified learning events feed the profile", () => {
  const profile = rebuildAlgorithmProfile([
    learningEvent({ eventId: "10000000-0000-4000-8000-000000000001", eventKey: "k1", outcome: "incorrect" }),
    { ...learningEvent(), eventType: "interview.session.completed", eventKey: "k2" },
    { ...learningEvent(), schemaVersion: "1.1", eventKey: "k3" },
    null
  ]);
  assert.deepEqual(profile.sourceEventKeys, ["k1"]);
});

test("duplicate event keys keep the earliest verified event", () => {
  const profile = rebuildAlgorithmProfile([
    learningEvent({ eventId: "10000000-0000-4000-8000-000000000001", eventKey: "k1", outcome: "incorrect", observedAt: "2026-08-14T10:00:00.000Z" }),
    learningEvent({ eventId: "10000000-0000-4000-8000-000000000002", eventKey: "k1", outcome: "correct", observedAt: "2026-08-14T11:00:00.000Z" })
  ]);
  assert.equal(profile.topicMastery["双指针"].negative, 1);
  assert.equal(profile.topicMastery["双指针"].positive, 0);
});

test("a neutral consulted outcome never creates a weakness", () => {
  const profile = rebuildAlgorithmProfile([
    learningEvent({ eventKey: "k1", outcome: "consulted" })
  ]);
  assert.deepEqual(profile.weaknesses, []);
  assert.equal(profile.topicMastery["双指针"].neutral, 1);
  assert.deepEqual(profile.pendingProblemIds, ["Hot100:两数之和"]);
});

test("negative outcomes create weaknesses and improving ones are marked", () => {
  const profile = rebuildAlgorithmProfile([
    learningEvent({ eventKey: "k1", eventId: "10000000-0000-4000-8000-000000000001", outcome: "incorrect", observedAt: "2026-08-14T10:00:00.000Z" }),
    learningEvent({ eventKey: "k2", eventId: "10000000-0000-4000-8000-000000000002", outcome: "correct", observedAt: "2026-08-14T11:00:00.000Z" })
  ]);
  assert.equal(profile.weaknesses.length, 1);
  assert.equal(profile.weaknesses[0].topic, "双指针");
  assert.equal(profile.weaknesses[0].status, "improving");
  assert.equal(profile.weaknesses[0].negative, 1);
  assert.equal(profile.weaknesses[0].positive, 1);
});

test("a problem stays pending until its latest outcome is positive", () => {
  const pending = rebuildAlgorithmProfile([
    learningEvent({ eventKey: "k1", eventId: "10000000-0000-4000-8000-000000000001", outcome: "incorrect", observedAt: "2026-08-14T10:00:00.000Z" })
  ]);
  assert.deepEqual(pending.pendingProblemIds, ["Hot100:两数之和"]);

  const resolved = rebuildAlgorithmProfile([
    learningEvent({ eventKey: "k1", eventId: "10000000-0000-4000-8000-000000000001", outcome: "incorrect", observedAt: "2026-08-14T10:00:00.000Z" }),
    learningEvent({ eventKey: "k2", eventId: "10000000-0000-4000-8000-000000000002", outcome: "completed", observedAt: "2026-08-14T11:00:00.000Z" })
  ]);
  assert.deepEqual(resolved.pendingProblemIds, []);
});

test("currentTopic and headEventId follow the latest verified event", () => {
  const profile = rebuildAlgorithmProfile([
    learningEvent({ eventKey: "k1", eventId: "10000000-0000-4000-8000-000000000001", topic: "双指针", observedAt: "2026-08-14T10:00:00.000Z" }),
    learningEvent({ eventKey: "k2", eventId: "10000000-0000-4000-8000-000000000002", topic: "动态规划", observedAt: "2026-08-14T11:00:00.000Z" })
  ]);
  assert.equal(profile.currentTopic, "动态规划");
  assert.equal(profile.headEventId, "10000000-0000-4000-8000-000000000002");
  assert.deepEqual(profile.sourceEventKeys, ["k1", "k2"]);
});

test("weaknesses are ordered by negative evidence count", () => {
  let index = 0;
  const event = (topic, outcome) => learningEvent({
    eventKey: `k${++index}`,
    eventId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    topic,
    outcome,
    observedAt: `2026-08-14T${String(10 + index).padStart(2, "0")}:00:00.000Z`
  });
  const profile = rebuildAlgorithmProfile([
    event("动态规划", "incorrect"),
    event("双指针", "incorrect"),
    event("双指针", "stuck"),
    event("图论", "incorrect")
  ]);
  assert.deepEqual(profile.weaknesses.map((weakness) => weakness.topic), ["双指针", "动态规划", "图论"]);
});

test("generatedAt comes from the supplied clock", () => {
  const profile = rebuildAlgorithmProfile([learningEvent()], { now: () => "2026-08-14T12:00:00.000Z" });
  assert.equal(profile.generatedAt, "2026-08-14T12:00:00.000Z");
});
