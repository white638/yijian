export async function normalizeUpload(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type))
    throw new Error("请选择 JPEG、PNG 或 WebP 照片。");
  if (file.size > 20 * 1024 * 1024)
    throw new Error("单张原照片不能超过 20 MB。");
  if (typeof createImageBitmap !== "function")
    throw new Error("当前浏览器无法处理照片，请更新浏览器后重试。");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(
      "无法读取这张照片，请换一张有效的 JPEG、PNG 或 WebP 图片。",
    );
  }
  try {
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width * bitmap.height > 25_000_000
    )
      throw new Error("照片尺寸过大，请选择不超过 2500 万像素的图片。");
    const ratio = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("当前浏览器无法处理图片，请更新浏览器后重试。");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error("图片处理未完成，请换一张照片。")),
        "image/jpeg",
        0.9,
      ),
    );
    if (blob.size > 5 * 1024 * 1024)
      throw new Error("处理后的照片仍超过 5 MB，请缩小图片后重试。");
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, {
      type: "image/jpeg",
    });
  } finally {
    bitmap.close();
  }
}
