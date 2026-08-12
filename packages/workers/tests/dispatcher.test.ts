import { describe, expect, test } from "vitest";
import { InMemoryJobRepository, type DispatchJob } from "../src/db.js";
import { Dispatcher } from "../src/dispatcher.js";
import { createQStashPublisher, QStashPublishError } from "../src/qstash.js";
import { createIngressHandler } from "../src/ingress.js";
import { createWorker } from "../src/index.js";

const now = new Date("2026-08-12T08:00:00.000Z");

function job(overrides: Partial<DispatchJob> = {}): DispatchJob {
  return {
    jobId: "job-1",
    eventKey: "qiaobingyuan:algorithm:evt-1",
    userId: "qiaobingyuan",
    state: "dispatch_pending",
    dispatchAttempts: 0,
    lastErrorCode: null,
    brokerMessageId: null,
    leaseOwner: null,
    leaseUntil: null,
    ...overrides
  };
}

function fixture(options: { publish?: () => Promise<unknown>; env?: Partial<Record<"QSTASH_TOKEN" | "SYNC_WORKER_URL" | "QSTASH_FAILURE_CALLBACK_URL", string>> } = {}) {
  const repository = new InMemoryJobRepository(() => "unused");
  repository.addDispatchJob(job());
  const published: unknown[] = [];
  const publisher = {
    publish: async (message: unknown) => {
      published.push(message);
      return options.publish ? options.publish() : { messageId: "msg-1" };
    }
  };
  const dispatcher = new Dispatcher(repository, publisher, {
    QSTASH_TOKEN: "test-token",
    SYNC_WORKER_URL: "https://sync.example/v1/sync",
    QSTASH_FAILURE_CALLBACK_URL: "https://ingress.example/v1/qstash/failure",
    ...options.env
  }, () => now, () => "lease-1");
  return { repository, dispatcher, published };
}

describe("durable QStash dispatcher", () => {
  test("marks a claimed pending job broker_queued only after a message id acknowledgement", async () => {
    const { repository, dispatcher, published } = fixture();

    await dispatcher.dispatch("job-1");

    expect(repository.getDispatchJob("job-1")).toMatchObject({ state: "broker_queued", brokerMessageId: "msg-1" });
    expect(published).toEqual([{
      targetUrl: "https://sync.example/v1/sync",
      failureCallbackUrl: "https://ingress.example/v1/qstash/failure",
      job: { jobId: "job-1", eventKey: "qiaobingyuan:algorithm:evt-1", userId: "qiaobingyuan" }
    }]);
  });

  test("retains a pending job and records an attempt when publication fails", async () => {
    const { repository, dispatcher } = fixture({ publish: async () => { throw new Error("network unavailable"); } });

    await dispatcher.dispatch("job-1");

    expect(repository.getDispatchJob("job-1")).toMatchObject({ state: "dispatch_pending", dispatchAttempts: 1, lastErrorCode: "qstash_publish_failed" });
  });

  test("records only the QStash HTTP status when publication is rejected", async () => {
    const { repository, dispatcher } = fixture({ publish: async () => { throw new QStashPublishError(401); } });

    await dispatcher.dispatch("job-1");

    expect(repository.getDispatchJob("job-1")).toMatchObject({
      state: "dispatch_pending",
      lastErrorCode: "qstash_publish_http_401"
    });
  });

  test("retains a pending job when QStash acknowledgement has no message id", async () => {
    const { repository, dispatcher } = fixture({ publish: async () => ({ accepted: true }) });

    await dispatcher.dispatch("job-1");

    expect(repository.getDispatchJob("job-1")).toMatchObject({ state: "dispatch_pending", dispatchAttempts: 1, lastErrorCode: "qstash_invalid_ack" });
  });

  test("leases a pending job so concurrent dispatcher calls publish at most once", async () => {
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const { repository, dispatcher, published } = fixture({ publish: async () => { await delayed; return { messageId: "msg-1" }; } });

    const first = dispatcher.dispatch("job-1");
    const second = dispatcher.dispatch("job-1");
    await Promise.resolve();
    expect(published).toHaveLength(1);
    release();
    await Promise.all([first, second]);

    expect(repository.getDispatchJob("job-1")).toMatchObject({ state: "broker_queued" });
  });

  test("bounded scheduled dispatch ignores jobs outside dispatch_pending", async () => {
    const { repository, dispatcher, published } = fixture();
    repository.addDispatchJob(job({ jobId: "queued", state: "broker_queued" }));
    repository.addDispatchJob(job({ jobId: "syncing", state: "syncing" }));
    repository.addDispatchJob(job({ jobId: "attention", state: "needs_attention" }));

    await dispatcher.dispatchPending(1);

    expect(published).toHaveLength(1);
    expect(repository.getDispatchJob("queued")?.state).toBe("broker_queued");
    expect(repository.getDispatchJob("syncing")?.state).toBe("syncing");
    expect(repository.getDispatchJob("attention")?.state).toBe("needs_attention");
  });

  test("missing QStash configuration is retained as a retryable dispatch failure", async () => {
    const { repository, dispatcher, published } = fixture({ env: { QSTASH_TOKEN: "" } });

    await dispatcher.dispatch("job-1");

    expect(published).toEqual([]);
    expect(repository.getDispatchJob("job-1")).toMatchObject({ state: "dispatch_pending", dispatchAttempts: 1, lastErrorCode: "qstash_config_missing" });
  });

  test("does not re-publish when acknowledgement persistence reports a lost compare-and-set", async () => {
    class LostAckRepository extends InMemoryJobRepository {
      override async markBrokerQueued(): Promise<boolean> { return false; }
    }
    const repository = new LostAckRepository(() => "unused");
    repository.addDispatchJob(job());
    let publishes = 0;
    const dispatcher = new Dispatcher(repository, { publish: async () => ({ messageId: `msg-${++publishes}` }) }, {
      QSTASH_TOKEN: "test-token", SYNC_WORKER_URL: "https://sync.example/v1/sync",
      QSTASH_FAILURE_CALLBACK_URL: "https://ingress.example/v1/qstash/failure"
    }, () => now, () => "lease-1");

    await dispatcher.dispatch("job-1");
    await dispatcher.dispatch("job-1");

    expect(publishes).toBe(1);
    expect(repository.getDispatchJob("job-1")).toMatchObject({ state: "dispatching", brokerMessageId: "msg-1", lastErrorCode: "qstash_ack_persist_failed" });
  });

  test("keeps an acknowledged job out of retry when acknowledgement persistence throws", async () => {
    class ThrowingAckRepository extends InMemoryJobRepository {
      override async markBrokerQueued(): Promise<boolean> { throw new Error("D1 unavailable"); }
    }
    const repository = new ThrowingAckRepository(() => "unused");
    repository.addDispatchJob(job());
    let publishes = 0;
    const dispatcher = new Dispatcher(repository, { publish: async () => ({ messageId: `msg-${++publishes}` }) }, {
      QSTASH_TOKEN: "test-token", SYNC_WORKER_URL: "https://sync.example/v1/sync",
      QSTASH_FAILURE_CALLBACK_URL: "https://ingress.example/v1/qstash/failure"
    }, () => now, () => "lease-1");

    await dispatcher.dispatch("job-1");
    await dispatcher.dispatch("job-1");

    expect(publishes).toBe(1);
    expect(repository.getDispatchJob("job-1")?.state).toBe("dispatching");
  });
});

describe("QStash HTTP boundary", () => {
  test("uses the configured regional QStash API host", async () => {
    let request: Request | undefined;
    const publisher = createQStashPublisher("secret-token", async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ messageId: "msg-http" }), { status: 200 });
    }, "https://qstash-us-east-1.upstash.io");

    await publisher.publish({
      targetUrl: "https://sync.example/v1/sync",
      failureCallbackUrl: "https://ingress.example/v1/qstash/failure",
      job: { jobId: "job-1", eventKey: "qiaobingyuan:algorithm:evt-1", userId: "qiaobingyuan" }
    });

    expect(request?.url).toBe("https://qstash-us-east-1.upstash.io/v2/publish/https://sync.example/v1/sync");
  });

  test("sends only safe job identifiers and never the token in the body", async () => {
    let request: Request | undefined;
    const publisher = createQStashPublisher("secret-token", async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ messageId: "msg-http" }), { status: 200 });
    });

    await publisher.publish({
      targetUrl: "https://sync.example/v1/sync",
      failureCallbackUrl: "https://ingress.example/v1/qstash/failure",
      job: { jobId: "job-1", eventKey: "qiaobingyuan:algorithm:evt-1", userId: "qiaobingyuan" }
    });

    expect(request?.url).toBe("https://qstash.upstash.io/v2/publish/https://sync.example/v1/sync");
    expect(await request?.json()).toEqual({ jobId: "job-1", eventKey: "qiaobingyuan:algorithm:evt-1", userId: "qiaobingyuan" });
    expect(request?.headers.get("authorization")).toBe("Bearer secret-token");
    expect(request?.headers.get("upstash-failure-callback")).toBe("https://ingress.example/v1/qstash/failure");
  });
});

describe("ingress and Cron wiring", () => {
  test("new ingress schedules best-effort dispatch without delaying its 202 response", async () => {
    const repository = new InMemoryJobRepository(() => "job-1");
    const scheduled: Promise<unknown>[] = [];
    let dispatched = 0;
    const handler = createIngressHandler(
      { INGRESS_SHARED_SECRET: "ingress-secret" }, repository,
      { dispatch: async () => { dispatched += 1; } }
    );
    const response = await handler(new Request("https://ingress.example/v1/jobs", {
      method: "POST",
      headers: { authorization: "Bearer ingress-secret" },
      body: JSON.stringify({
        schemaVersion: "1", eventId: "evt-1", eventKey: "qiaobingyuan:algorithm:evt-1",
        type: "algorithm.completed", userId: "qiaobingyuan", sourceSkill: "algorithm-learning",
        destination: "drive", createdAt: "2026-08-12T08:00:00.000Z", payload: {}
      })
    }), { waitUntil: (work) => scheduled.push(work) });

    expect(response.status).toBe(202);
    expect(dispatched).toBe(1);
    expect(scheduled).toHaveLength(1);
  });

  test("duplicate ingress does not schedule another dispatch", async () => {
    const repository = new InMemoryJobRepository(() => "job-1");
    let dispatched = 0;
    const handler = createIngressHandler(
      { INGRESS_SHARED_SECRET: "ingress-secret" }, repository,
      { dispatch: async () => { dispatched += 1; } }
    );
    const request = () => new Request("https://ingress.example/v1/jobs", {
      method: "POST", headers: { authorization: "Bearer ingress-secret" },
      body: JSON.stringify({
        schemaVersion: "1", eventId: "evt-1", eventKey: "qiaobingyuan:algorithm:evt-1",
        type: "algorithm.completed", userId: "qiaobingyuan", sourceSkill: "algorithm-learning",
        destination: "drive", createdAt: "2026-08-12T08:00:00.000Z", payload: {}
      })
    });
    const context = { waitUntil: (work: Promise<unknown>) => work };

    await handler(request(), context);
    await handler(request(), context);

    expect(dispatched).toBe(1);
  });

  test("interleaved duplicate ingress schedules only the request that inserted the event", async () => {
    const repository = new InMemoryJobRepository(() => "job-1");
    const scheduled: Promise<unknown>[] = [];
    const handler = createIngressHandler(
      { INGRESS_SHARED_SECRET: "ingress-secret" }, repository,
      { dispatch: async () => undefined }
    );
    const makeRequest = () => new Request("https://ingress.example/v1/jobs", {
      method: "POST", headers: { authorization: "Bearer ingress-secret" },
      body: JSON.stringify({
        schemaVersion: "1", eventId: "evt-1", eventKey: "qiaobingyuan:algorithm:evt-1",
        type: "algorithm.completed", userId: "qiaobingyuan", sourceSkill: "algorithm-learning",
        destination: "drive", createdAt: "2026-08-12T08:00:00.000Z", payload: {}
      })
    });

    await Promise.all([
      handler(makeRequest(), { waitUntil: (work) => scheduled.push(work) }),
      handler(makeRequest(), { waitUntil: (work) => scheduled.push(work) })
    ]);

    expect(scheduled).toHaveLength(1);
  });

  test("scheduled handler scans only a bounded pending batch", async () => {
    const repository = new InMemoryJobRepository(() => "unused");
    repository.addDispatchJob(job({ jobId: "pending-1" }));
    repository.addDispatchJob(job({ jobId: "pending-2" }));
    const published: unknown[] = [];
    const worker = createWorker({
      INGRESS_SHARED_SECRET: "secret", QSTASH_TOKEN: "token", SYNC_WORKER_URL: "https://sync.example/v1/sync",
      QSTASH_FAILURE_CALLBACK_URL: "https://ingress.example/v1/qstash/failure"
    }, repository, { publish: async (value) => { published.push(value); return { messageId: `m-${published.length}` }; } }, 1);
    const deferred: Promise<unknown>[] = [];

    worker.scheduled({}, {} as never, { waitUntil: (work) => deferred.push(work) });
    await Promise.all(deferred);

    expect(published).toHaveLength(1);
    expect(repository.getDispatchJob("pending-1")?.state).toBe("broker_queued");
    expect(repository.getDispatchJob("pending-2")?.state).toBe("dispatch_pending");
  });
});
