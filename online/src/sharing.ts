import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Runtime, Statement } from "./platform.js";
import { stripJpegMetadata } from "./jpeg.js";
import { starterLimits, jsonBytes } from "./limits.js";
import { blobDeletionStatements, flushBlobDeletes } from "./cleanup.js";

type SharingEnv = {
  Variables: { runtime: Runtime; ownerId: string; sourceKey?: string };
};
type SharingContext = Context<SharingEnv>;
type ShareRow = {
  id: string;
  owner_id: string;
  question: string;
  status: "active" | "closed" | "revoked" | "imported";
  token_hash: string | null;
  created_at: string;
  expires_at: string;
  source_count: number;
  imported: number;
};
type Snapshot = {
  id: string;
  share_id: string;
  item_id: string;
  name: string;
  category: string;
  brand: string;
  image_id: string | null;
  object_key: string | null;
  position: number;
  history_bytes: number;
  image_bytes: number;
};
type ReplyRow = {
  id: string;
  share_id: string;
  request_id: string;
  payload_hash: string;
  nickname: string;
  text: string;
  snapshot_item_ids: string;
  item_ids: string;
  created_at: string;
};

const categories = [
  "top",
  "bottom",
  "dress",
  "outerwear",
  "shoes",
  "bag",
  "accessory",
  "other",
] as const;
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const createInput = z
  .object({
    question: z.string().trim().min(1).max(1000),
    item_ids: z
      .array(id)
      .min(1)
      .max(24)
      .refine((values) => new Set(values).size === values.length),
    expires_days: z
      .union([z.literal(1), z.literal(7), z.literal(30)])
      .default(7),
  })
  .strict();
const replyInput = z
  .object({
    request_id: z
      .string()
      .min(8)
      .max(120)
      .regex(/^[a-zA-Z0-9_-]+$/),
    nickname: z.string().trim().max(50).default(""),
    text: z.string().trim().max(2000).default(""),
    item_ids: z
      .array(id)
      .max(24)
      .default([])
      .refine((values) => new Set(values).size === values.length),
  })
  .strict()
  .refine((value) => value.text.length > 0 || value.item_ids.length > 0);
const actionInput = z
  .object({ action: z.enum(["close", "revoke", "regenerate"]) })
  .strict();

class ShareError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429,
    message: string,
  ) {
    super(message);
  }
}
const now = () => new Date().toISOString();
const placeholders = (length: number) =>
  Array.from({ length }, () => "?").join(",");
const uuid = () => crypto.randomUUID();
const bytesOf = (value: string) => new TextEncoder().encode(value);
type CapacityDelta = {
  shares: number;
  entries: number;
  history: number;
  snapshots: number;
};
const capacityMessage =
  "分享空间已达上限：50 份分享、300 条单品与建议、768 KB 文字和 16 MB 照片快照。";
const shareBytes = (question: string, createdAt: string) =>
  256 + jsonBytes({ question, created_at: createdAt });
const snapshotBytes = (item: {
  item_id: string;
  name: string;
  category: string;
  brand: string;
}) =>
  1 +
  jsonBytes({
    item_id: item.item_id,
    name: item.name,
    category: item.category,
    brand: item.brand,
  });
const replyBytes = (
  nickname: string,
  text: string,
  itemIds: string[],
  createdAt: string,
) =>
  1 + jsonBytes({ nickname, text, item_ids: itemIds, created_at: createdAt });
export const isCapacityFailure = (error: unknown) =>
  error instanceof Error && error.message.includes("capacity_limit");
async function reconcileSnapshots(runtime: Runtime, ownerId: string) {
  const rows = await runtime.db.all<{ id: string; object_key: string }>(
    "SELECT i.id,i.object_key FROM share_items i JOIN shares s ON s.id=i.share_id WHERE s.owner_id=? AND i.image_bytes<0",
    [ownerId],
  );
  for (const row of rows) {
    const bytes = await runtime.blobs.get(row.object_key);
    await runtime.db.run(
      "UPDATE share_items SET image_bytes=? WHERE id=? AND object_key=? AND image_bytes<0",
      [bytes?.length ?? 0, row.id, row.object_key],
    );
  }
}
async function checkCapacity(
  runtime: Runtime,
  ownerId: string,
  delta: CapacityDelta,
) {
  if (delta.snapshots > 0) {
    await flushBlobDeletes(runtime, ownerId);
    const [pending] = await runtime.db.all<{ count: number }>(
      "SELECT count(*) AS count FROM blob_delete_jobs WHERE owner_id=?",
      [ownerId],
    );
    if (pending.count)
      throw new ShareError(409, "照片清理尚未完成，请稍后再创建分享。");
  }
  await reconcileSnapshots(runtime, ownerId);
  const [usage] = await runtime.db.all<{
    share_count: number;
    entry_count: number;
    history_bytes: number;
    snapshot_bytes: number;
  }>("SELECT * FROM sharing_totals WHERE owner_id=?", [ownerId]);
  if (
    (usage?.share_count ?? 0) + delta.shares > starterLimits.shareCount ||
    (usage?.entry_count ?? 0) + delta.entries >
      starterLimits.historyEntryCount ||
    (usage?.history_bytes ?? 0) + delta.history > starterLimits.historyBytes ||
    (usage?.snapshot_bytes ?? 0) + delta.snapshots >
      starterLimits.snapshotStorageBytes
  )
    throw new ShareError(413, capacityMessage);
}
function capacityGuard(
  ownerId: string,
  delta: CapacityDelta,
  writeToken?: string,
): Statement[] {
  const guard = uuid();
  return [
    {
      sql: `INSERT INTO capacity_guards(id,allowed) SELECT ?,CASE WHEN coalesce(s.share_count,0)+?<=? AND coalesce(s.entry_count,0)+?<=? AND coalesce(s.history_bytes,0)+?<=? AND coalesce(s.snapshot_bytes,0)+?<=? THEN 1 ELSE 0 END FROM (SELECT 1) LEFT JOIN sharing_totals s ON s.owner_id=? ${writeToken ? "WHERE EXISTS(SELECT 1 FROM workspaces WHERE owner_id=? AND write_token=?)" : ""}`,
      params: [
        guard,
        delta.shares,
        starterLimits.shareCount,
        delta.entries,
        starterLimits.historyEntryCount,
        delta.history,
        starterLimits.historyBytes,
        delta.snapshots,
        starterLimits.snapshotStorageBytes,
        ownerId,
        ...(writeToken ? [ownerId, writeToken] : []),
      ],
    },
    { sql: "DELETE FROM capacity_guards WHERE id=?", params: [guard] },
  ];
}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", bytesOf(value));
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function token() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function privateHeaders(c: SharingContext) {
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  c.header("X-Content-Type-Options", "nosniff");
}
async function body<T>(c: SharingContext, schema: z.ZodType<T>): Promise<T> {
  if (Number(c.req.header("content-length") || 0) > 16384)
    throw new ShareError(413, "提交内容过大。");
  let input: unknown;
  try {
    const reader = c.req.raw.body?.getReader();
    if (!reader) throw new ShareError(400, "请提交有效的内容。");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 16384) {
          await reader.cancel();
          throw new ShareError(413, "提交内容过大。");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    input = JSON.parse(text);
  } catch (error) {
    if (error instanceof ShareError) throw error;
    throw new ShareError(400, "请提交有效的内容。");
  }
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ShareError(400, "请检查问题、单品和输入内容。");
  return result.data;
}
function managed(handler: (c: SharingContext) => Promise<Response>) {
  return async (c: SharingContext) => {
    privateHeaders(c);
    try {
      return await handler(c);
    } catch (error) {
      if (error instanceof ShareError)
        return c.json({ detail: error.message }, error.status);
      throw error;
    }
  };
}
function requireOwner(c: SharingContext) {
  const ownerId = c.get("ownerId");
  if (!ownerId) throw new ShareError(401, "请先登录。");
  return ownerId;
}
async function rate(
  runtime: Runtime,
  bucket: string,
  limit: number,
  seconds: number,
) {
  const stamp = Math.floor(Date.now() / 1000);
  const period = Math.floor(stamp / seconds);
  const result = await runtime.db.run(
    `INSERT INTO share_rate_limits(bucket,count,expires_at) VALUES(?,1,?)
     ON CONFLICT(bucket) DO UPDATE SET count=count+1 WHERE count < ?`,
    [`${bucket}:${period}`, (period + 1) * seconds, limit],
  );
  if (!result.changes) throw new ShareError(429, "操作较频繁，请稍后再试。");
  await runtime.db.run("DELETE FROM share_rate_limits WHERE expires_at < ?", [
    stamp,
  ]);
}
async function visitorRate(
  c: SharingContext,
  shareId: string,
  operation: string,
  limit: number,
  seconds: number,
) {
  const runtime = c.get("runtime");
  await rate(runtime, `share:${shareId}:${operation}`, limit, seconds);
  const source = c.get("sourceKey");
  if (source)
    await rate(
      runtime,
      `source:${await digest(source)}:${operation}`,
      limit,
      seconds,
    );
}
async function owned(runtime: Runtime, ownerId: string, shareId: string) {
  const [share] = await runtime.db.all<ShareRow>(
    "SELECT * FROM shares WHERE id=? AND owner_id=?",
    [shareId, ownerId],
  );
  if (!share) throw new ShareError(404, "找不到这份分享。");
  return share;
}
async function access(c: SharingContext, replying = false) {
  const match = /^Bearer ([0-9a-f]{64})$/.exec(
    c.req.header("authorization") || "",
  );
  if (!match) throw new ShareError(410, "分享链接已失效。");
  const hash = await digest(match[1]);
  const [share] = await c
    .get("runtime")
    .db.all<ShareRow>(
      `SELECT * FROM shares WHERE token_hash=? AND status IN ('active','closed') AND expires_at > ?`,
      [hash, now()],
    );
  if (!share) throw new ShareError(410, "分享链接已失效。");
  if (replying && share.status !== "active")
    throw new ShareError(403, "这份分享已关闭回复。");
  return { share, hash };
}
async function snapshots(runtime: Runtime, shareId: string) {
  return runtime.db.all<Snapshot>(
    "SELECT * FROM share_items WHERE share_id=? ORDER BY position",
    [shareId],
  );
}
function publicSnapshot(row: Snapshot) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    brand: row.brand,
    image_id: row.image_id,
  };
}
async function ownerView(
  runtime: Runtime,
  share: ShareRow,
  cached?: { items: Snapshot[]; count: number },
) {
  const items = cached?.items ?? (await snapshots(runtime, share.id));
  const count =
    cached ??
    (
      await runtime.db.all<{ count: number }>(
        "SELECT count(*) AS count FROM share_replies WHERE share_id=?",
        [share.id],
      )
    )[0];
  return {
    id: share.id,
    question: share.question,
    status:
      share.status !== "imported" &&
      share.status !== "revoked" &&
      share.expires_at <= now()
        ? "expired"
        : share.status,
    created_at: share.created_at,
    expires_at: share.expires_at,
    imported: !!share.imported,
    items: items.map((item) => ({
      ...publicSnapshot(item),
      item_id: item.item_id,
    })),
    suggestion_count: count.count,
  };
}
function suggestion(row: ReplyRow) {
  return {
    id: row.id,
    nickname: row.nickname,
    text: row.text,
    snapshot_item_ids: JSON.parse(row.snapshot_item_ids) as string[],
    item_ids: JSON.parse(row.item_ids) as string[],
    created_at: row.created_at,
  };
}
async function snapshotSource(
  runtime: Runtime,
  ownerId: string,
  source: Record<string, unknown>,
) {
  const image = typeof source.image_url === "string" ? source.image_url : "";
  const match = /^\/api\/images\/([a-zA-Z0-9_-]+\.jpe?g)$/.exec(image);
  if (!match) throw new ShareError(400, "所选单品需要一张已保存的照片。");
  const [asset] = await runtime.db.all<{ object_key: string }>(
    "SELECT object_key FROM assets WHERE owner_id=? AND name=?",
    [ownerId, match[1]],
  );
  if (!asset) throw new ShareError(400, "所选单品的照片不可用。");
  const bytes = await runtime.blobs.get(asset.object_key);
  if (!bytes || bytes.byteLength > starterLimits.imageBytes)
    throw new ShareError(400, "所选单品的照片不可用。");
  try {
    return stripJpegMetadata(bytes);
  } catch {
    throw new ShareError(400, "所选单品的照片需要重新保存。");
  }
}

export function mountSharing(app: Hono<SharingEnv>) {
  app.post(
    "/api/shares",
    managed(async (c) => {
      const runtime = c.get("runtime"),
        ownerId = requireOwner(c);
      const input = await body(c, createInput);
      await rate(runtime, `owner:${ownerId}:create`, 20, 86400);
      await checkCapacity(runtime, ownerId, {
        shares: 1,
        entries: input.item_ids.length,
        history: 0,
        snapshots: 0,
      });
      const [active] = await runtime.db.all<{ count: number }>(
        "SELECT count(*) AS count FROM shares WHERE owner_id=? AND status IN ('active','closed') AND expires_at>?",
        [ownerId, now()],
      );
      if (active.count >= 50)
        throw new ShareError(
          429,
          "同时有效的分享最多 50 份，请先撤销无需保留的链接。",
        );
      const rows = await runtime.db.all<{ id: string; data: string }>(
        `SELECT id,data FROM entries WHERE owner_id=? AND collection='items' AND id IN (${placeholders(input.item_ids.length)})`,
        [ownerId, ...input.item_ids],
      );
      if (rows.length !== input.item_ids.length)
        throw new ShareError(400, "请选择自己衣柜中存在的单品。");
      const shareId = uuid(),
        secret = token(),
        hash = await digest(secret),
        createdAt = now();
      const expiresAt = new Date(
        Date.now() + input.expires_days * 86400000,
      ).toISOString();
      const copies: Snapshot[] = [],
        keys: string[] = [];
      try {
        for (const [position, itemId] of input.item_ids.entries()) {
          const source = JSON.parse(
            rows.find((row) => row.id === itemId)!.data,
          ) as Record<string, unknown>;
          const imageId = uuid(),
            key = `share-snapshots/${shareId}/${imageId}.jpg`;
          const pixels = await snapshotSource(runtime, ownerId, source);
          keys.push(key);
          copies.push({
            id: uuid(),
            share_id: shareId,
            item_id: itemId,
            name:
              typeof source.name === "string"
                ? source.name.slice(0, 120)
                : "未命名单品",
            category: categories.includes(
              source.category as (typeof categories)[number],
            )
              ? String(source.category)
              : "other",
            brand:
              typeof source.brand === "string"
                ? source.brand.slice(0, 120)
                : "",
            image_id: imageId,
            object_key: key,
            position,
            history_bytes: 0,
            image_bytes: pixels.length,
          });
          copies[copies.length - 1].history_bytes = snapshotBytes(
            copies[copies.length - 1],
          );
          await checkCapacity(runtime, ownerId, {
            shares: 1,
            entries: copies.length,
            history:
              shareBytes(input.question, createdAt) +
              copies.reduce((sum, item) => sum + item.history_bytes, 0),
            snapshots: copies.reduce((sum, item) => sum + item.image_bytes, 0),
          });
          await runtime.blobs.put(key, pixels);
        }
        const result = await runtime.db.batch([
          ...capacityGuard(ownerId, {
            shares: 1,
            entries: copies.length,
            history:
              shareBytes(input.question, createdAt) +
              copies.reduce((sum, item) => sum + item.history_bytes, 0),
            snapshots: copies.reduce((sum, item) => sum + item.image_bytes, 0),
          }),
          {
            sql: `INSERT INTO shares(id,owner_id,question,status,token_hash,created_at,expires_at,source_count,history_bytes)
                SELECT ?,?,?,'active',?,?,?,?,? WHERE
                (SELECT count(*) FROM entries WHERE owner_id=? AND collection='items' AND id IN (${placeholders(input.item_ids.length)}))=?
                AND (SELECT count(*) FROM shares WHERE owner_id=? AND status IN ('active','closed') AND expires_at>?)<50`,
            params: [
              shareId,
              ownerId,
              input.question,
              hash,
              createdAt,
              expiresAt,
              copies.length,
              shareBytes(input.question, createdAt),
              ownerId,
              ...input.item_ids,
              copies.length,
              ownerId,
              now(),
            ],
          },
          ...copies.map((item) => ({
            sql: `INSERT INTO share_items(id,share_id,item_id,name,category,brand,image_id,object_key,position,history_bytes,image_bytes)
                SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM shares WHERE id=?)`,
            params: [
              item.id,
              shareId,
              item.item_id,
              item.name,
              item.category,
              item.brand,
              item.image_id,
              item.object_key,
              item.position,
              item.history_bytes,
              item.image_bytes,
              shareId,
            ],
          })),
        ]);
        if (!result[2].changes)
          throw new ShareError(
            409,
            "单品或分享数量已发生变化，请刷新后重新预览。",
          );
      } catch (error) {
        await runtime.db.batch(
          blobDeletionStatements(
            ownerId,
            keys,
            undefined,
            error instanceof ShareError || isCapacityFailure(error) ? 0 : 60,
          ),
        );
        await flushBlobDeletes(runtime, ownerId);
        if (isCapacityFailure(error))
          throw new ShareError(413, capacityMessage);
        throw error;
      }
      const share = await owned(runtime, ownerId, shareId);
      return c.json(
        { id: shareId, share: await ownerView(runtime, share), token: secret },
        201,
      );
    }),
  );

  app.get(
    "/api/shares",
    managed(async (c) => {
      const runtime = c.get("runtime"),
        ownerId = requireOwner(c);
      await flushBlobDeletes(runtime, ownerId);
      const rows = await runtime.db.all<
        ShareRow & { suggestion_count: number }
      >(
        `SELECT s.*,(SELECT count(*) FROM share_replies r WHERE r.share_id=s.id) AS suggestion_count FROM shares s WHERE owner_id=?
         ORDER BY CASE WHEN status IN ('active','closed') AND expires_at>? THEN 0 ELSE 1 END,created_at DESC LIMIT 200`,
        [ownerId, now()],
      );
      const [total] = await runtime.db.all<{ count: number }>(
        "SELECT count(*) AS count FROM shares WHERE owner_id=?",
        [ownerId],
      );
      const photos = await runtime.db.all<Snapshot>(
        "SELECT * FROM share_items WHERE share_id IN (SELECT value FROM json_each(?)) ORDER BY position",
        [JSON.stringify(rows.map((row) => row.id))],
      );
      return c.json({
        shares: await Promise.all(
          rows.map((share) =>
            ownerView(runtime, share, {
              items: photos.filter((photo) => photo.share_id === share.id),
              count: share.suggestion_count,
            }),
          ),
        ),
        total_count: total.count,
        has_more: total.count > rows.length,
      });
    }),
  );
  app.get(
    "/api/shares/:id",
    managed(async (c) => {
      const runtime = c.get("runtime"),
        share = await owned(runtime, requireOwner(c), c.req.param("id")!);
      const rows = await runtime.db.all<ReplyRow>(
        "SELECT * FROM share_replies WHERE share_id=? ORDER BY created_at DESC",
        [share.id],
      );
      return c.json({
        share: await ownerView(runtime, share),
        suggestions: rows.map(suggestion),
      });
    }),
  );
  app.get(
    "/api/shares/:id/images/:imageId",
    managed(async (c) => {
      const runtime = c.get("runtime"),
        share = await owned(runtime, requireOwner(c), c.req.param("id")!);
      const [image] = await runtime.db.all<{ object_key: string }>(
        "SELECT object_key FROM share_items WHERE image_id=? AND share_id=? AND object_key IS NOT NULL",
        [c.req.param("imageId")!, share.id],
      );
      if (!image) throw new ShareError(404, "找不到这张照片。");
      const pixels = await runtime.blobs.get(image.object_key);
      if (!pixels) throw new ShareError(404, "找不到这张照片。");
      c.header("Content-Type", "image/jpeg");
      return c.body(pixels as unknown as ArrayBuffer);
    }),
  );
  app.patch(
    "/api/shares/:id",
    managed(async (c) => {
      const runtime = c.get("runtime"),
        ownerId = requireOwner(c);
      const share = await owned(runtime, ownerId, c.req.param("id")!);
      if (share.imported)
        throw new ShareError(409, "迁入的分享历史仅供查看，请创建一份新分享。");
      const { action } = await body(c, actionInput);
      let secret: string | undefined;
      if (action === "regenerate") {
        await rate(runtime, `owner:${ownerId}:regenerate`, 30, 86400);
        const selected = await snapshots(runtime, share.id);
        const remaining = await runtime.db.all<{ id: string }>(
          `SELECT id FROM entries WHERE owner_id=? AND collection='items' AND id IN (${placeholders(selected.length)})`,
          [ownerId, ...selected.map((item) => item.item_id)],
        );
        if (
          !selected.length ||
          selected.length !== remaining.length ||
          selected.some((item) => !item.object_key)
        ) {
          throw new ShareError(
            409,
            "分享中的单品已失效，请重新选择单品创建分享。",
          );
        }
        secret = token();
        const updated = await runtime.db.run(
          `UPDATE shares SET token_hash=?, status='active', expires_at=? WHERE id=? AND owner_id=?
         AND (SELECT count(*) FROM entries WHERE owner_id=? AND collection='items' AND id IN (${placeholders(selected.length)}))=?
         AND NOT EXISTS(SELECT 1 FROM share_items WHERE share_id=? AND object_key IS NULL)
         AND (SELECT count(*) FROM shares WHERE owner_id=? AND id<>? AND status IN ('active','closed') AND expires_at>?)<50`,
          [
            await digest(secret),
            new Date(Date.now() + 7 * 86400000).toISOString(),
            share.id,
            ownerId,
            ownerId,
            ...selected.map((item) => item.item_id),
            selected.length,
            share.id,
            ownerId,
            share.id,
            now(),
          ],
        );
        if (!updated.changes)
          throw new ShareError(409, "单品已失效或有效分享数量已达到 50 份。");
      } else if (action === "revoke") {
        await runtime.db.run(
          `UPDATE shares SET status='revoked',token_hash=NULL WHERE id=? AND owner_id=?`,
          [share.id, ownerId],
        );
      } else {
        const updated = await runtime.db.run(
          `UPDATE shares SET status='closed' WHERE id=? AND owner_id=? AND status='active' AND expires_at>?`,
          [share.id, ownerId, now()],
        );
        if (!updated.changes)
          throw new ShareError(409, "这份分享当前不接受回复。");
      }
      return c.json({
        share: await ownerView(
          runtime,
          await owned(runtime, ownerId, share.id),
        ),
        ...(secret ? { token: secret } : {}),
      });
    }),
  );
  app.delete(
    "/api/shares/:id",
    managed(async (c) => {
      const runtime = c.get("runtime"),
        ownerId = requireOwner(c),
        share = await owned(runtime, ownerId, c.req.param("id")!);
      const keys = (await snapshots(runtime, share.id)).flatMap((item) =>
        item.object_key ? [item.object_key] : [],
      );
      await runtime.db.batch([
        ...blobDeletionStatements(ownerId, keys),
        {
          sql: "DELETE FROM shares WHERE id=? AND owner_id=?",
          params: [share.id, ownerId],
        },
      ]);
      await flushBlobDeletes(runtime, ownerId);
      return c.json({ ok: true });
    }),
  );
  app.delete(
    "/api/shares/:id/suggestions/:replyId",
    managed(async (c) => {
      const runtime = c.get("runtime"),
        share = await owned(runtime, requireOwner(c), c.req.param("id")!);
      if (share.imported) throw new ShareError(409, "迁入的分享历史仅供查看。");
      const removed = await runtime.db.run(
        "DELETE FROM share_replies WHERE id=? AND share_id=?",
        [c.req.param("replyId")!, share.id],
      );
      if (!removed.changes) throw new ShareError(404, "找不到这条建议。");
      return c.json({ ok: true });
    }),
  );

  app.post(
    "/api/share/view",
    managed(async (c) => {
      const { share, hash } = await access(c);
      await visitorRate(c, share.id, "view", 120, 60);
      const items = await snapshots(c.get("runtime"), share.id);
      const status = await activeAgain(c.get("runtime"), share.id, hash);
      return c.json({
        question: share.question,
        items: items.map(publicSnapshot),
        expires_at: share.expires_at,
        accepting: status === "active",
      });
    }),
  );
  app.get(
    "/api/share/images/:imageId",
    managed(async (c) => {
      const { share, hash } = await access(c);
      const runtime = c.get("runtime");
      await visitorRate(c, share.id, "image", 480, 60);
      const [image] = await runtime.db.all<{ object_key: string }>(
        "SELECT object_key FROM share_items WHERE image_id=? AND share_id=? AND object_key IS NOT NULL",
        [c.req.param("imageId")!, share.id],
      );
      if (!image) throw new ShareError(404, "找不到这张照片。");
      const pixels = await runtime.blobs.get(image.object_key);
      if (!pixels) throw new ShareError(404, "找不到这张照片。");
      await activeAgain(runtime, share.id, hash);
      c.header("Content-Type", "image/jpeg");
      return c.body(pixels as unknown as ArrayBuffer);
    }),
  );
  app.post(
    "/api/share/reply",
    managed(async (c) => {
      const { share, hash } = await access(c, true),
        runtime = c.get("runtime");
      const input = await body(c, replyInput);
      const selected = await snapshots(runtime, share.id);
      const chosen = input.item_ids.map((itemId) =>
        selected.find((item) => item.id === itemId),
      );
      if (chosen.some((item) => !item))
        throw new ShareError(400, "只能选择这份分享中的单品。");
      const payloadHash = await digest(
        JSON.stringify({
          nickname: input.nickname,
          text: input.text,
          item_ids: input.item_ids,
        }),
      );
      const [existing] = await runtime.db.all<ReplyRow>(
        "SELECT * FROM share_replies WHERE share_id=? AND request_id=?",
        [share.id, input.request_id],
      );
      if (existing) {
        await activeAgain(runtime, share.id, hash, true);
        if (existing.payload_hash !== payloadHash)
          throw new ShareError(409, "重复提交编号对应了不同内容，请重新提交。");
        return c.json({ ok: true });
      }
      await visitorRate(c, share.id, "reply", 30, 3600);
      const createdAt = now(),
        sourceIds = chosen.map((item) => item!.item_id),
        historyBytes = replyBytes(
          input.nickname,
          input.text,
          sourceIds,
          createdAt,
        );
      const delta = {
        shares: 0,
        entries: 1,
        history: historyBytes,
        snapshots: 0,
      };
      let saved: { changes: number };
      try {
        await checkCapacity(runtime, share.owner_id, delta);
        const results = await runtime.db.batch([
          ...capacityGuard(share.owner_id, delta),
          {
            sql: `INSERT OR IGNORE INTO share_replies(id,share_id,request_id,payload_hash,nickname,text,snapshot_item_ids,item_ids,created_at,history_bytes)
       SELECT ?,?,?,?,?,?,?,?,?,? FROM shares WHERE id=? AND token_hash=? AND status='active' AND expires_at>?
       AND (SELECT count(*) FROM share_replies WHERE share_id=?)<200`,
            params: [
              uuid(),
              share.id,
              input.request_id,
              payloadHash,
              input.nickname,
              input.text,
              JSON.stringify(input.item_ids),
              JSON.stringify(sourceIds),
              createdAt,
              historyBytes,
              share.id,
              hash,
              now(),
              share.id,
            ],
          },
        ]);
        saved = results[2];
      } catch (error) {
        if (
          isCapacityFailure(error) ||
          (error instanceof ShareError && error.status === 413)
        ) {
          await activeAgain(runtime, share.id, hash, true);
          const [retry] = await runtime.db.all<ReplyRow>(
            "SELECT * FROM share_replies WHERE share_id=? AND request_id=?",
            [share.id, input.request_id],
          );
          if (retry?.payload_hash === payloadHash) return c.json({ ok: true });
          throw new ShareError(413, capacityMessage);
        }
        throw error;
      }
      if (!saved.changes) {
        await activeAgain(runtime, share.id, hash, true);
        const [retry] = await runtime.db.all<ReplyRow>(
          "SELECT * FROM share_replies WHERE share_id=? AND request_id=?",
          [share.id, input.request_id],
        );
        if (retry?.payload_hash === payloadHash) return c.json({ ok: true });
        if (retry)
          throw new ShareError(409, "重复提交编号对应了不同内容，请重新提交。");
        throw new ShareError(429, "这份分享收到的建议已达到上限。");
      }
      return c.json({ ok: true }, 201);
    }),
  );
}

async function activeAgain(
  runtime: Runtime,
  shareId: string,
  hash: string,
  replying = false,
) {
  const [active] = await runtime.db.all<{ status: string }>(
    `SELECT status FROM shares WHERE id=? AND token_hash=? AND status IN ('active','closed') AND expires_at>?`,
    [shareId, hash, now()],
  );
  if (!active) throw new ShareError(410, "分享链接已失效。");
  if (replying && active.status !== "active")
    throw new ShareError(403, "这份分享已关闭回复。");
  return active.status;
}

/** Call in the same database batch as deleting original items to close concurrent creation. */
export function itemShareInvalidationStatements(
  ownerId: string,
  itemIds: string[],
  writeToken?: string,
): Statement[] {
  if (!itemIds.length) return [];
  return [
    {
      sql: `UPDATE shares SET status='revoked',token_hash=NULL WHERE owner_id=? AND imported=0
          AND id IN (SELECT share_id FROM share_items WHERE item_id IN (${placeholders(itemIds.length)}))
          ${writeToken ? "AND EXISTS(SELECT 1 FROM workspaces WHERE owner_id=? AND write_token=?)" : ""}`,
      params: [
        ownerId,
        ...itemIds,
        ...(writeToken ? [ownerId, writeToken] : []),
      ],
    },
  ];
}

/** Invalidate access before removing independently stored snapshot photos. */
export async function invalidateItemShares(
  runtime: Runtime,
  ownerId: string,
  itemId: string,
) {
  await runtime.db.batch(itemShareInvalidationStatements(ownerId, [itemId]));
  const affected = await runtime.db.all<{ id: string }>(
    `SELECT s.id FROM shares s JOIN share_items i ON i.share_id=s.id WHERE s.owner_id=? AND s.imported=0 AND i.item_id=?`,
    [ownerId, itemId],
  );
  for (const { id: shareId } of affected) {
    const images = await snapshots(runtime, shareId);
    const keys = images.flatMap((image) =>
      image.object_key ? [image.object_key] : [],
    );
    await runtime.db.batch([
      ...blobDeletionStatements(ownerId, keys),
      {
        sql: "UPDATE share_items SET object_key=NULL,image_id=NULL,image_bytes=0 WHERE share_id=?",
        params: [shareId],
      },
    ]);
  }
  await flushBlobDeletes(runtime, ownerId);
}

const historyItem = z
  .object({
    item_id: id,
    name: z.string().max(120),
    category: z.enum(categories),
    brand: z.string().max(120),
  })
  .strict();
const historyReply = z
  .object({
    nickname: z.string().max(50),
    text: z.string().max(2000),
    item_ids: z.array(id).max(24),
    created_at: z.string().datetime(),
  })
  .strict();
const historySchema = z
  .array(
    z
      .object({
        question: z.string().min(1).max(1000),
        created_at: z.string().datetime(),
        items: z.array(historyItem).max(24),
        suggestions: z.array(historyReply).max(200),
      })
      .strict(),
  )
  .max(starterLimits.shareCount);
export type SharingHistory = z.infer<typeof historySchema>;

export async function exportSharingHistory(
  runtime: Runtime,
  ownerId: string,
): Promise<SharingHistory> {
  const rows = await runtime.db.all<ShareRow>(
    "SELECT * FROM shares WHERE owner_id=? ORDER BY created_at DESC",
    [ownerId],
  );
  if (rows.length > starterLimits.shareCount)
    throw new ShareError(413, capacityMessage);
  return Promise.all(
    rows.map(async (share) => {
      const items = await snapshots(runtime, share.id);
      const replies = await runtime.db.all<ReplyRow>(
        "SELECT * FROM share_replies WHERE share_id=? ORDER BY created_at",
        [share.id],
      );
      return {
        question: share.question,
        created_at: share.created_at,
        items: items.map((item) => ({
          item_id: item.item_id,
          name: item.name,
          category: item.category as (typeof categories)[number],
          brand: item.brand,
        })),
        suggestions: replies.map((row) => ({
          nickname: row.nickname,
          text: row.text,
          item_ids: JSON.parse(row.item_ids) as string[],
          created_at: row.created_at,
        })),
      };
    }),
  );
}

export async function prepareSharingHistoryImport(
  runtime: Runtime,
  ownerId: string,
  input: unknown,
  writeToken?: string,
): Promise<Statement[]> {
  const parsed = historySchema.safeParse(input);
  if (!parsed.success) throw new ShareError(400, "分享历史格式无效。");
  if (
    parsed.data.reduce(
      (sum, history) => sum + history.items.length + history.suggestions.length,
      0,
    ) > starterLimits.historyEntryCount ||
    jsonBytes(parsed.data) > starterLimits.historyBytes
  ) {
    throw new ShareError(413, capacityMessage);
  }
  if (!parsed.data.length) return [];
  const delta = {
    shares: parsed.data.length,
    entries: parsed.data.reduce(
      (sum, h) => sum + h.items.length + h.suggestions.length,
      0,
    ),
    history: parsed.data.reduce(
      (sum, h) =>
        sum +
        shareBytes(h.question, h.created_at) +
        h.items.reduce((n, i) => n + snapshotBytes(i), 0) +
        h.suggestions.reduce(
          (n, r) =>
            n + replyBytes(r.nickname, r.text, r.item_ids, r.created_at),
          0,
        ),
      0,
    ),
    snapshots: 0,
  };
  if (delta.history > starterLimits.historyBytes)
    throw new ShareError(413, capacityMessage);
  if (runtime.db) await checkCapacity(runtime, ownerId, delta);
  const statements: Statement[] = capacityGuard(ownerId, delta, writeToken);
  for (const history of parsed.data) {
    const shareId = uuid();
    if (
      new Set(history.items.map((item) => item.item_id)).size !==
      history.items.length
    )
      throw new ShareError(400, "分享历史中存在重复单品。");
    const map = new Map(history.items.map((item) => [item.item_id, uuid()]));
    statements.push({
      sql: `INSERT INTO shares(id,owner_id,question,status,token_hash,created_at,expires_at,source_count,imported,history_bytes)
            SELECT ?,?,?,'imported',NULL,?,?,?,1,? ${writeToken ? "WHERE EXISTS(SELECT 1 FROM workspaces WHERE owner_id=? AND write_token=?)" : ""}`,
      params: [
        shareId,
        ownerId,
        history.question,
        history.created_at,
        history.created_at,
        history.items.length,
        shareBytes(history.question, history.created_at),
        ...(writeToken ? [ownerId, writeToken] : []),
      ],
    });
    history.items.forEach((item, position) =>
      statements.push({
        sql: `INSERT INTO share_items(id,share_id,item_id,name,category,brand,image_id,object_key,position,history_bytes)
            SELECT ?,?,?,?,?,?,NULL,NULL,?,? WHERE EXISTS(SELECT 1 FROM shares WHERE id=?)`,
        params: [
          map.get(item.item_id)!,
          shareId,
          item.item_id,
          item.name,
          item.category,
          item.brand,
          position,
          snapshotBytes(item),
          shareId,
        ],
      }),
    );
    for (const reply of history.suggestions) {
      if (reply.item_ids.some((itemId) => !map.has(itemId)))
        throw new ShareError(400, "建议中包含未分享的单品。");
      statements.push({
        sql: `INSERT INTO share_replies(id,share_id,request_id,payload_hash,nickname,text,snapshot_item_ids,item_ids,created_at,history_bytes)
              SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM shares WHERE id=?)`,
        params: [
          uuid(),
          shareId,
          uuid(),
          "",
          reply.nickname,
          reply.text,
          JSON.stringify(reply.item_ids.map((itemId) => map.get(itemId))),
          JSON.stringify(reply.item_ids),
          reply.created_at,
          replyBytes(
            reply.nickname,
            reply.text,
            reply.item_ids,
            reply.created_at,
          ),
          shareId,
        ],
      });
    }
  }
  return statements;
}
