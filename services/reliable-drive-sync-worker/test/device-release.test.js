import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("T11 production candidate keeps V1 writes and account creation fail-closed", async () => {
  const config = await readFile(new URL("../wrangler.production.toml", import.meta.url), "utf8");
  assert.match(config, /V1_WRITE_ENABLED\s*=\s*"false"/);
  assert.match(config, /V1_RETIRED\s*=\s*"true"/);
  assert.match(config, /ACCOUNT_OPERATIONS_ENABLED\s*=\s*"false"/);
  assert.match(config, /ACCOUNT_SELF_REGISTER_ENABLED\s*=\s*"false"/);
});

