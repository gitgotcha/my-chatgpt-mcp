import assert from "node:assert/strict";
import test from "node:test";
import { createDriveRepository, formatGoogleDriveWriteError, withSharedDriveSupport } from "../src/google-drive.js";

const env = { GOOGLE_DRIVE_FOLDER_ID: "root" };

test("Drive writes use a user OAuth refresh token when configured", async () => {
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "user-access-token" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "folder-or-file-1", name: "identity.json", mimeType: "application/json" }), { status: 200 });
  };
  const repository = createDriveRepository({
    ...env,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token"
  }, { fetch, readJsonFile: async (id) => ({ id, value: {} }) });

  await repository.createJson("user-folder", "identity.json", { schemaVersion: "1.2" });

  assert.equal(requests[0].url, "https://oauth2.googleapis.com/token");
  assert.match(requests[0].init.body.toString(), /grant_type=refresh_token/);
  assert.match(requests[0].init.body.toString(), /client_id=client-id/);
  assert.match(requests[0].init.body.toString(), /refresh_token=refresh-token/);
  assert.equal(requests[1].init.headers.authorization, "Bearer user-access-token");
});

test("incomplete OAuth configuration does not replace service-account authentication", () => {
  const repository = createDriveRepository({ ...env, GOOGLE_OAUTH_CLIENT_ID: "only-client-id" }, {
    uploadFile: async () => ({ id: "file-1" }),
    readJsonFile: async (id) => ({ id, value: {} })
  });
  assert.equal(repository.rootFolderId, "root");
});

test("a repository reuses one OAuth access token across Drive calls", async () => {
  let tokenRequests = 0;
  const fetch = async (url) => {
    if (url === "https://oauth2.googleapis.com/token") {
      tokenRequests += 1;
      return new Response(JSON.stringify({ access_token: "user-access-token" }), { status: 200 });
    }
    if (url.includes("/upload/drive/v3/files")) {
      return new Response(JSON.stringify({ id: "file-1", name: "identity.json", mimeType: "application/json" }), { status: 200 });
    }
    return new Response(JSON.stringify({ files: [], nextPageToken: null }), { status: 200 });
  };
  const repository = createDriveRepository({
    ...env,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token"
  }, { fetch, readJsonFile: async (id) => ({ id, value: {} }) });

  await repository.createJson("user-folder", "identity.json", { schemaVersion: "1.2" });
  await repository.listJson("user-folder");
  assert.equal(tokenRequests, 1);
});

test("formatGoogleDriveWriteError preserves Drive status and message", () => {
  assert.equal(
    formatGoogleDriveWriteError(403, { error: { message: "The caller does not have permission" } }),
    "Google Drive write failed (403): The caller does not have permission"
  );
});

test("withSharedDriveSupport enables shared-drive requests", () => {
  const url = new URL(withSharedDriveSupport("https://www.googleapis.com/drive/v3/files?q=example", { list: true }));
  assert.equal(url.searchParams.get("supportsAllDrives"), "true");
  assert.equal(url.searchParams.get("includeItemsFromAllDrives"), "true");
  assert.equal(url.searchParams.get("corpora"), "allDrives");
});

test("createJson reads the created file back with its parent", async () => {
  const calls = [];
  const repository = createDriveRepository(env, {
    uploadFile: async (parentId, name, content, mimeType) => {
      calls.push({ parentId, name, content, mimeType });
      return { id: "event-file-1", name, parents: [parentId] };
    },
    readJsonFile: async (fileId) => ({
      id: fileId,
      name: "event-11111111-1111-4111-8111-111111111111.json",
      parents: ["events-folder"],
      value: { schemaVersion: "1.2", eventId: "11111111-1111-4111-8111-111111111111" }
    })
  });
  const created = await repository.createJson(
    "events-folder",
    "event-11111111-1111-4111-8111-111111111111.json",
    { schemaVersion: "1.2", eventId: "11111111-1111-4111-8111-111111111111" }
  );
  assert.deepEqual(created.parents, ["events-folder"]);
  assert.equal(calls[0].mimeType, "application/json");
  assert.equal(calls[0].content, '{"schemaVersion":"1.2","eventId":"11111111-1111-4111-8111-111111111111"}');
});

test("repository never falls back to the configured root for an unknown parent", async () => {
  const repository = createDriveRepository(env, {
    uploadFile: async () => { throw new Error("must not write"); }
  });
  await assert.rejects(
    () => repository.createJson("", "identity.json", { schemaVersion: "1.2" }),
    /parentId/
  );
});

test("findFolder scopes its exact-name search to the requested parent", async () => {
  const queries = [];
  const repository = createDriveRepository(env, {
    listChildren: async (parentId, options) => {
      queries.push({ parentId, options });
      return [{ id: "folder-1", name: "events", mimeType: "application/vnd.google-apps.folder", parents: [parentId] }];
    }
  });
  const folder = await repository.findFolder("candidate-1", "events");
  assert.equal(folder.id, "folder-1");
  assert.deepEqual(queries, [{ parentId: "candidate-1", options: { name: "events", foldersOnly: true } }]);
});

test("ensureFolder returns an existing exact-name child without writing", async () => {
  const repository = createDriveRepository(env, {
    listChildren: async () => [{ id: "events-1", name: "events", mimeType: "application/vnd.google-apps.folder", parents: ["candidate-1"] }],
    createFolder: async () => { throw new Error("must not create"); }
  });
  const folder = await repository.ensureFolder("candidate-1", "events");
  assert.equal(folder.id, "events-1");
});

test("ensureFolder rejects invalid parent or path-like child name", async () => {
  const repository = createDriveRepository(env);
  await assert.rejects(() => repository.ensureFolder("", "events"), /invalid folder input/);
  await assert.rejects(() => repository.ensureFolder("candidate-1", "events/2026"), /invalid folder input/);
});

test("createJson rejects an upload response without a file id", async () => {
  const repository = createDriveRepository(env, { uploadFile: async () => ({}) });
  await assert.rejects(
    () => repository.createJson("events-folder", "event-11111111-1111-4111-8111-111111111111.json", { schemaVersion: "1.2" }),
    /file id/
  );
});

test("readJson rejects malformed JSON returned by Drive", async () => {
  const repository = createDriveRepository(env, {
    readJsonFile: async () => { throw new SyntaxError("Unexpected token"); }
  });
  await assert.rejects(() => repository.readJson("event-file-1"), SyntaxError);
});

test("readJson preserves Drive read failures", async () => {
  const repository = createDriveRepository(env, {
    readJsonFile: async () => { throw new Error("Google Drive read failed"); }
  });
  await assert.rejects(() => repository.readJson("event-file-1"), /Google Drive read failed/);
});

test("listJson returns only JSON children with their Drive metadata", async () => {
  const repository = createDriveRepository(env, {
    listChildren: async () => [
      { id: "event-1", name: "event-a.json", mimeType: "application/json", parents: ["events-folder"], createdTime: "2026-08-14T00:00:00.000Z" },
      { id: "readme", name: "readme.txt", mimeType: "text/plain", parents: ["events-folder"] }
    ]
  });
  const files = await repository.listJson("events-folder");
  assert.deepEqual(files, [{ id: "event-1", name: "event-a.json", mimeType: "application/json", parents: ["events-folder"], createdTime: "2026-08-14T00:00:00.000Z" }]);
});

test("createJson accepts every canonical projection filename", async () => {
  const names = [
    "identity.json",
    "registration-11111111-1111-4111-8111-111111111111.json",
    "event-11111111-1111-4111-8111-111111111111.json",
    "snapshot-2026-08-29T00-00-00-000Z-11111111-1111-4111-8111-111111111111.json",
    "daily-plan-2026-08-29-11111111-1111-4111-8111-111111111111.json",
    "resume-v1-0123456789abcdef.json",
    "question-bank-v1-11111111-1111-4111-8111-111111111111.json",
    "migration-2026-08-29-dry-run.json"
  ];
  for (const name of names) {
    const repository = createDriveRepository(env, {
      uploadFile: async () => ({ id: "created-file" }),
      readJsonFile: async (id) => ({ id, name, parents: ["events-folder"], value: { schemaVersion: "1.2" } })
    });
    await repository.createJson("events-folder", name, { schemaVersion: "1.2" });
  }
});

test("createJson still rejects traversal, separators and unlisted filenames", async () => {
  const repository = createDriveRepository(env, {
    uploadFile: async () => { throw new Error("must not write"); }
  });
  for (const name of [
    "../identity.json",
    "identity.json.bak",
    "notes.txt",
    "event-../nested.json",
    "daily-plan-2026-8-29-plan.json",
    "unknown-projection.json"
  ]) {
    await assert.rejects(
      () => repository.createJson("events-folder", name, { schemaVersion: "1.2" }),
      /invalid JSON target/
    );
  }
});
