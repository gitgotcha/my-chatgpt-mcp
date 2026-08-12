# MCP Cloud Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the local MCP server to send persisted Outbox events to the deployed Worker without ever losing events when configuration or networking fails.

**Architecture:** Add a fetch-backed `IngressTransport` and construct it only when both local environment variables are usable. Existing `SubmitEventService` continues to own SQLite persistence, bounded attempts, abort signals, and acknowledgement rules.

**Tech Stack:** TypeScript, Node fetch, Vitest, Cloudflare Workers Secrets, Wrangler.

## Global Constraints

- Never commit `INGRESS_SHARED_SECRET`, QStash credentials, or Drive credentials.
- `RELIABLE_DRIVE_SYNC_INGRESS_URL` is the complete `/v1/jobs` URL.
- Only HTTP `202` with a non-empty JSON `jobId` acknowledges an Outbox record.
- Missing, blank, malformed, or partial configuration sends no request and keeps the record pending.
- Preserve existing bounded-deadline and `AbortSignal` behavior.

---

## File Structure

- Create `packages/mcp-server/src/fetch-ingress.ts`: authenticated HTTP transport.
- Create `packages/mcp-server/tests/fetch-ingress.test.ts`: injected-fetch tests.
- Modify `packages/mcp-server/src/index.ts`: environment-based transport selection.
- Modify `.env.example`: variable names and URL shape only.

### Task 1: Build and test the fetch ingress transport

**Files:**

- Create: `packages/mcp-server/src/fetch-ingress.ts`
- Create: `packages/mcp-server/tests/fetch-ingress.test.ts`

**Interfaces:**

- Consumes `IngressTransport` and `IngressResponse` from `./submit-event.js` and `SyncEvent` from `@reliable-drive-sync/protocol/event`.
- Produces `createFetchIngressTransport(config, fetchImpl): IngressTransport | null`.
- `config` is `{ url?: string; sharedSecret?: string }`.

- [ ] **Step 1: Write failing request-construction tests**

```ts
test("posts an event with the Worker bearer secret", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const transport = createFetchIngressTransport(validConfig, async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ jobId: "job-1" }), { status: 202 });
  });
  await expect(transport?.send(baseEvent, new AbortController().signal)).resolves.toEqual({
    status: 202, body: { jobId: "job-1" }
  });
  expect(calls[0]).toMatchObject({
    url: "https://worker.example/v1/jobs",
    init: { method: "POST", headers: { Authorization: "Bearer secret", "content-type": "application/json" } }
  });
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(baseEvent);
});

test.each([
  { url: undefined, sharedSecret: "secret" },
  { url: "https://worker.example/v1/jobs", sharedSecret: "" },
  { url: "not a URL", sharedSecret: "secret" }
])("returns null for unusable configuration", (config) => {
  expect(createFetchIngressTransport(config, failingFetch)).toBeNull();
});
```

- [ ] **Step 2: Run the test in red state**

Run: `pnpm --filter @reliable-drive-sync/mcp-server test -- fetch-ingress.test.ts`

Expected: FAIL because the transport module and factory do not exist.

- [ ] **Step 3: Implement the smallest transport**

```ts
export function createFetchIngressTransport(
  config: { url?: string; sharedSecret?: string },
  fetchImpl: typeof fetch = fetch
): IngressTransport | null {
  const url = config.url?.trim();
  const sharedSecret = config.sharedSecret?.trim();
  if (!url || !sharedSecret) return null;
  try { new URL(url); } catch { return null; }
  return {
    async send(event, signal) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${sharedSecret}`, "content-type": "application/json" },
        body: JSON.stringify(event),
        signal
      });
      let body: unknown = null;
      try { body = await response.json(); } catch { /* malformed body remains non-acknowledgeable */ }
      return { status: response.status, body };
    }
  };
}
```

- [ ] **Step 4: Add response and cancellation coverage**

```ts
test("returns null body for a non-JSON response", async () => {
  const transport = createFetchIngressTransport(validConfig, async () => new Response("busy", { status: 503 }));
  await expect(transport?.send(baseEvent, new AbortController().signal)).resolves.toEqual({ status: 503, body: null });
});

test("passes the Outbox deadline signal into fetch", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const transport = createFetchIngressTransport(validConfig, async (_url, init) => {
    received = init?.signal as AbortSignal;
    return new Response(JSON.stringify({ jobId: "job-1" }), { status: 202 });
  });
  await transport?.send(baseEvent, controller.signal);
  expect(received).toBe(controller.signal);
});
```

- [ ] **Step 5: Verify green and commit**

Run: `pnpm --filter @reliable-drive-sync/mcp-server test -- fetch-ingress.test.ts`

Expected: PASS.

```bash
git add packages/mcp-server/src/fetch-ingress.ts packages/mcp-server/tests/fetch-ingress.test.ts
git commit -m "feat: add authenticated Worker ingress transport"
```

### Task 2: Select the transport from local configuration

**Files:**

- Modify: `packages/mcp-server/src/index.ts`
- Modify: `packages/mcp-server/tests/fetch-ingress.test.ts`
- Modify: `.env.example`

**Interfaces:**

- Consumes `createFetchIngressTransport({ url, sharedSecret }, fetchImpl)`.
- Produces `ingressTransportFromEnvironment(env, fetchImpl): IngressTransport`.
- Reads exactly `RELIABLE_DRIVE_SYNC_INGRESS_URL` and `RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET`.

- [ ] **Step 1: Write the failing configuration-gate test**

```ts
test("enables ingress only with both local values", () => {
  expect(ingressTransportFromEnvironment({
    RELIABLE_DRIVE_SYNC_INGRESS_URL: "https://worker.example/v1/jobs",
    RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET: "secret"
  }, fakeFetch)).toBeDefined();
  expect(ingressTransportFromEnvironment({
    RELIABLE_DRIVE_SYNC_INGRESS_URL: "https://worker.example/v1/jobs"
  }, fakeFetch)).toThrow(/not configured/);
});
```

- [ ] **Step 2: Run the test in red state**

Run: `pnpm --filter @reliable-drive-sync/mcp-server test -- fetch-ingress.test.ts`

Expected: FAIL because `ingressTransportFromEnvironment` is not exported.

- [ ] **Step 3: Implement selection while preserving the disabled fallback**

```ts
export function ingressTransportFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): IngressTransport {
  return createFetchIngressTransport({
    url: env.RELIABLE_DRIVE_SYNC_INGRESS_URL,
    sharedSecret: env.RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET
  }, fetchImpl) ?? unavailableIngress();
}

const service = new SubmitEventService(outbox, ingressTransportFromEnvironment());
```

Keep `unavailableIngress()` throwing: `SubmitEventService` catches that error and retains the SQLite Outbox record as `pending`.

- [ ] **Step 4: Document only non-secret configuration**

Append to `.env.example`:

```dotenv
RELIABLE_DRIVE_SYNC_INGRESS_URL=https://reliable-drive-sync.qiaobingyuan886.workers.dev/v1/jobs
RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET=
```

- [ ] **Step 5: Run all code verification and commit**

Run:

```bash
pnpm --filter @reliable-drive-sync/mcp-server test
pnpm typecheck
pnpm test
pnpm build
pnpm verify:build
git diff --check
```

Expected: all commands pass.

```bash
git add packages/mcp-server/src/index.ts packages/mcp-server/tests/fetch-ingress.test.ts .env.example
git commit -m "feat: configure MCP cloud ingress from environment"
```

### Task 3: Provision and validate the ingress secret

**Files:**

- Modify: Cloudflare encrypted Secret store only.
- Modify: local Codex MCP configuration only.

**Interfaces:**

- Worker reads `INGRESS_SHARED_SECRET`.
- Local MCP process reads that identical value as `RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET`.

- [ ] **Step 1: Generate a random secret without logging it**

```powershell
$secret = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
Set-Clipboard -Value $secret
```

- [ ] **Step 2: Store it as a Cloudflare secret**

Run: `pnpm exec wrangler secret put INGRESS_SHARED_SECRET --config packages/workers/wrangler.toml`

Expected: paste from the clipboard at Wrangler's hidden prompt and receive a success response.

- [ ] **Step 3: Add local MCP variables without tracking a file**

Set `RELIABLE_DRIVE_SYNC_INGRESS_URL` to `https://reliable-drive-sync.qiaobingyuan886.workers.dev/v1/jobs`. Set `RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET` to the same clipboard value in the Codex MCP server configuration.

- [ ] **Step 4: Check unauthenticated access is rejected**

Run: `Invoke-WebRequest -Method Post -Uri 'https://reliable-drive-sync.qiaobingyuan886.workers.dev/v1/jobs' -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck`

Expected: HTTP `401`.

- [ ] **Step 5: Check the end-to-end accepted path**

Restart Codex to load the two local variables, then call MCP `submit_event` with a non-sensitive synthetic event.

Expected: `accepted: true`, `deliveryState: "cloud_accepted"`, a D1 job, and one QStash log entry. A missing Drive OAuth setup may generate a recoverable downstream notice but cannot invalidate ingress acceptance.

## Plan Self-Review

- Task 1 covers request construction, response parsing, invalid configuration, and abort propagation.
- Task 2 covers environment selection, disabled fallback, documentation, and whole-project verification.
- Task 3 covers secret equality across trust boundaries and a safe operational smoke test.
- Names and signatures are consistent with existing `IngressTransport.send(event, signal)`.
