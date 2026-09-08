import { readFile } from "node:fs/promises";

const DEFAULT_WORKER_URL = "https://reliable-drive-sync.qiaobingyuan886.workers.dev";

function canaryError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseAllowlist(value) {
  if (!nonEmpty(value)) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * Parse the intentionally explicit canary mode. There is no implicit remote
 * default: an operator must choose --local or --remote.
 */
export function parseCanaryArgs(argv = []) {
  const args = Array.from(argv);
  const modeFlags = args.filter((arg) => arg === "--local" || arg === "--remote");
  if (modeFlags.length !== 1) throw canaryError("canary_mode_required");
  const mode = modeFlags[0].slice(2);
  const result = { mode };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!["--url", "--credential", "--user-id", "--event-file"].includes(arg)) continue;
    const value = args[index + 1];
    if (!nonEmpty(value) || value.startsWith("--")) {
      throw canaryError("canary_argument_value_required", `${arg} requires a value`);
    }
    const key = arg.slice(2).replaceAll("-", "_");
    result[key] = value;
    index += 1;
  }
  result.confirmRemote = args.includes("--confirm-remote");
  return result;
}

/**
 * Resolve the only legal V2 write destination. Once a V2 write has been
 * accepted, silently falling back to the V1 endpoint could create a second
 * business event and is therefore rejected as a configuration error.
 */
export function resolveWritePath({ writeVersion = "v1", accepted = false, fallback } = {}) {
  if (writeVersion === "v2" && fallback === "v1") {
    throw canaryError("v2_write_fallback_forbidden");
  }
  if (writeVersion === "v2") return "/v2/events";
  if (writeVersion === "v1") return "/v1/sync";
  throw canaryError("unsupported_write_version");
}

function requireCredentials(env) {
  if (!nonEmpty(env?.RDS2_CANARY_CREDENTIAL)) {
    throw canaryError("canary_credentials_required");
  }
  const allowedUserIds = parseAllowlist(env.RDS2_ALLOWED_USER_IDS);
  if (allowedUserIds.length === 0) throw canaryError("canary_allowlist_required");
  return { credential: env.RDS2_CANARY_CREDENTIAL.trim(), allowedUserIds };
}

function remoteOptions(parsed, env) {
  const credential = parsed.credential ?? env.RDS2_CANARY_CREDENTIAL;
  const userId = parsed.user_id ?? env.RDS2_CANARY_USER_ID;
  const url = parsed.url ?? env.RDS2_CANARY_URL ?? DEFAULT_WORKER_URL;
  if (!nonEmpty(credential) || !nonEmpty(userId) || !nonEmpty(url)) {
    throw canaryError("remote_canary_arguments_required");
  }
  const allowedUserIds = parseAllowlist(env.RDS2_ALLOWED_USER_IDS);
  if (allowedUserIds.length === 0) throw canaryError("canary_allowlist_required");
  if (!allowedUserIds.includes(userId.trim())) throw canaryError("canary_user_not_allowed");
  if (!parsed.confirmRemote && env.RDS2_CANARY_CONFIRM !== "YES") {
    throw canaryError("remote_canary_confirmation_required");
  }
  if (!nonEmpty(parsed.event_file ?? env.RDS2_CANARY_EVENT_FILE)) {
    throw canaryError("remote_canary_event_file_required");
  }
  return { credential: credential.trim(), userId: userId.trim(), url: url.trim(), allowedUserIds,
    eventFile: parsed.event_file ?? env.RDS2_CANARY_EVENT_FILE };
}

/**
 * Execute a canary in a deliberately side-effect-free local mode, or an
 * explicitly confirmed remote mode. Local mode never constructs a Drive
 * client and never calls fetch; this makes it safe in CI and on a laptop.
 */
export async function runCanary({ argv = [], env = process.env, fetchImpl = globalThis.fetch,
  readFileImpl = readFile } = {}) {
  const parsed = parseCanaryArgs(argv);
  if (parsed.mode === "local") {
    const { allowedUserIds } = requireCredentials(env);
    return {
      mode: "local",
      outcome: "dry_run",
      allowedUserIds,
      requestId: "local-canary-request",
      eventId: "local-canary-event",
      jobId: null,
      cloudPersistence: "not_attempted",
      drivePersistence: "not_attempted"
    };
  }

  const options = remoteOptions(parsed, env);
  if (typeof fetchImpl !== "function") throw canaryError("fetch_unavailable");
  let envelope;
  try {
    envelope = JSON.parse(await readFileImpl(options.eventFile, "utf8"));
  } catch {
    throw canaryError("remote_canary_event_invalid");
  }
  const response = await fetchImpl(`${options.url.replace(/\/$/, "")}/v2/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.credential}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(envelope)
  });
  let receipt = null;
  try { receipt = await response.json(); } catch { /* preserve status-only evidence */ }
  return {
    mode: "remote",
    httpStatus: response.status,
    outcome: response.ok ? "accepted" : "rejected",
    requestId: receipt?.attemptedRequestId ?? envelope?.requestId ?? null,
    eventId: receipt?.eventId ?? envelope?.payload?.event?.eventId ?? null,
    jobId: receipt?.jobId ?? null,
    cloudPersistence: receipt?.cloudPersistence ?? "unknown",
    drivePersistence: "asynchronous"
  };
}

async function main() {
  try {
    const result = await runCanary({ argv: process.argv.slice(2) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: { code: error?.code ?? "canary_failed" } })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("rds2-canary.mjs")) await main();
