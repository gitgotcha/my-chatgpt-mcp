import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { LocalOutbox } from "../outbox.mjs";

const [path, owner, barrier] = process.argv.slice(2);
const outbox = new LocalOutbox({ path, owner });
try {
  writeFileSync(`${barrier}.${owner}.ready`, "ready");
  while (!existsSync(barrier)) await delay(5);
  const claims = outbox.claimDue({ limit: 1 });
  process.stdout.write(JSON.stringify({ owner, claimed: claims.map((row) => row.requestId) }));
} finally {
  outbox.close();
}
