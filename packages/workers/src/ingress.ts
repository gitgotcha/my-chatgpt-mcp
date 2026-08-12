import { parseSyncEvent } from "@reliable-drive-sync/protocol/event";
import type { JobRepository } from "./db.js";

export type WorkerEnvironment = { INGRESS_SHARED_SECRET: string };

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

export function createIngressHandler(env: WorkerEnvironment, repository: JobRepository) {
  return async (request: Request): Promise<Response> => {
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
        return json({ jobId: job.jobId, state: job.state }, 202);
      } catch (error) {
        if (error instanceof TypeError) return json({ error: "Invalid sync event" }, 400);
        return json({ error: "Unable to accept sync event" }, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/notices") {
      const denied = authorizationFailure(request, env);
      if (denied) return denied;
      const userId = url.searchParams.get("userId");
      if (!userId) return json({ error: "userId is required" }, 400);
      const notices = await repository.listOpenNotices(userId);
      return json({ notices: notices.map(({ id, category, message }) => ({ id, category, message })) }, 200);
    }

    return json({ error: "Not found" }, 404);
  };
}
