import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { openDeviceStore } from "../gateway/device-store.mjs";

const cleanup = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "rds2-device-store-"));
  const path = join(directory, "control.sqlite");
  const stores = [];
  t.after(async () => {
    for (const store of stores.reverse()) store.close();
    await rm(directory, cleanup);
  });
  return {
    directory,
    path,
    open: () => {
      const store = openDeviceStore({ path });
      stores.push(store);
      return store;
    }
  };
}

test("T00 creates an isolated control store and exposes a durable current binding", async (t) => {
  const { path, open } = await fixture(t);
  assert.equal(existsSync(path), false, "pure construction must not pre-create a database");

  const store = open();
  assert.equal(existsSync(path), true, "opening the control store creates only its own database");
  const first = store.current();
  assert.equal(first, null, "an unbound device has no current user");

  store.exclusive(({ db }) => {
    db.prepare("INSERT INTO device_binding(singleton, installation_id, binding_epoch, binding_revision, user_id, credential_ref) VALUES(1, ?, 0, 0, ?, ?)").run(
      "installation-test", "user-test", "credential-ref-test"
    );
  });
  assert.deepEqual(store.current(), {
    singleton: 1,
    installationId: "installation-test",
    bindingEpoch: 0,
    bindingRevision: 0,
    userId: "user-test",
    credentialRef: "credential-ref-test"
  });

  store.close();
  const reopened = open();
  assert.equal(reopened.current().userId, "user-test", "binding survives a restart");
});

test("T00 rejects async work inside the device lock", async (t) => {
  const { open } = await fixture(t);
  const store = open();
  assert.throws(
    () => store.exclusive(() => Promise.resolve()),
    (error) => error?.code === "async_in_device_lock"
  );
});

test("T00 an async callback cannot write after its lock is rejected", async (t) => {
  const { open } = await fixture(t);
  const store = open();
  assert.throws(
    () => store.exclusive(async ({ db }) => {
      await Promise.resolve();
      db.prepare("INSERT INTO device_binding(singleton, installation_id, binding_epoch, binding_revision, user_id, credential_ref) VALUES(1, ?, ?, 0, ?, ?)").run(
        "installation-late", "epoch-late", "user-late", "credential-late"
      );
    }),
    (error) => error?.code === "async_in_device_lock"
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.current(), null, "rejected async work must have no delayed database side effect");
});

test("T00 rolls back a failed synchronous action", async (t) => {
  const { open } = await fixture(t);
  const store = open();
  assert.throws(() => store.exclusive(({ db }) => {
    db.prepare("INSERT INTO device_binding(singleton, installation_id, binding_epoch, binding_revision, user_id, credential_ref) VALUES(1, ?, 0, 0, ?, ?)").run(
      "installation-rollback", "user-rollback", "credential-ref"
    );
    throw new Error("synthetic failure");
  }), /synthetic failure/);
  assert.equal(store.current(), null, "failed actions do not leave a partial binding");
});

test("T00 two real Node processes cannot overlap the critical section", async (t) => {
  const { directory, path } = await fixture(t);
  const ready = join(directory, "holder.ready");
  const release = join(directory, "holder.release");
  const moduleUrl = pathToFileURL(fileURLToPath(new URL("../gateway/device-store.mjs", import.meta.url))).href;
  const script = [
    `import { existsSync, writeFileSync } from "node:fs";`,
    `import { openDeviceStore } from ${JSON.stringify(moduleUrl)};`,
    `const store = openDeviceStore({path:${JSON.stringify(path)}});`,
    `store.exclusive(() => { writeFileSync(${JSON.stringify(ready)}, "ready"); while (!existsSync(${JSON.stringify(release)})) {} });`,
    `store.close();`
  ].join("\n");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let holderStderr = "";
  holder.stderr.on("data", (chunk) => { holderStderr += chunk; });
  for (let i = 0; i < 250 && !existsSync(ready); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(ready), true, `holder did not enter the lock: ${holderStderr}`);
  const contender = spawnSync(process.execPath, ["--input-type=module", "-e", [
    `import { openDeviceStore } from ${JSON.stringify(moduleUrl)};`,
    `const store = openDeviceStore({path:${JSON.stringify(path)}});`,
    `try { store.exclusive(() => "unexpected"); process.stdout.write("unexpected"); } catch (error) { process.stdout.write(error.code ?? "unknown"); } finally { store.close(); }`
  ].join("\n")], { encoding: "utf8", timeout: 15_000 });
  assert.equal(contender.status, 0, contender.stderr);
  assert.equal(contender.stdout, "device_busy", "the second process must not enter the critical section");
  await writeFile(release, "release");
  await new Promise((resolve, reject) => {
    holder.once("error", reject);
    holder.once("exit", (code) => code === 0 ? resolve() : reject(new Error(holderStderr || `holder exited ${code}`)));
  });
});

test("T00 an OS-terminated holder releases its SQLite lock", async (t) => {
  const { directory, path } = await fixture(t);
  const ready = join(directory, "killed-holder.ready");
  const moduleUrl = pathToFileURL(fileURLToPath(new URL("../gateway/device-store.mjs", import.meta.url))).href;
  const script = [
    `import { writeFileSync } from "node:fs";`,
    `import { openDeviceStore } from ${JSON.stringify(moduleUrl)};`,
    `const store = openDeviceStore({path:${JSON.stringify(path)}});`,
    `store.exclusive(() => { writeFileSync(${JSON.stringify(ready)}, "ready"); while (true) {} });`
  ].join("\n");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  for (let i = 0; i < 250 && !existsSync(ready); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(ready), true, "holder did not enter the lock");
  holder.kill();
  await new Promise((resolve) => holder.once("exit", resolve));

  const contender = spawnSync(process.execPath, ["--input-type=module", "-e", [
    `import { openDeviceStore } from ${JSON.stringify(moduleUrl)};`,
    `const store = openDeviceStore({path:${JSON.stringify(path)}});`,
    `store.exclusive(() => "acquired"); process.stdout.write("acquired"); store.close();`
  ].join("\n")], { encoding: "utf8", timeout: 5_000 });
  assert.equal(contender.status, 0, contender.stderr);
  assert.equal(contender.stdout, "acquired");
});

test("T00 a killed transaction rolls back while a committed binding survives", async (t) => {
  const { directory, path, open } = await fixture(t);
  const moduleUrl = pathToFileURL(fileURLToPath(new URL("../gateway/device-store.mjs", import.meta.url))).href;
  const initial = open();
  initial.exclusive(({ db }) => db.prepare("INSERT INTO device_binding(singleton, installation_id, binding_epoch, binding_revision, user_id, credential_ref) VALUES(1, ?, ?, 0, ?, ?)").run(
    "installation-a", "epoch-a", "user-a", "credential-a"
  ));
  initial.close();

  const rollbackReady = join(directory, "rollback.ready");
  const rollbackScript = [
    `import { writeFileSync } from "node:fs";`,
    `import { openDeviceStore } from ${JSON.stringify(moduleUrl)};`,
    `const store = openDeviceStore({path:${JSON.stringify(path)}});`,
    `store.exclusive(({ db }) => { db.prepare("UPDATE device_binding SET user_id = ?, credential_ref = ? WHERE singleton = 1").run("user-b", "credential-b"); writeFileSync(${JSON.stringify(rollbackReady)}, "ready"); while (true) {} });`
  ].join("\n");
  const rollbackHolder = spawn(process.execPath, ["--input-type=module", "-e", rollbackScript], { stdio: ["ignore", "ignore", "pipe"] });
  for (let i = 0; i < 250 && !existsSync(rollbackReady); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(existsSync(rollbackReady), true, "rollback holder did not reach its uncommitted write");
  rollbackHolder.kill();
  await new Promise((resolve) => rollbackHolder.once("exit", resolve));
  const afterRollback = open();
  assert.equal(afterRollback.current().userId, "user-a", "killing an open transaction must preserve the previous binding");
  afterRollback.close();

  const commitReady = join(directory, "commit.ready");
  const commitScript = [
    `import { writeFileSync } from "node:fs";`,
    `import { openDeviceStore } from ${JSON.stringify(moduleUrl)};`,
    `const store = openDeviceStore({path:${JSON.stringify(path)}});`,
    `store.exclusive(({ db }) => db.prepare("UPDATE device_binding SET user_id = ?, credential_ref = ? WHERE singleton = 1").run("user-c", "credential-c"));`,
    `writeFileSync(${JSON.stringify(commitReady)}, "ready"); while (true) {}`
  ].join("\n");
  const commitHolder = spawn(process.execPath, ["--input-type=module", "-e", commitScript], { stdio: ["ignore", "ignore", "pipe"] });
  for (let i = 0; i < 250 && !existsSync(commitReady); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(existsSync(commitReady), true, "commit holder did not finish its transaction");
  commitHolder.kill();
  await new Promise((resolve) => commitHolder.once("exit", resolve));
  const afterCommit = open();
  assert.equal(afterCommit.current().userId, "user-c", "a committed binding must survive process termination");
});

test("T00 resolves a relative control-store path from the launcher working directory", async (t) => {
  const { directory } = await fixture(t);
  const moduleUrl = pathToFileURL(fileURLToPath(new URL("../gateway/device-store.mjs", import.meta.url))).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", [
    `import { existsSync } from "node:fs";`,
    `import { openDeviceStore } from ${JSON.stringify(moduleUrl)};`,
    `const store = openDeviceStore({path:"relative/control.sqlite"});`,
    `process.stdout.write(String(store.current() === null && existsSync("relative/control.sqlite")));`,
    `store.close();`
  ].join("\n")], { cwd: directory, encoding: "utf8", timeout: 5_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "true");
});
