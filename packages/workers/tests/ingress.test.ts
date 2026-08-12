import { describe, expect, test } from "vitest";
import { InMemoryJobRepository } from "../src/db.js";
import { createIngressHandler, secureEquals, type WorkerEnvironment } from "../src/ingress.js";

const sharedSecret = "a-very-secret-test-value";

function event(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1",
    eventId: "evt-123",
    eventKey: "qiaobingyuan:algorithm:evt-123",
    type: "algorithm.completed",
    userId: "qiaobingyuan",
    sourceSkill: "algorithm-learning",
    destination: "drive",
    createdAt: "2026-08-12T08:00:00.000Z",
    payload: { problem: "three-sum" },
    ...overrides
  };
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://worker.example${path}`, init);
}

function fixture() {
  const repository = new InMemoryJobRepository(() => "job-opaque-1");
  const env: WorkerEnvironment = { INGRESS_SHARED_SECRET: sharedSecret };
  return { repository, handler: createIngressHandler(env, repository) };
}

describe("cloud ingress", () => {
  test("rejects a missing bearer token", async () => {
    const { handler } = fixture();
    const response = await handler(request("/v1/jobs", {
      method: "POST",
      body: JSON.stringify(event())
    }));

    expect(response.status).toBe(401);
  });

  test("rejects an incorrect bearer token", async () => {
    const { handler } = fixture();
    const response = await handler(request("/v1/jobs", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
      body: JSON.stringify(event())
    }));

    expect(response.status).toBe(403);
  });

  test("fails closed when the ingress secret is missing or empty", async () => {
    const emptyRepository = new InMemoryJobRepository(() => "must-not-create");
    const missingRepository = new InMemoryJobRepository(() => "must-not-create");
    const emptyHandler = createIngressHandler({ INGRESS_SHARED_SECRET: "" }, emptyRepository);
    const missingHandler = createIngressHandler({} as WorkerEnvironment, missingRepository);
    const requestWithEmptyBearer = request("/v1/jobs", {
      method: "POST",
      headers: { authorization: "Bearer " },
      body: JSON.stringify(event())
    });

    const emptyResponse = await emptyHandler(requestWithEmptyBearer);
    const missingResponse = await missingHandler(requestWithEmptyBearer);

    expect(emptyResponse.status).toBe(503);
    await expect(emptyResponse.json()).resolves.toEqual({ error: "Service unavailable" });
    expect(missingResponse.status).toBe(503);
    expect(emptyRepository.jobCount).toBe(0);
    expect(missingRepository.jobCount).toBe(0);
  });

  test("rejects an event that fails shared protocol validation", async () => {
    const { handler } = fixture();
    const response = await handler(request("/v1/jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${sharedSecret}` },
      body: JSON.stringify(event({ destination: "email" }))
    }));

    expect(response.status).toBe(400);
  });

  test("accepts a valid event as dispatch_pending", async () => {
    const { handler } = fixture();
    const response = await handler(request("/v1/jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${sharedSecret}` },
      body: JSON.stringify(event())
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ jobId: "job-opaque-1", state: "dispatch_pending" });
  });

  test("returns the original job for a duplicate event key", async () => {
    const { handler, repository } = fixture();
    const init: RequestInit = {
      method: "POST",
      headers: { authorization: `Bearer ${sharedSecret}` },
      body: JSON.stringify(event())
    };

    const first = await handler(request("/v1/jobs", init));
    const duplicate = await handler(request("/v1/jobs", init));

    expect(first.status).toBe(202);
    await expect(duplicate.json()).resolves.toEqual({ jobId: "job-opaque-1", state: "dispatch_pending" });
    expect(repository.jobCount).toBe(1);
  });

  test("lists only authenticated open notices for the requested user", async () => {
    const { handler, repository } = fixture();
    repository.addOpenNotice({ id: "n1", userId: "qiaobingyuan", category: "drive", message: "retry needed" });
    repository.addOpenNotice({ id: "n2", userId: "another-user", category: "drive", message: "other" });

    const unauthenticated = await handler(request("/v1/notices?userId=qiaobingyuan"));
    const scoped = await handler(request("/v1/notices?userId=qiaobingyuan", {
      headers: { authorization: `Bearer ${sharedSecret}` }
    }));

    expect(unauthenticated.status).toBe(401);
    await expect(scoped.json()).resolves.toEqual({ notices: [{ id: "n1", category: "drive", message: "retry needed" }] });
  });

  test("compares equal-length secrets without an early mismatch return", () => {
    expect(secureEquals("same-length", "same-length")).toBe(true);
    expect(secureEquals("same-length", "different!!!")).toBe(false);
    expect(secureEquals("short", "longer")).toBe(false);
  });
});
