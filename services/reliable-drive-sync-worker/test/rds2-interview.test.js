import assert from "node:assert/strict";
import test from "node:test";
import { interviewReducer, reduceInterviewProfile } from "../src/rds2/projection/interview.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const IDENTITY = { userId: USER_ID, username: "乔炳源" };

const session = (sessionId, completedAt = "2026-09-01T09:00:00.000Z") => ({
  schemaVersion: "1.2",
  eventId: `${sessionId === "S-1" ? "10000000" : "20000000"}-0000-4000-8000-000000000001`,
  eventKey: `session:${sessionId}`,
  eventType: "interview.session.completed",
  userId: USER_ID,
  username: "乔炳源",
  sessionId,
  interviewType: "mock",
  domain: "java_backend",
  completedAt
});

let reviewCounter = 10;
function review(overrides = {}) {
  reviewCounter += 1;
  return {
    schemaVersion: "1.2",
    eventId: `30000000-0000-4000-8000-${String(reviewCounter).padStart(12, "0")}`,
    eventKey: `review:v${overrides.reviewVersion ?? 1}:${reviewCounter}`,
    eventType: "interview.review.completed",
    userId: USER_ID,
    username: "乔炳源",
    sessionId: "S-1",
    reviewVersion: 1,
    completedAt: "2026-09-01T10:00:00.000Z",
    sourceSessionEventId: session("S-1").eventId,
    applyProfileChanges: true,
    profileChanges: [{
      domain: "java_backend", weaknessId: "W-1", status: "failed",
      title: "并发控制", evidenceRefs: ["q-1"], evidenceConfidence: "high"
    }],
    ...overrides
  };
}

function reduce(events) {
  return reduceInterviewProfile(events);
}

test("T12 applyProfileChanges=false does not change capability state", () => {
  const result = reduce([review({ applyProfileChanges: false })]);
  assert.deepEqual(result.domainProfiles, {});
  assert.deepEqual(result.generalCompetencies, {});
});

test("T12 a higher reviewVersion replaces the old session contribution", () => {
  const first = review();
  const newer = review({
    reviewVersion: 2,
    eventKey: "review:v2:latest",
    completedAt: "2026-09-02T10:00:00.000Z",
    profileChanges: [{ domain: "java_backend", weaknessId: "W-1", status: "passed", variantId: "v-a", evidenceRefs: ["q-2"] }]
  });
  const profile = reduce([newer, first]);
  const weakness = profile.domainProfiles.java_backend.weaknesses["W-1"];
  assert.equal(weakness.status, "improving");
  assert.deepEqual(weakness.evidenceRefs, ["q-2"]);
  assert.equal(profile.headEventId, newer.eventId);
});

test("T12 an older review arriving later cannot overwrite the selected version", () => {
  const newer = review({ reviewVersion: 2, eventKey: "review:v2:selected", completedAt: "2026-09-02T10:00:00.000Z", profileChanges: [{ domain: "java_backend", weaknessId: "W-1", status: "passed", variantId: "v-a" }] });
  const older = review({ reviewVersion: 1, eventKey: "review:v1:late", completedAt: "2026-09-03T10:00:00.000Z" });
  const weakness = reduce([newer, older]).domainProfiles.java_backend.weaknesses["W-1"];
  assert.equal(weakness.status, "improving");
  assert.deepEqual(weakness.passingVariantIds, ["v-a"]);
});

test("T12 same-version ties use the V1 completedAt/eventId comparator", () => {
  const early = review({ eventKey: "review:v1:early", completedAt: "2026-09-01T10:00:00.000Z", profileChanges: [{ domain: "java_backend", weaknessId: "W-1", status: "failed", title: "旧" }] });
  const late = review({ eventKey: "review:v1:late", completedAt: "2026-09-01T11:00:00.000Z", profileChanges: [{ domain: "java_backend", weaknessId: "W-1", status: "passed", title: "新", variantId: "v-a" }] });
  const weakness = reduce([late, early]).domainProfiles.java_backend.weaknesses["W-1"];
  assert.equal(weakness.title, "新");
  assert.equal(weakness.status, "improving");
});

test("T12 two passing sessions with one variant do not close a weakness", () => {
  const first = review({ sessionId: "S-1", eventKey: "review:S-1:v1", profileChanges: [{ domain: "java_backend", weaknessId: "W-1", status: "passed", variantId: "v-a" }] });
  const second = review({ sessionId: "S-2", eventKey: "review:S-2:v1", sourceSessionEventId: session("S-2").eventId, profileChanges: [{ domain: "java_backend", weaknessId: "W-1", status: "passed", variantId: "v-a" }] });
  const weakness = reduce([session("S-2"), session("S-1"), second, first]).domainProfiles.java_backend.weaknesses["W-1"];
  assert.equal(weakness.status, "improving");
  assert.equal(weakness.passingSessionIds.length, 2);
  assert.equal(weakness.passingVariantIds.length, 1);
});

test("T12 replacing a review with an empty change set revokes the old contribution", () => {
  const first = review();
  const replacement = review({ reviewVersion: 2, eventKey: "review:v2:revoke", completedAt: "2026-09-02T10:00:00.000Z", profileChanges: [] });
  const profile = reduce([first, replacement]);
  assert.deepEqual(profile.domainProfiles, {});
});

test("T12 reducer declares session/review reads without unbounded history", () => {
  const plan = interviewReducer.planPageReads({ events: [session("S-1"), review()] });
  assert.deepEqual(plan.reads.map((item) => item.rowKind), ["session", "review"]);
  assert.ok(plan.reads.every((item) => Array.isArray(item.rowKeys) && item.rowKeys.length <= 2));
});

test("T12 buildPage persists selected review and contribution rows", () => {
  const current = review({ reviewVersion: 1, eventKey: "review:page:1" });
  const result = interviewReducer.buildPage({
    events: [session("S-1"), current],
    staged: { session: new Map(), review: new Map(), selected_review: new Map(), contribution: new Map() },
    continuation: { nextEventSeq: 1, page: 1 }
  });
  assert.equal(result.continuation.nextEventSeq, 3);
  assert.equal(result.summary.domainProfiles.java_backend.weaknesses["W-1"].status, "open");
  assert.ok(result.rowChanges.some((row) => row.rowKind === "selected_review"));
  assert.ok(result.rowChanges.some((row) => row.rowKind === "contribution"));
});

test("T12 a later review version replaces the selected contribution across pages", () => {
  const first = review({ reviewVersion: 1, eventKey: "review:page:1" });
  const firstPage = interviewReducer.buildPage({
    events: [first], staged: { session: new Map(), review: new Map(), selected_review: new Map(), contribution: new Map() },
    continuation: { nextEventSeq: 1, page: 1 }
  });
  const staged = { session: new Map(), review: new Map(), selected_review: new Map(), contribution: new Map() };
  for (const row of firstPage.rowChanges) {
    if (row.rowKind === "selected_review") staged.selected_review.set(row.rowKey, row.value);
    if (row.rowKind === "review") staged.review.set(row.rowKey, row.value);
  }
  const newer = review({ reviewVersion: 2, eventKey: "review:page:2", completedAt: "2026-09-02T10:00:00.000Z",
    profileChanges: [{ domain: "java_backend", weaknessId: "W-1", status: "passed", variantId: "v-a" }] });
  const second = interviewReducer.buildPage({
    events: [newer], staged,
    continuation: { ...firstPage.continuation, reviewEvents: [first] }
  });
  assert.equal(second.summary.domainProfiles.java_backend.weaknesses["W-1"].status, "improving");
  assert.deepEqual(second.summary.domainProfiles.java_backend.weaknesses["W-1"].evidenceRefs, []);
});
