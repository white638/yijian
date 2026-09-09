export type Category =
  | "top"
  | "bottom"
  | "dress"
  | "outerwear"
  | "shoes"
  | "bag"
  | "accessory"
  | "other";
export const categories: Record<Category, string> = {
  top: "上衣",
  bottom: "下装",
  dress: "连衣裙",
  outerwear: "外套",
  shoes: "鞋履",
  bag: "包袋",
  accessory: "配饰",
  other: "其他",
};
export const occasions: Record<string, string> = {
  casual: "日常",
  work: "工作",
  sport: "运动",
  formal: "正式",
};
export const colorNames: Record<string, string> = {
  black: "黑色",
  white: "白色",
  gray: "灰色",
  grey: "灰色",
  blue: "蓝色",
  navy: "藏蓝",
  red: "红色",
  green: "绿色",
  beige: "米色",
  brown: "棕色",
  pink: "粉色",
  purple: "紫色",
  yellow: "黄色",
  orange: "橙色",
  cream: "奶油色",
  multicolor: "多色",
};
export const seasonNames: Record<string, string> = {
  spring: "春季",
  summer: "夏季",
  autumn: "秋季",
  fall: "秋季",
  winter: "冬季",
  all: "四季",
};
export const itemName = (i: Item) =>
  i.name || categories[i.category] || "未命名单品";
export const translateValue = (value: string) =>
  colorNames[value.toLowerCase()] ||
  seasonNames[value.toLowerCase()] ||
  occasions[value] ||
  value;
export interface ReferencePrice {
  amount: number;
  currency:
    | "CNY"
    | "USD"
    | "EUR"
    | "GBP"
    | "JPY"
    | "KRW"
    | "HKD"
    | "TWD"
    | "CAD"
    | "AUD"
    | "CHF";
  label: "页面售价" | "起售价" | "发售价格";
  observed_at: string;
  source_url: string;
}
export interface Item {
  id: string;
  name: string;
  category: Category;
  colors: string[];
  seasons: string[];
  occasions: string[];
  tags: string[];
  status: "available" | "laundry" | "archived";
  confirmed: boolean;
  favorite: boolean;
  price: string | null;
  currency: string | null;
  reference_price?: ReferencePrice | null;
  brand: string;
  closet: string;
  notes: string;
  purchased_at: string | null;
  created_at: string;
  updated_at: string;
  image_url: string | null;
  original_url: string | null;
  background_status: "completed" | "skipped" | "failed";
  ai_status: "idle" | "processing" | "review" | "error";
  ai_error: string | null;
  wear_count: number;
}
export interface Outfit {
  id: string;
  name: string;
  item_ids: string[];
  notes: string;
  source: "manual" | "rules" | "ai" | "assistant";
  created_at: string;
}
export interface Suggestion {
  name: string;
  item_ids: string[];
  reason: string;
  source: "rules" | "ai";
}
export interface Suggestions {
  outfits: Suggestion[];
  missing: string[];
  message: string;
}
export interface Plan {
  id: string;
  date: string;
  outfit_id: string | null;
  item_ids: string[];
  name: string;
  notes: string;
}
export interface WearEvent {
  id: string;
  item_ids: string[];
  item_names: Record<string, string>;
  date: string;
  notes: string;
  created_at: string;
}
export interface Trip {
  id: string;
  name: string;
  destination: string;
  start_date: string;
  end_date: string;
  entries: { item_id: string; packed: boolean }[];
  created_at: string;
}
export type Provider =
  | "none"
  | "openai"
  | "compatible"
  | "ollama"
  | "codex"
  | "claude-code";
export interface AISettings {
  provider: Provider;
  base_url: string;
  text_model: string;
  vision_model: string;
  has_key: boolean;
  capabilities: { text: boolean; vision: boolean };
  configured: boolean;
  assistant_connected?: boolean;
  automatic_vision?: {
    supported: boolean;
    enabled: boolean;
    ready: boolean;
    reason: string;
  };
  assistant_connection?: {
    status: "disconnected" | "pending" | "connected";
    client_name?: string;
    expires_at?: number;
    verified_at?: number;
    request_id?: string;
  };
}
export interface AssistantDeviceRequest {
  id: string;
  user_code: string;
  client_name: string;
  expires_at: number;
  status: "pending" | "approved";
}
export interface Preferences {
  location: string;
  temperature: number;
  sensitivity: string;
  notes: string;
  excluded_ids: string[];
  blocked_pairs: string[][];
  closet_scope: string;
}
export interface AppState {
  settings: {
    name: string;
    onboarded: boolean;
    language: string;
    preferences: Preferences;
  };
  items: Item[];
  outfits: Outfit[];
  plans: Plan[];
  wear_events: WearEvent[];
  trips: Trip[];
  ai: AISettings;
  features: { background_removal: boolean; background_removal_ready: boolean };
  insights: {
    total: number;
    available: number;
    laundry: number;
    unworn: number;
    costs: {
      currency: string | null;
      total: number | string;
      priced_items: number;
    }[];
    categories: { category: Category; count: number }[];
    colors: { color: string; count: number }[];
    most_worn: Item[];
    unworn_items: Item[];
  };
}
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const dateLabel = (date: string) =>
  new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(
    new Date(`${date.slice(0, 10)}T12:00:00`),
  );
export const money = (
  amount: number | string,
  currency: string | null = "CNY",
) =>
  currency
    ? new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
      }).format(Number(amount))
    : `${Number(amount).toLocaleString("zh-CN")}（币种未填）`;
export function costPerWear(
  item: Pick<Item, "price" | "wear_count" | "currency">,
) {
  return item.price == null
    ? "尚未记录价格"
    : item.wear_count === 0
      ? "尚未穿着"
      : money(Number(item.price) / item.wear_count, item.currency);
}
export function mergeTripItems(entries: Trip["entries"], ids: string[]) {
  const rows = new Map(entries.map((e) => [e.item_id, e]));
  for (const id of ids)
    if (!rows.has(id)) rows.set(id, { item_id: id, packed: false });
  return [...rows.values()];
}
