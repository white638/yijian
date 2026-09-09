export const CAPTURE_PREFIX = "YIJIAN_CAPTURE_V1\n";
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function collectVisibleImages() {
  if (!/^https?:$/.test(location.protocol))
    throw new Error("请在普通商品网页中使用采集功能。");
  const viewport = { width: innerWidth, height: innerHeight };
  const candidates = [];
  const seen = new Set();
  for (const image of document.images) {
    if (
      !image.complete ||
      image.naturalWidth < 160 ||
      image.naturalHeight < 160
    )
      continue;
    const style = getComputedStyle(image);
    if (
      style.display === "none" ||
      style.visibility !== "visible" ||
      Number(style.opacity) === 0
    )
      continue;
    const bounds = image.getBoundingClientRect();
    const x = Math.max(0, bounds.left),
      y = Math.max(0, bounds.top);
    const right = Math.min(viewport.width, bounds.right),
      bottom = Math.min(viewport.height, bounds.bottom);
    const width = right - x,
      height = bottom - y;
    if (width < 120 || height < 120) continue;
    const hit = document.elementFromPoint(x + width / 2, y + height / 2);
    if (!hit || (hit !== image && !image.contains(hit))) continue;
    const key = [x, y, width, height].map(Math.round).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ rect: { x, y, width, height }, area: width * height });
  }
  candidates.sort((a, b) => b.area - a.area);
  const page = new URL(location.href);
  const source = new URL(page.origin + page.pathname);
  for (const key of [
    "id",
    "item_id",
    "goods_id",
    "skuId",
    "sku",
    "product_id",
    "spuId",
    "propertyValueId",
  ])
    if (page.searchParams.has(key))
      source.searchParams.set(key, page.searchParams.get(key));
  return {
    title: document.title.trim().slice(0, 120),
    source_url: source.href,
    viewport,
    candidates: candidates
      .slice(0, 8)
      .map(({ rect }, index) => ({ id: String(index + 1), rect })),
  };
}

export function cropBounds(rect, viewport, bitmap) {
  if (
    ![
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      viewport.width,
      viewport.height,
      bitmap.width,
      bitmap.height,
    ].every(Number.isFinite) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    bitmap.width <= 0 ||
    bitmap.height <= 0 ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    throw new Error("图片位置无效，请重新采集。");
  const sx = bitmap.width / viewport.width,
    sy = bitmap.height / viewport.height;
  const x = Math.max(0, Math.floor(rect.x * sx));
  const y = Math.max(0, Math.floor(rect.y * sy));
  const right = Math.min(bitmap.width, Math.ceil((rect.x + rect.width) * sx));
  const bottom = Math.min(
    bitmap.height,
    Math.ceil((rect.y + rect.height) * sy),
  );
  if (right <= x || bottom <= y)
    throw new Error("图片已移出可见区域，请重新采集。");
  return { x, y, width: right - x, height: bottom - y };
}

export function dataBytes(value) {
  const encoded = value.split(",")[1] || "";
  return (
    Math.floor((encoded.length * 3) / 4) -
    (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0)
  );
}

export async function cropCandidate(screenshot, rect, viewport) {
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("截图无法读取，请重新采集。"));
    image.src = screenshot;
  });
  const bounds = cropBounds(rect, viewport, {
    width: image.naturalWidth,
    height: image.naturalHeight,
  });
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 1280 / Math.max(bounds.width, bounds.height));
  canvas.width = Math.max(1, Math.round(bounds.width * scale));
  canvas.height = Math.max(1, Math.round(bounds.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法处理图片，请保存商品截图后上传。");
  context.drawImage(
    image,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  for (const quality of [0.9, 0.75, 0.6]) {
    const data = canvas.toDataURL("image/jpeg", quality);
    if (
      data.startsWith("data:image/jpeg;base64,") &&
      dataBytes(data) <= MAX_IMAGE_BYTES
    )
      return data;
  }
  throw new Error("图片仍然过大，请缩小商品图的显示范围后重新采集。");
}

export function capturePayload(page, image) {
  if (
    !image.startsWith("data:image/jpeg;base64,") ||
    dataBytes(image) > MAX_IMAGE_BYTES
  )
    throw new Error("采集图片无效或过大，请重新采集。");
  const source = new URL(page.source_url);
  if (
    !/^https?:$/.test(source.protocol) ||
    source.username ||
    source.password ||
    source.href.length > 2600
  )
    throw new Error("请在普通商品网页中使用采集功能。");
  const result =
    CAPTURE_PREFIX +
    JSON.stringify({
      version: 1,
      title: page.title.slice(0, 120),
      source_url: source.href,
      image,
    });
  if (new TextEncoder().encode(result).length > 4 * 1024 * 1024)
    throw new Error("采集数据过大，请重新采集。");
  return result;
}
