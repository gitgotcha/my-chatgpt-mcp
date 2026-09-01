import { rebuildAlgorithmProfile } from "./algorithm-profile-model.js";

const hasOnlyParent = (file, parentId) => Array.isArray(file?.parents) && file.parents.length === 1 && file.parents[0] === parentId;
const snapshotName = (generatedAt, headEventId) =>
  `snapshot-${String(generatedAt).replace(/[:.]/g, "-")}-${headEventId ?? "00000000-0000-4000-8000-000000000000"}.json`;

export function createAlgorithmStore({ eventStore, layout, drive, now = () => new Date().toISOString() }) {
  if (!eventStore?.appendEvent || !eventStore?.listVerifiedEvents) throw new Error("invalid_algorithm_store");
  if (!layout?.ensureDomainPath) throw new Error("invalid_algorithm_store");
  if (!drive?.createJson || !drive?.readJson || !drive?.listJson) throw new Error("invalid_algorithm_store");

  async function saveSnapshot(identity, profile) {
    const folder = await layout.ensureDomainPath(identity.userId, "algorithm", ["profile", "snapshots"]);
    const name = snapshotName(profile.generatedAt, profile.headEventId);
    const created = await drive.createJson(folder.id, name, profile);
    const read = await drive.readJson(created.id);
    if (!read || read.id !== created.id || read.name !== name || !hasOnlyParent(read, folder.id)
      || JSON.stringify(read.value) !== JSON.stringify(profile)) throw new Error("snapshot_readback_failed");
    return { fileId: read.id, name: read.name };
  }

  async function submitLearning(identity, event) {
    const appended = await eventStore.appendEvent(identity, event);
    try {
      const verified = await eventStore.listVerifiedEvents(identity);
      const profile = rebuildAlgorithmProfile(verified, { now });
      const snapshotReceipt = await saveSnapshot(identity, profile);
      return {
        status: "ok",
        event: appended.event,
        receipt: appended.receipt,
        data: { profile, snapshotReceipt }
      };
    } catch (cause) {
      console.error("algorithm_snapshot_failed", cause instanceof Error ? cause.message : String(cause));
      return {
        status: "profile_cache_pending",
        event: appended.event,
        receipt: appended.receipt,
        data: { profileRebuildRequired: true }
      };
    }
  }

  async function createDailyPlan(identity, event) {
    const folder = await layout.ensureDomainPath(identity.userId, "algorithm", ["plans", "daily"]);
    const name = `daily-plan-${event.localDate}-${event.planId}.json`;
    const listed = await drive.listJson(folder.id);
    const existing = listed.find((file) => file.name === name);
    if (existing) {
      const read = await drive.readJson(existing.id);
      if (read && hasOnlyParent(read, folder.id)) {
        return {
          status: "ok",
          event,
          receipt: { fileId: read.id, name: read.name, reused: true },
          data: { plan: read.value }
        };
      }
    }
    const appended = await eventStore.appendEvent(identity, event);
    const created = await drive.createJson(folder.id, name, appended.event);
    const read = await drive.readJson(created.id);
    if (!read || read.id !== created.id || read.name !== name || !hasOnlyParent(read, folder.id)) {
      throw new Error("plan_readback_failed");
    }
    return {
      status: "ok",
      event: appended.event,
      receipt: { fileId: read.id, name: read.name, reused: false },
      data: { plan: read.value }
    };
  }

  return { submitLearning, createDailyPlan };
}
