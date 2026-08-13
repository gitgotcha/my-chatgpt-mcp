import { artifactObjectKey, type ArtifactSubmission } from "@reliable-drive-sync/protocol/artifact";
import { verifyQStashSignature, type SyncEnvironment } from "./sync.js";
import { QStashPublishError, type QStashPublisher } from "./qstash.js";
import { D1ArtifactRepository } from "./artifact-jobs.js";

export interface R2Object { arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } }
export interface R2Bucket { put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>; get(key: string): Promise<R2Object | null>; }
export type ArtifactDestination = { syncArtifact(artifact: ArtifactSubmission, bytes: Uint8Array): Promise<{ kind: "success" } | { kind: "retryable"; code: string } | { kind: "permanent"; code: string }> };
type Envelope = { kind: "artifact"; jobId: string; artifactKey: string; candidateId: string };
const envelope = (value: unknown): value is Envelope => typeof value === "object" && value !== null && (value as Record<string, unknown>).kind === "artifact" && typeof (value as Record<string, unknown>).jobId === "string" && typeof (value as Record<string, unknown>).artifactKey === "string" && typeof (value as Record<string, unknown>).candidateId === "string";
const response = (status: number, headers?: HeadersInit) => new Response(null, { status, headers });

export class ArtifactDispatcher {
  constructor(private readonly repository: D1ArtifactRepository, private readonly publisher: QStashPublisher, private readonly env: { QSTASH_TOKEN?: string; SYNC_WORKER_URL?: string; QSTASH_FAILURE_CALLBACK_URL?: string }) {}
  async dispatch(jobId: string): Promise<void> {
    const owner = crypto.randomUUID(); const claimed = await this.repository.claimDispatch(jobId, owner, new Date(Date.now() + 300_000)); if (!claimed) return;
    if (!this.env.QSTASH_TOKEN || !this.env.SYNC_WORKER_URL || !this.env.QSTASH_FAILURE_CALLBACK_URL) return this.repository.releaseDispatch(jobId, owner, "qstash_config_missing");
    try { const ack = await this.publisher.publish({ targetUrl: this.env.SYNC_WORKER_URL, failureCallbackUrl: this.env.QSTASH_FAILURE_CALLBACK_URL, job: { kind: "artifact", jobId: claimed.jobId, artifactKey: claimed.artifactKey, candidateId: claimed.candidateId } }); const messageId = typeof (ack as { messageId?: unknown })?.messageId === "string" ? (ack as { messageId: string }).messageId : null; if (!messageId || !(await this.repository.markQueued(jobId, owner, messageId))) return; }
    catch (error) { await this.repository.releaseDispatch(jobId, owner, error instanceof QStashPublishError ? `qstash_publish_http_${error.status}` : "qstash_publish_failed"); }
  }
}

/** R2 is the durable binary hand-off. The signed QStash body contains only immutable identifiers. */
export function createArtifactSyncHandler(env: SyncEnvironment, repository: D1ArtifactRepository, bucket: R2Bucket | undefined, destination: ArtifactDestination) {
  return async (request: Request): Promise<Response> => {
    const raw = await request.text(); const valid = await verifyQStashSignature(request.headers.get("Upstash-Signature"), raw, env.SYNC_WORKER_URL, [env.QSTASH_CURRENT_SIGNING_KEY ?? "", env.QSTASH_NEXT_SIGNING_KEY ?? ""]);
    if (!valid) return response(489, { "Upstash-NonRetryable-Error": "true" });
    let message: unknown; try { message = JSON.parse(raw); } catch { return response(489, { "Upstash-NonRetryable-Error": "true" }); }
    if (!envelope(message)) return response(489, { "Upstash-NonRetryable-Error": "true" });
    const stored = await repository.load(message.jobId); if (!stored || stored.artifactKey !== message.artifactKey || stored.candidateId !== message.candidateId) return response(489, { "Upstash-NonRetryable-Error": "true" });
    const owner = crypto.randomUUID(); const claimed = await repository.claimSync(stored.jobId, owner, new Date(Date.now() + 300_000));
    if (!claimed) { const state = await repository.state(stored.jobId); return state === "synced" ? response(204) : state === "needs_attention" ? response(489, { "Upstash-NonRetryable-Error": "true" }) : response(503); }
    if (!bucket) { await repository.releaseSync(stored.jobId, owner, "r2_configuration_unavailable"); return response(503); }
    const object = await bucket.get(artifactObjectKey(stored.artifact)); if (!object) { await repository.seal(stored.jobId, owner, "artifact_staging_missing"); return response(489, { "Upstash-NonRetryable-Error": "true" }); }
    const bytes = new Uint8Array(await object.arrayBuffer()); const outcome = await destination.syncArtifact(stored.artifact, bytes);
    if (outcome.kind === "success") return (await repository.markSynced(stored.jobId, owner)) ? response(204) : response(503);
    if (outcome.kind === "retryable") { await repository.releaseSync(stored.jobId, owner, outcome.code); return response(503); }
    await repository.seal(stored.jobId, owner, outcome.code); return response(489, { "Upstash-NonRetryable-Error": "true" });
  };
}
