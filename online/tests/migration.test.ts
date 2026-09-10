import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createNodePlatform } from "../src/adapters/node.js";
import {
  emptyWorkspace,
  storedItem,
  validateWorkspace,
  type Workspace,
} from "../src/models.js";
import {
  readWorkspace,
  commitWorkspace,
  mutateWorkspace,
} from "../src/repository.js";
import {
  mountMigration,
  readArchive,
  makeArchive,
  archiveLimits,
} from "../src/migration.js";
import type { Runtime } from "../src/platform.js";
import { starterLimits } from "../src/limits.js";
import { flushBlobDeletes } from "../src/cleanup.js";

type Env = {
  Variables: { runtime: Runtime; ownerId: string; sourceKey?: string };
};
const image = new Uint8Array(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
    "base64",
  ),
);
const itemId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const imageFile = "a".repeat(32) + "-original.jpg";
const time = "2026-09-10T12:00:00.000Z";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
let platform: ReturnType<typeof createNodePlatform>,
  runtime: Runtime,
  app: Hono<Env>,
  directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "yijian-migration-"));
  platform = createNodePlatform({
    databasePath: ":memory:",
    blobDirectory: join(directory, "blobs"),
  });
  runtime = {
    ...platform,
    publicOrigin: "https://yijian.example",
    registrationMode: "closed",
  };
  for (const owner of ["owner-a", "owner-b"]) {
    await platform.db.run(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,?,?)",
      [owner, owner, `${owner}@example.com`, time, time],
    );
    await readWorkspace(runtime, owner);
  }
  app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("runtime", runtime);
    c.set("ownerId", c.req.header("x-test-owner") || "");
    await next();
  });
  app.onError((error, c) =>
    c.json(
      { detail: error.message },
      error instanceof HTTPException ? error.status : 500,
    ),
  );
  mountMigration(app);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  platform.close();
  await rm(directory, { recursive: true, force: true });
});

function workspace() {
  const state = emptyWorkspace();
  state.settings.name = "来源衣柜";
  state.items.push(
    storedItem.parse({
      id: itemId,
      name: "白色上衣",
      category: "top",
      confirmed: true,
      created_at: time,
      updated_at: time,
      image_url: `/api/images/${imageFile}`,
      original_url: `/api/images/${imageFile}`,
      ai_status: "processing",
      ai_error: "PRIVATE JOB DETAILS",
    }),
  );
  state.outfits.push({
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    name: "白色穿搭",
    item_ids: [itemId],
    notes: "",
    source: "manual",
    layout: null,
    created_at: time,
  });
  return state;
}
function archive(
  state: Workspace = workspace(),
  options: {
    files?: Record<string, Uint8Array>;
    manifest?: Record<string, unknown>;
    history?: unknown;
  } = {},
) {
  const manifest = {
    format: "yijian-workspace",
    version: 1,
    exported_at: time,
    data: state,
    sha256: { [imageFile]: hash(image) },
    sharing_history: options.history ?? [],
    ...options.manifest,
  };
  return zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    [`images/${imageFile}`]: image,
    ...options.files,
  });
}
async function preview(bytes = archive(), owner = "owner-a") {
  const form = new FormData();
  form.set(
    "file",
    new File([bytes.slice().buffer as ArrayBuffer], "衣间.zip", {
      type: "application/zip",
    }),
  );
  return app.request("/api/migration/preview", {
    method: "POST",
    headers: { "x-test-owner": owner },
    body: form,
  });
}
function apply(previewId: string, owner = "owner-a") {
  return app.request("/api/migration/import", {
    method: "POST",
    headers: { "x-test-owner": owner, "Content-Type": "application/json" },
    body: JSON.stringify({ preview_id: previewId }),
  });
}
async function seedTarget(
  state = workspace(),
  owner = "owner-a",
  bytes = image,
) {
  const before = await readWorkspace(runtime, owner);
  const key = `wardrobes/${owner}/${imageFile}`;
  await runtime.blobs.put(key, bytes);
  await commitWorkspace(
    runtime,
    owner,
    before,
    validateWorkspace(state),
    (writeToken) => [
      {
        sql: "INSERT INTO assets(owner_id,name,object_key,sha256,size) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM workspaces WHERE owner_id=? AND write_token=?)",
        params: [
          owner,
          imageFile,
          key,
          hash(bytes),
          bytes.length,
          owner,
          writeToken,
        ],
      },
    ],
  );
}
function patchCentral(
  bytes: Uint8Array,
  patch: (view: DataView, offset: number, index: number) => void,
) {
  const result = bytes.slice(),
    view = new DataView(result.buffer);
  let offset = view.getUint32(result.length - 6, true),
    index = 0;
  while (view.getUint32(offset, true) === 0x02014b50) {
    const next =
      offset +
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
    patch(view, offset, index++);
    offset = next;
  }
  return result;
}

describe("portable ZIP migration", () => {
  it("preserves imported photos when the database commits but its response is lost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(time));
    const report = await (await preview()).json();
    const originalBatch = runtime.db.batch.bind(runtime.db);
    let interrupted = false;
    vi.spyOn(runtime.db, "batch").mockImplementation(async (statements) => {
      const result = await originalBatch(statements);
      if (
        !interrupted &&
        statements.some((statement) =>
          statement.sql.includes("INSERT INTO assets"),
        )
      ) {
        interrupted = true;
        throw new Error("database response lost after commit");
      }
      return result;
    });
    const result = await apply(report.preview_id);
    expect(result.status).toBe(200);
    expect(interrupted).toBe(true);
    expect((await readWorkspace(runtime, "owner-a")).state.items).toHaveLength(
      1,
    );
    const [asset] = await runtime.db.all<{ object_key: string }>(
      "SELECT object_key FROM assets WHERE owner_id=?",
      ["owner-a"],
    );
    expect(await runtime.blobs.get(asset.object_key)).toEqual(image);
    vi.setSystemTime(new Date(Date.parse(time) + 61_000));
    await flushBlobDeletes(runtime, "owner-a");
    expect(await runtime.blobs.get(asset.object_key)).toEqual(image);
    expect(await runtime.db.all("SELECT * FROM blob_delete_jobs")).toEqual([]);
    const backup = await app.request("/api/backup", {
      headers: { "x-test-owner": "owner-a" },
    });
    expect(backup.status).toBe(200);
    expect(
      (await readArchive(new Uint8Array(await backup.arrayBuffer()))).state
        .items,
    ).toHaveLength(1);
  });

  it("rejects imports whose merged photo usage exceeds the starter capacity", async () => {
    await runtime.db.run(
      "INSERT INTO assets(owner_id,name,object_key,sha256,size) VALUES(?,?,?,?,?)",
      [
        "owner-a",
        "reserved-original.jpg",
        "private/reserved.jpg",
        "0".repeat(64),
        starterLimits.imageStorageBytes,
      ],
    );
    expect((await preview()).status).toBe(413);
    expect((await readWorkspace(runtime, "owner-a")).state.items).toHaveLength(
      0,
    );
  });

  it("rechecks photo capacity inside the same import transaction", async () => {
    const report = await (await preview()).json();
    const batch = runtime.db.batch.bind(runtime.db);
    let inserted = false;
    vi.spyOn(runtime.db, "batch").mockImplementation(async (statements) => {
      if (
        !inserted &&
        statements.some((statement) =>
          statement.sql.includes("INSERT INTO assets"),
        )
      ) {
        inserted = true;
        await runtime.db.run(
          "INSERT INTO assets(owner_id,name,object_key,sha256,size) VALUES(?,?,?,?,?)",
          [
            "owner-a",
            "reserved-original.jpg",
            "private/reserved.jpg",
            "0".repeat(64),
            starterLimits.imageStorageBytes,
          ],
        );
      }
      return batch(statements);
    });
    expect((await apply(report.preview_id)).status).toBe(413);
    expect((await readWorkspace(runtime, "owner-a")).state.items).toHaveLength(
      0,
    );
    expect(await runtime.db.all("SELECT * FROM assets")).toHaveLength(1);
    expect(await runtime.db.all("SELECT * FROM capacity_guards")).toHaveLength(
      0,
    );
  });

  it("rejects excess source records and portable sharing history before writing", async () => {
    const state = workspace();
    for (let index = 0; index < starterLimits.itemCount; index++)
      state.items.push({ ...state.items[0], id: crypto.randomUUID() });
    expect((await preview(archive(state))).status).toBe(413);
    const suggestions = Array.from({ length: 200 }, () => ({
      nickname: "",
      text: "建议",
      item_ids: [],
      created_at: time,
    }));
    const history = [0, 1].map(() => ({
      question: "分享历史",
      created_at: time,
      items: [],
      suggestions,
    }));
    expect((await preview(archive(workspace(), { history }))).status).toBe(413);
    expect(
      await runtime.db.all("SELECT * FROM migration_previews"),
    ).toHaveLength(0);
  });

  it("returns a committed import even when physical preview cleanup must be retried", async () => {
    const report = await (await preview()).json();
    const originalDelete = runtime.blobs.delete.bind(runtime.blobs);
    vi.spyOn(runtime.blobs, "delete").mockRejectedValue(
      new Error("temporary storage failure"),
    );
    expect((await apply(report.preview_id)).status).toBe(200);
    expect((await readWorkspace(runtime, "owner-a")).state.items).toHaveLength(
      1,
    );
    expect(await runtime.db.all("SELECT * FROM blob_delete_jobs")).toHaveLength(
      1,
    );
    vi.spyOn(runtime.blobs, "delete").mockImplementation(originalDelete);
    expect((await preview()).status).toBe(200);
    expect(await runtime.db.all("SELECT * FROM blob_delete_jobs")).toHaveLength(
      0,
    );
  });
  it("previews without modifying the workspace and imports pictures and records once", async () => {
    const response = await preview();
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report.counts.items).toBe(1);
    expect(report.counts.outfits).toBe(1);
    expect((await readWorkspace(runtime, "owner-a")).state.items).toHaveLength(
      0,
    );
    const result = await apply(report.preview_id);
    expect(result.status).toBe(200);
    expect(await (await apply(report.preview_id)).json()).toEqual(
      await result.json(),
    );
    const state = (await readWorkspace(runtime, "owner-a")).state;
    expect(state.items).toHaveLength(1);
    expect(state.settings.name).toBe("来源衣柜");
    expect(state.items[0].ai_status).toBe("idle");
    expect(state.items[0].ai_error).toBeNull();
    const assets = await runtime.db.all<{ object_key: string; sha256: string }>(
      "SELECT * FROM assets WHERE owner_id=?",
      ["owner-a"],
    );
    expect(assets).toHaveLength(1);
    expect(assets[0].sha256).toBe(hash(image));
    expect(await runtime.blobs.get(assets[0].object_key)).toEqual(image);
    const rows = await runtime.db.all<{ object_key: null; status: string }>(
      "SELECT * FROM migration_previews",
    );
    expect(rows[0].object_key).toBeNull();
    expect(rows[0].status).toBe("imported");
  });

  it("binds previews to their account and rejects unregistered owner access", async () => {
    const report = await (await preview()).json();
    expect((await apply(report.preview_id, "owner-b")).status).toBe(404);
    expect((await preview(archive(), "")).status).toBe(401);
    expect((await app.request("/api/backup")).status).toBe(401);
    expect((await readWorkspace(runtime, "owner-b")).state.items).toHaveLength(
      0,
    );
  });

  it("retains target changes, reports conflicts, and adds nonconflicting records", async () => {
    const target = workspace();
    target.items[0].name = "目标自己的名称";
    target.settings.name = "保留目标设置";
    await seedTarget(target);
    const source = workspace();
    source.items.push({ ...source.items[0], id: otherId, name: "另一件衣物" });
    const report = await (await preview(archive(source))).json();
    expect(report.counts.items).toBe(1);
    expect(
      report.conflicts.some((entry: { id: string }) => entry.id === itemId),
    ).toBe(true);
    expect((await apply(report.preview_id)).status).toBe(200);
    const state = (await readWorkspace(runtime, "owner-a")).state;
    expect(state.items.find((item) => item.id === itemId)?.name).toBe(
      "目标自己的名称",
    );
    expect(state.items).toHaveLength(2);
    expect(state.settings.name).toBe("保留目标设置");
    expect(await runtime.db.all("SELECT * FROM assets")).toHaveLength(1);
  });

  it("counts exact duplicates without creating additional records", async () => {
    const state = workspace();
    state.items[0].ai_status = "idle";
    state.items[0].ai_error = null;
    await seedTarget(state);
    const report = await (await preview(archive(state))).json();
    expect(report.duplicates).toBe(2);
    expect(report.counts.items).toBe(0);
    expect((await apply(report.preview_id)).status).toBe(200);
    expect((await readWorkspace(runtime, "owner-a")).state.items).toHaveLength(
      1,
    );
  });

  it("rejects same-name different-hash images without changing target objects", async () => {
    const changed = new Uint8Array([...image, 42]);
    await seedTarget(workspace(), "owner-a", changed);
    expect((await preview()).status).toBe(409);
    expect(await runtime.blobs.get(`wardrobes/owner-a/${imageFile}`)).toEqual(
      changed,
    );
    expect(
      await runtime.db.all("SELECT * FROM migration_previews"),
    ).toHaveLength(0);
  });

  it("allows equal filenames in independent accounts", async () => {
    const changed = new Uint8Array([...image, 42]);
    await seedTarget(workspace(), "owner-b", changed);
    const report = await (await preview()).json();
    expect((await apply(report.preview_id)).status).toBe(200);
    expect(await runtime.blobs.get(`wardrobes/owner-b/${imageFile}`)).toEqual(
      changed,
    );
    expect(await runtime.db.all("SELECT * FROM assets")).toHaveLength(2);
  });

  it("does not silently reuse a missing or corrupted target photo", async () => {
    await seedTarget();
    await runtime.blobs.put(
      `wardrobes/owner-a/${imageFile}`,
      new Uint8Array([1, 2, 3]),
    );
    expect((await preview()).status).toBe(409);
    await runtime.blobs.delete(`wardrobes/owner-a/${imageFile}`);
    expect((await preview()).status).toBe(409);
  });

  it("requires a new preview after a target revision change", async () => {
    const report = await (await preview()).json();
    await mutateWorkspace(runtime, "owner-a", (state) => {
      state.settings.name = "刚刚编辑";
    });
    expect((await apply(report.preview_id)).status).toBe(409);
    expect((await readWorkspace(runtime, "owner-a")).state.items).toHaveLength(
      0,
    );
  });

  it("rolls back staged blobs and sharing history when a concurrent write wins the CAS", async () => {
    const history = [
      {
        question: "历史问题",
        created_at: time,
        items: [{ item_id: itemId, name: "上衣", category: "top", brand: "" }],
        suggestions: [],
      },
    ];
    const report = await (
      await preview(archive(workspace(), { history }))
    ).json();
    const put = runtime.blobs.put.bind(runtime.blobs),
      staged: string[] = [];
    vi.spyOn(runtime.blobs, "put").mockImplementation(async (key, bytes) => {
      await put(key, bytes);
      if (key.startsWith("wardrobes/")) {
        staged.push(key);
        await mutateWorkspace(runtime, "owner-a", (state) => {
          state.settings.name = "并发修改";
        });
      }
    });
    expect((await apply(report.preview_id)).status).toBe(409);
    expect(await runtime.db.all("SELECT * FROM shares")).toHaveLength(0);
    expect(await runtime.db.all("SELECT * FROM assets")).toHaveLength(0);
    for (const key of staged) expect(await runtime.blobs.get(key)).toBeNull();
  });

  it("makes parallel confirmation of the same preview idempotent", async () => {
    const report = await (await preview()).json();
    const responses = await Promise.all([
      apply(report.preview_id),
      apply(report.preview_id),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect((await readWorkspace(runtime, "owner-a")).state.items).toHaveLength(
      1,
    );
    expect(await runtime.db.all("SELECT * FROM assets")).toHaveLength(1);
  });

  it("expires previews after fifteen minutes and limits pending archive storage", async () => {
    const report = await (await preview()).json();
    await preview();
    await preview();
    expect((await preview()).status).toBe(429);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60000);
    expect((await apply(report.preview_id)).status).toBe(409);
    expect((await preview()).status).toBe(200);
    expect(
      await runtime.db.all(
        "SELECT * FROM migration_previews WHERE object_key IS NOT NULL",
      ),
    ).toHaveLength(1);
  });

  it("imports sharing history read-only without copying live link credentials", async () => {
    const history = [
      {
        question: "历史问题",
        created_at: time,
        items: [{ item_id: itemId, name: "上衣", category: "top", brand: "" }],
        suggestions: [
          {
            nickname: "朋友",
            text: "很好看",
            item_ids: [itemId],
            created_at: time,
          },
        ],
      },
    ];
    const report = await (
      await preview(archive(workspace(), { history }))
    ).json();
    expect((await apply(report.preview_id)).status).toBe(200);
    const shares = await runtime.db.all<{ status: string; token_hash: null }>(
      "SELECT * FROM shares",
    );
    expect(shares[0].status).toBe("imported");
    expect(shares[0].token_hash).toBeNull();
    expect(await runtime.db.all("SELECT * FROM share_replies")).toHaveLength(1);
  });

  it("exports the Python-compatible manifest and strips private or transient fields", async () => {
    await seedTarget();
    await runtime.db.run(
      "UPDATE entries SET data=json_set(data,'$.api_key','PRIVATE-API-KEY','$.ai_job_id','job-secret') WHERE collection='items'",
    );
    const result = await makeArchive(runtime, "owner-a");
    const contents = unzipSync(result);
    const manifest = JSON.parse(
      new TextDecoder().decode(contents["manifest.json"]),
    );
    expect(manifest.format).toBe("yijian-workspace");
    expect(manifest.version).toBe(1);
    expect(manifest.data.schema_version).toBe(1);
    expect(manifest.sha256[imageFile]).toBe(hash(image));
    expect(JSON.stringify(manifest)).not.toContain("PRIVATE-API-KEY");
    expect(JSON.stringify(manifest)).not.toContain("job-secret");
    expect(JSON.stringify(manifest)).not.toContain("PRIVATE JOB DETAILS");
    expect((await readArchive(result)).state.items).toHaveLength(1);
  });

  it("rejects malformed references, duplicate ids and unsupported format versions", async () => {
    const missing = workspace();
    missing.outfits[0].item_ids = [otherId];
    expect((await preview(archive(missing))).status).toBe(422);
    const duplicate = workspace();
    duplicate.items.push({ ...duplicate.items[0] });
    expect((await preview(archive(duplicate))).status).toBe(422);
    expect(
      (await preview(archive(workspace(), { manifest: { version: 2 } })))
        .status,
    ).toBe(422);
    expect(
      (
        await preview(
          archive(workspace(), {
            manifest: { sha256: { [imageFile]: "0".repeat(64) } },
          }),
        )
      ).status,
    ).toBe(422);
  });

  it("rejects extra images, traversal names, absolute paths and symlink entries", async () => {
    for (const name of [
      "../secret",
      "/absolute",
      "images/unlisted.jpg",
      "images\\fake.jpg",
    ]) {
      await expect(
        readArchive(archive(workspace(), { files: { [name]: image } })),
      ).rejects.toThrow();
    }
    const symlink = patchCentral(archive(), (view, offset) =>
      view.setUint32(offset + 38, 0xa1ff << 16, true),
    );
    await expect(readArchive(symlink)).rejects.toThrow("符号链接");
  });

  it("rejects corrupted checksums even when central and local declarations agree", async () => {
    const corrupt = patchCentral(archive(), (view, offset, index) => {
      if (index === 1) {
        view.setUint32(offset + 16, 0, true);
        view.setUint32(view.getUint32(offset + 42, true) + 14, 0, true);
      }
    });
    await expect(readArchive(corrupt)).rejects.toThrow("校验");
  });

  it("checks declared expansion limits before allocating image output", async () => {
    const large = patchCentral(archive(), (view, offset, index) => {
      if (index === 1)
        view.setUint32(offset + 24, archiveLimits.image + 1, true);
    });
    await expect(readArchive(large)).rejects.toThrow("容量上限");
  });

  it("stops a deflate stream that expands beyond its declaration", async () => {
    const compressed = archive(workspace(), {
      files: { [`images/${imageFile}`]: new Uint8Array(2 * 1024 * 1024) },
    });
    const lying = patchCentral(compressed, (view, offset, index) => {
      if (index === 1) {
        view.setUint32(offset + 24, 1, true);
        view.setUint32(view.getUint32(offset + 42, true) + 22, 1, true);
      }
    });
    await expect(readArchive(lying)).rejects.toThrow("实际展开容量");
  });

  it("rejects encrypted files and central/local filename mismatches", async () => {
    const encrypted = patchCentral(archive(), (view, offset) =>
      view.setUint16(offset + 8, 1, true),
    );
    await expect(readArchive(encrypted)).rejects.toThrow("加密");
    const mismatched = patchCentral(archive(), (view, offset, index) => {
      if (index === 1)
        view.setUint8(view.getUint32(offset + 42, true) + 30, 120);
    });
    await expect(readArchive(mismatched)).rejects.toThrow();
  });

  it("rejects duplicate ZIP names before decoding payloads", async () => {
    const second = "b".repeat(32) + "-original.jpg";
    const duplicate = patchCentral(
      archive(workspace(), { files: { [`images/${second}`]: image } }),
      (view, offset, index) => {
        if (index === 2) {
          const local = view.getUint32(offset + 42, true);
          for (let position = 0; position < 32; position++) {
            view.setUint8(offset + 46 + 7 + position, 97);
            view.setUint8(local + 30 + 7 + position, 97);
          }
        }
      },
    );
    await expect(readArchive(duplicate)).rejects.toThrow("重复路径");
  });

  it.skipIf(!process.env.YIJIAN_TEST_PYTHON)(
    "round-trips through the existing Python backup reader and writer",
    async () => {
      await seedTarget();
      const exported = await makeArchive(runtime, "owner-a"),
        source = join(directory, "cloud.zip"),
        target = join(directory, "local.zip");
      await writeFile(source, exported);
      const script = `from pathlib import Path\nfrom types import SimpleNamespace\nfrom server.backup import read_archive,make_archive\nimport sys\ndata,blobs=read_archive(Path(sys.argv[1]).read_bytes())\nroot=Path(sys.argv[2]).parent\nfor name,content in blobs.items(): (root/name).write_bytes(content)\nPath(sys.argv[2]).write_bytes(make_archive(SimpleNamespace(read=lambda:data),SimpleNamespace(resolve=lambda name:root/name)))\nprint(len(data['items']))`;
      const result = spawnSync(
        process.env.YIJIAN_TEST_PYTHON!,
        ["-c", script, source, target],
        {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("1");
      const imported = await readArchive(
        new Uint8Array(await readFile(target)),
      );
      expect(imported.state.items[0].id).toBe(itemId);
      expect(imported.images.get(imageFile)).toEqual(image);
    },
  );
});
