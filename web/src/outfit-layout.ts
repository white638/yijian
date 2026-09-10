import type { CSSProperties } from "react";
import type { Item, OutfitLayout, OutfitPlacement } from "./types";

export const MAX_OUTFIT_ITEMS = 24;
export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function grid(ids: string[]): OutfitPlacement[] {
  const columns = Math.max(1, Math.ceil(Math.sqrt(ids.length * 0.8)));
  const rows = Math.max(1, Math.ceil(ids.length / columns));
  const width = Math.min(70, (100 / columns) * 0.86, (125 / rows) * 0.86);
  return ids.map((item_id, index) => ({
    item_id,
    x: ((index % columns) + 0.5) * (100 / columns),
    y: (Math.floor(index / columns) + 0.5) * (100 / rows),
    width,
    rotation: 0,
  }));
}

export function templatePlacements(
  ids: string[],
  items: Item[],
  template: OutfitLayout["template"],
): OutfitPlacement[] {
  if (ids.length < 2 || template === "grid") return grid(ids);
  const clothes = ids.filter((id) =>
    ["top", "bottom", "dress", "outerwear"].includes(
      items.find((item) => item.id === id)?.category || "",
    ),
  );
  const primary = clothes[0] || ids[0];
  if (template === "editorial") {
    const others = ids.filter((id) => id !== primary);
    const columns = others.length > 6 ? 2 : 1;
    const rows = Math.ceil(others.length / columns);
    const width = Math.min(31 / columns, 105 / rows);
    return [
      { item_id: primary, x: 32, y: 46, width: 59, rotation: -5 },
      ...others.map((item_id, index) => ({
        item_id,
        x: columns === 1 ? 81 : 69 + (index % 2) * 21,
        y: 8 + ((Math.floor(index / columns) + 0.5) * 84) / rows,
        width: clamp(width, 8, 85),
        rotation: 0,
      })),
    ];
  }
  if (ids.length > 10) return grid(ids);
  const main = clothes.length ? clothes.slice(0, 3) : [primary];
  const rest = ids.filter((id) => !main.includes(id));
  if (!rest.length) return grid(ids);
  return [
    ...main.map((item_id, index) => ({
      item_id,
      x: 35,
      y: ((index + 0.5) * 94) / main.length + 3,
      width: Math.min(59, 108 / main.length),
      rotation: 0,
    })),
    ...rest.map((item_id, index) => ({
      item_id,
      x: 81,
      y: ((index + 0.5) * 92) / rest.length + 4,
      width: clamp(Math.min(30, 98 / rest.length), 8, 85),
      rotation: 0,
    })),
  ];
}

export function syncLayout(
  layout: OutfitLayout | null | undefined,
  ids: string[],
  items: Item[],
): OutfitLayout {
  const next: OutfitLayout = layout || {
    version: 1,
    mode: "free",
    template: "balanced",
    background: "#ffffff",
    placements: [],
  };
  const defaults = templatePlacements(ids, items, next.template);
  const existing = next.placements.filter((p) => ids.includes(p.item_id));
  return {
    ...next,
    placements: [
      ...existing,
      ...defaults.filter((p) => !existing.some((e) => e.item_id === p.item_id)),
    ],
  };
}

export function placementStyle(placement: OutfitPlacement): CSSProperties {
  return {
    left: `${placement.x}%`,
    top: `${placement.y}%`,
    width: `${placement.width}%`,
    transform: `translate(-50%, -50%) rotate(${placement.rotation}deg)`,
  };
}
