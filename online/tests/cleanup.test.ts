import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createNodePlatform } from "../src/adapters/node.js";
import { blobDeletionStatements, flushBlobDeletes } from "../src/cleanup.js";
import type { Runtime } from "../src/platform.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (cleanup.length) await cleanup.pop()!();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "yijian-cleanup-test-"));
  const options = {
    databasePath: join(directory, "data.sqlite"),
    blobDirectory: join(directory, "objects"),
  };
  let platform = createNodePlatform(options);
  const owner = crypto.randomUUID(),
    other = crypto.randomUUID();
  for (const id of [owner, other])
    await platform.db.run(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,?,?)",
      [
        id,
        "测试账号",
        id + "@example.com",
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
  cleanup.push(async () => {
    await platform.close();
    if (
      resolve(directory).startsWith(
        resolve(tmpdir()) + sep + "yijian-cleanup-test-",
      )
    )
      rmSync(directory, { recursive: true, force: true });
  });
  return {
    owner,
    other,
    get runtime(): Runtime {
      return {
        ...platform,
        publicOrigin: "http://localhost:3117",
        registrationMode: "closed",
      };
    },
    async restart() {
      await platform.close();
      platform = createNodePlatform(options);
    },
  };
}

describe("durable owner-scoped image cleanup", () => {
  it("preserves live assets and removes stale jobs after an uncertain commit", async () => {
    const f = await fixture(),
      key = `wardrobes/${f.owner}/photo.jpg`;
    const bytes = new Uint8Array([1, 2, 3]);
    await f.runtime.db.run(
      "INSERT INTO workspaces(owner_id,settings) VALUES(?,?)",
      [f.owner, "{}"],
    );
    await f.runtime.db.run(
      "INSERT INTO assets(owner_id,name,object_key,sha256,size) VALUES(?,?,?,?,?)",
      [f.owner, "photo.jpg", key, "0".repeat(64), bytes.length],
    );
    await f.runtime.blobs.put(key, bytes);
    await f.runtime.db.batch(blobDeletionStatements(f.owner, [key]));
    await flushBlobDeletes(f.runtime, f.owner);
    expect(await f.runtime.blobs.get(key)).toEqual(bytes);
    expect(await f.runtime.db.all("SELECT * FROM blob_delete_jobs")).toEqual(
      [],
    );
    await f.runtime.db.batch([
      {
        sql: "DELETE FROM assets WHERE owner_id=? AND name=?",
        params: [f.owner, "photo.jpg"],
      },
      ...blobDeletionStatements(f.owner, [key]),
    ]);
    await flushBlobDeletes(f.runtime, f.owner);
    expect(await f.runtime.blobs.get(key)).toBeNull();
  });

  it("protects another account's referenced photo from an erroneous queue entry", async () => {
    const f = await fixture(),
      key = `wardrobes/${f.other}/photo.jpg`;
    await f.runtime.db.run(
      "INSERT INTO workspaces(owner_id,settings) VALUES(?,?)",
      [f.other, "{}"],
    );
    await f.runtime.db.run(
      "INSERT INTO assets(owner_id,name,object_key,sha256,size) VALUES(?,?,?,?,1)",
      [f.other, "photo.jpg", key, "0".repeat(64)],
    );
    await f.runtime.blobs.put(key, new Uint8Array([9]));
    await f.runtime.db.batch(blobDeletionStatements(f.owner, [key]));
    await flushBlobDeletes(f.runtime, f.owner);
    expect(await f.runtime.blobs.get(key)).toEqual(new Uint8Array([9]));
    expect(await f.runtime.db.all("SELECT * FROM blob_delete_jobs")).toEqual(
      [],
    );
  });

  it("protects revoked share snapshots while their database pointers remain", async () => {
    const f = await fixture(),
      key = `sharing/${f.owner}/photo.jpg`,
      shareId = crypto.randomUUID();
    await f.runtime.db.run(
      "INSERT INTO shares(id,owner_id,question,status,created_at,expires_at,source_count) VALUES(?,?,?,'revoked',?,?,1)",
      [shareId, f.owner, "搭配", "2026-01-01", "2026-01-02"],
    );
    await f.runtime.db.run(
      "INSERT INTO share_items(id,share_id,item_id,name,category,brand,object_key,position) VALUES(?,?,?,?,?,?,?,0)",
      [crypto.randomUUID(), shareId, "item", "上衣", "top", "", key],
    );
    await f.runtime.blobs.put(key, new Uint8Array([3]));
    await f.runtime.db.batch(blobDeletionStatements(f.owner, [key]));
    await flushBlobDeletes(f.runtime, f.owner);
    expect(await f.runtime.blobs.get(key)).toEqual(new Uint8Array([3]));
    expect(await f.runtime.db.all("SELECT * FROM blob_delete_jobs")).toEqual(
      [],
    );
  });

  it("protects preview archives until their persistent pointer is cleared", async () => {
    const f = await fixture(),
      key = "migration-previews/archive.zip",
      id = crypto.randomUUID();
    await f.runtime.db.run(
      "INSERT INTO workspaces(owner_id,settings) VALUES(?,?)",
      [f.owner, "{}"],
    );
    await f.runtime.db.run(
      "INSERT INTO migration_previews(id,owner_id,object_key,sha256,target_revision,expires_at,created_at,status) VALUES(?,?,?,?,0,?,?,'ready')",
      [id, f.owner, key, "0".repeat(64), "2020-01-01", "2020-01-01"],
    );
    await f.runtime.blobs.put(key, new Uint8Array([5]));
    await f.runtime.db.batch(blobDeletionStatements(f.owner, [key]));
    await flushBlobDeletes(f.runtime, f.owner);
    expect(await f.runtime.blobs.get(key)).toEqual(new Uint8Array([5]));
    expect(await f.runtime.db.all("SELECT * FROM blob_delete_jobs")).toEqual(
      [],
    );
    await f.runtime.db.batch([
      {
        sql: "UPDATE migration_previews SET object_key=NULL WHERE id=? AND owner_id=?",
        params: [id, f.owner],
      },
      ...blobDeletionStatements(f.owner, [key]),
    ]);
    await flushBlobDeletes(f.runtime, f.owner);
    expect(await f.runtime.blobs.get(key)).toBeNull();
  });

  it("waits for uncertain database operations before cleaning staged photos", async () => {
    const f = await fixture(),
      key = `wardrobes/${f.owner}/staged.jpg`;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
    await f.runtime.blobs.put(key, new Uint8Array([7]));
    await f.runtime.db.batch(
      blobDeletionStatements(f.owner, [key], undefined, 60),
    );
    await flushBlobDeletes(f.runtime, f.owner);
    expect(await f.runtime.blobs.get(key)).toEqual(new Uint8Array([7]));
    vi.setSystemTime(new Date("2026-09-10T12:00:59.999Z"));
    await flushBlobDeletes(f.runtime, f.owner);
    expect(await f.runtime.blobs.get(key)).toEqual(new Uint8Array([7]));
    vi.setSystemTime(new Date("2026-09-10T12:01:00.000Z"));
    await flushBlobDeletes(f.runtime, f.owner);
    expect(await f.runtime.blobs.get(key)).toBeNull();
    expect(await f.runtime.db.all("SELECT * FROM blob_delete_jobs")).toEqual(
      [],
    );
  });

  it("keeps failed deletion jobs across restart and clears them only after successful retry", async () => {
    const f = await fixture(),
      key = `wardrobes/${f.owner}/photo.jpg`;
    await f.runtime.blobs.put(key, new Uint8Array([1, 2, 3]));
    await f.runtime.db.batch(blobDeletionStatements(f.owner, [key, key]));
    expect(
      await f.runtime.db.all("SELECT * FROM blob_delete_jobs"),
    ).toHaveLength(1);
    const broken = {
      ...f.runtime,
      blobs: {
        ...f.runtime.blobs,
        get: f.runtime.blobs.get.bind(f.runtime.blobs),
        put: f.runtime.blobs.put.bind(f.runtime.blobs),
        delete: vi.fn(async () => {
          throw new Error("storage temporarily unavailable");
        }),
      },
    };
    await expect(flushBlobDeletes(broken, f.owner)).resolves.toBeUndefined();
    expect(
      await f.runtime.db.all("SELECT * FROM blob_delete_jobs"),
    ).toHaveLength(1);
    expect(await f.runtime.blobs.get(key)).toEqual(new Uint8Array([1, 2, 3]));
    await f.restart();
    await flushBlobDeletes(f.runtime, f.owner);
    expect(await f.runtime.blobs.get(key)).toBeNull();
    expect(await f.runtime.db.all("SELECT * FROM blob_delete_jobs")).toEqual(
      [],
    );
  });

  it("only processes the current owner's queue", async () => {
    const f = await fixture();
    const a = `wardrobes/${f.owner}/a.jpg`,
      b = `wardrobes/${f.other}/b.jpg`;
    await f.runtime.blobs.put(a, new Uint8Array([1]));
    await f.runtime.blobs.put(b, new Uint8Array([2]));
    await f.runtime.db.batch([
      ...blobDeletionStatements(f.owner, [a]),
      ...blobDeletionStatements(f.other, [b]),
    ]);
    await flushBlobDeletes(f.runtime, f.owner);
    expect(await f.runtime.blobs.get(a)).toBeNull();
    expect(await f.runtime.blobs.get(b)).toEqual(new Uint8Array([2]));
    expect(
      await f.runtime.db.all("SELECT owner_id FROM blob_delete_jobs"),
    ).toEqual([{ owner_id: f.other }]);
  });

  it("does not enqueue after a failed CAS and atomically rolls back a failed transaction", async () => {
    const f = await fixture(),
      key = `wardrobes/${f.owner}/photo.jpg`;
    await f.runtime.db.run(
      "INSERT INTO workspaces(owner_id,settings,revision,write_token) VALUES(?,?,1,?)",
      [f.owner, "{}", "current-token"],
    );
    await f.runtime.db.batch([
      {
        sql: "UPDATE workspaces SET write_token=? WHERE owner_id=? AND revision=0",
        params: ["stale-token", f.owner],
      },
      ...blobDeletionStatements(f.owner, [key], "stale-token"),
    ]);
    expect(await f.runtime.db.all("SELECT * FROM blob_delete_jobs")).toEqual(
      [],
    );
    await expect(
      f.runtime.db.batch([
        ...blobDeletionStatements(f.owner, [key], "current-token"),
        {
          sql: "INSERT INTO blob_delete_jobs(owner_id,object_key,created_at) VALUES(NULL,'invalid','now')",
        },
      ]),
    ).rejects.toThrow();
    expect(await f.runtime.db.all("SELECT * FROM blob_delete_jobs")).toEqual(
      [],
    );
    await f.runtime.db.batch(
      blobDeletionStatements(f.owner, [key], "current-token"),
    );
    expect(
      await f.runtime.db.all("SELECT object_key FROM blob_delete_jobs"),
    ).toEqual([{ object_key: key }]);
  });

  it("rejects traversal and URLs without sending them to blob storage", async () => {
    const f = await fixture();
    for (const key of [
      "../private",
      "/absolute",
      "wardrobes/../../private",
      "https://example.com/image.jpg",
      "folder\\file.jpg",
    ]) {
      expect(() => blobDeletionStatements(f.owner, [key])).toThrow();
    }
    await f.runtime.db.run(
      "INSERT INTO blob_delete_jobs(owner_id,object_key,created_at) VALUES(?,?,?)",
      [f.owner, "../private", "now"],
    );
    const remove = vi.spyOn(f.runtime.blobs, "delete");
    await flushBlobDeletes(f.runtime, f.owner);
    expect(remove).not.toHaveBeenCalled();
    expect(
      await f.runtime.db.all("SELECT * FROM blob_delete_jobs"),
    ).toHaveLength(1);
  });

  it("bounds each flush even when a larger limit is supplied", async () => {
    const f = await fixture();
    const keys = Array.from(
      { length: 12 },
      (_, index) => `wardrobes/${f.owner}/${index}.jpg`,
    );
    await f.runtime.db.batch(blobDeletionStatements(f.owner, keys));
    await flushBlobDeletes(f.runtime, f.owner, 1000);
    expect(
      await f.runtime.db.all("SELECT * FROM blob_delete_jobs"),
    ).toHaveLength(4);
    await flushBlobDeletes(f.runtime, f.owner, 2);
    expect(
      await f.runtime.db.all("SELECT * FROM blob_delete_jobs"),
    ).toHaveLength(2);
  });
});
