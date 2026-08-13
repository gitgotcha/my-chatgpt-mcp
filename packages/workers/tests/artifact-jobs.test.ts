import { describe, expect, test } from "vitest";
import { D1ArtifactRepository } from "../src/artifact-jobs.js";
import type { D1Database } from "../src/db.js";

describe("D1ArtifactRepository content staging", () => {
  test("loads the private staged bytes by job id", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const database: D1Database = {
      prepare() {
        const statement = { bind: () => statement, run: async () => ({ meta: { changes: 1 } }), first: async <T>() => ({ content: bytes }) as T };
        return statement;
      }
    };
    const repository = new D1ArtifactRepository(database);
    await expect(repository.loadContent("artifact-job")).resolves.toEqual(bytes);
  });
});
