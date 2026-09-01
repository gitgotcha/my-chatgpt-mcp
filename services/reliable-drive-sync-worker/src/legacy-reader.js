// Read-only adapter for the pre-normalization namespace directories.
//
// The only canonical write target is DriveRoot/my-chatGPT-skills/. Historical
// data below `algorithm/` and `interview/` must stay readable during the
// migration window, but it may never be created, updated, moved or deleted
// from here.
export const LEGACY_DOMAINS = ["algorithm", "interview"];

const LEGACY_PATHS = [["events"], ["profile", "snapshots"]];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGISTRATION = /^registration-([0-9a-f-]+)\.json$/i;

const sameSegments = (left, right) => left.length === right.length && left.every((part, index) => part === right[index]);
const hasOnlyParent = (file, parentId) => Array.isArray(file?.parents) && file.parents.length === 1 && file.parents[0] === parentId;
const allowedSegments = (segments) => segments.length === 0
  || LEGACY_PATHS.some((candidate) => sameSegments(candidate, segments));

export function createLegacyReader({ drive } = {}) {
  if (!drive?.rootFolderId || !drive.findFolder || !drive.listJson || !drive.readJson) {
    throw new Error("invalid_drive");
  }

  const find = (parentId, name) => (parentId ? drive.findFolder(parentId, name) : null);
  const wait = (value) => (value && typeof value.then === "function" ? value : Promise.resolve(value));

  async function resolve(parentPromise, name) {
    const parent = await wait(parentPromise);
    if (!parent) return null;
    return wait(find(parent.id, name));
  }

  function assertDomain(domain) {
    if (!LEGACY_DOMAINS.includes(domain)) throw new Error("legacy_read_only");
    return domain;
  }

  async function domainRoot(domain) {
    return resolve(Promise.resolve({ id: drive.rootFolderId }), assertDomain(domain));
  }

  async function userRoot(domain, userId) {
    if (typeof userId !== "string" || !UUID.test(userId)) throw new Error("legacy_read_only");
    const users = await resolve(domainRoot(domain), "users");
    return resolve(Promise.resolve(users), userId);
  }

  async function registry(domain) {
    return resolve(domainRoot(assertDomain(domain)), "user-registry");
  }

  async function path({ domain, userId, segments = [], create = false } = {}) {
    if (create) throw new Error("legacy_read_only");
    assertDomain(domain);
    if (!Array.isArray(segments) || !allowedSegments(segments)) throw new Error("legacy_read_only");
    let parent = await userRoot(domain, userId);
    if (!parent) return null;
    for (const segment of segments) {
      parent = await resolve(Promise.resolve(parent), segment);
      if (!parent) return null;
    }
    return parent;
  }

  async function listEvents(domain, userId) {
    const folder = await path({ domain, userId, segments: ["events"] });
    return folder ? drive.listJson(folder.id) : [];
  }

  // The historical namespace registries are the only way to associate a name
  // with the user id it used to have before the global registry existed.
  async function registrations(domain) {
    const folder = await registry(assertDomain(domain));
    if (!folder) return [];
    const files = (await drive.listJson(folder.id)).filter((file) => REGISTRATION.test(file.name));
    const records = [];
    for (const file of files) {
      const read = await drive.readJson(file.id);
      if (!read || read.name !== file.name || !hasOnlyParent(read, folder.id)) continue;
      const record = read.value;
      if (!record || !UUID.test(String(record.userId ?? ""))) continue;
      // A registration file is only trusted when its name and payload agree.
      const named = REGISTRATION.exec(file.name)?.[1];
      if (!named || named.toLowerCase() !== String(record.userId).toLowerCase()) continue;
      records.push(record);
    }
    return records.sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
  }

  return {
    domains: [...LEGACY_DOMAINS],
    path,
    registry,
    registrations,
    listEvents,
    listJson: (folderId) => drive.listJson(folderId),
    readJson: (fileId) => drive.readJson(fileId)
  };
}
