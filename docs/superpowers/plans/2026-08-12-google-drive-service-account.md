# Google Drive Service Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the deployed Cloudflare Worker write immutable Drive event and snapshot JSON using a least-privilege Google service account instead of a user OAuth refresh token.

**Architecture:** Add a focused service-account credential boundary that signs RS256 JWT bearer assertions with Worker Web Crypto and exchanges them for cached short-lived Google access tokens. Inject that boundary into the existing Drive REST capability without changing the event/snapshot adapter or the D1/QStash state machine. Operators share only the two configured Drive folders with the service-account email and put the PEM private key only in a Cloudflare Secret.

**Tech Stack:** TypeScript, Cloudflare Workers Web Crypto, Vitest, Google OAuth 2.0 JWT bearer grant, Google Drive REST API, Cloudflare Workers Variables and Secrets.

## Global Constraints

- Use `GOOGLE_SERVICE_ACCOUNT_EMAIL` as a Cloudflare Text variable and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` only as a Cloudflare Secret.
- Preserve `DRIVE_EVENTS_PARENT_ID=1ZZRD4a1Z93NT1OGKbRkLPu13TsHbDsF8` and `DRIVE_SNAPSHOTS_PARENT_ID=1bAokejGSIdn2oLCWPjDgSb3xbiX0r999` as Text variables.
- Never write, print, snapshot, commit, or send a service-account JSON key, private key, access token, client secret, or refresh token.
- When both service-account bindings are present, service-account authentication takes precedence. If exactly one is present, return retryable `drive_configuration_unavailable` and do not fall back to OAuth.
- Preserve compatibility with the existing explicit access-token and refresh-token code paths when neither service-account binding is set.
- Request `https://www.googleapis.com/auth/drive` only in the signed service-account assertion; the Drive ACL must be limited to the two shared child folders.
- Keep the existing D1 job state machine, QStash verification, immutable-event readback, snapshot validation, and 64-entry LRU cache behavior intact.
- Use TDD: run the targeted test red before each implementation step, then run the full suite, `pnpm typecheck`, `pnpm build`, `pnpm verify:build`, and `git diff --check` before claiming completion.

---

## File Structure

- Create: `packages/workers/src/service-account.ts` — encode/sign service-account JWT assertions and exchange them for cached Google access tokens.
- Create: `packages/workers/tests/service-account.test.ts` — deterministic JWT grant, literal-newline PEM, cache, and error-classification tests.
- Modify: `packages/workers/src/drive-adapter.ts` — select service-account credentials first, classify incomplete configuration, and extend cache identity without retaining raw key values.
- Modify: `packages/workers/src/index.ts` — expose the two binding names in `WorkerConfig` / `Environment`.
- Modify: `.env.example` — add empty service-account variable names only.
- Create: `docs/google-drive-service-account-setup.md` — human-operated Google Cloud, Drive sharing, Cloudflare binding, deployment, key-revocation, and verification steps.
- Modify: `docs/superpowers/plans/2026-08-12-google-drive-production-configuration.md` — mark the OAuth-only operator plan superseded and link to the service-account setup guide.

### Task 1: Service-account JWT bearer credential boundary

**Files:**
- Create: `packages/workers/src/service-account.ts`
- Create: `packages/workers/tests/service-account.test.ts`

**Interfaces:**
- Consumes: `GoogleServiceAccountEnvironment` with `GOOGLE_SERVICE_ACCOUNT_EMAIL?: string` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string`; a fetch implementation; a clock.
- Produces: `GoogleServiceAccountCredential.token(): Promise<string>`.
- Produces: a thrown shape `{ status: number; configuration?: true }` so the Drive adapter can retain its existing outcome mapping.

- [ ] **Step 1: Write failing JWT-grant tests**

Create `packages/workers/tests/service-account.test.ts`. Generate an ephemeral RSA signing key with `crypto.subtle.generateKey`, export it as PKCS#8 PEM, and mock the Google token endpoint plus a Drive request. Decode the mocked form body's JWT payload without inspecting its signature. Assert issuer, audience, scope, `exp - iat === 3600`, grant type, cached token reuse, and bearer header:

```ts
it("signs a Google JWT bearer assertion and caches its access token", async () => {
  const key = await testPrivateKeyPem();
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const credential = new GoogleServiceAccountCredential(
    { GOOGLE_SERVICE_ACCOUNT_EMAIL: "sync@test.iam.gserviceaccount.com", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: key },
    async (input, init) => {
      calls.push([input, init]);
      return new Response(JSON.stringify({ access_token: "service-token", expires_in: 3600 }));
    },
    () => 1_700_000_000_000,
  );
  expect(await credential.token()).toBe("service-token");
  expect(await credential.token()).toBe("service-token");
  expect(calls).toHaveLength(1);
  const assertion = new URLSearchParams(String(calls[0][1]?.body)).get("assertion")!;
  expect(decodeJwtPayload(assertion)).toMatchObject({
    iss: "sync@test.iam.gserviceaccount.com",
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  });
});
```

Add cases for a PEM whose newlines were replaced by literal `\\n`, an incomplete email/key pair that makes no HTTP call and throws `{ status: 503, configuration: true }`, and token endpoint 429/503/401 that propagate their status without token logging.

- [ ] **Step 2: Run the new test to verify it fails**

Run: `pnpm --filter @reliable-drive-sync/workers test -- service-account.test.ts`

Expected: FAIL because `../src/service-account.js` and `GoogleServiceAccountCredential` do not exist.

- [ ] **Step 3: Implement minimal signed assertion exchange**

Create `packages/workers/src/service-account.ts` with the following exact public contract and private helpers:

```ts
export type GoogleServiceAccountEnvironment = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
};

export class GoogleServiceAccountCredential {
  private cached?: { token: string; expiresAt: number };
  constructor(
    private readonly env: GoogleServiceAccountEnvironment,
    private readonly fetchLike: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async token(): Promise<string> {
    // reject a missing or half-configured credential with { status: 503, configuration: true }
    // build base64url(JSON header) + '.' + base64url(JSON claims)
    // import normalized PKCS#8 PEM as RSASSA-PKCS1-v1_5 SHA-256 and sign it
    // POST URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
    // cache the returned token until now + expires_in seconds, with 60s early-refresh margin
  }
}
```

Use a UTF-8 `TextEncoder`, a base64url encoder that removes padding, and `crypto.subtle.importKey("pkcs8", ...)` followed by `crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, ...)`. Normalize a literal `\\n` to real newlines before stripping `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----`. Token responses missing a string `access_token` throw `{ status: 503 }`; non-2xx responses throw `{ status: response.status }`.

- [ ] **Step 4: Run targeted credential tests**

Run: `pnpm --filter @reliable-drive-sync/workers test -- service-account.test.ts`

Expected: PASS. The mock sees exactly one token call for two token reads, no test output includes PEM material, and all error cases are asserted by status/configuration shape.

- [ ] **Step 5: Commit the credential boundary**

```bash
git add packages/workers/src/service-account.ts packages/workers/tests/service-account.test.ts
git commit -m "feat: add service account Drive credential"
```

### Task 2: Integrate service account selection, outcomes, and cache isolation

**Files:**
- Modify: `packages/workers/src/drive-adapter.ts`
- Modify: `packages/workers/src/index.ts`
- Modify: `packages/workers/tests/drive-adapter.test.ts`

**Interfaces:**
- Consumes: `GoogleServiceAccountCredential` from Task 1.
- Consumes: `WorkerConfig.GOOGLE_SERVICE_ACCOUNT_EMAIL?: string` and `WorkerConfig.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string`.
- Produces: `createProductionDriveAdapter()` / `cachedProductionDriveAdapter()` that use service credentials when complete and never cross-reuse different identities.

- [ ] **Step 1: Write failing integration tests**

Append targeted tests to `packages/workers/tests/drive-adapter.test.ts`:

```ts
it("uses service-account token before any OAuth credential", async () => {
  // Mock token endpoint => { access_token: "service-token" } and Drive list => { files: [] }.
  // Provide all service-account fields plus GOOGLE_DRIVE_ACCESS_TOKEN: "must-not-be-used".
  // Assert Google Drive request Authorization is "Bearer service-token".
});

it("treats a partial service-account configuration as retryable without OAuth fallback", async () => {
  const adapter = createProductionDriveAdapter({
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "sync@test.iam.gserviceaccount.com",
    GOOGLE_DRIVE_ACCESS_TOKEN: "must-not-be-used",
    DRIVE_EVENTS_PARENT_ID: "events",
    DRIVE_SNAPSHOTS_PARENT_ID: "snapshots",
  });
  await expect(adapter.sync(event)).resolves.toMatchObject({
    kind: "retryable", code: "drive_configuration_unavailable",
  });
});

it("separates service-account adapter cache identities", () => {
  resetDriveAdapterCacheForTest();
  expect(cachedProductionDriveAdapter(serviceConfig("key-a")))
    .not.toBe(cachedProductionDriveAdapter(serviceConfig("key-b")));
});
```

Use an ephemeral PEM helper imported or duplicated from Task 1 only inside tests; do not introduce a static key fixture. Add 429, 5xx, and 401 integration assertions through `DriveDestinationAdapter.sync` so `problem()` returns existing retryable or permanent outcomes.

- [ ] **Step 2: Run integration tests to verify they fail**

Run: `pnpm --filter @reliable-drive-sync/workers test -- drive-adapter.test.ts`

Expected: FAIL because production configuration ignores service-account variables and incomplete service config falls through to the explicit OAuth access token.

- [ ] **Step 3: Wire the credential into the existing REST capability**

Modify `packages/workers/src/drive-adapter.ts`:

```ts
type DriveAuthEnvironment = GoogleServiceAccountEnvironment & {
  GOOGLE_DRIVE_ACCESS_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
};

private async token(): Promise<string> {
  const hasEmail = Boolean(this.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const hasKey = Boolean(this.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
  if (hasEmail !== hasKey) throw { status: 503, configuration: true };
  if (hasEmail && hasKey) return this.serviceCredential().token();
  // retain current explicit access-token and refresh-token branches unchanged
}
```

Add a lazily created `GoogleServiceAccountCredential` field so its token cache lives with `GoogleDriveCapability`. Extend both `createProductionDriveAdapter` and `cachedProductionDriveAdapter` environment types; include service email and private-key values in the already length-delimited SHA-256 cache input. Preserve the raw-key-free cache rule. In `problem()`, map `error.configuration === true` to `{ kind: "retryable", code: "drive_configuration_unavailable" }` before generic 5xx handling.

Modify `packages/workers/src/index.ts` to include both optional service-account fields in `WorkerConfig`; `Environment` inherits them. Do not change route dispatch or the D1/QStash interfaces.

- [ ] **Step 4: Run focused and full regression suites**

Run:

```bash
pnpm --filter @reliable-drive-sync/workers test -- service-account.test.ts drive-adapter.test.ts
pnpm test
pnpm typecheck
```

Expected: all new credential/integration cases pass; all existing Worker, MCP, Protocol, D1/QStash, and snapshot recovery tests remain green.

- [ ] **Step 5: Commit the integration**

```bash
git add packages/workers/src/drive-adapter.ts packages/workers/src/index.ts packages/workers/tests/drive-adapter.test.ts
git commit -m "feat: use service account for Drive sync"
```

### Task 3: Safe operator configuration and deployment documentation

**Files:**
- Modify: `.env.example`
- Create: `docs/google-drive-service-account-setup.md`
- Modify: `docs/superpowers/plans/2026-08-12-google-drive-production-configuration.md`

**Interfaces:**
- Consumes: deployed Worker `reliable-drive-sync`, Cloudflare dashboard, the two configured folder IDs, and the service-account binding names from Task 2.
- Produces: secret-safe repeatable setup instructions and a non-sensitive environment template.

- [ ] **Step 1: Write documentation assertions/checklist before editing**

Write a short checklist in the setup document draft that must be true after editing:

```text
[ ] Only GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is called a Cloudflare Secret.
[ ] GOOGLE_SERVICE_ACCOUNT_EMAIL, DRIVE_EVENTS_PARENT_ID, and DRIVE_SNAPSHOTS_PARENT_ID are called Text variables.
[ ] No key JSON, private-key example, OAuth token, or Client Secret is present.
[ ] The service-account email is shared as Editor only with events and snapshots.
[ ] The final verification requires a fresh event, D1 state synced, and JSON in both folders.
```

- [ ] **Step 2: Apply documentation and template changes**

In `.env.example`, add only:

```dotenv
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=
```

Create `docs/google-drive-service-account-setup.md` with exact UI flow: Google Cloud Console → IAM & Admin → Service Accounts → Create Service Account (`reliable-drive-sync-worker`) → Keys → Add key → Create new key → JSON; copy `client_email` and `private_key` directly into Cloudflare then remove the local download through the operating-system recycle bin. Explain Drive’s Share action twice: add the email to `events` and `snapshots`, role **Editor**, do not share the root. Include the exact five Cloudflare bindings and labels:

```text
Text:   GOOGLE_SERVICE_ACCOUNT_EMAIL
Secret: GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
Text:   DRIVE_EVENTS_PARENT_ID
Text:   DRIVE_SNAPSHOTS_PARENT_ID
```

Document the fresh-event/D1/Drive acceptance check and key rotation: create a new Google key, replace the Cloudflare Secret, deploy, validate one new event, then delete the old Google key. Mark the older OAuth configuration plan as superseded and link to this guide.

- [ ] **Step 3: Run a secret and documentation safety scan**

Run:

```bash
git grep -nE 'BEGIN (RSA )?PRIVATE KEY|"private_key"[[:space:]]*:' -- . ':!docs/superpowers/specs/*'
git diff --check
```

Expected: no private-key material or JSON key fixture is tracked; `git diff --check` is clean. Variable names are allowed, values are blank.

- [ ] **Step 4: Build verification**

Run:

```bash
pnpm build
pnpm verify:build
node packages/mcp-server/dist/index.js flush-pending
pnpm test
pnpm typecheck
git diff --check
```

Expected: build outputs Protocol/MCP only as before; no-config flush exits in a controlled state; all tests pass; no Workers deployment occurs in this task.

- [ ] **Step 5: Commit documentation**

```bash
git add .env.example docs/google-drive-service-account-setup.md docs/superpowers/plans/2026-08-12-google-drive-production-configuration.md
git commit -m "docs: add Drive service account setup"
```

### Task 4: Operator-only Cloudflare deployment and live acceptance

**Files:**
- Read: `docs/google-drive-service-account-setup.md`
- Read: `packages/workers/wrangler.toml`
- No source edit is expected.

**Interfaces:**
- Consumes: deployed worker URL `https://reliable-drive-sync.qiaobingyuan886.workers.dev`, D1/QStash configuration, Cloudflare bindings, and the local MCP ingress environment already configured on the operator computer.
- Produces: a live Drive-synced job validated without exposing credential contents.

- [ ] **Step 1: Create and share the service account**

Follow `docs/google-drive-service-account-setup.md` exactly. Keep the downloaded JSON key outside the repository. Share only `events` and `snapshots` with the service-account `client_email` as **Editor**.

- [ ] **Step 2: Enter Cloudflare values without echoing secrets**

In Cloudflare Dashboard → Workers & Pages → `reliable-drive-sync` → Settings → Variables and Secrets, set:

```text
Text:   GOOGLE_SERVICE_ACCOUNT_EMAIL
Secret: GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
Text:   DRIVE_EVENTS_PARENT_ID = 1ZZRD4a1Z93NT1OGKbRkLPu13TsHbDsF8
Text:   DRIVE_SNAPSHOTS_PARENT_ID = 1bAokejGSIdn2oLCWPjDgSb3xbiX0r999
```

Save/deploy configuration. Do not use a terminal command that includes the private key value; do not ask Cloudflare to display saved Secrets.

- [ ] **Step 3: Submit a new non-sensitive event and inspect its D1 state**

Restart Codex so the MCP server is fresh, submit a new harmless algorithm-learning event, then inspect only the new job in Cloudflare D1. Expected state sequence is `broker_queued` then `synced`. Do not replay pre-service-account `dispatching` records.

- [ ] **Step 4: Verify both Drive writes**

Confirm a new immutable event JSON exists in `events` and a matching valid snapshot JSON exists in `snapshots`. Record only job ID/state and non-secret error code if it fails. Do not download or paste credentials as evidence.

- [ ] **Step 5: Record acceptance and rotate if a key leaked**

Acceptance passes only for a new job with state `synced` and both Drive objects present. If the downloaded JSON key was exposed, immediately create a replacement key, update the Cloudflare Secret, validate a new event, then delete the exposed key in Google Cloud.
