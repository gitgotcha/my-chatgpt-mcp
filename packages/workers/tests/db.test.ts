import { describe, expect, test } from "vitest";
import { D1JobRepository, type D1Database } from "../src/db.js";

function event() {
  return {
    schemaVersion: "1" as const, eventId: "evt-1", eventKey: "qiaobingyuan:algorithm:evt-1",
    type: "algorithm.completed", userId: "qiaobingyuan", sourceSkill: "algorithm-learning",
    destination: "drive" as const, createdAt: "2026-08-12T08:00:00.000Z", payload: {}
  };
}

describe("D1 idempotent insert", () => {
  test("marks only the request whose INSERT changed a row as new during an interleaved duplicate", async () => {
    let inserted = false;
    let releaseReads!: () => void;
    const reads = new Promise<void>((resolve) => { releaseReads = resolve; });
    let readCount = 0;
    const database: D1Database = {
      prepare(query) {
        const statement = {
          bind: () => statement,
          async run() {
            const changes = inserted ? 0 : 1;
            inserted = true;
            return { meta: { changes } };
          },
          async first<T>() {
            if (query.includes("SELECT job_id")) {
              readCount += 1;
              if (readCount <= 2) await reads;
              return (inserted ? { job_id: "persisted-job", event_key: event().eventKey, user_id: event().userId, state: "dispatch_pending" } : null) as T | null;
            }
            return null;
          }
        };
        return statement;
      }
    };
    const repository = new D1JobRepository(database);
    const first = repository.createOrGet(event());
    const second = repository.createOrGet(event());
    await Promise.resolve();
    releaseReads();

    const [one, two] = await Promise.all([first, second]);

    expect([one.isNew, two.isNew].filter(Boolean)).toHaveLength(1);
    expect(one.jobId).toBe("persisted-job");
    expect(two.jobId).toBe("persisted-job");
  });
});
