import assert from "node:assert/strict";
import test from "node:test";
import { rebuildInterviewProfile } from "../src/profile-model.js";

const identity = { userId: "00000000-0000-4000-8000-000000000001", username: "Ada" };
const sessionEvent = { schemaVersion: "1.2", eventId: "11111111-1111-4111-8111-111111111111", eventKey: "session", eventType: "interview.session.completed", ...identity, sessionId: "MOCK-1" };
const approvedReview = {
  schemaVersion: "1.2", eventId: "22222222-2222-4222-8222-222222222222", eventKey: "review-1", eventType: "interview.review.completed", ...identity,
  sessionId: "MOCK-1", reviewVersion: 1, applyProfileChanges: true, completedAt: "2026-08-14T10:00:00.000Z",
  profileChanges: [{ domain: "java_backend", weaknessId: "W-001", status: "failed", evidenceRef: "q1" }]
};

test("session events, pending reviews, and narrative do not change profile", () => {
  const snapshot = rebuildInterviewProfile([
    sessionEvent,
    { ...approvedReview, applyProfileChanges: false },
    { ...approvedReview, eventId: "33333333-3333-4333-8333-333333333333", eventKey: "review-2", profileChanges: [], narrative: "擅长所有并发问题" }
  ]);
  assert.deepEqual(snapshot.domainProfiles, {});
});

test("a weakness closes after two sessions and two variants pass", () => {
  const failed = { ...approvedReview, sessionId: "MOCK-1" };
  const passedA = { ...approvedReview, eventId: "33333333-3333-4333-8333-333333333333", eventKey: "review-2", sessionId: "MOCK-2", reviewVersion: 1, completedAt: "2026-08-15T10:00:00.000Z", profileChanges: [{ domain: "java_backend", weaknessId: "W-001", status: "passed", variantId: "scenario-a" }] };
  const sameA = { ...passedA, eventId: "44444444-4444-4444-8444-444444444444", eventKey: "review-3", sessionId: "MOCK-3", completedAt: "2026-08-16T10:00:00.000Z" };
  const passedB = { ...passedA, eventId: "55555555-5555-4555-8555-555555555555", eventKey: "review-4", sessionId: "MOCK-4", completedAt: "2026-08-17T10:00:00.000Z", profileChanges: [{ domain: "java_backend", weaknessId: "W-001", status: "passed", variantId: "scenario-b" }] };
  const snapshot = rebuildInterviewProfile([failed, passedA, sameA, passedB]);
  assert.equal(snapshot.domainProfiles.java_backend.weaknesses["W-001"].status, "closed");
  assert.deepEqual(snapshot.domainProfiles.java_backend.weaknesses["W-001"].passingVariantIds.sort(), ["scenario-a", "scenario-b"]);
});

test("a higher review version replaces an earlier review for the same session", () => {
  const corrected = { ...approvedReview, eventId: "33333333-3333-4333-8333-333333333333", eventKey: "review:v2", reviewVersion: 2, profileChanges: [] };
  const snapshot = rebuildInterviewProfile([approvedReview, corrected]);
  assert.deepEqual(snapshot.domainProfiles, {});
  assert.deepEqual(snapshot.sourceEventKeys, ["review:v2"]);
});

