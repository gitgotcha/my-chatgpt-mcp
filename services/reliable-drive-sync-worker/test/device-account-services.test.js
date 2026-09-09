import assert from "node:assert/strict";
import test from "node:test";
import { hashText } from "../src/rds2/identity/hashing.js";
import { registerAccount } from "../src/rds2/accounts/registration.js";
import { createPairing, redeemPairing } from "../src/rds2/accounts/pairing.js";
import { withDeviceAccountsD1 } from "./support/rds2-d1.js";

const NOW = "2026-09-09T01:00:00.000Z";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

function ioFor(db) { return { db }; }

test("T03 same-name registrations get independent UUIDs and same-intent retries replay", async () => {
  await withDeviceAccountsD1(async (_binding, db) => {
    const io = ioFor(db);
    const first = await registerAccount({ io, requestId: "register-a", name: "同名", secret: "secret-a", now: NOW, uuid: USER_A });
    const replay = await registerAccount({ io, requestId: "register-a", name: "同名", secret: "secret-a", now: NOW, uuid: USER_B });
    const second = await registerAccount({ io, requestId: "register-b", name: "同名", secret: "secret-b", now: NOW, uuid: USER_B });
    assert.equal(first.userId, replay.userId);
    assert.notEqual(first.userId, second.userId);
    assert.equal(replay.replayed, true);
    await assert.rejects(
      registerAccount({ io, requestId: "register-a", name: "同名", secret: "other-secret", now: NOW, uuid: USER_A }),
      (error) => error?.code === "registration_conflict"
    );
  });
});

test("T03 pairing consumes one expiring ticket atomically and is idempotent by request and proof", async () => {
  await withDeviceAccountsD1(async (_binding, db) => {
    const io = ioFor(db);
    const account = await registerAccount({ io, requestId: "register-source", name: "来源", secret: "source-secret", now: NOW, uuid: USER_A });
    const sourceHash = await hashText("source-secret");
    const ticket = await createPairing({
      io,
      principal: { userId: account.userId, credentialHash: sourceHash },
      code: "pair-code",
      now: NOW
    });
    assert.equal(ticket.userId, USER_A);
    assert.equal(Object.hasOwn(ticket, "code"), false);

    const redeemed = await redeemPairing({ io, requestId: "redeem-a", code: "pair-code", secret: "target-secret", now: NOW });
    const replay = await redeemPairing({ io, requestId: "redeem-a", code: "pair-code", secret: "target-secret", now: NOW });
    assert.equal(redeemed.userId, replay.userId);
    assert.equal(replay.replayed, true);
    await assert.rejects(
      redeemPairing({ io, requestId: "redeem-b", code: "pair-code", secret: "other-target", now: NOW }),
      (error) => ["pairing_used", "pairing_conflict"].includes(error?.code)
    );
  });
});

test("T03 a ticket cannot be redeemed after ten minutes or from a revoked source", async () => {
  await withDeviceAccountsD1(async (_binding, db) => {
    const io = ioFor(db);
    const account = await registerAccount({ io, requestId: "register-expiring", name: "过期来源", secret: "source-secret", now: NOW, uuid: USER_A });
    const sourceHash = await hashText("source-secret");
    await createPairing({ io, principal: { userId: account.userId, credentialHash: sourceHash }, code: "expired-code", now: NOW });
    await assert.rejects(
      redeemPairing({ io, requestId: "redeem-expired", code: "expired-code", secret: "target-secret", now: "2026-09-09T01:10:01.000Z" }),
      (error) => error?.code === "pairing_expired"
    );
    await db.prepare("UPDATE rds2_credentials SET status = 'revoked' WHERE credential_hash = ?").bind(sourceHash).run();
    await assert.rejects(
      createPairing({ io, principal: { userId: account.userId, credentialHash: sourceHash }, code: "revoked-code", now: NOW }),
      (error) => error?.code === "source_not_authorized"
    );
  });
});
