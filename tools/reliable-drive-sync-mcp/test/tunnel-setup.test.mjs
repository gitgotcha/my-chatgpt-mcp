import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("ChatGPT Work tunnel helper is secret-safe and uses the stdio launcher", async () => {
  const script = await readFile(fileURLToPath(new URL("../setup-chatgpt-work-tunnel.ps1", import.meta.url)), "utf8");
  assert.match(script, /CONTROL_PLANE_API_KEY/);
  assert.match(script, /sample_mcp_stdio_local/);
  assert.match(script, /--tunnel-id/);
  assert.match(script, /--mcp-command/);
  assert.match(script, /start\.cmd/);
  assert.match(script, /doctor/);
  assert.match(script, /DryRun/);
  assert.doesNotMatch(script, /Write-(Host|Output).*API_KEY/i);
});
