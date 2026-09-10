import type { Workspace, Entity } from "./models.js";
export const features = {
  online: true,
  background_removal: false,
  background_removal_ready: false,
  capabilities: {
    ai: false,
    background_removal: false,
    product_import: false,
    sharing: true,
    migration: true,
  },
};
export function itemView(
  item: Entity,
  state: Workspace,
): Entity & { wear_count: number; cost_per_wear: string | null } {
  const wear_count =
    (item.prior_wear_count ?? 0) +
    state.wear_events.filter((e) => e.item_ids.includes(item.id)).length;
  return {
    ...item,
    wear_count,
    cost_per_wear:
      item.price != null && wear_count
        ? (Number(item.price) / wear_count).toFixed(2)
        : null,
  };
}
export function stateView(state: Workspace) {
  const items = state.items.map((item) => itemView(item, state));
  const costs = new Map<
    string | null,
    { cents: number; priced_items: number }
  >();
  const categories = new Map<string, number>();
  const colors = new Map<string, number>();
  for (const item of items) {
    if (item.price != null && item.status !== "archived") {
      const cost = costs.get(item.currency) ?? { cents: 0, priced_items: 0 };
      cost.cents += Math.round(Number(item.price) * 100);
      cost.priced_items++;
      costs.set(item.currency, cost);
    }
    categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
    for (const color of item.colors)
      colors.set(color, (colors.get(color) ?? 0) + 1);
  }
  return {
    ...state,
    edition: "online",
    items,
    features,
    ai: {
      provider: "none",
      base_url: "",
      text_model: "",
      vision_model: "",
      has_key: false,
      capabilities: { text: false, vision: false },
      configured: false,
      assistant_connected: false,
      automatic_vision: {
        supported: false,
        enabled: false,
        ready: false,
        reason: "当前云端实例提供衣柜、手动穿搭和分享功能。",
      },
    },
    insights: {
      total: items.length,
      available: items.filter((i) => i.status === "available").length,
      laundry: items.filter((i) => i.status === "laundry").length,
      unworn: items.filter((i) => !i.wear_count).length,
      costs: [...costs].map(([currency, value]) => ({
        currency,
        total: (value.cents / 100).toFixed(2),
        priced_items: value.priced_items,
      })),
      categories: [...categories].map(([category, count]) => ({
        category,
        count,
      })),
      colors: [...colors]
        .sort((a, b) => b[1] - a[1])
        .map(([color, count]) => ({ color, count })),
      most_worn: items
        .filter((i) => i.wear_count)
        .sort((a, b) => b.wear_count - a.wear_count)
        .slice(0, 8),
      unworn_items: items.filter((i) => !i.wear_count).slice(0, 8),
    },
  };
}
