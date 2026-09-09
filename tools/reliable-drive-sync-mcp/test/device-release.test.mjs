import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(runtimeRoot, "build-device-release.mjs");
const manifestPath = join(runtimeRoot, "dist", "device-runtime-manifest.json");

test("T11 release builder hashes the tracked bridge runtime from its actual directory", async () => {
  await rm(join(runtimeRoot, "dist"), { recursive: true, force: true });
  try {
    const { stdout } = await run(process.execPath, [script], { cwd: runtimeRoot });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.files, 8);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.files.length, 8);
    for (const entry of manifest.files) {
      assert.ok(entry.path && !entry.path.includes("..") && !entry.path.startsWith("/"));
      await access(join(runtimeRoot, entry.path));
    }
    assert.match(result.packageHash, /^[0-9a-f]{64}$/);
  } finally {
    await rm(join(runtimeRoot, "dist"), { recursive: true, force: true });
  }
});
