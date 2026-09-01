import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("local client setup configures the shared Codex/ChatGPT desktop stdio server and WorkBuddy", async () => {
  const script = await readFile(fileURLToPath(new URL("../setup-local-clients.ps1", import.meta.url)), "utf8");
  assert.match(script, /\[mcp_servers\.reliable_drive_sync\]/);
  assert.match(script, /start\.cmd/);
  assert.match(script, /mcpServers/);
  assert.match(script, /RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET/);
  assert.doesNotMatch(script, /MCP_URL_TOKEN|tunnel-client|Streamable HTTP/i);
  assert.equal([...script].every((character) => character.charCodeAt(0) < 128), true);
});
