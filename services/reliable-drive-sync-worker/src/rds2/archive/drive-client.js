// RDS V2 archive Drive client (Rev 6 plan T08). Wraps the V1 upload primitive
// with the same io.fetch (so the single budget still sees every call and the
// OAuth token call goes through it too), pins list queries to exactly one
// parent/name/not-trashed combination, and reads content with a hard byte cap.
// Redirects are never followed: io.fetch already rejects 3xx.
import { googleUpload } from "../../google-drive.js";

export const MAX_OBJECT_BYTES = 256 * 1024;

// The exact lookup only has to tell "none" from "one" from "several", so the
// page is explicitly tiny and the metadata response is bounded as well — a
// content-only read is not the only response that must have a ceiling.
export const FIND_PAGE_SIZE = 2;
export const MAX_FIND_RESPONSE_BYTES = 64 * 1024;
// Completeness is part of the contract: without these fields a truncated
// result is indistinguishable from "the object does not exist".
const FIND_FIELDS = "nextPageToken,incompleteSearch,files(id,name)";

function driveHttpError(status) {
  const error = new Error("drive_http_error");
  error.code = "drive_http_error";
  error.status = status;
  return error;
}

function contentError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const escapeDriveQuery = (value) => String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");

export function createArchiveClient({ env, io, tokenProvider, folderId }) {
  if (!folderId) throw contentError("archive_folder_missing");
  // One OAuth round trip per invocation, no matter how many calls follow.
  let tokenPromise = null;
  const token = () => {
    if (!tokenPromise) {
      tokenPromise = Promise.resolve(tokenProvider()).catch((error) => {
        tokenPromise = null;
        throw error;
      });
    }
    return tokenPromise;
  };
  return {
    // Exact object lookup: parent + exact name + not trashed. Ambiguity is
    // the caller's signal, never silently resolved — and neither is an
    // INCOMPLETE answer: a truncated page is not "no such object", so it
    // fails closed instead of inviting a duplicate upload.
    async findExact(name) {
      const bearer = await token();
      const q = `name = '${escapeDriveQuery(name)}' and '${escapeDriveQuery(folderId)}' in parents and trashed = false`;
      const response = await io.fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`
          + `&pageSize=${FIND_PAGE_SIZE}&fields=${encodeURIComponent(FIND_FIELDS)}`,
        { headers: { authorization: `Bearer ${bearer}` } }
      );
      if (!response.ok) throw driveHttpError(response.status);
      const raw = await response.text();
      if (new TextEncoder().encode(raw).length > MAX_FIND_RESPONSE_BYTES) {
        throw contentError("drive_response_too_large");
      }
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw contentError("drive_response_invalid");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw contentError("drive_response_invalid");
      }
      // Fail closed, never silently "not found": no unbounded paging inside
      // one invocation, and an incomplete corpus is a diagnosable refusal.
      if (payload.incompleteSearch === true || payload.nextPageToken) {
        throw contentError("drive_search_incomplete");
      }
      const files = payload.files ?? [];
      if (!Array.isArray(files)) throw contentError("drive_response_invalid");
      return files.map((file) => {
        if (!file || typeof file !== "object" || typeof file.id !== "string" || !file.id) {
          // A hit without an id cannot be used and must not read as "none".
          throw contentError("drive_response_invalid");
        }
        return { id: file.id, name: file.name ?? null };
      });
    },
    async upload(name, bytes) {
      const bearer = await token();
      // V1 primitive, same parameter order; the token provider reuses the
      // cached token so OAuth stays a single budgeted call per invocation.
      return googleUpload(env, folderId, name, bytes, "application/json", io.fetch, async () => bearer);
    },
    // Content-only read (V1 readJson also reads metadata — not used here).
    // The whole object is streamed under the byte cap; oversized or non-JSON
    // content is a content error, never an unbounded download.
    async readContent(fileId) {
      const bearer = await token();
      const response = await io.fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
        { headers: { authorization: `Bearer ${bearer}` } }
      );
      if (!response.ok) throw driveHttpError(response.status);
      const reader = response.body.getReader();
      let total = 0;
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_OBJECT_BYTES) {
          try { await reader.cancel(); } catch { /* stream already closed */ }
          throw contentError("artifact_too_large");
        }
        chunks.push(value);
      }
      const parts = chunks.map((chunk) => new Uint8Array(chunk));
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        merged.set(part, offset);
        offset += part.byteLength;
      }
      const text = new TextDecoder().decode(merged);
      try {
        return { text, json: JSON.parse(text) };
      } catch {
        throw contentError("artifact_not_json");
      }
    }
  };
}
