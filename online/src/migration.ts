import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { Inflate, zipSync } from "fflate";
import { z } from "zod";
import type { Runtime, Statement } from "./platform.js";
import {
  collections,
  imageName,
  imageNames,
  validateWorkspace,
  checkRelations,
  type Workspace,
  type Collection,
  type Entity,
} from "./models.js";
import { readWorkspace, commitWorkspace } from "./repository.js";
import { stripJpegMetadata } from "./jpeg.js";
import { starterLimits, assertWorkspaceCapacity } from "./limits.js";
import { blobDeletionStatements, flushBlobDeletes } from "./cleanup.js";
import {
  exportSharingHistory,
  prepareSharingHistoryImport,
  type SharingHistory,
  isCapacityFailure,
} from "./sharing.js";

type Env = {
  Variables: { runtime: Runtime; ownerId: string; sourceKey?: string };
};
export const archiveLimits = {
  archive: starterLimits.archiveBytes,
  expanded: starterLimits.expandedBytes,
  manifest: starterLimits.manifestBytes,
  image: starterLimits.imageBytes,
  entries: starterLimits.imageCount + 1,
};
const timestamp = () => new Date().toISOString();
const encode = (value: string) => new TextEncoder().encode(value);
const invalid = (message = "备份校验失败，请选择完整的衣间备份。") =>
  new HTTPException(422, { message });
const oversized = (
  message = "迁移包超过容量上限：压缩包和展开内容各 24 MB、照片合计 16 MB、单张照片 5 MB、清单 2 MB。",
) => new HTTPException(413, { message });
const conflict = (message: string) => new HTTPException(409, { message });
async function sha(bytes: Uint8Array) {
  const result = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
const crcTable = new Uint32Array(256).map((_, value) => {
  let crc = value;
  for (let index = 0; index < 8; index++)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
type ZipEntry = {
  name: string;
  method: number;
  crc: number;
  compressed: number;
  expanded: number;
  start: number;
  end: number;
};

function zipEntries(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length > archiveLimits.archive) throw oversized();
  if (bytes.length < 22) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && u32(end) !== 0x06054b50)
    end--;
  if (
    end < 0 ||
    u32(end) !== 0x06054b50 ||
    end + 22 + u16(end + 20) !== bytes.length
  )
    throw invalid();
  const count = u16(end + 10),
    centralSize = u32(end + 12),
    central = u32(end + 16);
  if (
    u16(end + 4) ||
    u16(end + 6) ||
    u16(end + 8) !== count ||
    count === 65535 ||
    central === 0xffffffff ||
    centralSize === 0xffffffff
  )
    throw invalid("不支持分卷或 ZIP64 迁移包。");
  if (!count || count > archiveLimits.entries || central + centralSize !== end)
    throw invalid();
  const entries: ZipEntry[] = [],
    names = new Set<string>(),
    ranges: [number, number][] = [];
  let cursor = central,
    expanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) throw invalid();
    const flags = u16(cursor + 8),
      method = u16(cursor + 10),
      crc = u32(cursor + 16);
    const compressed = u32(cursor + 20),
      size = u32(cursor + 24);
    const nameLength = u16(cursor + 28),
      extraLength = u16(cursor + 30),
      commentLength = u16(cursor + 32);
    const local = u32(cursor + 42),
      nameEnd = cursor + 46 + nameLength;
    if (
      nameEnd + extraLength + commentLength > end ||
      u16(cursor + 34) ||
      flags & ~0x0808 ||
      ![0, 8].includes(method)
    )
      throw invalid("迁移包包含不支持的压缩或加密方式。");
    if (((u32(cursor + 38) >>> 16) & 0xf000) === 0xa000)
      throw invalid("迁移包不能包含符号链接。");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(cursor + 46, nameEnd),
    );
    if (
      name !== "manifest.json" &&
      !(name.startsWith("images/") && imageName.test(name.slice(7)))
    )
      throw invalid("迁移包包含无效路径。");
    if (names.has(name)) throw invalid("迁移包包含重复路径。");
    names.add(name);
    const limit =
      name === "manifest.json" ? archiveLimits.manifest : archiveLimits.image;
    expanded += size;
    if (size > limit || expanded > archiveLimits.expanded) throw oversized();
    if (
      compressed > archiveLimits.archive ||
      local + 30 > central ||
      u32(local) !== 0x04034b50
    )
      throw invalid();
    const localNameLength = u16(local + 26),
      localExtraLength = u16(local + 28);
    const start = local + 30 + localNameLength + localExtraLength;
    if (
      start > central ||
      start + compressed > central ||
      u16(local + 6) !== flags ||
      u16(local + 8) !== method
    )
      throw invalid();
    const localName = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(local + 30, local + 30 + localNameLength),
    );
    if (
      localName !== name ||
      (!(flags & 8) &&
        (u32(local + 14) !== crc ||
          u32(local + 18) !== compressed ||
          u32(local + 22) !== size))
    )
      throw invalid();
    for (const [extraStart, extraEnd] of [
      [nameEnd, nameEnd + extraLength],
      [local + 30 + localNameLength, start],
    ]) {
      let extra = extraStart;
      while (extra < extraEnd) {
        if (
          extra + 4 > extraEnd ||
          u16(extra) === 1 ||
          extra + 4 + u16(extra + 2) > extraEnd
        )
          throw invalid("迁移包的额外字段无效。");
        extra += 4 + u16(extra + 2);
      }
    }
    ranges.push([local, start + compressed]);
    entries.push({
      name,
      method,
      crc,
      compressed,
      expanded: size,
      start,
      end: start + compressed,
    });
    cursor = nameEnd + extraLength + commentLength;
  }
  if (cursor !== end || !names.has("manifest.json")) throw invalid();
  ranges.sort((left, right) => left[0] - right[0]);
  if (
    ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1])
  )
    throw invalid("迁移包中的文件区域重叠。");
  return entries;
}
function expand(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  if (entry.method === 0) {
    const content = bytes.slice(entry.start, entry.end);
    if (content.length !== entry.expanded || crc32(content) !== entry.crc)
      throw invalid("迁移包文件校验失败。");
    return content;
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const inflater = new Inflate((chunk) => {
    length += chunk.length;
    if (length > entry.expanded)
      throw invalid("迁移包实际展开容量与声明不符。");
    chunks.push(chunk);
  });
  // Small compressed chunks bound the allocation before each expanded-size check.
  for (let cursor = entry.start; cursor < entry.end; cursor += 1024) {
    inflater.push(
      bytes.subarray(cursor, Math.min(entry.end, cursor + 1024)),
      cursor + 1024 >= entry.end,
    );
  }
  if (length !== entry.expanded) throw invalid("迁移包文件长度不符。");
  const content = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    content.set(chunk, cursor);
    cursor += chunk.length;
  }
  if (crc32(content) !== entry.crc) throw invalid("迁移包文件校验失败。");
  return content;
}
type Archive = {
  state: Workspace;
  images: Map<string, Uint8Array>;
  hashes: Record<string, string>;
  sharing: SharingHistory;
};
export async function readArchive(bytes: Uint8Array): Promise<Archive> {
  try {
    const entries = zipEntries(bytes);
    const manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        expand(bytes, entries.find((entry) => entry.name === "manifest.json")!),
      ),
    );
    if (
      !manifest ||
      manifest.format !== "yijian-workspace" ||
      manifest.version !== 1 ||
      !manifest.sha256 ||
      typeof manifest.sha256 !== "object" ||
      Array.isArray(manifest.sha256)
    )
      throw invalid("只支持衣间第 1 版迁移包。");
    const state = validateWorkspace(manifest.data);
    assertWorkspaceCapacity(state);
    for (const item of state.items) {
      item.ai_status = item.confirmed ? "idle" : "review";
      item.ai_error = null;
    }
    const referenced = new Set(state.items.flatMap(imageNames));
    if (
      referenced.size > starterLimits.imageCount ||
      entries
        .filter((entry) => entry.name !== "manifest.json")
        .reduce((sum, entry) => sum + entry.expanded, 0) >
        starterLimits.imageStorageBytes
    )
      throw oversized();
    if (
      Object.keys(manifest.sha256).length !== referenced.size ||
      Object.keys(manifest.sha256).some((name) => !referenced.has(name)) ||
      entries.length !== referenced.size + 1
    )
      throw invalid("照片清单与衣物引用不一致。");
    const images = new Map<string, Uint8Array>(),
      hashes: Record<string, string> = {};
    for (const name of referenced) {
      const entry = entries.find(
        (candidate) => candidate.name === `images/${name}`,
      );
      const expected = manifest.sha256[name];
      if (
        !entry ||
        typeof expected !== "string" ||
        !/^[a-f0-9]{64}$/.test(expected)
      )
        throw invalid("照片清单缺失或校验码无效。");
      const content = expand(bytes, entry);
      if ((await sha(content)) !== expected)
        throw invalid("照片校验失败，请重新导出备份。");
      stripJpegMetadata(content);
      images.set(name, content);
      hashes[name] = expected;
    }
    const sharing = manifest.sharing_history ?? [];
    // Preparation validates the portable whitelist without writing database records.
    await prepareSharingHistoryImport({} as Runtime, "validation", sharing);
    return { state, images, hashes, sharing };
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (error instanceof Error && "status" in error && error.status === 413)
      throw oversized(error.message);
    throw invalid();
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
type Conflict = { collection: Collection; id: string; name: string };
function merge(target: Workspace, incoming: Workspace) {
  const state = structuredClone(target),
    conflicts: Conflict[] = [];
  const counts = Object.fromEntries(
    collections.map((key) => [key, 0]),
  ) as Record<Collection, number>;
  const empty = collections.every((key) => target[key].length === 0);
  let duplicates = 0;
  if (empty) state.settings = structuredClone(incoming.settings);
  for (const collection of collections) {
    const byId = new Map(
      state[collection].map((entity) => [entity.id, entity]),
    );
    for (const entity of incoming[collection]) {
      const existing =
        byId.get(entity.id) ??
        (collection === "wear_events"
          ? state.wear_events.find(
              (event) => event.request_id === entity.request_id,
            )
          : undefined);
      if (existing) {
        if (stable(existing) === stable(entity)) duplicates++;
        else
          conflicts.push({
            collection,
            id: entity.id,
            name: String(
              entity.name || entity.item_name || entity.date || "已有记录",
            ),
          });
        continue;
      }
      state[collection].push(structuredClone(entity));
      byId.set(entity.id, entity);
      counts[collection]++;
    }
  }
  checkRelations(state);
  assertWorkspaceCapacity(state);
  return {
    state,
    counts,
    duplicates,
    conflicts,
    requires_empty: false as const,
  };
}
async function checkAssetConflicts(
  runtime: Runtime,
  ownerId: string,
  archive: Archive,
  needed = new Set(archive.state.items.flatMap(imageNames)),
) {
  const assets = await runtime.db.all<{
    name: string;
    sha256: string;
    size: number;
    object_key: string;
  }>("SELECT name,sha256,size,object_key FROM assets WHERE owner_id=?", [
    ownerId,
  ]);
  for (const asset of assets)
    if (
      archive.hashes[asset.name] &&
      archive.hashes[asset.name] !== asset.sha256
    ) {
      throw conflict(
        "同名照片内容不同，迁移已停止。请在来源衣柜重新保存对应照片后再次导出。",
      );
    }
  for (const asset of assets)
    if (archive.hashes[asset.name]) {
      const bytes = await runtime.blobs.get(asset.object_key);
      if (!bytes || (await sha(bytes)) !== asset.sha256)
        throw conflict("目标衣柜的同名照片损坏或缺失，请先修复照片再迁移。");
    }
  const existingNames = new Set(assets.map((asset) => asset.name));
  const total =
    assets.reduce((sum, asset) => sum + asset.size, 0) +
    [...archive.images].reduce(
      (sum, [name, bytes]) =>
        sum + (existingNames.has(name) || !needed.has(name) ? 0 : bytes.length),
      0,
    );
  const added = [...archive.images.keys()].filter(
    (name) => needed.has(name) && !existingNames.has(name),
  ).length;
  if (added) {
    await flushBlobDeletes(runtime, ownerId);
    const [pending] = await runtime.db.all<{ count: number }>(
      "SELECT count(*) AS count FROM blob_delete_jobs WHERE owner_id=?",
      [ownerId],
    );
    if (pending.count) throw conflict("照片清理尚未完成，请稍后再迁移。");
  }
  if (
    total > starterLimits.imageStorageBytes ||
    assets.length + added > starterLimits.imageCount
  )
    throw oversized("合并后的照片超过 16 MB 或 150 张，请先整理衣柜。");
  return existingNames;
}
type PreviewRow = {
  id: string;
  owner_id: string;
  object_key: string | null;
  sha256: string;
  target_revision: number;
  expires_at: string;
  status: "ready" | "imported";
  result: string | null;
};
async function cleanPreviews(runtime: Runtime, ownerId: string) {
  const expired = await runtime.db.all<{ id: string; object_key: string }>(
    `SELECT id,object_key FROM migration_previews WHERE owner_id=? AND status='ready' AND expires_at<=? AND object_key IS NOT NULL`,
    [ownerId, timestamp()],
  );
  for (const preview of expired) {
    await runtime.db.batch([
      ...blobDeletionStatements(ownerId, [preview.object_key]),
      {
        sql: "UPDATE migration_previews SET object_key=NULL WHERE id=? AND owner_id=? AND status=?",
        params: [preview.id, ownerId, "ready"],
      },
    ]);
  }
  await flushBlobDeletes(runtime, ownerId);
}
async function owner(c: Context<Env>) {
  const ownerId = c.get("ownerId");
  if (!ownerId) throw new HTTPException(401, { message: "请先登录衣间。" });
  return { runtime: c.get("runtime"), ownerId };
}
export async function makeArchive(
  runtime: Runtime,
  ownerId: string,
): Promise<Uint8Array> {
  const workspace = await readWorkspace(runtime, ownerId),
    state = validateWorkspace(workspace.state);
  assertWorkspaceCapacity(state);
  for (const item of state.items) {
    item.ai_status = item.confirmed ? "idle" : "review";
    item.ai_error = null;
  }
  const files: Record<string, Uint8Array> = {},
    hashes: Record<string, string> = {};
  let expanded = 0;
  const names = [...new Set(state.items.flatMap(imageNames))];
  if (names.length + 1 > archiveLimits.entries) throw oversized();
  for (const name of names) {
    const [asset] = await runtime.db.all<{
      object_key: string;
      sha256: string;
    }>("SELECT object_key,sha256 FROM assets WHERE owner_id=? AND name=?", [
      ownerId,
      name,
    ]);
    const bytes = asset ? await runtime.blobs.get(asset.object_key) : null;
    if (!bytes) throw conflict("部分照片无法读取，请检查照片后重新导出。");
    expanded += bytes.length;
    if (
      bytes.length > archiveLimits.image ||
      expanded > starterLimits.imageStorageBytes
    )
      throw oversized();
    const hash = await sha(bytes);
    if (hash !== asset.sha256)
      throw conflict("照片校验失败，请先检查照片存储。");
    stripJpegMetadata(bytes);
    files[`images/${name}`] = bytes;
    hashes[name] = hash;
  }
  let sharing: SharingHistory;
  try {
    sharing = await exportSharingHistory(runtime, ownerId);
    await prepareSharingHistoryImport({} as Runtime, ownerId, sharing);
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 413)
      throw oversized(error.message);
    throw error;
  }
  const manifest = encode(
    JSON.stringify({
      format: "yijian-workspace",
      version: 1,
      exported_at: timestamp(),
      data: state,
      sha256: hashes,
      sharing_history: sharing,
    }),
  );
  if (
    manifest.length > archiveLimits.manifest ||
    expanded + manifest.length > archiveLimits.expanded
  )
    throw oversized();
  files["manifest.json"] = manifest;
  const bytes = zipSync(files, { level: 0 });
  if (bytes.length > archiveLimits.archive) throw oversized();
  return bytes;
}

export function mountMigration(app: Hono<Env>) {
  app.get("/api/backup", async (c) => {
    const { runtime, ownerId } = await owner(c);
    const bytes = await makeArchive(runtime, ownerId);
    return new Response(bytes.slice().buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="yijian-backup.zip"',
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  app.post("/api/migration/preview", async (c) => {
    const { runtime, ownerId } = await owner(c);
    await cleanPreviews(runtime, ownerId);
    const [pending] = await runtime.db.all<{ count: number }>(
      `SELECT count(*) AS count FROM migration_previews WHERE owner_id=? AND status='ready' AND expires_at>?`,
      [ownerId, timestamp()],
    );
    if (pending.count >= starterLimits.pendingPreviews)
      throw new HTTPException(429, {
        message: "已有三个待确认的迁移预览，请先完成导入或等待预览过期。",
      });
    const form = await c.req.formData(),
      file = form.get("file");
    if (!(file instanceof File) || form.getAll("file").length !== 1)
      throw invalid("请选择一个衣间 ZIP 备份文件。");
    if (file.size > archiveLimits.archive) throw oversized();
    const bytes = new Uint8Array(await file.arrayBuffer()),
      archive = await readArchive(bytes);
    const before = await readWorkspace(runtime, ownerId),
      result = merge(before.state, archive.state);
    await checkAssetConflicts(
      runtime,
      ownerId,
      archive,
      new Set(result.state.items.flatMap(imageNames)),
    );
    await prepareSharingHistoryImport(runtime, ownerId, archive.sharing);
    const previewId = crypto.randomUUID(),
      key = `migration-previews/${crypto.randomUUID()}.zip`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await runtime.blobs.put(key, bytes);
    try {
      const saved = await runtime.db.run(
        `INSERT INTO migration_previews(id,owner_id,object_key,sha256,target_revision,expires_at,created_at,status)
         SELECT ?,?,?,?,?,?,?,'ready' WHERE (SELECT count(*) FROM migration_previews WHERE owner_id=? AND status='ready' AND expires_at>?)<${starterLimits.pendingPreviews}`,
        [
          previewId,
          ownerId,
          key,
          await sha(bytes),
          before.revision,
          expiresAt,
          timestamp(),
          ownerId,
          timestamp(),
        ],
      );
      if (!saved.changes)
        throw new HTTPException(429, {
          message: "待确认的迁移预览已达上限，请稍后再试。",
        });
    } catch (error) {
      await runtime.db.batch(
        blobDeletionStatements(
          ownerId,
          [key],
          undefined,
          error instanceof HTTPException ? 0 : 60,
        ),
      );
      await flushBlobDeletes(runtime, ownerId);
      throw error;
    }
    return c.json({
      preview_id: previewId,
      counts: result.counts,
      duplicates: result.duplicates,
      conflicts: result.conflicts,
      requires_empty: false,
      expires_at: expiresAt,
    });
  });
  app.post("/api/migration/import", async (c) => {
    const { runtime, ownerId } = await owner(c);
    let previewId: string;
    try {
      previewId = z
        .object({ preview_id: z.string().uuid() })
        .strict()
        .parse(await c.req.json()).preview_id;
    } catch {
      throw invalid("迁移预览编号无效。");
    }
    const [preview] = await runtime.db.all<PreviewRow>(
      "SELECT * FROM migration_previews WHERE id=? AND owner_id=?",
      [previewId, ownerId],
    );
    if (!preview)
      throw new HTTPException(404, { message: "找不到这份迁移预览。" });
    if (preview.status === "imported" && preview.result)
      return c.json(JSON.parse(preview.result));
    if (preview.expires_at <= timestamp() || !preview.object_key)
      throw conflict("迁移预览已过期，请重新选择备份。");
    const before = await readWorkspace(runtime, ownerId);
    if (before.revision !== preview.target_revision)
      throw conflict("衣柜已发生变化，请重新预览后导入。");
    const bytes = await runtime.blobs.get(preview.object_key);
    if (!bytes || (await sha(bytes)) !== preview.sha256)
      throw invalid("迁移预览文件校验失败，请重新选择备份。");
    const archive = await readArchive(bytes),
      merged = merge(before.state, archive.state);
    const needed = new Set(merged.state.items.flatMap(imageNames));
    const existing = await checkAssetConflicts(
      runtime,
      ownerId,
      archive,
      needed,
    );
    const staged: {
      name: string;
      key: string;
      bytes: Uint8Array;
      hash: string;
    }[] = [];
    const result = {
      ok: true,
      counts: merged.counts,
      duplicates: merged.duplicates,
      conflicts: merged.conflicts.length,
      sharing_history: archive.sharing.length,
    };
    try {
      for (const [name, content] of archive.images)
        if (needed.has(name) && !existing.has(name)) {
          const key = `wardrobes/${ownerId}/migration-${crypto.randomUUID()}/${name}`;
          staged.push({
            name,
            key,
            bytes: content,
            hash: archive.hashes[name],
          });
          await runtime.blobs.put(key, content);
        }
      let historyStatements: Statement[] = [];
      // IDs are generated once; statements themselves remain conditional on the transaction's write token.
      const prepare = async (writeToken: string) =>
        prepareSharingHistoryImport(
          runtime,
          ownerId,
          archive.sharing,
          writeToken,
        );
      const historyToken = crypto.randomUUID();
      historyStatements = await prepare(historyToken);
      const guard = crypto.randomUUID();
      await commitWorkspace(
        runtime,
        ownerId,
        before,
        merged.state,
        (writeToken) => [
          {
            sql: `INSERT INTO capacity_guards(id,allowed) SELECT ?,CASE WHEN (SELECT coalesce(sum(size),0) FROM assets WHERE owner_id=?)+?<=? AND (SELECT count(*) FROM assets WHERE owner_id=?)+?<=? THEN 1 ELSE 0 END WHERE EXISTS(SELECT 1 FROM workspaces WHERE owner_id=? AND write_token=?)`,
            params: [
              guard,
              ownerId,
              staged.reduce((sum, asset) => sum + asset.bytes.length, 0),
              starterLimits.imageStorageBytes,
              ownerId,
              staged.length,
              starterLimits.imageCount,
              ownerId,
              writeToken,
            ],
          },
          { sql: "DELETE FROM capacity_guards WHERE id=?", params: [guard] },
          ...staged.map((asset) => ({
            sql: "INSERT INTO assets(owner_id,name,object_key,sha256,size) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM workspaces WHERE owner_id=? AND write_token=?)",
            params: [
              ownerId,
              asset.name,
              asset.key,
              asset.hash,
              asset.bytes.length,
              ownerId,
              writeToken,
            ],
          })),
          ...historyStatements.map((statement) => ({
            ...statement,
            params: statement.params?.map((value) =>
              value === historyToken ? writeToken : value,
            ),
          })),
          {
            sql: `UPDATE migration_previews SET status='imported',result=?,object_key=NULL WHERE id=? AND owner_id=? AND status='ready' AND EXISTS(SELECT 1 FROM workspaces WHERE owner_id=? AND write_token=?)`,
            params: [
              JSON.stringify(result),
              previewId,
              ownerId,
              ownerId,
              writeToken,
            ],
          },
          ...blobDeletionStatements(ownerId, [preview.object_key!], writeToken),
        ],
      );
    } catch (error) {
      await runtime.db.batch(
        blobDeletionStatements(
          ownerId,
          staged.map((asset) => asset.key),
          undefined,
          error instanceof HTTPException || isCapacityFailure(error) ? 0 : 60,
        ),
      );
      await flushBlobDeletes(runtime, ownerId);
      const [finished] = await runtime.db.all<PreviewRow>(
        "SELECT * FROM migration_previews WHERE id=? AND owner_id=?",
        [previewId, ownerId],
      );
      if (finished?.status === "imported" && finished.result)
        return c.json(JSON.parse(finished.result));
      if (isCapacityFailure(error))
        throw oversized("合并期间容量已发生变化，请整理衣柜后重新预览。");
      throw error;
    }
    await flushBlobDeletes(runtime, ownerId);
    return c.json(result);
  });
}
