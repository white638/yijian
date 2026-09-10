import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BlobStore,
  Database,
  Runtime,
  SQLValue,
  Statement,
} from "../src/platform.js";
import {
  exportSharingHistory,
  invalidateItemShares,
  itemShareInvalidationStatements,
  mountSharing,
  prepareSharingHistoryImport,
} from "../src/sharing.js";
import { starterLimits } from "../src/limits.js";

type Env = {
  Variables: { runtime: Runtime; ownerId: string; sourceKey?: string };
};
class TestDatabase implements Database {
  native = new DatabaseSync(":memory:");
  beforeRun?: (sql: string) => Promise<void>;
  constructor() {
    this.native.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE workspaces(owner_id TEXT PRIMARY KEY,write_token TEXT);
      CREATE TABLE user(id TEXT PRIMARY KEY);
      CREATE TABLE entries(owner_id TEXT, collection TEXT, id TEXT, data TEXT, PRIMARY KEY(owner_id,collection,id));
      CREATE TABLE assets(owner_id TEXT,name TEXT,object_key TEXT, PRIMARY KEY(owner_id,name));`);
    this.native.exec(
      readFileSync(
        new URL("../migrations/002_sharing.sql", import.meta.url),
        "utf8",
      ),
    );
    this.native.exec(
      readFileSync(
        new URL("../migrations/003_migration.sql", import.meta.url),
        "utf8",
      ),
    );
    this.native.exec(
      readFileSync(
        new URL("../migrations/004_sharing_capacity.sql", import.meta.url),
        "utf8",
      ),
    );
    this.native.exec(
      readFileSync(
        new URL("../migrations/005_blob_cleanup.sql", import.meta.url),
        "utf8",
      ),
    );
    this.native.exec("INSERT INTO user(id) VALUES('owner-a'),('owner-b')");
  }
  async all<T>(sql: string, params: SQLValue[] = []) {
    return this.native.prepare(sql).all(...params) as T[];
  }
  async run(sql: string, params: SQLValue[] = []) {
    await this.beforeRun?.(sql);
    return { changes: Number(this.native.prepare(sql).run(...params).changes) };
  }
  async batch(statements: Statement[]) {
    this.native.exec("BEGIN");
    try {
      const results = [];
      for (const { sql, params = [] } of statements) {
        await this.beforeRun?.(sql);
        results.push({
          changes: Number(this.native.prepare(sql).run(...params).changes),
        });
      }
      this.native.exec("COMMIT");
      return results;
    } catch (error) {
      this.native.exec("ROLLBACK");
      throw error;
    }
  }
}
class TestBlobs implements BlobStore {
  files = new Map<string, Uint8Array>();
  afterGet?: (key: string) => Promise<void>;
  afterPut?: (key: string) => Promise<void>;
  async get(key: string) {
    const result = this.files.get(key)?.slice() ?? null;
    await this.afterGet?.(key);
    return result;
  }
  async put(key: string, bytes: Uint8Array) {
    this.files.set(key, bytes.slice());
    await this.afterPut?.(key);
  }
  async delete(key: string) {
    this.files.delete(key);
  }
}

// Marker-valid fixture includes deliberately private EXIF metadata and trailing bytes.
const privateJpeg = new Uint8Array([
  255,
  216,
  255,
  225,
  0,
  10,
  ...new TextEncoder().encode("GPS-HOME"),
  255,
  192,
  0,
  11,
  8,
  0,
  1,
  0,
  1,
  1,
  1,
  17,
  0,
  255,
  218,
  0,
  8,
  1,
  1,
  0,
  0,
  63,
  0,
  13,
  255,
  217,
  ...new TextEncoder().encode("TRAILING-PRIVATE"),
]);

let db: TestDatabase, blobs: TestBlobs, runtime: Runtime, app: Hono<Env>;
beforeEach(async () => {
  db = new TestDatabase();
  blobs = new TestBlobs();
  runtime = {
    db,
    blobs,
    publicOrigin: "https://yijian.example",
    registrationMode: "closed",
  };
  app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("runtime", runtime);
    c.set("ownerId", c.req.header("x-test-owner") || "");
    await next();
  });
  mountSharing(app);
  await item("owner-a", "item-a", {
    name: "白色上衣",
    category: "top",
    brand: "示例牌",
    price: "399.00",
    notes: "PRIVATE NOTE",
    size: "L",
  });
  await item("owner-a", "item-b", { name: "灰色长裤", category: "bottom" });
  await item("owner-b", "item-c", { name: "其他账号衣物", category: "dress" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.native.close();
});

async function item(
  owner: string,
  itemId: string,
  attrs: Record<string, unknown>,
) {
  const name = `${itemId}-original.jpg`,
    key = `private/${owner}/${name}`;
  await db.run(
    "INSERT INTO entries(owner_id,collection,id,data) VALUES(?,?,?,?)",
    [
      owner,
      "items",
      itemId,
      JSON.stringify({
        ...attrs,
        image_url: `/api/images/${name}`,
        original_url: `/api/images/${name}`,
        owner_id: owner,
      }),
    ],
  );
  await db.run("INSERT INTO assets(owner_id,name,object_key) VALUES(?,?,?)", [
    owner,
    name,
    key,
  ]);
  await blobs.put(key, privateJpeg);
}
function request(
  path: string,
  method = "GET",
  body?: unknown,
  owner = "owner-a",
  secret?: string,
) {
  return app.request(path, {
    method,
    headers: {
      ...(owner ? { "x-test-owner": owner } : {}),
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function create(
  itemIds = ["item-a", "item-b"],
  owner = "owner-a",
  expiresDays = 7,
) {
  const response = await request(
    "/api/shares",
    "POST",
    {
      question: "这两件周末一起穿合适吗？",
      item_ids: itemIds,
      expires_days: expiresDays,
    },
    owner,
  );
  expect(response.status).toBe(201);
  return response.json() as Promise<{
    id: string;
    token: string;
    share: { items: { id: string; image_id: string; item_id: string }[] };
  }>;
}
function reply(
  secret: string,
  itemIds: string[] = [],
  requestId = "request-one",
  text = "建议搭配白色鞋子。",
) {
  return request(
    "/api/share/reply",
    "POST",
    { request_id: requestId, nickname: "朋友", text, item_ids: itemIds },
    "",
    secret,
  );
}

describe("private snapshot sharing", () => {
  it("enforces snapshot and history budgets and removes staged copies on rejection", async () => {
    const share = await create();
    await db.run("UPDATE share_items SET image_bytes=? WHERE id=?", [
      starterLimits.snapshotStorageBytes,
      share.share.items[0].id,
    ]);
    const before = [...blobs.files.keys()];
    expect(
      (
        await request("/api/shares", "POST", {
          question: "更多照片",
          item_ids: ["item-a"],
        })
      ).status,
    ).toBe(413);
    expect([...blobs.files.keys()]).toEqual(before);
    await db.run("UPDATE share_items SET image_bytes=0 WHERE share_id=?", [
      share.id,
    ]);
    await db.run("UPDATE shares SET history_bytes=? WHERE id=?", [
      starterLimits.historyBytes,
      share.id,
    ]);
    expect((await reply(share.token)).status).toBe(413);
    expect(await db.all("SELECT * FROM share_replies")).toHaveLength(0);
  });

  it("rolls back history imports if capacity changes after validation", async () => {
    const share = await create();
    const history = await exportSharingHistory(runtime, "owner-a");
    const statements = await prepareSharingHistoryImport(
      runtime,
      "owner-a",
      history,
    );
    await db.run("UPDATE shares SET history_bytes=? WHERE id=?", [
      starterLimits.historyBytes,
      share.id,
    ]);
    await expect(db.batch(statements)).rejects.toThrow("capacity_limit");
    expect(await db.all("SELECT * FROM shares")).toHaveLength(1);
    expect(await db.all("SELECT * FROM capacity_guards")).toHaveLength(0);
  });

  it("deletes a share permanently and retries private photo cleanup after a storage failure", async () => {
    const share = await create();
    await reply(share.token);
    expect(
      (await request(`/api/shares/${share.id}`, "DELETE", undefined, "owner-b"))
        .status,
    ).toBe(404);
    const originalDelete = blobs.delete.bind(blobs);
    const fail = vi
      .spyOn(blobs, "delete")
      .mockRejectedValue(new Error("storage unavailable"));
    expect((await request(`/api/shares/${share.id}`, "DELETE")).status).toBe(
      200,
    );
    expect(
      (await request("/api/share/view", "POST", {}, "", share.token)).status,
    ).toBe(410);
    expect(await db.all("SELECT * FROM shares")).toHaveLength(0);
    expect(await db.all("SELECT * FROM share_replies")).toHaveLength(0);
    expect(await db.all("SELECT * FROM blob_delete_jobs")).toHaveLength(2);
    expect(
      (
        await request("/api/shares", "POST", {
          question: "新分享",
          item_ids: ["item-a"],
        })
      ).status,
    ).toBe(409);
    fail.mockImplementation(originalDelete);
    await request("/api/shares");
    expect(await db.all("SELECT * FROM blob_delete_jobs")).toHaveLength(0);
    expect(
      [...blobs.files.keys()].filter((key) =>
        key.startsWith("share-snapshots/"),
      ),
    ).toHaveLength(0);
    await create();
  });
  it("bounds valid links and keeps them visible ahead of older history", async () => {
    for (let index = 0; index < 50; index++)
      await db.run(
        "INSERT INTO shares(id,owner_id,question,status,created_at,expires_at,source_count) VALUES(?,?,?,'active',?,?,0)",
        [
          `seed-${index}`,
          "owner-a",
          "有效分享",
          "2020-01-01T00:00:00.000Z",
          "2099-01-01T00:00:00.000Z",
        ],
      );
    expect(
      (
        await request("/api/shares", "POST", {
          question: "新问题",
          item_ids: ["item-a"],
        })
      ).status,
    ).toBe(413);
    await db.run("DELETE FROM shares WHERE id=?", ["seed-0"]);
    const share = await create();
    for (let index = 0; index < 160; index++)
      await db.run(
        "INSERT INTO shares(id,owner_id,question,status,created_at,expires_at,source_count) VALUES(?,?,?,'revoked',?,?,0)",
        [
          `old-${index}`,
          "owner-a",
          "历史",
          "2090-01-01T00:00:00.000Z",
          "2090-01-01T00:00:00.000Z",
        ],
      );
    const list = await (await request("/api/shares")).json();
    expect(list.shares).toHaveLength(200);
    expect(list.total_count).toBe(210);
    expect(list.has_more).toBe(true);
    expect(
      list.shares
        .slice(0, 50)
        .some((entry: { id: string }) => entry.id === share.id),
    ).toBe(true);
    await expect(exportSharingHistory(runtime, "owner-a")).rejects.toThrow(
      "50",
    );
  });

  it("copies only approved snapshot fields, removes metadata, and stores only token hashes", async () => {
    const share = await create();
    expect(share.token).toMatch(/^[0-9a-f]{64}$/);
    const rows = await db.all<{ token_hash: string }>(
      "SELECT token_hash FROM shares",
    );
    expect(rows[0].token_hash).not.toBe(share.token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    const view = await request("/api/share/view", "POST", {}, "", share.token);
    expect(view.status).toBe(200);
    const data = await view.json();
    expect(Object.keys(data).sort()).toEqual([
      "accepting",
      "expires_at",
      "items",
      "question",
    ]);
    expect(Object.keys(data.items[0]).sort()).toEqual([
      "brand",
      "category",
      "id",
      "image_id",
      "name",
    ]);
    for (const secret of [
      "owner-a",
      "PRIVATE NOTE",
      "399.00",
      "original_url",
      "item-a",
    ])
      expect(JSON.stringify(data)).not.toContain(secret);
    const image = await request(
      `/api/share/images/${data.items[0].image_id}`,
      "GET",
      undefined,
      "",
      share.token,
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("cache-control")).toBe("private, no-store");
    expect(image.headers.get("referrer-policy")).toBe("no-referrer");
    const bytes = new Uint8Array(await image.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).not.toContain("GPS-HOME");
    expect(new TextDecoder().decode(bytes)).not.toContain("TRAILING-PRIVATE");
    expect(blobs.files.get("private/owner-a/item-a-original.jpg")).toEqual(
      privateJpeg,
    );
    const ownerDetail = await request(`/api/shares/${share.id}`);
    expect(JSON.stringify(await ownerDetail.json())).not.toContain(share.token);
  });

  it("preserves snapshots after editing the source item", async () => {
    const share = await create();
    await db.run("UPDATE entries SET data=? WHERE owner_id=? AND id=?", [
      JSON.stringify({ name: "编辑后的名称", price: "9000" }),
      "owner-a",
      "item-a",
    ]);
    const response = await request(
      "/api/share/view",
      "POST",
      {},
      "",
      share.token,
    );
    expect(JSON.stringify(await response.json())).toContain("白色上衣");
  });

  it("rejects selecting another account items and unauthenticated owner routes", async () => {
    expect(
      (
        await request("/api/shares", "POST", {
          question: "问题",
          item_ids: ["item-c"],
        })
      ).status,
    ).toBe(400);
    expect((await request("/api/shares", "GET", undefined, "")).status).toBe(
      401,
    );
    const share = await create();
    expect(
      (await request(`/api/shares/${share.id}`, "GET", undefined, "owner-b"))
        .status,
    ).toBe(404);
    expect(
      (
        await request(
          `/api/shares/${share.id}`,
          "PATCH",
          { action: "revoke" },
          "owner-b",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/api/shares/${share.id}/images/${share.share.items[0].image_id}`,
          "GET",
          undefined,
          "owner-b",
        )
      ).status,
    ).toBe(404);
  });

  it("scopes photos and selected snapshot identifiers to one share", async () => {
    const first = await create(["item-a"]),
      second = await create(["item-c"], "owner-b");
    expect(
      (
        await request(
          `/api/share/images/${second.share.items[0].image_id}`,
          "GET",
          undefined,
          "",
          first.token,
        )
      ).status,
    ).toBe(404);
    expect((await reply(first.token, [second.share.items[0].id])).status).toBe(
      400,
    );
    expect((await reply(first.token, ["item-a"])).status).toBe(400);
    expect(
      (await request(`/api/share/view?token=${first.token}`, "POST", {}, ""))
        .status,
    ).toBe(410);
  });

  it("allows owner photo previews without handing the secret to the browser image URL", async () => {
    const share = await create();
    const photo = await request(
      `/api/shares/${share.id}/images/${share.share.items[0].image_id}`,
    );
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/jpeg");
  });

  it("only returns submit confirmation to a visitor and maps selections for the owner", async () => {
    const share = await create();
    const response = await reply(share.token, [share.share.items[0].id]);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    const view = await request("/api/share/view", "POST", {}, "", share.token);
    expect(JSON.stringify(await view.json())).not.toContain("建议搭配");
    const owner = await request(`/api/shares/${share.id}`);
    const result = await owner.json();
    expect(result.suggestions[0].item_ids).toEqual(["item-a"]);
    expect(result.suggestions[0].snapshot_item_ids).toEqual([
      share.share.items[0].id,
    ]);
    expect(result.share.suggestion_count).toBe(1);
    expect(JSON.stringify(result)).not.toContain("payload_hash");
  });

  it("accepts a clothing-only suggestion and rejects an empty one", async () => {
    const share = await create();
    expect((await reply(share.token, [], "request-empty", "")).status).toBe(
      400,
    );
    expect(
      (
        await reply(
          share.token,
          [share.share.items[0].id],
          "request-clothes",
          "",
        )
      ).status,
    ).toBe(201);
    const result = await (await request(`/api/shares/${share.id}`)).json();
    expect(result.suggestions[0].text).toBe("");
    expect(result.suggestions[0].item_ids).toEqual(["item-a"]);
  });

  it("deduplicates retry requests and rejects changed content for the same identifier", async () => {
    const share = await create();
    expect((await reply(share.token)).status).toBe(201);
    expect((await reply(share.token)).status).toBe(200);
    expect(
      (await reply(share.token, [], "request-one", "不同内容")).status,
    ).toBe(409);
    expect(
      (
        await db.all<{ count: number }>(
          "SELECT count(*) AS count FROM share_replies",
        )
      )[0].count,
    ).toBe(1);
  });

  it("allows viewing after closing replies and rejects all later submissions", async () => {
    const share = await create();
    expect(
      (await request(`/api/shares/${share.id}`, "PATCH", { action: "close" }))
        .status,
    ).toBe(200);
    const view = await request("/api/share/view", "POST", {}, "", share.token);
    expect(view.status).toBe(200);
    expect((await view.json()).accepting).toBe(false);
    expect(
      (
        await request(
          `/api/share/images/${share.share.items[0].image_id}`,
          "GET",
          undefined,
          "",
          share.token,
        )
      ).status,
    ).toBe(200);
    expect((await reply(share.token)).status).toBe(403);
  });

  it.each(["revoke", "regenerate"] as const)(
    "invalidates all old-token routes on %s",
    async (action) => {
      const share = await create();
      const response = await request(`/api/shares/${share.id}`, "PATCH", {
        action,
      });
      expect(response.status).toBe(200);
      expect(
        (await request("/api/share/view", "POST", {}, "", share.token)).status,
      ).toBe(410);
      expect(
        (
          await request(
            `/api/share/images/${share.share.items[0].image_id}`,
            "GET",
            undefined,
            "",
            share.token,
          )
        ).status,
      ).toBe(410);
      expect((await reply(share.token)).status).toBe(410);
      if (action === "regenerate") {
        const next = await response.json();
        expect(next.token).not.toBe(share.token);
        expect(
          (await request("/api/share/view", "POST", {}, "", next.token)).status,
        ).toBe(200);
      }
    },
  );

  it("rejects expired shares for both read and write requests", async () => {
    const share = await create(["item-a"], "owner-a", 1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 86400000);
    expect(
      (await request("/api/share/view", "POST", {}, "", share.token)).status,
    ).toBe(410);
    expect((await reply(share.token)).status).toBe(410);
    expect(
      (await (await request(`/api/shares/${share.id}`)).json()).share.status,
    ).toBe("expired");
  });

  it("checks close atomically when a reply was validated before closing", async () => {
    const share = await create();
    db.beforeRun = async (sql) => {
      if (sql.includes("INSERT OR IGNORE INTO share_replies")) {
        db.beforeRun = undefined;
        await request(`/api/shares/${share.id}`, "PATCH", { action: "close" });
      }
    };
    expect((await reply(share.token)).status).toBe(403);
    expect(await db.all("SELECT * FROM share_replies")).toHaveLength(0);
  });

  it("rechecks authorization after snapshot retrieval before returning image bytes", async () => {
    const share = await create();
    blobs.afterGet = async (key) => {
      if (key.startsWith("share-snapshots/")) {
        blobs.afterGet = undefined;
        await request(`/api/shares/${share.id}`, "PATCH", { action: "revoke" });
      }
    };
    expect(
      (
        await request(
          `/api/share/images/${share.share.items[0].image_id}`,
          "GET",
          undefined,
          "",
          share.token,
        )
      ).status,
    ).toBe(410);
  });

  it("invalidates related shares and removes copied photos when deleting an original", async () => {
    const share = await create();
    await db.batch([
      ...itemShareInvalidationStatements("owner-a", ["item-a"]),
      {
        sql: "DELETE FROM entries WHERE owner_id=? AND collection='items' AND id=?",
        params: ["owner-a", "item-a"],
      },
    ]);
    await invalidateItemShares(runtime, "owner-a", "item-a");
    expect(
      (await request("/api/share/view", "POST", {}, "", share.token)).status,
    ).toBe(410);
    expect(
      (
        await request(`/api/shares/${share.id}`, "PATCH", {
          action: "regenerate",
        })
      ).status,
    ).toBe(409);
    expect(
      [...blobs.files.keys()].filter((key) =>
        key.startsWith("share-snapshots/"),
      ),
    ).toHaveLength(0);
    expect(blobs.files.has("private/owner-a/item-a-original.jpg")).toBe(true);
  });

  it("cleans pending snapshot objects if the source is deleted during creation", async () => {
    blobs.afterPut = async (key) => {
      if (key.startsWith("share-snapshots/")) {
        blobs.afterPut = undefined;
        await db.run(
          "DELETE FROM entries WHERE owner_id=? AND collection='items' AND id=?",
          ["owner-a", "item-a"],
        );
      }
    };
    const response = await request("/api/shares", "POST", {
      question: "问题",
      item_ids: ["item-a"],
    });
    expect(response.status).toBe(409);
    expect(await db.all("SELECT * FROM shares")).toHaveLength(0);
    expect(
      [...blobs.files.keys()].filter((key) =>
        key.startsWith("share-snapshots/"),
      ),
    ).toHaveLength(0);
  });

  it("enforces database-backed reply quotas across requests", async () => {
    const share = await create();
    for (let index = 0; index < 30; index++)
      expect((await reply(share.token, [], `request-${index}`)).status).toBe(
        201,
      );
    expect((await reply(share.token, [], "request-limit")).status).toBe(429);
    expect((await reply(share.token, [], "request-0")).status).toBe(200);
    expect(
      (
        await db.all<{ count: number }>(
          "SELECT count(*) AS count FROM share_replies",
        )
      )[0].count,
    ).toBe(30);
  });

  it("deletes owner suggestions without permitting cross-account access", async () => {
    const share = await create();
    await reply(share.token);
    const detail = await (await request(`/api/shares/${share.id}`)).json();
    const path = `/api/shares/${share.id}/suggestions/${detail.suggestions[0].id}`;
    expect((await request(path, "DELETE", undefined, "owner-b")).status).toBe(
      404,
    );
    expect((await request(path, "DELETE")).status).toBe(200);
    expect((await request(path, "DELETE")).status).toBe(404);
  });

  it("exports portable history without access credentials and imports it read-only", async () => {
    const share = await create();
    await reply(share.token, [share.share.items[0].id]);
    const history = await exportSharingHistory(runtime, "owner-a");
    for (const forbidden of [
      share.token,
      "token_hash",
      "payload_hash",
      "request_id",
      "image_id",
      "object_key",
      "owner-a",
    ]) {
      expect(JSON.stringify(history)).not.toContain(forbidden);
    }
    await db.batch(
      await prepareSharingHistoryImport(runtime, "owner-b", history),
    );
    const list = await (
      await request("/api/shares", "GET", undefined, "owner-b")
    ).json();
    expect(list.shares).toHaveLength(1);
    expect(list.shares[0].status).toBe("imported");
    expect(list.shares[0].items[0].image_id).toBeNull();
    expect(
      (
        await request(
          `/api/shares/${list.shares[0].id}`,
          "PATCH",
          { action: "regenerate" },
          "owner-b",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await db.all<{ token_hash: string | null }>(
          "SELECT token_hash FROM shares WHERE owner_id=?",
          ["owner-b"],
        )
      )[0].token_hash,
    ).toBeNull();
  });

  it("rejects imported credentials and suggestions that refer outside their snapshot", async () => {
    const share = await create();
    await reply(share.token);
    const history = await exportSharingHistory(runtime, "owner-a");
    await expect(
      prepareSharingHistoryImport(runtime, "owner-b", [
        { ...history[0], token_hash: "secret" },
      ]),
    ).rejects.toThrow();
    history[0].suggestions[0].item_ids = ["outside-item"];
    await expect(
      prepareSharingHistoryImport(runtime, "owner-b", history),
    ).rejects.toThrow();
  });

  it("does not invalidate shares or import history when the workspace revision changed", async () => {
    const share = await create();
    const history = await exportSharingHistory(runtime, "owner-a");
    await db.run("INSERT INTO workspaces(owner_id,write_token) VALUES(?,?)", [
      "owner-a",
      "current-token",
    ]);
    await db.batch(
      itemShareInvalidationStatements("owner-a", ["item-a"], "outdated-token"),
    );
    expect(
      (await request("/api/share/view", "POST", {}, "", share.token)).status,
    ).toBe(200);
    await db.batch(
      await prepareSharingHistoryImport(
        runtime,
        "owner-a",
        history,
        "outdated-token",
      ),
    );
    expect(await db.all("SELECT * FROM shares")).toHaveLength(1);
    await db.batch(
      await prepareSharingHistoryImport(
        runtime,
        "owner-a",
        history,
        "current-token",
      ),
    );
    expect(await db.all("SELECT * FROM shares")).toHaveLength(2);
    await db.batch(
      itemShareInvalidationStatements("owner-a", ["item-a"], "current-token"),
    );
    expect(
      (await request("/api/share/view", "POST", {}, "", share.token)).status,
    ).toBe(410);
  });

  it("rejects oversized bodies without trusting a content-length header", async () => {
    const response = await request("/api/shares", "POST", {
      question: "超长".repeat(10000),
      item_ids: ["item-a"],
    });
    expect(response.status).toBe(413);
  });

  it("rejects invalid lengths, duplicate items, external image URLs and malformed images", async () => {
    expect(
      (
        await request("/api/shares", "POST", {
          question: "问题",
          item_ids: ["item-a", "item-a"],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/shares", "POST", {
          question: "问题",
          item_ids: ["item-a"],
          expires_days: 365,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/shares", "POST", {
          question: "问题",
          item_ids: ["item-a"],
          owner_id: "owner-b",
        })
      ).status,
    ).toBe(400);
    await db.run("UPDATE entries SET data=? WHERE owner_id=? AND id=?", [
      JSON.stringify({ image_url: "https://example.com/secret.jpg" }),
      "owner-a",
      "item-a",
    ]);
    expect(
      (
        await request("/api/shares", "POST", {
          question: "问题",
          item_ids: ["item-a"],
        })
      ).status,
    ).toBe(400);
    blobs.files.set(
      "private/owner-a/item-b-original.jpg",
      new TextEncoder().encode("not a JPEG"),
    );
    expect(
      (
        await request("/api/shares", "POST", {
          question: "问题",
          item_ids: ["item-b"],
        })
      ).status,
    ).toBe(400);
  });
});
