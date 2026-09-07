// T09: turn the local outbox into a reliable receipt.
//
// The service owns the only network call; the outbox owns every durable
// write. They never overlap: a send happens OUTSIDE any SQLite transaction,
// and the local commit that acknowledges a receipt happens only after the
// cloud receipt has been matched against the attempted request.
//
// Rules carried from the frozen addendum §10:
//   - nothing is ever dropped: a send that fails, a response that is lost and
//     a local confirm that fails all leave the row in place, to be retried;
//   - a retry replays the SAME requestId and envelope, which the cloud settles
//     with already_recorded against the original event — never a second one;
//   - a row the cloud already acknowledged answers a repeat submit from the
//     locally stored receipt, without touching the network;
//   - at most 20 rows per flush, one HTTP request each;
//   - the wake-up timer starts on the first write and is cancelled on close.
import { MAX_FLUSH_ROWS } from "./local-outbox-v2.mjs";

const WAKE_MS = 30_000;
const PERMANENT_PREFIXES = ["request_id_conflict", "event_id_conflict", "event_key_conflict", "identity_", "invalid_", "unsupported_"];

function safeCode(error, fallback = "delivery_failed") {
  const candidate = error?.code ?? (error instanceof Error ? error.message : String(error ?? ""));
  return typeof candidate === "string" && /^[a-z][a-z0-9_]{0,80}$/.test(candidate) ? candidate : fallback;
}

function isPermanent(code) {
  return PERMANENT_PREFIXES.some((prefix) => code.startsWith(prefix));
}

export function createDeliveryServiceV2({
  outbox,
  send,
  clock,
  schedule,
  wakeMs = WAKE_MS
}) {
  if (!outbox || typeof outbox.enqueue !== "function") throw new Error("invalid_outbox");
  if (typeof send !== "function") throw new Error("invalid_send");
  const now = typeof clock === "function" ? clock : () => new Date().toISOString();
  const scheduleFn = schedule ?? ((action, ms) => {
    const timer = setTimeout(action, ms);
    if (typeof timer?.unref === "function") timer.unref();
    return timer;
  });

  let timer = null;
  let closed = false;

  const arm = () => {
    if (closed || timer !== null) return;
    timer = scheduleFn(() => {
      timer = null;
      if (closed) return;
      flushDue().catch(() => {});
    }, wakeMs);
  };

  async function submit(envelope) {
    if (closed) throw new Error("service_closed");
    const requestId = envelope?.requestId;
    if (typeof requestId !== "string" || !requestId.trim()) throw new Error("invalid_request_id");

    // A fact the cloud already acknowledged is answered locally: repeating the
    // HTTP call could only ever return the same receipt.
    const existing = outbox.get ? outbox.get(requestId) : null;
    if (existing?.state === "acknowledged") {
      return { persistence: { localOutbox: "acknowledged" }, receipt: existing.receipt };
    }
    const stored = outbox.enqueue(envelope);
    arm();
    return {
      persistence: { localOutbox: stored.state === "blocked" ? "blocked" : "pending" },
      receipt: null,
      conflict: stored.conflict === true
    };
  }

  async function flushDue() {
    if (closed) return { delivered: 0, failed: 0 };
    const claimed = outbox.claimDue({ limit: MAX_FLUSH_ROWS });
    let delivered = 0;
    let failed = 0;
    for (const row of claimed) {
      // The send is a single HTTP request and MUST stay outside any local
      // transaction: a durable write may never span a network call.
      let receipt;
      try {
        receipt = await send(row.envelope);
      } catch (error) {
        const code = safeCode(error);
        outbox.fail({ requestId: row.requestId, code: isPermanent(code) ? code : code });
        failed += 1;
        continue;
      }
      try {
        outbox.confirm(receipt);
        delivered += 1;
      } catch (error) {
        // The cloud has it, so the row must survive: keep it retryable with
        // the failure recorded, never park it and never drop it.
        outbox.fail({ requestId: row.requestId, code: safeCode(error, "local_confirm_failed") });
        failed += 1;
      }
    }
    return { delivered, failed };
  }

  function close() {
    if (closed) return;
    closed = true;
    if (timer !== null) {
      if (typeof timer.cancel === "function") timer.cancel();
      else clearTimeout(timer);
      timer = null;
    }
  }

  return {
    submit,
    flushDue,
    close,
    get timerActive() {
      return timer !== null;
    },
    get closed() {
      return closed;
    },
    now
  };
}
