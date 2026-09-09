// T08: produce a portable runtime manifest from tracked files only. Runtime
// secrets, local account stores and absolute user paths are deliberately not
// inputs to this builder.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = fileURLToPath(new URL(".", import.meta.url));
const files = Object.freeze([
  "stdio-bridge.mjs", "v2-routing.mjs", "local-outbox-v2.mjs",
  "delivery-service-v2.mjs", "gateway/device-store.mjs", "gateway/accounts.mjs",
  "gateway/business-transport.mjs", "gateway/secure-store.mjs"
]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const entries = [];
for (const relative of files) entries.push({ path: relative, sha256: hash(await readFile(join(runtimeRoot, relative))) });
const manifest = { manifestVersion: 1, runtimeVersion: "2.0.0-device-binding", files: entries };
manifest.packageHash = hash(JSON.stringify(manifest));
const output = join(runtimeRoot, "dist", "device-runtime-manifest.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ packageHash: manifest.packageHash, files: entries.length })}\n`);
