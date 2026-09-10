import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createNodePlatform } from "../src/adapters/node.js";
import { createAuth } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { readWorkspace, commitWorkspace } from "../src/repository.js";
import { stripJpegMetadata } from "../src/jpeg.js";

const origin = "http://localhost:3117";
const jpeg = Uint8Array.from(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDw6iiivuTmP//Z",
    "base64",
  ),
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "yijian-app-test-"));
  const platform = createNodePlatform({
    databasePath: join(dir, "data.sqlite"),
    blobDirectory: join(dir, "blobs"),
  });
  cleanups.push(async () => {
    await platform.close();
    if (resolve(dir).startsWith(resolve(tmpdir()) + sep + "yijian-app-test-"))
      rmSync(dir, { recursive: true, force: true });
  });
  const auth = createAuth({
    database: platform.authDatabase,
    secret: "app-test-independent-secret-with-40-characters",
    publicOrigin: origin,
    registrationMode: "open",
  });
  const runtime = {
    ...platform,
    auth,
    publicOrigin: origin,
    registrationMode: "open" as const,
  };
  const app = createApp(runtime);
  const call = (
    path: string,
    method = "GET",
    data?: unknown,
    cookie = "",
    extra: Record<string, string> = {},
  ) => {
    const headers = new Headers({ origin, ...extra });
    if (cookie) headers.set("cookie", cookie);
    const body =
      data instanceof FormData
        ? data
        : data === undefined
          ? undefined
          : JSON.stringify(data);
    if (body && !(body instanceof FormData) && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    return app.request(origin + "/api" + path, { method, headers, body });
  };
  const signup = async (email: string) => {
    const response = await call("/auth/sign-up/email", "POST", {
      name: "测试用户",
      email,
      password: "test-password-for-wardrobe-103",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return {
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
      user: (await response.json()).user,
    };
  };
  const a = await signup("a@example.com"),
    b = await signup("b@example.com");
  const add = async (input: unknown, cookie = a.cookie) => {
    const response = await call("/items", "POST", input, cookie);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  };
  const upload = async (cookie = a.cookie) => {
    const form = new FormData();
    form.append(
      "files",
      new File([jpeg], "蓝色上衣.jpg", { type: "image/jpeg" }),
    );
    const response = await call("/items/upload", "POST", form, cookie);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()).items[0];
  };
  return { ...platform, runtime, call, a, b, add, upload };
}
describe("online wardrobe end to end", () => {
  it("rejects malformed multipart uploads without storing records or photos", async () => {
    const f = await fixture();
    const response = await f.call("/items/upload", "POST", "invalid multipart body", f.a.cookie, {
      "content-type": "multipart/form-data; boundary=expected-boundary",
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: "上传表单无法读取，请重新选择图片。" });
    expect((await readWorkspace(f.runtime, f.a.user.id)).state.items).toEqual([]);
    expect(await f.db.all("SELECT name FROM assets WHERE owner_id=?", [f.a.user.id])).toEqual([]);
    expect(await f.db.all("SELECT object_key FROM blob_delete_jobs WHERE owner_id=?", [f.a.user.id])).toEqual([]);
  });
  it("preserves a committed upload when its database response is lost", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const originalBatch = f.db.batch.bind(f.db);
    let interrupted = false;
    vi.spyOn(f.db, "batch").mockImplementation(async (statements) => {
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
    const form = new FormData();
    form.append(
      "files",
      new File([jpeg], "蓝色上衣.jpg", { type: "image/jpeg" }),
    );
    expect(
      (await f.call("/items/upload", "POST", form, f.a.cookie)).status,
    ).toBe(500);
    expect(interrupted).toBe(true);
    const response = await f.call("/state", "GET", undefined, f.a.cookie);
    expect(response.status).toBe(200);
    const state = await response.json();
    expect(state.items).toHaveLength(1);
    const item = state.items[0];
    const [asset] = await f.db.all<{ object_key: string }>(
      "SELECT object_key FROM assets WHERE owner_id=?",
      [f.a.user.id],
    );
    expect(await f.blobs.get(asset.object_key)).toEqual(
      stripJpegMetadata(jpeg),
    );
    const path = item.image_url.replace("/api", "");
    const beforeCleanup = await f.call(path, "GET", undefined, f.a.cookie);
    expect(beforeCleanup.status).toBe(200);
    expect(new Uint8Array(await beforeCleanup.arrayBuffer())).toEqual(
      stripJpegMetadata(jpeg),
    );
    expect(
      await f.db.all("SELECT * FROM blob_delete_jobs WHERE owner_id=?", [
        f.a.user.id,
      ]),
    ).toHaveLength(1);
    vi.setSystemTime(now + 61_000);
    const afterCleanup = await f.call(path, "GET", undefined, f.a.cookie);
    expect(afterCleanup.status).toBe(200);
    expect(new Uint8Array(await afterCleanup.arrayBuffer())).toEqual(
      stripJpegMetadata(jpeg),
    );
    expect(await f.blobs.get(asset.object_key)).toEqual(
      stripJpegMetadata(jpeg),
    );
    expect(
      await f.db.all("SELECT * FROM blob_delete_jobs WHERE owner_id=?", [
        f.a.user.id,
      ]),
    ).toEqual([]);
    expect(
      (await readWorkspace(f.runtime, f.a.user.id)).state.items[0].id,
    ).toBe(item.id);
  });

  it("requires real sessions, ignores identity headers and rejects cross-origin writes", async () => {
    const f = await fixture();
    expect((await f.call("/state")).status).toBe(401);
    expect(
      (
        await f.call("/state", "GET", undefined, "", {
          "x-user-id": f.a.user.id,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.call("/items", "POST", { name: "衬衫" }, f.a.cookie, {
          origin: "https://other.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (await f.call("/state", "GET", undefined, f.a.cookie)).headers.get(
        "cache-control",
      ),
    ).toContain("no-store");
    expect(
      (await f.call("/auth/sign-out", "POST", {}, f.a.cookie)).status,
    ).toBe(200);
    expect((await f.call("/state", "GET", undefined, f.a.cookie)).status).toBe(
      401,
    );
  });
  it("isolates records, photos and relations between accounts", async () => {
    const f = await fixture();
    const item = await f.upload();
    expect(
      (
        await f.call(
          item.image_url.replace("/api", ""),
          "GET",
          undefined,
          f.a.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.call(
          item.image_url.replace("/api", ""),
          "GET",
          undefined,
          f.b.cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (await f.call("/items/" + item.id, "PATCH", { name: "越权" }, f.b.cookie))
        .status,
    ).toBe(404);
    expect(
      (await f.call("/items/" + item.id, "DELETE", undefined, f.b.cookie))
        .status,
    ).toBe(404);
    expect(
      (
        await f.call(
          "/outfits",
          "POST",
          { name: "越权穿搭", item_ids: [item.id] },
          f.b.cookie,
        )
      ).status,
    ).toBe(422);
    expect(
      (await (await f.call("/state", "GET", undefined, f.b.cookie)).json())
        .items,
    ).toEqual([]);
  });
  it("updates only supplied fields including partial preferences", async () => {
    const f = await fixture();
    const item = await f.add({
      name: "蓝衬衫",
      category: "top",
      brand: "已填品牌",
      price: "42.30",
      favorite: true,
      confirmed: true,
      materials: ["棉"],
      styles: ["简约"],
    });
    const patched = await (
      await f.call("/items/" + item.id, "PATCH", { name: "新名字" }, f.a.cookie)
    ).json();
    expect(patched).toMatchObject({
      name: "新名字",
      category: "top",
      brand: "已填品牌",
      price: "42.30",
      favorite: true,
      confirmed: true,
      materials: ["棉"],
      styles: ["简约"],
    });
    await f.call(
      "/settings",
      "PATCH",
      {
        name: "我的衣柜",
        onboarded: true,
        preferences: { location: "北京", temperature: 18 },
      },
      f.a.cookie,
    );
    const response = await f.call(
      "/settings",
      "PATCH",
      { preferences: { temperature: 21 } },
      f.a.cookie,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: "我的衣柜",
      onboarded: true,
      preferences: { location: "北京", temperature: 21 },
    });
    expect(
      (
        await f.call(
          "/items/" + item.id,
          "PATCH",
          { image_url: "/api/images/secret.jpg" },
          f.a.cookie,
        )
      ).status,
    ).toBe(422);
  });
  it("persists canvas rotations and scales, plans, trips and wear accounting", async () => {
    const f = await fixture(),
      item = await f.add({ name: "外套", confirmed: true, price: "120" });
    const layout = {
      version: 1,
      mode: "free",
      template: "balanced",
      background: "#ffffff",
      placements: [{ item_id: item.id, x: 42, y: 53, width: 33, rotation: 47 }],
    };
    const response = await f.call(
      "/outfits",
      "POST",
      { name: "周末", item_ids: [item.id], layout },
      f.a.cookie,
    );
    expect(response.status).toBe(200);
    const outfit = await response.json();
    expect(outfit.layout).toEqual(layout);
    const plan = await (
      await f.call(
        "/plans",
        "POST",
        { date: "2026-09-15", outfit_id: outfit.id },
        f.a.cookie,
      )
    ).json();
    expect(plan.item_ids).toEqual([item.id]);
    expect(
      (
        await f.call(
          "/trips",
          "POST",
          { name: "旅行", start_date: "2026-09-15", end_date: "2026-09-14" },
          f.a.cookie,
        )
      ).status,
    ).toBe(422);
    const trip = await f.call(
      "/trips",
      "POST",
      {
        name: "旅行",
        start_date: "2026-09-15",
        end_date: "2026-09-16",
        entries: [{ item_id: item.id, packed: true }],
      },
      f.a.cookie,
    );
    expect(trip.status).toBe(200);
    const wear = {
      date: "2026-09-01",
      item_ids: [item.id],
      request_id: "request-for-wear-01",
    };
    const first = await (
      await f.call("/wear", "POST", wear, f.a.cookie)
    ).json();
    const second = await (
      await f.call("/wear", "POST", wear, f.a.cookie)
    ).json();
    expect(first.id).toBe(second.id);
    expect(
      (
        await f.call(
          "/wear",
          "POST",
          { ...wear, date: "2026-09-02" },
          f.a.cookie,
        )
      ).status,
    ).toBe(409);
    const state = await (
      await f.call("/state", "GET", undefined, f.a.cookie)
    ).json();
    expect(state.items[0]).toMatchObject({
      wear_count: 1,
      cost_per_wear: "120.00",
    });
    expect(state.insights.costs).toEqual([
      { currency: "CNY", total: "120.00", priced_items: 1 },
    ]);
    await f.call("/items/" + item.id, "DELETE", undefined, f.a.cookie);
    const after = await (
      await f.call("/state", "GET", undefined, f.a.cookie)
    ).json();
    expect(after.plans[0].item_ids).toEqual([]);
    expect(after.outfits[0].layout.placements).toEqual([]);
    expect(after.trips[0].entries).toEqual([]);
    expect(after.wear_events[0].item_names[item.id]).toBe("外套");
  });
  it("revokes shares and private image access when a source item is deleted", async () => {
    const f = await fixture(),
      item = await f.upload();
    const shared = await f.call(
      "/shares",
      "POST",
      { question: "怎么搭配？", item_ids: [item.id] },
      f.a.cookie,
    );
    expect(shared.status).toBe(201);
    const result = await shared.json();
    expect(
      (
        await f.call("/share/view", "POST", {}, "", {
          authorization: "Bearer " + result.token,
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.call("/items/" + item.id, "DELETE", undefined, f.a.cookie))
        .status,
    ).toBe(200);
    expect(
      (
        await f.call("/share/view", "POST", {}, "", {
          authorization: "Bearer " + result.token,
        })
      ).status,
    ).toBe(410);
    expect(
      (
        await f.call(
          item.image_url.replace("/api", ""),
          "GET",
          undefined,
          f.a.cookie,
        )
      ).status,
    ).toBe(404);
  });
  it("prevents a stale workspace write from overwriting another edit", async () => {
    const f = await fixture();
    const item = await f.add({ name: "原名字" });
    const before = await readWorkspace(f.runtime, f.a.user.id),
      state = structuredClone(before.state);
    state.items[0].name = "旧窗口";
    await f.call("/items/" + item.id, "PATCH", { name: "新窗口" }, f.a.cookie);
    await expect(
      commitWorkspace(f.runtime, f.a.user.id, before, state),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await readWorkspace(f.runtime, f.a.user.id)).state.items[0].name,
    ).toBe("新窗口");
  });
  it("rejects invalid images, invalid dates, invalid layouts and unavailable future endpoints", async () => {
    const f = await fixture();
    const form = new FormData();
    form.append(
      "files",
      new File(["<svg>private</svg>"], "shirt.jpg", { type: "image/jpeg" }),
    );
    expect(
      (await f.call("/items/upload", "POST", form, f.a.cookie)).status,
    ).toBe(422);
    expect(
      (
        await f.call(
          "/items",
          "POST",
          { purchased_at: "2026-02-30" },
          f.a.cookie,
        )
      ).status,
    ).toBe(422);
    const item = await f.add({ name: "T恤" });
    expect(
      (
        await f.call(
          "/outfits",
          "POST",
          {
            name: "画布",
            item_ids: [item.id],
            layout: {
              version: 1,
              mode: "free",
              template: "grid",
              background: "#fff000",
              placements: [],
            },
          },
          f.a.cookie,
        )
      ).status,
    ).toBe(422);
    expect((await f.call("/ai/config", "POST", {}, f.a.cookie)).status).toBe(
      404,
    );
  });
  it("recommends real available items with shoes, accessories and exclusions", async () => {
    const f = await fixture();
    for (const [category, name] of [
      ["top", "T恤"],
      ["bottom", "长裤"],
      ["shoes", "运动鞋"],
      ["accessory", "手表"],
      ["accessory", "项链"],
      ["accessory", "保暖围巾"],
    ])
      await f.add({ category, name, confirmed: true });
    const state = await (
      await f.call("/state", "GET", undefined, f.a.cookie)
    ).json();
    const scarf = state.items.find((i: any) => i.name === "保暖围巾");
    const response = await f.call(
      "/recommendations",
      "POST",
      { temperature: 28 },
      f.a.cookie,
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.outfits.length).toBeGreaterThan(0);
    expect(result.outfits[0].item_ids).not.toContain(scarf.id);
    expect(result.outfits[0].item_ids.length).toBe(5);
    const shoe = state.items.find((i: any) => i.category === "shoes");
    const excluded = await (
      await f.call(
        "/recommendations",
        "POST",
        { excluded_ids: [shoe.id] },
        f.a.cookie,
      )
    ).json();
    expect(excluded.outfits).toEqual([]);
    expect(excluded.missing).toContain("shoes");
  });
});
describe("public JPEG copies", () => {
  it("removes metadata and trailing data without changing JPEG scan bytes", () => {
    const app1 = new Uint8Array([
      255,
      225,
      0,
      10,
      ...new TextEncoder().encode("GPS-DATA"),
    ]);
    const input = new Uint8Array(jpeg.length + app1.length + 6);
    input.set(jpeg.slice(0, 2));
    input.set(app1, 2);
    input.set(jpeg.slice(2), 2 + app1.length);
    input.set(new TextEncoder().encode("SECRET"), input.length - 6);
    const output = stripJpegMetadata(input);
    expect(new TextDecoder().decode(output)).not.toContain("GPS-DATA");
    expect(output).toEqual(stripJpegMetadata(jpeg));
  });
  it("rejects truncation and arbitrary bytes", () => {
    expect(() => stripJpegMetadata(jpeg.slice(0, -2))).toThrow();
    expect(() =>
      stripJpegMetadata(new Uint8Array([255, 216, 255, 217])),
    ).toThrow();
  });
});

it("keeps committed deletion successful and retries failed physical cleanup", async () => {
  const f = await fixture(),
    item = await f.upload();
  const remove = f.blobs.delete.bind(f.blobs);
  f.blobs.delete = async () => {
    throw new Error("storage unavailable");
  };
  const deleted = await f.call(
    "/items/" + item.id,
    "DELETE",
    undefined,
    f.a.cookie,
  );
  expect(deleted.status).toBe(200);
  expect(
    (
      await f.db.all(
        "SELECT object_key FROM blob_delete_jobs WHERE owner_id=?",
        [f.a.user.id],
      )
    ).length,
  ).toBe(1);
  expect(
    (
      await f.call(
        item.image_url.replace("/api", ""),
        "GET",
        undefined,
        f.a.cookie,
      )
    ).status,
  ).toBe(404);
  const form = new FormData();
  form.append("files", new File([jpeg], "next.jpg", { type: "image/jpeg" }));
  expect((await f.call("/items/upload", "POST", form, f.a.cookie)).status).toBe(
    409,
  );
  f.blobs.delete = remove;
  expect((await f.call("/state", "GET", undefined, f.a.cookie)).status).toBe(
    200,
  );
  expect(
    await f.db.all("SELECT object_key FROM blob_delete_jobs WHERE owner_id=?", [
      f.a.user.id,
    ]),
  ).toEqual([]);
});
