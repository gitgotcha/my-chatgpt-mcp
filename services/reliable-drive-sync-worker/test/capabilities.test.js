import assert from "node:assert/strict";
import test from "node:test";
import { GENERIC_PROFILE_EVENT_TYPES, capabilitiesFor } from "../src/capabilities.js";

test("capabilitiesFor reports the exact enabled contract", () => {
  assert.deepEqual(capabilitiesFor({ GENERIC_PROFILE_ENABLED: "true" }), {
    status: "ok",
    data: {
      protocolRevision: "2026-09-01",
      genericProfile: {
        enabled: true,
        eventTypes: [
          "system.user.resolve",
          "profile.evidence.recorded",
          "profile.snapshot.read"
        ]
      },
      receiptSemantics: {
        pending: "local_outbox",
        cloud_accepted: "cloud_outbox_drive_pending"
      }
    }
  });
});

test("capabilitiesFor reports disabled for missing, empty and non-true values", () => {
  for (const env of [{}, { GENERIC_PROFILE_ENABLED: "false" }, { GENERIC_PROFILE_ENABLED: "" }, { GENERIC_PROFILE_ENABLED: "TRUE" }, { GENERIC_PROFILE_ENABLED: "1" }]) {
    const capabilities = capabilitiesFor(env);
    assert.equal(capabilities.status, "ok");
    assert.equal(capabilities.data.genericProfile.enabled, false);
    assert.deepEqual(capabilities.data.genericProfile.eventTypes, []);
    assert.deepEqual(capabilities.data.receiptSemantics, {
      pending: "local_outbox",
      cloud_accepted: "cloud_outbox_drive_pending"
    });
  }
});

test("the capability event list is frozen and separate from the published copy", () => {
  assert.ok(Object.isFrozen(GENERIC_PROFILE_EVENT_TYPES));
  const first = capabilitiesFor({ GENERIC_PROFILE_ENABLED: "true" });
  first.data.genericProfile.eventTypes.push("tampered");
  const second = capabilitiesFor({ GENERIC_PROFILE_ENABLED: "true" });
  assert.deepEqual(second.data.genericProfile.eventTypes, [...GENERIC_PROFILE_EVENT_TYPES]);
});
