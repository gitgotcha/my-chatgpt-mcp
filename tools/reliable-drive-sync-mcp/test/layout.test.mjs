import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { handleRequest } from "../stdio-bridge.mjs";

test("the stable bridge exposes only submit_event", async () => {
  const response = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(response.result.tools.map(({ name }) => name), ["submit_event"]);
});

test("the Windows launcher can recover persistent user environment values", async () => {
  const launcher = await readFile(fileURLToPath(new URL("../start.cmd", import.meta.url)), "utf8");
  assert.match(launcher, /HKCU\\Environment/);
  assert.match(launcher, /reg query/);
  assert.match(launcher, /RELIABLE_DRIVE_SYNC_INGRESS_URL/);
  assert.match(launcher, /RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET/);
  assert.doesNotMatch(launcher, /echo\s+%RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET%/i);
  assert.doesNotMatch(launcher, /exit \/b 2/i);
});
