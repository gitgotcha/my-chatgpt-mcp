import { describe, expect, it } from "vitest";
import { ArtifactSubmitService, type ArtifactIngressTransport } from "../src/artifact-service.js";
import { LocalArtifactOutbox } from "../src/artifact-outbox.js";
import { parseArtifactSubmission, sha256Hex } from "@reliable-drive-sync/protocol/artifact";

const bytes = new TextEncoder().encode('{"session":"ok"}');
const valid = async () => ({
  schemaVersion: "1", artifactId: "artifact-1", artifactKey: "candidate-001:interview:MOCK-001:session:v1",
  candidateId: "candidate-001", sourceSkill: "interview", sessionId: "MOCK-001", artifactType: "session",
  fileName: "session.json", contentType: "application/json", contentBase64: btoa(String.fromCharCode(...bytes)), sha256: await sha256Hex(bytes), createdAt: "2026-08-13T00:00:00.000Z"
});
function artifactOutbox() { return new LocalArtifactOutbox(":memory:"); }

describe("ArtifactSubmitService", () => {
  it("persists before sending and acknowledges only a 202 response", async () => {
    const outbox = artifactOutbox(); let pendingAtSend = false;
    const transport: ArtifactIngressTransport = { send: async (artifact) => { pendingAtSend = outbox.hasArtifact(artifact.artifactKey); return { status: 202, body: { jobId: "job-1" } }; } };
    const result = await new ArtifactSubmitService(outbox, transport).submit(await valid());
    expect(pendingAtSend).toBe(true); expect(result.deliveryState).toBe("cloud_accepted"); expect(outbox.listPendingRaw()).toEqual([]);
  });

  it("keeps a rejected artifact pending and restores interrupted sends", async () => {
    const outbox = artifactOutbox(); const artifact = await valid(); outbox.enqueue(await parseArtifactSubmission(artifact)); outbox.markSending(artifact.artifactKey);
    const transport: ArtifactIngressTransport = { send: async () => ({ status: 503, body: {} }) };
    const restarted = new LocalArtifactOutbox(outbox.filename);
    const result = await new ArtifactSubmitService(restarted, transport).submit(artifact);
    expect(result.deliveryState).toBe("pending"); expect(restarted.listPendingRaw()).toHaveLength(1);
  });
});
