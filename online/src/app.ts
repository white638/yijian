import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Runtime, Statement } from "./platform.js";
import { requireSameOrigin } from "./auth.js";
import {
  collections,
  itemInput,
  storedItem,
  outfitInput,
  planInput,
  wearInput,
  tripInput,
  settings,
  preferences,
  imageName,
  imageNames,
  references,
  type Collection,
  type Entity,
  type Workspace,
} from "./models.js";
import {
  readWorkspace,
  commitWorkspace,
  mutateWorkspace,
  find,
} from "./repository.js";
import { features, stateView, itemView } from "./views.js";
import { stripJpegMetadata } from "./jpeg.js";
import {
  mountSharing,
  itemShareInvalidationStatements,
  invalidateItemShares,
} from "./sharing.js";
import { mountMigration } from "./migration.js";
import { recommend } from "./recommendations.js";
import { ValidationError } from "./models.js";
import { starterLimits } from "./limits.js";
import { blobDeletionStatements, flushBlobDeletes } from "./cleanup.js";

export type AppEnv = {
  Variables: { runtime: Runtime; ownerId: string; sourceKey?: string };
};
const stamp = () => new Date().toISOString();
const today = () => stamp().slice(0, 10);
export async function digest(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function newItem(input: unknown): Entity {
  const time = stamp();
  return storedItem.parse({
    ...itemInput.parse(input),
    id: crypto.randomUUID(),
    created_at: time,
    updated_at: time,
  });
}
async function json(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    return z.record(z.string(), z.unknown()).parse(await c.req.json());
  } catch {
    throw new HTTPException(422, { message: "提交内容格式无效。" });
  }
}
function validateSelection(state: Workspace, entity: Entity) {
  references(state, entity.item_ids);
  if (!entity.item_ids.length)
    throw new HTTPException(422, { message: "请至少选择一件单品。" });
  if (entity.source && entity.source !== "manual") {
    const items = entity.item_ids.map((id: string) => find(state, "items", id));
    if (
      items.some(
        (item: Entity) => !item.confirmed || item.status !== "available",
      )
    )
      throw new HTTPException(409, { message: "请先确认单品并检查可用状态。" });
    const categories = new Set(items.map((item: Entity) => item.category));
    const count = (category: string) =>
      items.filter((i: Entity) => i.category === category).length;
    if (
      count("shoes") !== 1 ||
      count("outerwear") > 1 ||
      !(
        (count("dress") === 1 && count("top") === 0 && count("bottom") === 0) ||
        (count("dress") === 0 && count("top") === 1 && count("bottom") === 1)
      )
    )
      throw new HTTPException(422, {
        message: "完整穿搭需要上衣、下装和鞋，或连衣裙和鞋。",
      });
    const pref = state.settings.preferences;
    if (
      items.some(
        (i: Entity) =>
          pref.excluded_ids.includes(i.id) ||
          (pref.closet_scope !== "all" && i.closet !== pref.closet_scope),
      ) ||
      pref.blocked_pairs.some((pair) =>
        pair.every((id) => entity.item_ids.includes(id)),
      )
    )
      throw new HTTPException(409, {
        message: "这套穿搭包含推荐设置排除的单品或组合。",
      });
  }
}
export function createApp(runtime?: Runtime) {
  const app = new Hono<AppEnv>();
  if (runtime)
    app.use("*", async (c, next) => {
      c.set("runtime", runtime);
      await next();
    });
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex, nofollow");
    const current = c.get("runtime");
    requireSameOrigin(c.req.raw, current.publicOrigin);
    const path = c.req.path;
    if (
      path === "/api/health" ||
      path === "/api/account/config" ||
      path.startsWith("/api/auth/") ||
      path.startsWith("/api/share/")
    ) {
      await next();
      return;
    }
    const session = await current.auth?.getSession(c.req.raw.headers);
    if (!session) throw new HTTPException(401, { message: "请先登录衣间。" });
    c.set("ownerId", session.user.id);
    await flushBlobDeletes(current, session.user.id);
    await next();
  });
  app.use("/api/*", async (c, next) => {
    const limit =
      c.req.path === "/api/migration/preview"
        ? starterLimits.archiveBytes + starterLimits.multipartOverheadBytes
        : c.req.path === "/api/items/upload"
          ? starterLimits.uploadBodyBytes
          : starterLimits.jsonBodyBytes;
    return bodyLimit({
      maxSize: limit,
      onError: (context) =>
        context.json({ detail: "提交内容超过容量上限。" }, 413),
    })(c, next);
  });
  app.get("/api/health", (c) => c.json({ ok: true, edition: "online" }));
  app.get("/api/account/config", (c) =>
    c.json({
      edition: "online",
      registrationMode: c.get("runtime").registrationMode,
      features,
    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const auth = c.get("runtime").auth;
    if (!auth) return c.json({ detail: "认证服务尚未配置。" }, 503);
    return auth.handler(c.req.raw);
  });
  app.get("/api/account", async (c) => {
    const r = c.get("runtime");
    const session = await r.auth!.getSession(c.req.raw.headers);
    return c.json({
      user: session!.user,
      edition: "online",
      registrationMode: r.registrationMode,
    });
  });
  app.get("/api/state", async (c) =>
    c.json(
      stateView(
        (await readWorkspace(c.get("runtime"), c.get("ownerId"))).state,
      ),
    ),
  );
  app.patch("/api/settings", async (c) => {
    const raw = await json(c);
    const validated = settings
      .partial()
      .extend({ preferences: preferences.partial().optional() })
      .strict()
      .parse(raw);
    const parsed = Object.fromEntries(
      Object.keys(raw).map((key) => [
        key,
        validated[key as keyof typeof validated],
      ]),
    ) as typeof validated;
    if (parsed.preferences)
      parsed.preferences = Object.fromEntries(
        Object.keys(raw.preferences as object).map((key) => [
          key,
          parsed.preferences![key as keyof typeof parsed.preferences],
        ]),
      );
    return c.json(
      await mutateWorkspace(c.get("runtime"), c.get("ownerId"), (state) => {
        state.settings = settings.parse({
          ...state.settings,
          ...parsed,
          preferences: { ...state.settings.preferences, ...parsed.preferences },
        });
        return state.settings;
      }),
    );
  });
  app.get("/api/images/:name", async (c) => {
    const name = c.req.param("name");
    if (!imageName.test(name))
      throw new HTTPException(404, { message: "图片不存在。" });
    const r = c.get("runtime");
    const [asset] = await r.db.all<{ object_key: string }>(
      "SELECT object_key FROM assets WHERE owner_id=? AND name=?",
      [c.get("ownerId"), name],
    );
    const bytes = asset ? await r.blobs.get(asset.object_key) : null;
    if (!bytes) throw new HTTPException(404, { message: "图片不存在。" });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  app.post("/api/items", async (c) => {
    const item = newItem(await json(c));
    return c.json(
      await mutateWorkspace(c.get("runtime"), c.get("ownerId"), (state) => {
        state.items.push(item);
        return itemView(item, state);
      }),
    );
  });
  app.post("/api/items/upload", async (c) => {
    const form = await c.req.formData();
    const files = form.getAll("files");
    if (
      !files.length ||
      files.length > 20 ||
      files.some((file) => typeof file === "string")
    )
      throw new HTTPException(422, { message: "每次请选择 1 至 20 张图片。" });
    const r = c.get("runtime"),
      owner = c.get("ownerId");
    const before = await readWorkspace(r, owner);
    const [pendingCleanup] = await r.db.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM blob_delete_jobs WHERE owner_id=?",
      [owner],
    );
    if (pendingCleanup.count)
      throw new HTTPException(409, {
        message: "照片清理尚未完成，请稍后再上传。",
      });
    const state = structuredClone(before.state);
    const [usage] = await r.db.all<{ size: number; count: number }>(
      "SELECT COALESCE(SUM(size),0) AS size,COUNT(*) AS count FROM assets WHERE owner_id=?",
      [owner],
    );
    const staged: {
      name: string;
      key: string;
      bytes: Uint8Array;
      hash: string;
    }[] = [];
    const items: Entity[] = [];
    try {
      for (const file of files as File[]) {
        if (file.size > starterLimits.imageBytes)
          throw new HTTPException(413, {
            message: "处理后的单张图片不能超过 5 MB。",
          });
        let bytes: Uint8Array;
        try {
          bytes = stripJpegMetadata(new Uint8Array(await file.arrayBuffer()));
        } catch {
          throw new HTTPException(422, {
            message: "图片无法读取，请重新选择图片。",
          });
        }
        const name = crypto.randomUUID().replaceAll("-", "") + "-original.jpg";
        const item = newItem({
          name: file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "新衣物",
        });
        item.image_url = item.original_url = "/api/images/" + name;
        items.push(item);
        state.items.push(item);
        staged.push({
          name,
          key: `wardrobes/${owner}/${name}`,
          bytes,
          hash: await digest(bytes),
        });
      }
      if (
        usage.size + staged.reduce((sum, a) => sum + a.bytes.length, 0) >
          starterLimits.imageStorageBytes ||
        usage.count + staged.length > starterLimits.imageCount
      )
        throw new HTTPException(413, {
          message: "当前实例最多保存 16 MB、150 张单品照片，请整理后再上传。",
        });
      for (const asset of staged) await r.blobs.put(asset.key, asset.bytes);
      await commitWorkspace(r, owner, before, state, (token) =>
        staged.map((asset) => ({
          sql: "INSERT INTO assets(owner_id,name,object_key,sha256,size) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM workspaces WHERE owner_id=? AND write_token=?)",
          params: [
            owner,
            asset.name,
            asset.key,
            asset.hash,
            asset.bytes.length,
            owner,
            token,
          ],
        })),
      );
      return c.json({
        items: items.map((item) => itemView(item, state)),
        warnings: [],
      });
    } catch (error) {
      await r.db.batch(
        blobDeletionStatements(
          owner,
          staged.map((asset) => asset.key),
          undefined,
          error instanceof HTTPException ? 0 : 60,
        ),
      );
      await flushBlobDeletes(r, owner);
      throw error;
    }
  });
  app.patch("/api/items/:id", async (c) => {
    const raw = await json(c);
    const validated = itemInput.partial().parse(raw);
    const changes = Object.fromEntries(
      Object.keys(raw).map((key) => [
        key,
        validated[key as keyof typeof validated],
      ]),
    );
    return c.json(
      await mutateWorkspace(c.get("runtime"), c.get("ownerId"), (state) => {
        const item = find(state, "items", c.req.param("id"));
        Object.assign(item, changes, { updated_at: stamp(), ai_error: null });
        item.ai_status = item.confirmed ? "idle" : "review";
        return itemView(item, state);
      }),
    );
  });
  app.delete("/api/items/:id", async (c) => {
    const r = c.get("runtime"),
      owner = c.get("ownerId"),
      id = c.req.param("id");
    const before = await readWorkspace(r, owner);
    const state = structuredClone(before.state);
    const item = find(state, "items", id);
    state.items = state.items.filter((i) => i.id !== id);
    for (const key of ["outfits", "plans"] as const)
      for (const row of state[key]) {
        row.item_ids = row.item_ids.filter((value: string) => value !== id);
        if (row.layout)
          row.layout.placements = row.layout.placements.filter(
            (value: { item_id: string }) => value.item_id !== id,
          );
      }
    for (const trip of state.trips)
      trip.entries = trip.entries.filter(
        (entry: { item_id: string }) => entry.item_id !== id,
      );
    const pref = state.settings.preferences;
    pref.excluded_ids = pref.excluded_ids.filter((value) => value !== id);
    pref.blocked_pairs = pref.blocked_pairs.filter(
      (pair) => !pair.includes(id),
    );
    const remaining = new Set(state.items.flatMap(imageNames));
    const removed = imageNames(item).filter((name) => !remaining.has(name));
    const assets = await r.db.all<{ name: string; object_key: string }>(
      "SELECT name,object_key FROM assets WHERE owner_id=?",
      [owner],
    );
    await commitWorkspace(r, owner, before, state, (token) => [
      ...itemShareInvalidationStatements(owner, [id], token),
      ...blobDeletionStatements(
        owner,
        assets.filter((a) => removed.includes(a.name)).map((a) => a.object_key),
        token,
      ),
      {
        sql: "DELETE FROM assets WHERE owner_id=? AND name IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM workspaces WHERE owner_id=? AND write_token=?)",
        params: [owner, JSON.stringify(removed), owner, token],
      },
    ]);
    await invalidateItemShares(r, owner, id);
    await flushBlobDeletes(r, owner);
    return c.json({ ok: true });
  });
  app.post("/api/items/:id/wash", async (c) =>
    c.json(
      await mutateWorkspace(c.get("runtime"), c.get("ownerId"), (state) => {
        const item = find(state, "items", c.req.param("id"));
        if (item.status === "archived")
          throw new HTTPException(409, { message: "请先将单品移出归档。" });
        item.status = "available";
        item.updated_at = stamp();
        state.care_events.push({
          id: crypto.randomUUID(),
          item_id: item.id,
          item_name: item.name,
          date: today(),
          created_at: stamp(),
          action: "wash",
        });
        return itemView(item, state);
      }),
    ),
  );
  app.post("/api/items/:id/restore", async (c) =>
    c.json(
      await mutateWorkspace(c.get("runtime"), c.get("ownerId"), (state) => {
        const item = find(state, "items", c.req.param("id"));
        if (!item.original_url)
          throw new HTTPException(422, { message: "此单品没有原图。" });
        item.image_url = item.original_url;
        item.background_status = "skipped";
        item.updated_at = stamp();
        return itemView(item, state);
      }),
    ),
  );
  for (const key of ["outfits", "plans", "trips"] as const) {
    const schema =
      key === "outfits" ? outfitInput : key === "plans" ? planInput : tripInput;
    const validate = (state: Workspace, value: Entity) => {
      if (key === "outfits") validateSelection(state, value);
      if (key === "plans") {
        if (value.outfit_id && !value.item_ids.length)
          value.item_ids = [
            ...find(state, "outfits", value.outfit_id).item_ids,
          ];
        references(state, value.item_ids);
      }
    };
    app.post("/api/" + key, async (c) => {
      const parsed = schema.parse(await json(c));
      return c.json(
        await mutateWorkspace(c.get("runtime"), c.get("ownerId"), (state) => {
          const entity: Entity = {
            ...parsed,
            id: crypto.randomUUID(),
            ...(key === "plans" ? {} : { created_at: stamp() }),
          };
          validate(state, entity);
          state[key].push(entity);
          return entity;
        }),
      );
    });
    app.patch("/api/" + key + "/:id", async (c) => {
      const raw = await json(c);
      return c.json(
        await mutateWorkspace(c.get("runtime"), c.get("ownerId"), (state) => {
          const entity = find(state, key, c.req.param("id")!);
          const { id, created_at, ...prior } = entity;
          const merged = { ...prior, ...raw };
          if (
            key === "outfits" &&
            raw.item_ids &&
            !("layout" in raw) &&
            JSON.stringify(raw.item_ids) !== JSON.stringify(prior.item_ids)
          )
            merged.layout = null;
          Object.assign(entity, schema.parse(merged));
          validate(state, entity);
          return entity;
        }),
      );
    });
    app.delete("/api/" + key + "/:id", async (c) =>
      c.json(
        await mutateWorkspace(c.get("runtime"), c.get("ownerId"), (state) => {
          const entity = find(state, key, c.req.param("id")!);
          state[key] = state[key].filter((e) => e.id !== entity.id);
          if (key === "outfits")
            for (const plan of state.plans)
              if (plan.outfit_id === entity.id) plan.outfit_id = null;
          return { ok: true };
        }),
      ),
    );
  }
  app.post("/api/wear", async (c) => {
    const parsed = wearInput.parse(await json(c));
    if (parsed.date > today())
      throw new HTTPException(422, { message: "实际穿着日期不能晚于今天。" });
    return c.json(
      await mutateWorkspace(c.get("runtime"), c.get("ownerId"), (state) => {
        const previous = state.wear_events.find(
          (e) => e.request_id === parsed.request_id,
        );
        if (previous) {
          if (
            Object.keys(parsed).some(
              (key) =>
                JSON.stringify(previous[key]) !==
                JSON.stringify(parsed[key as keyof typeof parsed]),
            )
          )
            throw new HTTPException(409, {
              message: "这次记录已提交，请刷新后再试。",
            });
          return previous;
        }
        references(state, parsed.item_ids);
        const items = parsed.item_ids.map((id) => find(state, "items", id));
        if (items.some((i) => !i.confirmed || i.status !== "available"))
          throw new HTTPException(409, {
            message: "请先确认单品并检查可用状态。",
          });
        const entity = {
          ...parsed,
          id: crypto.randomUUID(),
          item_names: Object.fromEntries(items.map((i) => [i.id, i.name])),
          created_at: stamp(),
        };
        state.wear_events.push(entity);
        return entity;
      }),
    );
  });
  app.delete("/api/wear/:id", async (c) =>
    c.json(
      await mutateWorkspace(c.get("runtime"), c.get("ownerId"), (state) => {
        const row = find(state, "wear_events", c.req.param("id"));
        state.wear_events = state.wear_events.filter((e) => e.id !== row.id);
        return { ok: true };
      }),
    ),
  );
  app.post("/api/recommendations", async (c) =>
    c.json(
      recommend(
        (await readWorkspace(c.get("runtime"), c.get("ownerId"))).state,
        await json(c),
      ),
    ),
  );
  mountSharing(app);
  mountMigration(app);
  app.all("/api/*", (c) =>
    c.json({ detail: "当前云端实例尚未提供这项功能。" }, 404),
  );
  app.onError((error, c) => {
    if (error instanceof HTTPException)
      return c.json({ detail: error.message }, error.status);
    if (error instanceof z.ZodError)
      return c.json({ detail: "请检查填写内容、长度、日期和单品信息。" }, 422);
    if (error instanceof ValidationError)
      return c.json({ detail: error.message }, 422);
    if (error instanceof SyntaxError)
      return c.json({ detail: "提交内容格式无效。" }, 422);
    // Error details can include private SQL parameters; keep responses and platform logs content-free.
    return c.json({ detail: "操作未完成，请稍后重试。" }, 500);
  });
  return app;
}
