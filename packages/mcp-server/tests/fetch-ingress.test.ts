import { describe, expect, test } from "vitest";
import { createFetchIngressTransport } from "../src/fetch-ingress.js";

const baseEvent = {
  schemaVersion: "1",
  eventId: "event-1",
  eventKey: "qiao:event:1",
  type: "profile.updated",
  userId: "qiao",
  sourceSkill: "algorithm-learning",
  destination: "drive" as const,
  createdAt: "2026-08-12T00:00:00.000Z",
  payload: { topic: "three-sum" }
};

const validConfig = {
  url: "https://worker.example/v1/jobs",
  sharedSecret: "secret"
};

describe("createFetchIngressTransport", () => {
  test("posts an event with the Worker bearer secret", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = createFetchIngressTransport(validConfig, async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ jobId: "job-1" }), { status: 202 });
    });

    await expect(transport?.send(baseEvent, new AbortController().signal)).resolves.toEqual({
      status: 202,
      body: { jobId: "job-1" }
    });
    expect(calls[0]?.url).toBe("https://worker.example/v1/jobs");
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer secret", "content-type": "application/json" }
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(baseEvent);
  });

  test.each([
    { url: undefined, sharedSecret: "secret" },
    { url: "https://worker.example/v1/jobs", sharedSecret: "" },
    { url: "not a URL", sharedSecret: "secret" }
  ])("does not create a transport for unusable configuration", (config) => {
    expect(createFetchIngressTransport(config, async () => new Response())).toBeNull();
  });

  test("returns a null body when ingress does not return JSON", async () => {
    const transport = createFetchIngressTransport(validConfig, async () => new Response("busy", { status: 503 }));
    await expect(transport?.send(baseEvent, new AbortController().signal)).resolves.toEqual({
      status: 503,
      body: null
    });
  });

  test("passes the Outbox deadline signal into fetch", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const transport = createFetchIngressTransport(validConfig, async (_url, init) => {
      received = init?.signal as AbortSignal;
      return new Response(JSON.stringify({ jobId: "job-1" }), { status: 202 });
    });

    await transport?.send(baseEvent, controller.signal);
    expect(received).toBe(controller.signal);
  });
});
