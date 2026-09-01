import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../stdio-bridge.mjs";

test("the stable bridge exposes only submit_event", async () => {
  const response = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(response.result.tools.map(({ name }) => name), ["submit_event"]);
});
