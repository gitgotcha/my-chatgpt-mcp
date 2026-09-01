export const DEFAULT_PLUGIN_ROOT_NAME = "my-chatGPT-skills";
export const USERS_FOLDER_NAME = "users";
export const REGISTRY_FOLDER_NAME = "user-registry";

const DOMAIN_PATHS = new Map([
  ["algorithm", [["events"], ["profile", "snapshots"], ["plans", "daily"]]],
  ["interview", [["events"], ["profile", "snapshots"]]],
  ["resume-knowledge", [
    ["sources", "resume", "snapshots"],
    ["question-bank", "snapshots"],
    ["events"],
    ["profile", "snapshots"],
    ["plans", "daily"]
  ]]
]);

const TRAVERSAL = new Set([".", ".."]);
const hasSeparator = (value) => value.includes("/") || value.includes("\\");
const usableName = (value) => typeof value === "string" && value.length > 0 && !TRAVERSAL.has(value) && !hasSeparator(value);

function resolveSegments(domain, segments) {
  if (!DOMAIN_PATHS.has(domain)) throw new Error("invalid_domain");
  if (!Array.isArray(segments) || segments.length === 0) throw new Error("invalid_path");
  if (!segments.every(usableName)) throw new Error("invalid_path");
  const allowed = DOMAIN_PATHS.get(domain);
  const permitted = allowed.some((candidate) => candidate.length === segments.length
    && candidate.every((part, index) => part === segments[index]));
  if (!permitted) throw new Error("invalid_path");
  return segments;
}

function resolveUserId(userId) {
  if (!usableName(userId)) throw new Error("invalid_user_id");
  return userId;
}

export function createStorageLayout({ drive, pluginRootName = DEFAULT_PLUGIN_ROOT_NAME } = {}) {
  if (!drive?.rootFolderId) throw new Error("invalid_drive");
  if (!usableName(pluginRootName)) throw new Error("invalid_plugin_root");

  async function ensureBase() {
    return drive.ensureFolder(drive.rootFolderId, pluginRootName);
  }

  async function findBase() {
    return drive.findFolder(drive.rootFolderId, pluginRootName);
  }

  async function ensureUsers() {
    const base = await ensureBase();
    return drive.ensureFolder(base.id, USERS_FOLDER_NAME);
  }

  async function findUsers() {
    const base = await findBase();
    return base ? drive.findFolder(base.id, USERS_FOLDER_NAME) : null;
  }

  async function ensureUserRoot(userId) {
    const id = resolveUserId(userId);
    const users = await ensureUsers();
    return drive.ensureFolder(users.id, id);
  }

  async function findUserRoot(userId) {
    const id = resolveUserId(userId);
    const users = await findUsers();
    return users ? drive.findFolder(users.id, id) : null;
  }

  async function ensureDomainPath(userId, domain, segments) {
    const path = resolveSegments(domain, segments);
    let parent = await ensureUserRoot(userId);
    parent = await drive.ensureFolder(parent.id, domain);
    for (const segment of path) parent = await drive.ensureFolder(parent.id, segment);
    return parent;
  }

  async function findDomainPath(userId, domain, segments) {
    const path = resolveSegments(domain, segments);
    let parent = await findUserRoot(userId);
    if (!parent) return null;
    parent = await drive.findFolder(parent.id, domain);
    if (!parent) return null;
    for (const segment of path) {
      parent = await drive.findFolder(parent.id, segment);
      if (!parent) return null;
    }
    return parent;
  }

  async function ensureRegistry() {
    const base = await ensureBase();
    return drive.ensureFolder(base.id, REGISTRY_FOLDER_NAME);
  }

  async function findRegistry() {
    const base = await findBase();
    return base ? drive.findFolder(base.id, REGISTRY_FOLDER_NAME) : null;
  }

  return {
    pluginRootName,
    ensureBase,
    findBase,
    ensureUserRoot,
    findUserRoot,
    ensureDomainPath,
    findDomainPath,
    ensureRegistry,
    findRegistry
  };
}
