import { describe, expect, test } from "vitest";
import { createFetchArtifactTransport, createInterviewApi, createFetchIngressTransport, ingressTransportFromEnvironment } from "../src/fetch-ingress.js";
import { sha256Hex } from "@reliable-drive-sync/protocol/artifact";

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
  test("posts an immutable artifact and reads candidate routes with the Worker bearer secret", async () => {
    const bytes = new TextEncoder().encode("{}");
    const artifact = { schemaVersion: "1" as const, artifactId: "artifact-1", artifactKey: "candidate-001:interview:MOCK-001:session:v1", candidateId: "candidate-001", sourceSkill: "interview" as const, sessionId: "MOCK-001", artifactType: "session" as const, fileName: "session.json" as const, contentType: "application/json" as const, contentBase64: btoa("{}"), sha256: await sha256Hex(bytes), createdAt: "2026-08-13T00:00:00.000Z", bytes };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ jobId: "artifact-job" }), { status: 202 }); };
    await expect(createFetchArtifactTransport(validConfig, fetchMock as typeof fetch)?.send(artifact, new AbortController().signal)).resolves.toEqual({ status: 202, body: { jobId: "artifact-job" } });
    expect(calls[0]).toMatchObject({ url: "https://worker.example/v1/artifacts", init: { method: "POST", headers: { Authorization: "Bearer secret" } } });
    const api = createInterviewApi(validConfig, fetchMock as typeof fetch)!;
    await api.listCandidates("qiao", 5); await api.getCandidateContext("candidate-001"); await api.readArtifact("candidate-001", artifact.artifactKey);
    expect(calls.slice(1).map((call) => call.url)).toEqual([
      "https://worker.example/v1/candidates?query=qiao&limit=5",
      "https://worker.example/v1/candidates/candidate-001/context",
      `https://worker.example/v1/artifacts/${encodeURIComponent(artifact.artifactKey)}?candidateId=candidate-001`
    ]);
  });
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

  test("uses a disabled transport unless both local values are present", async () => {
    const ready = ingressTransportFromEnvironment({
      RELIABLE_DRIVE_SYNC_INGRESS_URL: "https://worker.example/v1/jobs",
      RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET: "secret"
    }, async () => new Response(JSON.stringify({ jobId: "job-1" }), { status: 202 }));
    await expect(ready.send(baseEvent, new AbortController().signal)).resolves.toEqual({
      status: 202,
      body: { jobId: "job-1" }
    });

    const disabled = ingressTransportFromEnvironment({
      RELIABLE_DRIVE_SYNC_INGRESS_URL: "https://worker.example/v1/jobs"
    });
    await expect(disabled.send(baseEvent, new AbortController().signal)).rejects.toThrow("Ingress is not configured");
  });
});
