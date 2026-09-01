// Side-effect-free capability descriptor for `system.capabilities.read`.
// Building this answer must never touch Drive, D1 or any identity store, so
// old runtimes and new skills can negotiate support before anything else.
export const GENERIC_PROFILE_EVENT_TYPES = Object.freeze([
  "system.user.resolve",
  "profile.evidence.recorded",
  "profile.snapshot.read"
]);

export function capabilitiesFor(env = {}) {
  const enabled = env.GENERIC_PROFILE_ENABLED === "true";
  return {
    status: "ok",
    data: {
      protocolRevision: "2026-09-01",
      genericProfile: {
        enabled,
        eventTypes: enabled ? [...GENERIC_PROFILE_EVENT_TYPES] : []
      },
      receiptSemantics: {
        pending: "local_outbox",
        cloud_accepted: "cloud_outbox_drive_pending"
      }
    }
  };
}
