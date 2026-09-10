import { afterEach, expect, it, vi } from "vitest";
import { normalizeUpload } from "../src/online-images";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("normalizes image dimensions, white background, JPEG output and closes decoded image", async () => {
  const bitmap = { width: 3200, height: 2400, close: vi.fn() };
  const decode = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal("createImageBitmap", decode);
  const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  let dimensions: number[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
  ) {
    dimensions = [this.width, this.height];
    callback(new Blob(["jpeg"], { type: "image/jpeg" }));
  });
  const result = await normalizeUpload(
    new File(["png"], "shirt.png", { type: "image/png" }),
  );
  expect(dimensions).toEqual([1600, 1200]);
  expect(context.fillStyle).toBe("#ffffff");
  expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1600, 1200);
  expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1600, 1200);
  expect(result.type).toBe("image/jpeg");
  expect(result.name).toBe("shirt.jpg");
  expect(bitmap.close).toHaveBeenCalledOnce();
});
it("rejects unsupported and oversized inputs before decoding", async () => {
  const decode = vi.fn();
  vi.stubGlobal("createImageBitmap", decode);
  await expect(
    normalizeUpload(new File(["svg"], "image.svg", { type: "image/svg+xml" })),
  ).rejects.toThrow("JPEG");
  const big = new File(["x"], "image.jpg", { type: "image/jpeg" });
  Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
  await expect(normalizeUpload(big)).rejects.toThrow("20 MB");
  expect(decode).not.toHaveBeenCalled();
});
it("rejects excessive pixel count and frees the bitmap", async () => {
  const bitmap = { width: 6000, height: 5000, close: vi.fn() };
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  await expect(
    normalizeUpload(new File(["x"], "image.jpg", { type: "image/jpeg" })),
  ).rejects.toThrow("2500 万像素");
  expect(bitmap.close).toHaveBeenCalledOnce();
});
