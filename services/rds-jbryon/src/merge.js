// RDS-JBryon deterministic merge and dependency order (design §9).
//
// Pure functions: callers pass the base version's JSON, the current snapshot,
// the requested changes and the observed effects of other requests. Nothing
// here reads or writes storage.
//
// Merge is all-or-nothing: one conflicting operation means the whole request is
// recorded as a conflict, never partially applied.
import { RdsError, isObject } from "./contracts.js";

const fail = (code, detail) => {
  throw new RdsError(code, detail);
};

export const deepEqual = (left, right) => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
  }
  return false;
};

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const pathKey = (path) => path.join("\u0000");
const overlaps = (left, right) => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

function parentWasDeleted(base, current, path) {
  // A write below a path that existed in the base but is gone now would
  // silently recreate a deleted branch. Only STRICT ancestors count: removing
  // the field itself is a no-op, not a conflict.
  for (let length = 1; length < path.length; length += 1) {
    const prefix = path.slice(0, length);
    const baseValue = readPath(base, prefix);
    if (baseValue === undefined) continue;
    if (readPath(current, prefix) === undefined) return idOf(prefix);
  }
  return null;
}

const idOf = (path) => path.join("/");

function readPath(value, path) {
  let cursor = value;
  for (const segment of path) {
    if (!isObject(cursor) || !(segment in cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function writePath(value, path, next) {
  if (path.length === 0) return next;
  const root = isObject(value) ? clone(value) : {};
  let cursor = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (!isObject(cursor[segment])) cursor[segment] = {};
    cursor = cursor[segment];
  }
  cursor[path.at(-1)] = next;
  return root;
}

function removePath(value, path) {
  if (path.length === 0) return undefined;
  const root = clone(value);
  let cursor = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (!isObject(cursor) || !isObject(cursor[segment])) return root;
    cursor = cursor[segment];
  }
  if (isObject(cursor)) delete cursor[path.at(-1)];
  return root;
}

/**
 * Apply a validated change set to `current` using `base` as the common
 * ancestor. Returns one of:
 *   {status:"applied", value, changed:true}
 *   {status:"applied_noop", value:current, changed:false}
 *   {status:"conflict", conflicts:[...]}
 */
export function applyChanges({ base = {}, current = {}, changes = [] }) {
  if (!Array.isArray(changes) || changes.length === 0) fail("invalid_changes");
  const conflicts = [];
  const normalized = changes.map((change) => ({
    ...change,
    path: change.path ?? [],
    key: pathKey(change.path ?? [])
  }));

  // Two operations that touch the same or an ancestor/descendant path cannot be
  // ordered safely inside one request: record both, apply neither.
  for (let outer = 0; outer < normalized.length; outer += 1) {
    for (let inner = outer + 1; inner < normalized.length; inner += 1) {
      const left = normalized[outer];
      const right = normalized[inner];
      if (left.field && right.field && left.field === right.field
        && (left.itemId || right.itemId)) continue; // distinct itemIds are fine
      if (overlaps(left.path, right.path)) {
        conflicts.push({
          path: left.path,
          reason: "overlapping_paths",
          base: readPath(base, left.path) ?? null,
          current: readPath(current, left.path) ?? null,
          proposed: left.value ?? null
        });
      }
    }
  }
  if (conflicts.length) return { status: "conflict", conflicts };

  let next = clone(current) ?? {};
  let changed = false;
  for (const change of normalized) {
    if (change.op === "set" || change.op === "remove") {
      const deletedParent = parentWasDeleted(base, current, change.path);
      if (deletedParent) {
        conflicts.push({
          path: change.path,
          reason: "parent_deleted",
          base: readPath(base, change.path) ?? null,
          current: null,
          proposed: change.op === "set" ? change.value ?? null : null,
          parent: deletedParent
        });
        continue;
      }
      const baseValue = readPath(base, change.path);
      const currentValue = readPath(current, change.path);
      if (change.op === "set") {
        if (deepEqual(currentValue, change.value)) continue; // already true
        if (!deepEqual(baseValue, currentValue)) {
          conflicts.push({
            path: change.path,
            reason: "concurrent_change",
            base: baseValue ?? null,
            current: currentValue ?? null,
            proposed: change.value ?? null
          });
          continue;
        }
        next = writePath(next, change.path, clone(change.value));
        changed = true;
      } else {
        if (currentValue === undefined) continue;
        if (!deepEqual(baseValue, currentValue)) {
          conflicts.push({
            path: change.path,
            reason: "delete_modified",
            base: baseValue ?? null,
            current: currentValue ?? null,
            proposed: null
          });
          continue;
        }
        next = removePath(next, change.path);
        changed = true;
      }
      continue;
    }

    // item_set / item_remove: a set keyed by a stable itemId. Read the
    // ACCUMULATED result so several additions in one request all survive; the
    // base stays the original ancestor so concurrent changes are still caught.
    const field = change.field;
    const baseItems = readPath(base, change.path)?.[field] ?? {};
    const currentItems = readPath(next, change.path)?.[field] ?? {};
    // The whole item collection may have been deleted concurrently: adding a
    // new item must not recreate it.
    if (readPath(base, [...change.path, field]) !== undefined
      && readPath(current, [...change.path, field]) === undefined) {
      conflicts.push({
        path: [...change.path, field],
        reason: "parent_deleted",
        base: readPath(base, [...change.path, field]) ?? null,
        current: null,
        proposed: change.value ?? null,
        parent: idOf([...change.path, field])
      });
      continue;
    }
    if (!isObject(baseItems) || !isObject(currentItems)) {
      conflicts.push({
        path: change.path,
        reason: "item_field_not_an_object",
        base: baseItems ?? null,
        current: currentItems ?? null,
        proposed: change.value ?? null
      });
      continue;
    }
    const baseItem = baseItems[change.itemId];
    const currentItem = currentItems[change.itemId];
    if (change.op === "item_set") {
      if (deepEqual(currentItem, change.value)) continue;
      if (!deepEqual(baseItem, currentItem)) {
        conflicts.push({
          path: [...change.path, field, change.itemId],
          reason: "item_concurrent_change",
          base: baseItem ?? null,
          current: currentItem ?? null,
          proposed: change.value ?? null
        });
        continue;
      }
      const items = { ...deepCloneThing(currentItems), [change.itemId]: clone(change.value) };
      next = writePath(next, [...change.path, field], items);
      changed = true;
    } else {
      if (currentItem === undefined) continue;
      if (!deepEqual(baseItem, currentItem)) {
        conflicts.push({
          path: [...change.path, field, change.itemId],
          reason: "item_delete_modified",
          base: baseItem ?? null,
          current: currentItem ?? null,
          proposed: null
        });
        continue;
      }
      const items = { ...deepCloneThing(currentItems) };
      delete items[change.itemId];
      next = writePath(next, [...change.path, field], items);
      changed = true;
    }
  }

  if (conflicts.length) return { status: "conflict", conflicts };
  return changed
    ? { status: "applied", value: next, changed: true }
    : { status: "applied_noop", value: current, changed: false };
}

function deepCloneThing(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Bounded cycle detection over a frozen dependency graph. */
export function hasDependencyCycle(requestId, dependsOn, lookup, limit = 32) {
  const seen = new Set();
  const stack = [...(dependsOn ?? [])];
  let visited = 0;
  while (stack.length) {
    const next = stack.pop();
    if (next === requestId) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    visited += 1;
    if (visited > limit) return true;
    const request = lookup(next);
    if (request?.dependsOn) stack.push(...request.dependsOn);
  }
  return false;
}

/**
 * Classify whether a request's dependencies are ready (design §9.2).
 * Only real applied/applied_noop effects satisfy a dependency; a D1 receipt is
 * never enough. Returns a stable code the UI can explain.
 */
export function classifyDependency({ request, lookupEffect, lookupRequest, epoch }) {
  const dependsOn = request?.dependsOn ?? [];
  if (dependsOn.length === 0) return { ready: true };
  if (epoch !== undefined && request?.workspaceEpoch !== undefined && request.workspaceEpoch !== epoch) {
    return { ready: false, code: "workspace_epoch_mismatch" };
  }
  if (hasDependencyCycle(request.requestId, dependsOn, lookupRequest)) {
    return { ready: false, code: "dependency_cycle" };
  }
  for (const dependency of dependsOn) {
    const effect = lookupEffect(dependency);
    if (!effect) return { ready: false, code: "dependency_missing", dependency };
    if (effect.workspaceEpoch && effect.workspaceEpoch !== request.workspaceEpoch) {
      return { ready: false, code: "dependency_epoch_mismatch", dependency };
    }
    if (effect.effect === "conflict") {
      return { ready: false, code: "dependency_replan_required", dependency };
    }
    if (effect.effect === "needs_attention") {
      return { ready: false, code: "dependency_blocked", dependency };
    }
    if (effect.effect === "cancelled" || effect.targetDeleted === true) {
      return {
        ready: false,
        code: effect.supersededBy ? "dependency_superseded" : "dependency_cancelled",
        dependency
      };
    }
    if (effect.effect !== "applied" && effect.effect !== "applied_noop") {
      return { ready: false, code: "dependency_pending", dependency };
    }
  }
  return { ready: true };
}
