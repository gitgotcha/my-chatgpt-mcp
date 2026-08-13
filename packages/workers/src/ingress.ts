import { parseSyncEvent } from "@reliable-drive-sync/protocol/event";
import { parseArtifactSubmission } from "@reliable-drive-sync/protocol/artifact";
import type { JobRepository } from "./db.js";
import type { D1ArtifactRepository } from "./artifact-jobs.js";

export type WorkerEnvironment = { INGRESS_SHARED_SECRET: string };
export type WaitUntilContext = { waitUntil(work: Promise<unknown>): void };
export type ImmediateDispatcher = { dispatch(jobId: string): Promise<void> };

const encoder = new TextEncoder();

/** Compares all bytes up to the longest input; equal-length inputs have no early mismatch exit. */
export function secureEquals(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function authorizationFailure(request: Request, env: WorkerEnvironment): Response | null {
  if (!env.INGRESS_SHARED_SECRET) return json({ error: "Service unavailable" }, 503);
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
  const token = header.slice("Bearer ".length);
  if (!secureEquals(token, env.INGRESS_SHARED_SECRET)) return json({ error: "Forbidden" }, 403);
  return null;
}

export function createIngressHandler(env: WorkerEnvironment, repository: JobRepository, dispatcher?: ImmediateDispatcher, artifacts?: { repository: D1ArtifactRepository; dispatcher: ImmediateDispatcher }) {
  return async (request: Request, context?: WaitUntilContext): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/jobs") {
      const denied = authorizationFailure(request, env);
      if (denied) return denied;
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      try {
        const event = parseSyncEvent(body);
        const job = await repository.createOrGet(event);
        if (job.isNew && dispatcher && context) context.waitUntil(dispatcher.dispatch(job.jobId));
        return json({ jobId: job.jobId, state: job.state }, 202);
      } catch (error) {
        if (error instanceof TypeError) return json({ error: "Invalid sync event" }, 400);
        return json({ error: "Unable to accept sync event" }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/artifacts") {
      const denied = authorizationFailure(request, env);
      if (denied) return denied;
      if (!artifacts) return json({ error: "Artifact staging unavailable" }, 503);
      try {
        const artifact = await parseArtifactSubmission(await request.json());
        const job = await artifacts.repository.createOrGet(artifact);
        if (job === "conflict") return json({ error: "Artifact key conflicts with existing content" }, 409);
        if (job.isNew && context) context.waitUntil(artifacts.dispatcher.dispatch(job.jobId));
        return json({ jobId: job.jobId, state: job.state }, 202);
      } catch (error) {
        if (error instanceof TypeError) return json({ error: "Invalid artifact submission" }, 400);
        return json({ error: "Unable to accept artifact" }, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/notices") {
      const denied = authorizationFailure(request, env);
      if (denied) return denied;
      const userId = url.searchParams.get("userId");
      if (!userId) return json({ error: "userId is required" }, 400);
      const notices = await repository.consumeOpenNotices(userId, new Date());
      return json({ notices: notices.map(({ id, category, message }) => ({ id, category, message })) }, 200);
    }

    if (request.method === "GET" && url.pathname === "/v1/candidates") {
      const denied = authorizationFailure(request, env); if (denied) return denied;
      if (!artifacts) return json({ error: "Candidate API unavailable" }, 503);
      const query = url.searchParams.get("query")?.toLowerCase();
      const candidates = await artifacts.repository.listCandidates();
      return json({ candidates: candidates.filter((candidate) => !query || candidate.candidateId.toLowerCase().includes(query) || candidate.displayName?.toLowerCase().includes(query)) }, 200);
    }
    const candidateMatch = url.pathname.match(/^\/v1\/candidates\/([A-Za-z0-9_-]{1,64})\/context$/);
    if (request.method === "GET" && candidateMatch) {
      const denied = authorizationFailure(request, env); if (denied) return denied;
      if (!artifacts) return json({ error: "Candidate API unavailable" }, 503);
      const candidate = await artifacts.repository.getCandidate(candidateMatch[1]);
      return candidate ? json(candidate, 200) : json({ error: "Candidate not found" }, 404);
    }
    const artifactMatch = url.pathname.match(/^\/v1\/artifacts\/([^/]+)$/);
    if (request.method === "GET" && artifactMatch) {
      const denied = authorizationFailure(request, env); if (denied) return denied;
      const candidateId = url.searchParams.get("candidateId"); if (!candidateId || !artifacts) return json({ error: "Artifact API unavailable" }, 503);
      const artifact = await artifacts.repository.artifactForRead(candidateId, decodeURIComponent(artifactMatch[1]));
      if (!artifact) return json({ error: "Artifact not found" }, 404);
      if (artifact.contentType === "application/json" || artifact.contentType === "text/markdown") { const bytes = await artifacts.repository.loadContentForRead(candidateId, decodeURIComponent(artifactMatch[1])); if (!bytes) return json({ error: "Artifact content not found" }, 503); return json({ content: new TextDecoder().decode(bytes), contentType: artifact.contentType, fileName: artifact.fileName }, 200); }
      return json({ error: "Binary artifacts are not readable through MCP" }, 415);
    }

    return json({ error: "Not found" }, 404);
  };
}
