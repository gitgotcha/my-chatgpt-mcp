const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGISTRATION = /^registration-([0-9a-f-]+)\.json$/i;
export const IDENTITY_FILENAME = "identity.json";

const isUuid = (value) => typeof value === "string" && UUID.test(value);
const hasOnlyParent = (file, parentId) => Array.isArray(file?.parents) && file.parents.length === 1 && file.parents[0] === parentId;

export function normalizeDisplayName(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

export function createUserStore({ layout, drive, now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() } = {}) {
  if (!layout?.ensureUserRoot || !layout?.ensureRegistry) throw new Error("invalid_layout");
  if (!drive?.rootFolderId) throw new Error("invalid_drive");

  const identityOf = (userId, displayName) => ({ userId, displayName, nameKey: displayName, verified: true });

  async function registryFiles() {
    const registry = await layout.findRegistry();
    if (!registry) return { registry: null, files: [] };
    const files = (await drive.listJson(registry.id)).filter((file) => REGISTRATION.test(file.name));
    return { registry, files };
  }

  function validRegistration(file, registryId) {
    const record = file?.value;
    const filename = REGISTRATION.exec(file?.name ?? "");
    const name = normalizeDisplayName(record?.displayName);
    return Boolean(filename && record
      && filename[1].toLowerCase() === record.userId?.toLowerCase()
      && hasOnlyParent(file, registryId)
      && record.schemaVersion === "1.2"
      && record.status === "active"
      && isUuid(record.userId)
      && name.length > 0
      && record.displayName === name
      && record.nameKey === name
      && typeof record.createdAt === "string"
      && record.createdAt.length > 0);
  }

  async function listRegistrations() {
    const { registry, files } = await registryFiles();
    if (!registry) return [];
    const records = await Promise.all(files.map(async (file) => {
      const read = await drive.readJson(file.id);
      return validRegistration(read, registry.id) ? read.value : null;
    }));
    return records.filter(Boolean).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async function readIdentity(userId) {
    const userRoot = await layout.findUserRoot(userId);
    if (!userRoot) return null;
    const matches = (await drive.listJson(userRoot.id)).filter((file) => file.name === IDENTITY_FILENAME);
    if (matches.length !== 1) return null;
    const read = await drive.readJson(matches[0].id);
    const record = read?.value;
    if (!hasOnlyParent(read, userRoot.id)) return null;
    if (record?.schemaVersion !== "1.2" || record.userId !== userId) return null;
    const name = normalizeDisplayName(record.displayName);
    if (!name || record.displayName !== name || record.nameKey !== name) return null;
    if (typeof record.createdAt !== "string" || !record.createdAt.length) return null;
    return { file: read, identity: identityOf(userId, name), fileId: read.id };
  }

  async function verify({ userId, displayName } = {}) {
    const name = normalizeDisplayName(displayName);
    if (!name) throw new Error("invalid_display_name");
    if (!isUuid(userId)) throw new Error("identity_mismatch");

    const registrations = await listRegistrations();
    const byName = registrations.filter((record) => record.displayName === name);
    if (byName.length > 1) throw new Error("user_conflict");
    const byId = registrations.filter((record) => record.userId === userId);
    if (byId.length > 1) throw new Error("user_conflict");
    if (byName.length === 1 && byName[0].userId !== userId) throw new Error("identity_mismatch");
    if (byId.length === 1 && byId[0].displayName !== name) throw new Error("identity_mismatch");
    if (byName.length === 0) throw new Error("identity_mismatch");

    const stored = await readIdentity(userId);
    if (!stored || stored.identity.displayName !== name) throw new Error("identity_mismatch");
    return { status: "ok", identity: stored.identity };
  }

  async function resolveOrCreate({ displayName, preferredUserId } = {}) {
    const name = normalizeDisplayName(displayName);
    if (!name) throw new Error("invalid_display_name");
    if (preferredUserId !== undefined && !isUuid(preferredUserId)) throw new Error("invalid_user_id");

    const registrations = await listRegistrations();
    const byName = registrations.filter((record) => record.displayName === name);
    if (byName.length > 1) throw new Error("user_conflict");

    if (byName.length === 1) {
      const record = byName[0];
      if (preferredUserId !== undefined && preferredUserId !== record.userId) throw new Error("identity_mismatch");
      const stored = await readIdentity(record.userId);
      if (!stored || stored.identity.displayName !== name) throw new Error("identity_mismatch");
      return { status: "ok", ...stored.identity, identity: stored.identity };
    }

    if (preferredUserId !== undefined && registrations.some((record) => record.userId === preferredUserId)) {
      throw new Error("user_conflict");
    }

    const userId = preferredUserId ?? uuid();
    if (!isUuid(userId)) throw new Error("invalid_user_id");

    const userRoot = await layout.ensureUserRoot(userId);
    const createdAt = now();
    await drive.createJson(userRoot.id, IDENTITY_FILENAME, {
      schemaVersion: "1.2", userId, displayName: name, nameKey: name, createdAt
    });
    const stored = await readIdentity(userId);
    if (!stored || stored.identity.displayName !== name || stored.file.name !== IDENTITY_FILENAME) {
      throw new Error("identity_readback_failed");
    }

    const registry = await layout.ensureRegistry();
    const registration = await drive.createJson(registry.id, `registration-${userId}.json`, {
      schemaVersion: "1.2", userId, displayName: name, nameKey: name, status: "active", createdAt
    });
    if (!validRegistration(registration, registry.id) || registration.value.userId !== userId) {
      throw new Error("registration_readback_failed");
    }

    const identity = identityOf(userId, name);
    return { status: "ok", ...identity, identity };
  }

  return { listRegistrations, resolveOrCreate, verify };
}
