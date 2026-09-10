import type { Category, Item } from "./types";

export const subcategories: Record<Category, string[]> = {
  top: ["T恤", "衬衫", "针织衫", "卫衣", "Polo衫", "背心"],
  bottom: ["长裤", "短裤", "牛仔裤", "半裙", "运动裤"],
  dress: ["连衣裙", "吊带裙", "衬衫裙", "针织裙", "礼服裙"],
  outerwear: ["西装", "夹克", "风衣", "大衣", "羽绒服", "开衫"],
  shoes: ["运动鞋", "休闲鞋", "皮鞋", "靴子", "凉鞋", "高跟鞋"],
  bag: ["单肩包", "斜挎包", "双肩包", "手提包", "托特包", "手拿包"],
  accessory: [
    "帽子",
    "围巾",
    "腰带",
    "手表",
    "项链",
    "耳饰",
    "戒指",
    "手链",
    "眼镜",
  ],
  other: ["袜子", "连裤袜"],
};
export const attributeChoices = {
  materials: [
    "棉",
    "羊毛",
    "亚麻",
    "真丝",
    "聚酯纤维",
    "锦纶",
    "皮革",
    "粘胶纤维",
  ],
  pattern: ["纯色", "条纹", "格纹", "印花", "波点", "提花", "拼色"],
  styles: ["休闲", "极简", "通勤", "经典", "街头", "运动", "复古", "优雅"],
  fit: ["修身", "合身", "宽松", "超宽松"],
  cut: ["直筒", "收腰", "A字", "廓形", "锥形", "阔腿"],
  neckline: ["圆领", "V领", "翻领", "立领", "高领", "方领", "连帽"],
  sleeve_length: ["无袖", "短袖", "五分袖", "七分袖", "长袖"],
  length: ["短款", "常规", "长款", "七分", "九分", "及膝", "及踝"],
};
export const observableAttributes = [
  "subcategory",
  "materials",
  "pattern",
  "styles",
  "fit",
  "cut",
  "neckline",
  "sleeve_length",
  "length",
] as const;
export type ObservableAttribute = (typeof observableAttributes)[number];
export interface ItemAttributeDraft {
  subcategory: string;
  materials: string[];
  pattern: string;
  styles: string[];
  fit: string;
  cut: string;
  neckline: string;
  sleeve_length: string;
  length: string;
  size: string;
  care_notes: string;
}
export function itemAttributeDraft(item: Item): ItemAttributeDraft {
  return {
    subcategory: item.subcategory || "",
    materials: item.materials || [],
    pattern: item.pattern || "",
    styles: item.styles || [],
    fit: item.fit || "",
    cut: item.cut || "",
    neckline: item.neckline || "",
    sleeve_length: item.sleeve_length || "",
    length: item.length || "",
    size: item.size || "",
    care_notes: item.care_notes || "",
  };
}
