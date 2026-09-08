import assert from "node:assert/strict";
import test from "node:test";
import { genericProfileReducer } from "../src/rds2/projection/generic-profile.js";
import { planReadCost } from "../src/rds2/projection/staging-read.js";

function event(index) {
  return {
    payload: {
      event: {
        observations: [{
          dimensionKey: "topic",
          subjectKey: `member-${index}`
        }]
      }
    }
  };
}

test("T14 page read cost is bounded by the page, not total history", () => {
  const costs = [100, 10000, 100000].map((historySize) => {
    const page = Array.from({ length: 50 }, (_, index) => event(`${historySize}-${index}`));
    const plan = genericProfileReducer.planPageReads({ events: page });
    return planReadCost(plan, page.length);
  });
  assert.deepEqual(costs, [2, 2, 2]);
});

test("T14 the 50-key absolute bound is priced before any staged query", () => {
  const page = Array.from({ length: 50 }, (_, index) => event(index));
  const plan = genericProfileReducer.planPageReads({ events: page });
  assert.equal(plan.reads[0].rowKeys.length, 50);
  assert.equal(planReadCost(plan, page.length), 2);
});

test("T14 a page containing a 51st distinct member is deferred at the prefix boundary", () => {
  const page = Array.from({ length: 51 }, (_, index) => event(index));
  const plan = genericProfileReducer.planPageReads({ events: page });
  assert.equal(plan.consumedCount, 50);
  assert.equal(plan.reads[0].rowKeys.length, 50);
});

