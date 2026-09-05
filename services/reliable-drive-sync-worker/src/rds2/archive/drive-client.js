// RDS V2 archive Drive client (Rev 6 plan T08). Wraps the V1 upload primitive
// with the same io.fetch (so the single budget still sees every call and the
// OAuth token call goes through it too), pins list queries to exactly one
// parent/name/not-trashed combination, and reads content with a hard byte cap.
// Redirects are never followed: io.fetch already rejects 3xx.
import { googleUpload } from "../../google-drive.js";

export const MAX_OBJECT_BYTES = 256 * 1024;

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
    // the caller's signal, never silently resolved.
    async findExact(name) {
      const bearer = await token();
      const q = `name = '${escapeDriveQuery(name)}' and '${escapeDriveQuery(folderId)}' in parents and trashed = false`;
      const response = await io.fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
        { headers: { authorization: `Bearer ${bearer}` } }
      );
      if (!response.ok) throw driveHttpError(response.status);
      const payload = await response.json();
      return payload.files ?? [];
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
