# Google Drive Production Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure the deployed Worker to persist immutable events and snapshots to dedicated Google Drive folders using a renewable OAuth token.

**Architecture:** A dedicated Google account owns a Drive root and two child folders. Cloudflare Workers receives non-secret folder IDs as variables and renews a Google access token from OAuth client credentials plus a refresh token stored only in Workers Secrets. Existing D1, QStash, Worker URL, and local MCP configuration remain unchanged.

**Tech Stack:** Google Cloud Console, Google Drive API, Google OAuth 2.0, OAuth Playground, Cloudflare Workers Variables and Secrets, D1, QStash.

## Global Constraints

- Use the dedicated Google account for the Drive root and OAuth consent; never use a personal production Drive accidentally.
- Use scope `https://www.googleapis.com/auth/drive` because the Worker must list/read/write inside manually created parent folders.
- Never paste `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, or an access token into Git, `wrangler.toml`, `.env.example`, terminal output, or chat.
- Store only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` as Cloudflare Secrets.
- Store only `DRIVE_EVENTS_PARENT_ID` and `DRIVE_SNAPSHOTS_PARENT_ID` as plain Cloudflare variables.
- The deployed Worker URL is `https://reliable-drive-sync.qiaobingyuan886.workers.dev`.
- Do not delete earlier `dispatching` D1 jobs; their safety fence is intentional.

---

### Task 1: Create the Google Cloud project and enable Drive API

**Files:**
- Read: `docs/superpowers/specs/2026-08-12-google-drive-production-config-design.md`
- No repository files change.

**Interfaces:**
- Consumes: the dedicated Google account selected by the operator.
- Produces: one Google Cloud project with Google Drive API enabled.

- [ ] **Step 1: Open the Google Cloud Console**

Open `https://console.cloud.google.com/` while signed in to the dedicated Google account. Use the project picker → **New Project**. Choose a clear name such as `Reliable Drive Sync`; record neither credentials nor tokens.

- [ ] **Step 2: Enable Google Drive API**

Within that project, open **APIs & Services → Library**, search for `Google Drive API`, open it, then select **Enable**.

- [ ] **Step 3: Verify the API is enabled**

Open **APIs & Services → Enabled APIs & services**. Expected result: `Google Drive API` appears in the enabled list. Do not continue if it is absent.

### Task 2: Establish explicit Drive storage boundaries

**Files:**
- Read: `docs/superpowers/specs/2026-08-12-google-drive-production-config-design.md`
- No repository files change.

**Interfaces:**
- Consumes: the dedicated Google Drive account.
- Produces: `DRIVE_EVENTS_PARENT_ID` and `DRIVE_SNAPSHOTS_PARENT_ID` values.

- [ ] **Step 1: Create the root folder**

In Google Drive, create one folder named `Reliable Drive Sync`.

- [ ] **Step 2: Create child folders**

Inside that root, create folders exactly named `events` and `snapshots`. Do not place ordinary personal files in either folder.

- [ ] **Step 3: Copy each child folder ID**

Open `events`; its address has the form `https://drive.google.com/drive/folders/<FOLDER_ID>`. Copy only the value after `/folders/` as `DRIVE_EVENTS_PARENT_ID`. Repeat for `snapshots` as `DRIVE_SNAPSHOTS_PARENT_ID`.

- [ ] **Step 4: Verify folder isolation**

Expected result: both folders are empty children of `Reliable Drive Sync`; the two IDs are different. IDs are configuration values, not passwords, but still avoid posting them publicly.

### Task 3: Create renewable OAuth credentials

**Files:**
- Read: `docs/superpowers/specs/2026-08-12-google-drive-production-config-design.md`
- No repository files change.

**Interfaces:**
- Consumes: Google Cloud project from Task 1.
- Produces: a Client ID, Client Secret, and refresh token that all belong to the same Google Cloud project.

- [ ] **Step 1: Configure the OAuth consent screen**

Open **APIs & Services → OAuth consent screen**. Choose the audience requested by Google for the account, fill the minimum app name/support email/developer contact fields, and add the dedicated Google account as a test user if the console shows a testing stage.

- [ ] **Step 2: Add the Drive scope**

In the consent-screen scope editor, add `https://www.googleapis.com/auth/drive`. This grants access to the dedicated Drive account; do not grant it from another account.

- [ ] **Step 3: Create a Web OAuth client**

Open **APIs & Services → Credentials → Create Credentials → OAuth client ID**. Select **Web application**. Add exactly this authorized redirect URI:

```text
https://developers.google.com/oauthplayground
```

Save, then keep the Client ID and Client Secret private for the next step.

- [ ] **Step 4: Issue a refresh token through OAuth Playground**

Open `https://developers.google.com/oauthplayground/`. Select the gear icon, check **Use your own OAuth credentials**, enter the Client ID and Client Secret, then close settings. In Step 1, enter `https://www.googleapis.com/auth/drive`, select **Authorize APIs**, sign into the dedicated Google account, select **Exchange authorization code for tokens**, and copy only the resulting refresh token for the Cloudflare secret field.

- [ ] **Step 5: Set the consent screen to Production before long-term use**

Return to OAuth consent screen and complete the Production publishing action offered by Google. If Google blocks publishing pending verification, stop and report the exact console message; do not work around it. Testing-mode refresh tokens using this Drive scope expire after roughly seven days.

- [ ] **Step 6: Verify credential boundaries**

Expected result: the client fields and refresh token exist only in the Google Console/Playground UI and the operator's secure clipboard. They must not be written to this repository or sent in chat.

### Task 4: Bind Drive configuration to the deployed Worker

**Files:**
- Read: `packages/workers/src/drive-adapter.ts`
- Read: `.env.example`
- No source-code modification is expected.

**Interfaces:**
- Consumes: folder IDs from Task 2 and OAuth values from Task 3.
- Produces: a deployed Worker with all five Drive bindings available at runtime.

- [ ] **Step 1: Add plain folder variables**

In Cloudflare Dashboard → **Workers & Pages → reliable-drive-sync → Settings → Variables and Secrets**, add two **Text** variables:

```text
DRIVE_EVENTS_PARENT_ID=<events folder ID>
DRIVE_SNAPSHOTS_PARENT_ID=<snapshots folder ID>
```

Save and deploy the new configuration.

- [ ] **Step 2: Add OAuth secrets**

In the same page, add three **Secret** variables:

```text
GOOGLE_CLIENT_ID=<OAuth Client ID>
GOOGLE_CLIENT_SECRET=<OAuth Client Secret>
GOOGLE_REFRESH_TOKEN=<OAuth refresh token>
```

Save and deploy. Cloudflare must display secret values as write-only after saving; never replace a value merely to check it.

- [ ] **Step 3: Verify binding names exactly**

Expected variables are `DRIVE_EVENTS_PARENT_ID`, `DRIVE_SNAPSHOTS_PARENT_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN`. A misspelled name behaves as missing configuration and returns retryable 503 rather than writing a Drive file.

### Task 5: End-to-end verification and safe observation

**Files:**
- Read: `docs/portable-codex-mcp-setup.md`
- No repository files change unless a configuration defect is found.

**Interfaces:**
- Consumes: deployed bindings from Task 4 and existing local MCP ingress environment.
- Produces: one auditable `synced` job plus matching Drive event and snapshot files.

- [ ] **Step 1: Submit one new, non-sensitive test event**

Use a new algorithm-learning event from the local MCP after restarting Codex, or submit a deliberately non-sensitive test event. Do not reuse an old `dispatching` job.

- [ ] **Step 2: Check the D1 job state**

In Cloudflare D1 Console, inspect the newly created job. Expected progression: `broker_queued` then `synced`. While Google Drive is unavailable, it may stay queued/retry; it must not disappear.

- [ ] **Step 3: Check Drive output**

Open the `events` and `snapshots` folders. Expected result: a new immutable event JSON appears in `events`; a valid aggregate snapshot JSON appears in `snapshots`.

- [ ] **Step 4: Record failure symptoms without exposing secrets**

If the job reaches `needs_attention`, record only its state and non-secret error code. Do not copy HTTP authorization headers, tokens, client secrets, or refresh tokens into screenshots or chat.

- [ ] **Step 5: Complete acceptance**

Acceptance passes only if a newly submitted event is present in both correct Drive locations and the corresponding D1 job is `synced`.
