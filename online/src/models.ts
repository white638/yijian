import { z } from "zod";

export class ValidationError extends Error {}
export const collections = [
  "items",
  "outfits",
  "plans",
  "wear_events",
  "care_events",
  "trips",
] as const;
export type Collection = (typeof collections)[number];
export const id = z.string().uuid().toLowerCase();
const text = (max: number) => z.string().trim().max(max);
const labels = (max: number) =>
  z
    .array(text(80))
    .max(max)
    .transform((values) => [...new Set(values.filter(Boolean))]);
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
    "日期无效",
  );
export const currency = z.enum([
  "CNY",
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "KRW",
  "HKD",
  "TWD",
  "CAD",
  "AUD",
  "CHF",
]);
export const category = z.enum([
  "top",
  "bottom",
  "dress",
  "outerwear",
  "shoes",
  "bag",
  "accessory",
  "other",
]);
export const imageName = /^[a-f0-9]{32}-(?:original|cutout|beautified)\.jpg$/;
const imageUrl = z
  .string()
  .regex(/^\/api\/images\/[a-f0-9]{32}-(?:original|cutout|beautified)\.jpg$/);
const price = z
  .union([z.string(), z.number()])
  .nullable()
  .transform((value) => (value === null || value === "" ? null : Number(value)))
  .refine(
    (value) =>
      value === null ||
      (Number.isFinite(value) && value >= 0 && value <= 100000000),
    "价格无效",
  )
  .transform((value) => (value === null ? null : value.toFixed(2)));
export const itemInput = z
  .object({
    name: text(120).min(1).default("未命名单品"),
    category: category.default("other"),
    subcategory: text(80).default(""),
    materials: labels(10).default([]),
    pattern: text(80).default(""),
    styles: labels(12).default([]),
    fit: text(40).default(""),
    cut: text(80).default(""),
    neckline: text(80).default(""),
    sleeve_length: text(40).default(""),
    length: text(40).default(""),
    size: text(80).default(""),
    care_notes: text(1000).default(""),
    colors: labels(10).default([]),
    seasons: labels(4).default([]),
    occasions: labels(8).default([]),
    tags: labels(30).default([]),
    status: z.enum(["available", "laundry", "archived"]).default("available"),
    confirmed: z.boolean().default(false),
    favorite: z.boolean().default(false),
    price: price.default(null),
    currency: currency.nullable().default("CNY"),
    brand: text(120).default(""),
    closet: text(80).min(1).default("日常衣橱"),
    notes: text(3000).default(""),
    purchased_at: date.nullable().default(null),
  })
  .strict();
export const layout = z
  .object({
    version: z.literal(1),
    mode: z.enum(["free", "categories", "collage", "ai"]),
    template: z.enum(["balanced", "grid", "editorial"]),
    background: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    placements: z
      .array(
        z
          .object({
            item_id: id,
            x: z.number().min(0).max(100),
            y: z.number().min(0).max(100),
            width: z.number().min(8).max(85),
            rotation: z.number().min(-180).max(180),
          })
          .strict(),
      )
      .max(24),
  })
  .strict();
const itemIds = z
  .array(id)
  .max(24)
  .refine((ids) => new Set(ids).size === ids.length, "单品重复");
export const outfitInput = z
  .object({
    name: text(120).min(1),
    item_ids: itemIds,
    notes: text(3000).default(""),
    source: z.enum(["manual", "rules", "ai", "assistant"]).default("manual"),
    layout: layout.nullable().default(null),
  })
  .strict();
export const planInput = z
  .object({
    date,
    item_ids: itemIds.default([]),
    outfit_id: id.nullable().default(null),
    name: text(120).min(1).default("今日穿搭"),
    notes: text(3000).default(""),
  })
  .strict();
export const wearInput = z
  .object({
    date,
    item_ids: itemIds.refine((ids) => ids.length > 0),
    notes: text(3000).default(""),
    request_id: text(120).min(8),
  })
  .strict();
export const tripInput = z
  .object({
    name: text(120).min(1),
    destination: text(120).default(""),
    start_date: date,
    end_date: date,
    entries: z
      .array(
        z.object({ item_id: id, packed: z.boolean().default(false) }).strict(),
      )
      .max(1000)
      .default([]),
  })
  .strict();
export const preferences = z
  .object({
    location: text(120).default(""),
    temperature: z.number().min(-50).max(60).default(22),
    sensitivity: z.enum(["cold", "normal", "hot"]).default("normal"),
    notes: text(3000).default(""),
    excluded_ids: z.array(id).max(1000).default([]),
    blocked_pairs: z.array(z.array(id).length(2)).max(500).default([]),
    closet_scope: text(80).default("all"),
  })
  .strict();
export const settings = z
  .object({
    name: text(80).default(""),
    onboarded: z.boolean().default(false),
    language: z.literal("zh-CN").default("zh-CN"),
    preferences: preferences.default(() => preferences.parse({})),
  })
  .strict();
const timestamp = text(50).min(1);
const reference = z
  .object({
    amount: z.number().min(0).max(100000000),
    currency,
    label: z.enum(["页面售价", "起售价", "发售价格"]),
    observed_at: timestamp,
    source_url: z
      .string()
      .max(2600)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      }),
  })
  .strict();
export const storedItem = itemInput
  .extend({
    id,
    created_at: timestamp,
    updated_at: timestamp,
    image_url: imageUrl.nullable().default(null),
    original_url: imageUrl.nullable().default(null),
    beautified_url: imageUrl.nullable().optional(),
    beautified_source_url: imageUrl.nullable().optional(),
    extra_images: z.array(imageUrl).max(20).optional(),
    reference_price: reference.nullable().default(null),
    background_status: z
      .enum(["completed", "skipped", "failed"])
      .default("skipped"),
    ai_status: z
      .enum(["idle", "processing", "review", "error"])
      .default("idle"),
    ai_error: text(3000).nullable().default(null),
    prior_wear_count: z.number().int().min(0).max(100000).default(0),
  })
  .strip();
const storedSchemas = {
  items: storedItem,
  outfits: outfitInput.extend({ id, created_at: timestamp }).strip(),
  plans: planInput.extend({ id }).strip(),
  wear_events: wearInput
    .extend({
      id,
      created_at: timestamp,
      item_names: z.record(id, text(120)).default({}),
    })
    .strip(),
  care_events: z.object({
    id,
    item_id: id,
    item_name: text(120),
    date,
    created_at: timestamp,
    action: z.literal("wash"),
  }),
  trips: tripInput.extend({ id, created_at: timestamp }).strip(),
};
export type Item = z.infer<typeof storedItem>;
export type Entity = Record<string, any> & { id: string };
export type Workspace = {
  schema_version: 1;
  settings: z.infer<typeof settings>;
} & Record<Collection, Entity[]>;
export function emptyWorkspace(): Workspace {
  return {
    schema_version: 1,
    settings: settings.parse({}),
    items: [],
    outfits: [],
    plans: [],
    wear_events: [],
    care_events: [],
    trips: [],
  };
}
export function references(state: Workspace, ids: string[]) {
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !state.items.some((item) => item.id === id))
  )
    throw new ValidationError("所选单品不存在或重复。");
}
export function checkRelations(state: Workspace) {
  const requests = new Set<string>();
  for (const outfit of state.outfits) {
    references(state, outfit.item_ids);
    if (outfit.layout) {
      const placed = outfit.layout.placements.map(
        (p: { item_id: string }) => p.item_id,
      );
      if (
        new Set(placed).size !== placed.length ||
        placed.length !== outfit.item_ids.length ||
        placed.some((id: string) => !outfit.item_ids.includes(id))
      )
        throw new ValidationError("画布与所选单品不一致。");
    }
  }
  for (const plan of state.plans) {
    references(state, plan.item_ids);
    if (plan.outfit_id && !state.outfits.some((o) => o.id === plan.outfit_id))
      throw new ValidationError("穿搭不存在。");
  }
  for (const trip of state.trips) {
    if (trip.end_date < trip.start_date)
      throw new ValidationError("结束日期早于开始日期。");
    references(
      state,
      trip.entries.map((e: { item_id: string }) => e.item_id),
    );
  }
  for (const event of state.wear_events) {
    if (requests.has(event.request_id))
      throw new ValidationError("穿着记录重复。");
    requests.add(event.request_id);
    if (
      event.item_ids.some(
        (id: string) =>
          !state.items.some((i) => i.id === id) &&
          typeof event.item_names[id] !== "string",
      )
    )
      throw new ValidationError("穿着记录缺少单品名称。");
  }
  for (const item of state.items) {
    if (item.original_url && !item.original_url.endsWith("-original.jpg"))
      throw new ValidationError("原图无效。");
    if (item.beautified_url && !item.beautified_url.endsWith("-beautified.jpg"))
      throw new ValidationError("美化图无效。");
    if (
      item.beautified_source_url &&
      item.beautified_source_url !== (item.original_url || item.image_url)
    )
      throw new ValidationError("美化图来源无效。");
  }
  references(state, state.settings.preferences.excluded_ids);
  for (const pair of state.settings.preferences.blocked_pairs)
    references(state, pair);
}
export function validateWorkspace(input: unknown): Workspace {
  const raw = z
    .object({
      schema_version: z.literal(1),
      settings: z.unknown(),
      ...Object.fromEntries(
        collections.map((key) => [
          key,
          z.array(z.unknown()).max(key === "items" ? 2000 : 20000),
        ]),
      ),
    })
    .parse(input) as Record<string, any>;
  const result = emptyWorkspace();
  result.settings = settings.parse({
    ...raw.settings,
    preferences: raw.settings?.preferences ?? {},
  });
  for (const key of collections) {
    result[key] = raw[key].map((value: unknown) =>
      storedSchemas[key].parse(value),
    );
    if (new Set(result[key].map((e) => e.id)).size !== result[key].length)
      throw new ValidationError("记录 ID 重复。");
  }
  checkRelations(result);
  return result;
}
export function imageNames(item: Entity): string[] {
  return [
    ...new Set(
      [
        item.image_url,
        item.original_url,
        item.beautified_url,
        ...(item.extra_images ?? []),
      ]
        .filter(Boolean)
        .map((url) => String(url).replace("/api/images/", "")),
    ),
  ];
}
