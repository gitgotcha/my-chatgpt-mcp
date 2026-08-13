import { describe, expect, it } from "vitest";
import { artifactObjectKey, parseArtifactSubmission, sha256Hex } from "../src/artifact.js";

const bytes = new TextEncoder().encode('{"answer":"ok"}');
const base64 = btoa(String.fromCharCode(...bytes));
const checksum = await sha256Hex(bytes);
const valid = {
  schemaVersion: "1",
  artifactId: "artifact-001",
  artifactKey: "candidate-001:interview:MOCK-001:session:v1",
  candidateId: "candidate-001",
  sourceSkill: "interview",
  sessionId: "MOCK-001",
  artifactType: "session",
  fileName: "session.json",
  contentType: "application/json",
  contentBase64: base64,
  sha256: checksum,
  createdAt: "2026-08-13T00:00:00.000Z"
};

describe("parseArtifactSubmission", () => {
  it("accepts verified immutable interview artifacts and derives a stable R2 key", async () => {
    const parsed = await parseArtifactSubmission(valid);
    expect(parsed.bytes).toEqual(bytes);
    expect(artifactObjectKey(parsed)).toBe(`interview/candidate-001/MOCK-001/${checksum}-session.json`);
  });

  it.each([
    ["checksum mismatch", { sha256: "0".repeat(64) }],
    ["unsafe candidate", { candidateId: "../unsafe" }],
    ["unsupported MIME", { contentType: "application/pdf" }],
    ["filename path", { fileName: "nested/session.json" }],
  ])("rejects %s", async (_label, change) => {
    await expect(parseArtifactSubmission({ ...valid, ...change })).rejects.toThrow();
  });

  it("rejects decoded artifacts larger than one MiB before persistence", async () => {
    const hugeBase64 = "A".repeat(4 * Math.ceil((1024 * 1024 + 1) / 3));
    await expect(parseArtifactSubmission({ ...valid, contentBase64: hugeBase64, sha256: checksum })).rejects.toThrow(/1 MiB/i);
  });
});
