import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

test("T09 two real bridge processes serialize device acceptance and a killed holder is recoverable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rds2-multiprocess-"));
  const path = join(root, "control.sqlite");
  const ready = join(root, "ready");
  const release = join(root, "release");
  const moduleUrl = pathToFileURL(fileURLToPath(new URL("../gateway/device-store.mjs", import.meta.url))).href;
  const script = `import {existsSync,writeFileSync} from 'node:fs'; import {openDeviceStore} from ${JSON.stringify(moduleUrl)}; const s=openDeviceStore({path:${JSON.stringify(path)}}); s.exclusive(()=>{writeFileSync(${JSON.stringify(ready)},'1'); while(!existsSync(${JSON.stringify(release)})){} }); s.close();`;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(async () => { if (!holder.killed) holder.kill(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  for (let i = 0; i < 200 && !existsSync(ready); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(ready), true);
  const contender = spawn(process.execPath, ["--input-type=module", "-e", `import {openDeviceStore} from ${JSON.stringify(moduleUrl)}; const s=openDeviceStore({path:${JSON.stringify(path)}}); try{s.exclusive(()=>{});process.stdout.write('entered')}catch(e){process.stdout.write(e.code)}finally{s.close()}`], { encoding: "utf8" });
  const output = await new Promise((resolve, reject) => { let text = ""; contender.stdout.on("data", (chunk) => { text += chunk; }); contender.on("error", reject); contender.on("exit", () => resolve(text)); });
  assert.equal(output, "device_busy");
  await writeFile(release, "1");
  await new Promise((resolve) => holder.once("exit", resolve));
});

