export const CAPTURE_PREFIX = "YIJIAN_CAPTURE_V1\n";
export interface BrowserCapture {
  version: 1;
  title: string;
  source_url: string;
  image: string;
}
export function parseCapture(value: string): BrowserCapture | null {
  if (!value.startsWith("YIJIAN_CAPTURE_")) return null;
  if (!value.startsWith(CAPTURE_PREFIX))
    throw new Error("采集数据版本不支持，请更新衣间扩展后重新采集。");
  if (new TextEncoder().encode(value).length > 4 * 1024 * 1024)
    throw new Error("采集图片过大，请重新采集较小的商品图。");
  try {
    const data = JSON.parse(value.slice(CAPTURE_PREFIX.length));
    if (
      !data ||
      data.version !== 1 ||
      typeof data.title !== "string" ||
      data.title.length > 120 ||
      typeof data.source_url !== "string" ||
      data.source_url.length > 2600 ||
      typeof data.image !== "string" ||
      !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
        data.image,
      ) ||
      Object.keys(data).some(
        (key) => !["version", "title", "source_url", "image"].includes(key),
      )
    )
      throw new Error();
    const url = new URL(data.source_url);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      throw new Error();
    return {
      version: 1,
      title: data.title,
      source_url: data.source_url,
      image: data.image,
    };
  } catch {
    throw new Error("采集数据不完整或格式无效，请在衣间扩展中重新复制。");
  }
}
