import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { id, type Entity, type Workspace } from "./models.js";
export const recommendationInput = z
  .object({
    temperature: z.number().min(-50).max(60).default(22),
    occasion: z.enum(["casual", "work", "sport", "formal"]).default("casual"),
    locked_ids: z.array(id).max(12).default([]),
    excluded_ids: z.array(id).max(1000).default([]),
    seed: z.number().int().min(0).max(2147483647).default(0),
  })
  .strict();
const types: [string, RegExp][] = [
  ["scarf", /围巾|围脖|丝巾|披肩|\bscarf\b|\bshawl\b/i],
  ["hat", /帽|\bhat\b|\bcap\b|\bbeanie\b/i],
  ["gloves", /手套|\bgloves?\b/i],
  ["belt", /腰带|皮带|\bbelt\b/i],
  ["glasses", /眼镜|墨镜|\bglasses\b|\bsunglasses\b/i],
  ["watch", /手表|腕表|\bwatch\b/i],
  ["earrings", /耳环|耳钉|耳饰|耳夹|\bearrings?\b/i],
  ["necklace", /项链|项圈|吊坠|\bnecklace\b|\bpendant\b/i],
  ["bracelet", /手链|手镯|腕链|\bbracelet\b|\bbangle\b/i],
  ["ring", /戒指|指环|\bring\b/i],
  ["brooch", /胸针|\bbrooch\b/i],
  ["tie", /领带|领结|\btie\b/i],
];
const accessoryType = (item: Entity) =>
  types.find(([, pattern]) =>
    pattern.test([item.name, ...item.tags].join(" ")),
  )?.[0] ?? "other";
function randomScore(value: string) {
  let hash = 2166136261;
  for (const char of value)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967295;
}
export function recommend(state: Workspace, raw: unknown) {
  const request = recommendationInput.parse(raw),
    prefs = state.settings.preferences;
  const excluded = new Set([...request.excluded_ids, ...prefs.excluded_ids]);
  const candidates = state.items.filter(
    (i) =>
      i.confirmed &&
      i.status === "available" &&
      !excluded.has(i.id) &&
      (prefs.closet_scope === "all" || i.closet === prefs.closet_scope),
  );
  const locked = [...new Set(request.locked_ids)].map((id) => {
    const item = candidates.find((i) => i.id === id);
    if (!item)
      throw new HTTPException(409, {
        message: "锁定的单品不可用，或已被推荐设置排除。",
      });
    return item;
  });
  const temperature =
    request.temperature +
    (prefs.sensitivity === "cold" ? -4 : prefs.sensitivity === "hot" ? 4 : 0);
  const season =
    temperature < 12 ? "winter" : temperature >= 25 ? "summer" : "autumn";
  const seasonMatches = (i: Entity) =>
    !i.seasons.length ||
    i.seasons.includes("all") ||
    i.seasons.includes(season) ||
    (season === "autumn" && i.seasons.includes("spring"));
  const occasionMatches = (i: Entity) =>
    !i.occasions.length || i.occasions.includes(request.occasion);
  const wears = new Map(candidates.map((i) => [i.id, i.prior_wear_count ?? 0]));
  for (const event of state.wear_events)
    for (const id of event.item_ids)
      if (wears.has(id)) wears.set(id, wears.get(id)! + 1);
  const scores = new Map(
    candidates.map((i) => [
      i.id,
      8 / (1 + wears.get(i.id)!) +
        (seasonMatches(i) ? 5 : 0) +
        (occasionMatches(i) ? 5 : 0) +
        (i.favorite ? 1 : 0) +
        randomScore(request.seed + ":" + i.id) * 5,
    ]),
  );
  const score = (i: Entity) => scores.get(i.id)!;
  const blocked = (items: Entity[]) =>
    prefs.blocked_pairs.some((pair) =>
      pair.every((id) => items.some((i) => i.id === id)),
    );
  const groups: Record<string, Entity[]> = {};
  for (const category of [
    "top",
    "bottom",
    "dress",
    "outerwear",
    "shoes",
    "bag",
    "accessory",
    "other",
  ]) {
    const fixed = locked.filter((i) => i.category === category);
    if (
      fixed.length > 1 &&
      ["top", "bottom", "dress", "outerwear", "shoes"].includes(category)
    )
      throw new HTTPException(422, { message: "请减少同一类别的锁定单品。" });
    groups[category] = fixed.length
      ? fixed
      : candidates
          .filter((i) => i.category === category)
          .sort((a, b) => score(b) - score(a))
          .slice(0, 18);
  }
  if (
    locked.some((i) => i.category === "dress") &&
    locked.some((i) => ["top", "bottom"].includes(i.category))
  )
    throw new HTTPException(422, { message: "请选择连衣裙或上衣与下装。" });
  const ranked: { items: Entity[]; score: number }[] = [];
  const add = (base: Entity[]) => {
    const layers: (Entity | null)[] =
      (temperature < 18 || locked.some((i) => i.category === "outerwear")) &&
      groups.outerwear.length
        ? groups.outerwear
        : [null];
    for (const layer of layers) {
      const chosen = [...base, ...(layer ? [layer] : [])];
      for (const fixed of locked)
        if (!chosen.some((i) => i.id === fixed.id)) chosen.push(fixed);
      if (blocked(chosen)) continue;
      ranked.push({
        items: chosen,
        score: chosen.reduce((sum, i) => sum + score(i), 0) / chosen.length,
      });
      ranked.sort((a, b) => b.score - a.score);
      if (ranked.length > 3) ranked.pop();
    }
  };
  if (!locked.some((i) => i.category === "dress"))
    for (const top of groups.top)
      for (const bottom of groups.bottom)
        for (const shoes of groups.shoes) add([top, bottom, shoes]);
  if (!locked.some((i) => ["top", "bottom"].includes(i.category)))
    for (const dress of groups.dress)
      for (const shoes of groups.shoes) add([dress, shoes]);
  const suitable = (item: Entity) => {
    if (!seasonMatches(item) || !occasionMatches(item)) return false;
    if (item.category === "accessory" && temperature >= 22) {
      const type = accessoryType(item),
        text = [item.name, ...item.tags].join(" ");
      if (type === "scarf" && !/丝巾|\bsilk\b/i.test(text)) return false;
      if (type === "gloves" && !/防晒|骑行|\bcycling\b/i.test(text))
        return false;
      if (
        type === "hat" &&
        /保暖|毛线|针织|羊毛|绒|\bwool\b|\bbeanie\b|\bknit\b|\bwinter\b/i.test(
          text,
        )
      )
        return false;
    }
    return true;
  };
  const optional = candidates
    .filter((i) => ["bag", "accessory"].includes(i.category) && suitable(i))
    .sort((a, b) => score(b) - score(a));
  const enhance = (base: Entity[]) => {
    const items = [...base];
    for (const item of optional) {
      if (
        items.some((i) => i.id === item.id) ||
        items.filter((i) => i.category === item.category).length >=
          (item.category === "bag" ? 1 : 2)
      )
        continue;
      if (
        item.category === "accessory" &&
        items.some(
          (i) =>
            i.category === "accessory" &&
            accessoryType(i) === accessoryType(item),
        )
      )
        continue;
      if (!blocked([...items, item])) items.push(item);
    }
    return items;
  };
  const variants = ranked.flatMap((row) => [enhance(row.items), row.items]);
  const seen = new Set<string>();
  const outfits = [];
  for (const items of variants) {
    const signature = items
      .map((i) => i.id)
      .sort()
      .join(",");
    if (seen.has(signature)) continue;
    seen.add(signature);
    outfits.push({
      name: items[0].name + "的搭配",
      item_ids: items.map((i) => i.id),
      source: "rules",
      reason: "从已确认、当前可穿的单品中组合，并参考气温、场合与穿着次数。",
    });
    if (outfits.length === 3) break;
  }
  const missing = [];
  if (!groups.shoes.length) missing.push("shoes");
  if (!groups.dress.length)
    for (const category of ["top", "bottom"])
      if (!groups[category].length) missing.push(category);
  return {
    outfits,
    missing,
    message: outfits.length
      ? ""
      : "请补充并确认所需单品，或调整锁定、排除和衣橱范围。",
  };
}
