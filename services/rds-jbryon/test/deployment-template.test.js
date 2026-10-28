import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const templatePath = fileURLToPath(new URL("../wrangler.jsonc.template", import.meta.url));
const config = JSON.parse(readFileSync(templatePath, "utf8"));

test("the deployment template binds the Worker to a new D1, Queue and Cron", () => {
  assert.equal(config.name, "rds-jbryon");
  assert.equal(config.main, "src/worker.js");
  assert.equal(existsSync(fileURLToPath(new URL(`../${config.main}`, import.meta.url))), true);
  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.triggers.crons, ["* * * * *"]);
  assert.equal(config.d1_databases.length, 1);
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[0].migrations_dir, "migrations");
  assert.equal(config.queues.producers.length, 1);
  assert.equal(config.queues.producers[0].binding, "QUEUE");
  assert.equal(config.queues.producers[0].queue, config.queues.consumers[0].queue);
  assert.equal(config.queues.consumers[0].max_batch_size, 1);
  assert.equal(config.queues.consumers[0].max_concurrency, 1);
  assert.deepEqual(config.secrets.required, ["RDS_TOKEN"]);
});

test("the template is deliberately non-deployable until dedicated resources are filled", () => {
  assert.match(config.d1_databases[0].database_id, /^REPLACE_/);
  assert.match(config.queues.producers[0].queue, /^REPLACE_/);
  assert.match(config.vars.RDS_WORKSPACE_EPOCH, /^REPLACE_/);
  assert.equal(Object.hasOwn(config.vars, "RDS_TOKEN"), false);
});
