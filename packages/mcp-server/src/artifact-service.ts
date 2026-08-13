import { parseArtifactSubmission, type ArtifactSubmission } from "@reliable-drive-sync/protocol/artifact";
import { LocalArtifactOutbox, type StoredArtifact } from "./artifact-outbox.js";

export type ArtifactIngressResponse = { status: number; body: unknown };
export interface ArtifactIngressTransport { send(artifact: ArtifactSubmission, signal: AbortSignal): Promise<ArtifactIngressResponse>; }
export type ArtifactSubmitResult = { accepted: boolean; artifactKey: string; deliveryState: "cloud_accepted" | "pending" };

export class ArtifactSubmitService {
  constructor(private readonly outbox: LocalArtifactOutbox, private readonly transport: ArtifactIngressTransport, private readonly timeoutMs = 2_000) {}
  async submit(input: unknown): Promise<ArtifactSubmitResult> {
    const artifact = await parseArtifactSubmission(input); this.outbox.enqueue(artifact);
    const accepted = await this.deliver(artifact);
    return { accepted, artifactKey: artifact.artifactKey, deliveryState: accepted ? "cloud_accepted" : "pending" };
  }
  async flushPending(limit = 20): Promise<void> {
    for (const record of this.outbox.listPendingRaw().slice(0, limit)) await this.deliver(await parseArtifactSubmission(record.artifact));
  }
  private async deliver(artifact: ArtifactSubmission): Promise<boolean> {
    this.outbox.markSending(artifact.artifactKey); const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.transport.send(artifact, controller.signal),
        new Promise<ArtifactIngressResponse>((resolve) => { timeout = setTimeout(() => { controller.abort(); resolve({ status: 408, body: null }); }, this.timeoutMs); })
      ]);
      const jobId = response.status === 202 && typeof response.body === "object" && response.body !== null && typeof (response.body as { jobId?: unknown }).jobId === "string" ? (response.body as { jobId: string }).jobId : null;
      if (jobId) return this.outbox.acknowledge(artifact.artifactKey, jobId);
      this.outbox.markPending(artifact.artifactKey, `artifact_ingress_${response.status}`);
    } catch { this.outbox.markPending(artifact.artifactKey, "artifact_ingress_transport_error"); }
    finally { if (timeout) clearTimeout(timeout); }
    return false;
  }
}

export type CandidateApi = {
  listCandidates(query?: string, limit?: number): Promise<unknown>;
  getCandidateContext(candidateId: string, selectedDomain?: string, resumeId?: string, sessionId?: string): Promise<unknown>;
  readArtifact(candidateId: string, artifactKey: string): Promise<unknown>;
};
