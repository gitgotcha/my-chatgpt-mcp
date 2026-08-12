import { describe, expect, test } from "vitest";
import { InMemoryJobRepository, type DispatchJob } from "../src/db.js";
import { Reconciler } from "../src/reconciler.js";

const makeJob = (jobId: string, state: DispatchJob["state"]): DispatchJob => ({ jobId, eventKey: `qiao:${jobId}:1`, userId: "qiao", state, dispatchAttempts: 0, lastErrorCode: null, brokerMessageId: null, leaseOwner: null, leaseUntil: null });

describe("Reconciler", () => {
  test("publishes only eligible dispatch_pending jobs", async () => {
    const repository = new InMemoryJobRepository();
    repository.addDispatchJob(makeJob("pending-job", "dispatch_pending"));
    repository.addDispatchJob(makeJob("queued-job", "broker_queued"));
    repository.addDispatchJob(makeJob("syncing-job", "syncing"));
    repository.addDispatchJob(makeJob("dispatching-job", "dispatching"));
    const published: string[] = [];
    const reconciler = new Reconciler(repository, { dispatch: async (jobId) => { published.push(jobId); } });
    await reconciler.runFiveMinute();
    expect(published).toEqual(["pending-job"]);
  });

  test("does not replay an acknowledged-but-unpersisted dispatching fence", async () => {
    const repository = new InMemoryJobRepository();
    repository.addDispatchJob({ ...makeJob("uncertain", "dispatching"), brokerMessageId: "qstash-id", lastErrorCode: "qstash_ack_persist_failed", leaseOwner: "old", leaseUntil: "2020-01-01T00:00:00.000Z" });
    const published: string[] = [];
    const reconciler = new Reconciler(repository, { dispatch: async (jobId) => { published.push(jobId); } });
    await reconciler.runHourly();
    expect(published).toEqual([]);
  });
});
