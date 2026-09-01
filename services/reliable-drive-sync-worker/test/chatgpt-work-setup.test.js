import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("ChatGPT Work setup generates a secret, deploys, and copies the capability URL", async () => {
  const scriptPath = fileURLToPath(new URL("../setup-chatgpt-work.ps1", import.meta.url));
  const script = await readFile(scriptPath, "utf8");
  assert.match(script, /RandomNumberGenerator/);
  assert.match(script, /wrangler secret put MCP_URL_TOKEN/);
  assert.match(script, /wrangler deploy/);
  assert.match(script, /\/mcp\//);
  assert.match(script, /Set-Clipboard/);
  assert.doesNotMatch(script, /MCP_URL_TOKEN\s*=\s*['"][A-Za-z0-9_-]{32,}/);
  assert.doesNotMatch(script, /Write-Output\s+\$mcpUrl/);
});
