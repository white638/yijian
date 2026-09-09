import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  capturePayload,
  collectVisibleImages,
  cropBounds,
  cropCandidate,
  dataBytes,
  CAPTURE_PREFIX,
} from "../../integrations/browser-capture/core.js";
import { mountPopup } from "../../integrations/browser-capture/popup.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "../../integrations/browser-capture/manifest.json";
const picture = "data:image/jpeg;base64,/9j/2Q==";
const popupHTML = readFileSync(
  resolve(process.cwd(), "../integrations/browser-capture/popup.html"),
  "utf8",
);
const page = {
  title: "商品图",
  source_url: "https://shop.example.com/goods?id=1",
  viewport: { width: 800, height: 600 },
  candidates: [{ id: "1", rect: { x: 20, y: 30, width: 300, height: 400 } }],
};
const chromeApi = {
  tabs: { query: vi.fn(), captureVisibleTab: vi.fn() },
  scripting: { executeScript: vi.fn() },
};
const clipboard = { writeText: vi.fn() };
const crop = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  chromeApi.tabs.query.mockResolvedValue([
    { id: 7, windowId: 2, url: page.source_url },
  ]);
  chromeApi.tabs.captureVisibleTab.mockResolvedValue(picture);
  chromeApi.scripting.executeScript.mockResolvedValue([{ result: page }]);
  clipboard.writeText.mockResolvedValue(undefined);
  crop.mockResolvedValue(picture);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
it("uses only the three declared permissions and has no background task", () => {
  expect(manifest.permissions).toEqual([
    "activeTab",
    "scripting",
    "clipboardWrite",
  ]);
  expect(manifest).not.toHaveProperty("background");
  expect(manifest).not.toHaveProperty("host_permissions");
});
it("collects only visible large images and strips unrelated source parameters", () => {
  vi.stubGlobal("location", {
    protocol: "https:",
    href: "https://shop.example.com/item?id=42&session=private#account",
  });
  vi.stubGlobal("innerWidth", 800);
  vi.stubGlobal("innerHeight", 600);
  document.title = "蓝色上衣";
  const add = (x, y, width, height, visible = true, covered = false) => {
    const image = document.createElement("img");
    image.style.visibility = visible ? "visible" : "hidden";
    image.style.opacity = "1";
    Object.defineProperties(image, {
      complete: { value: true },
      naturalWidth: { value: 600 },
      naturalHeight: { value: 600 },
    });
    image.getBoundingClientRect = () => ({
      x,
      y,
      left: x,
      top: y,
      right: x + width,
      bottom: y + height,
      width,
      height,
      toJSON() {},
    });
    document.body.append(image);
    return { image, rect: { x, y, width, height }, covered };
  };
  const rows = [
    add(-40, 20, 300, 400),
    add(400, 10, 40, 40),
    add(10, 700, 300, 300),
    add(420, 200, 250, 250, false),
    add(420, 20, 200, 160, true, true),
  ];
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: (x, y) => {
      const row = rows.find(
        ({ rect }) =>
          x >= rect.x &&
          x <= rect.x + rect.width &&
          y >= rect.y &&
          y <= rect.y + rect.height,
      );
      return row && !row.covered ? row.image : document.body;
    },
  });
  const result = collectVisibleImages();
  expect(result.source_url).toBe("https://shop.example.com/item?id=42");
  expect(result.candidates).toEqual([
    { id: "1", rect: { x: 0, y: 20, width: 260, height: 400 } },
  ]);
  expect(result).not.toHaveProperty("html");
});
it("scales and clamps crop boundaries to bitmap pixels", () => {
  expect(
    cropBounds(
      { x: -10, y: 10, width: 100, height: 500 },
      { width: 200, height: 100 },
      { width: 400, height: 200 },
    ),
  ).toEqual({ x: 0, y: 20, width: 180, height: 180 });
  expect(() =>
    cropBounds(
      { x: 300, y: 0, width: 10, height: 10 },
      { width: 200, height: 100 },
      { width: 400, height: 200 },
    ),
  ).toThrow();
  expect(() =>
    cropBounds(
      { x: NaN, y: 0, width: 10, height: 10 },
      { width: 200, height: 100 },
      { width: 400, height: 200 },
    ),
  ).toThrow();
});

it("preserves Dewu product and variant identifiers while excluding share and session parameters", () => {
  vi.stubGlobal("location", {
    protocol: "https:",
    href: "https://www.dewu.com/product-detail.html?sourceName=share&spuId=10001&propertyValueId=20002&skuId=30003&session=example&token=example&spuid=40004#share",
  });
  const result = collectVisibleImages();
  const copied = JSON.parse(
    capturePayload(result, picture).slice(CAPTURE_PREFIX.length),
  );
  const source = new URL(copied.source_url);
  expect(source.origin + source.pathname).toBe(
    "https://www.dewu.com/product-detail.html",
  );
  expect(Object.fromEntries(source.searchParams)).toEqual({
    spuId: "10001",
    propertyValueId: "20002",
    skuId: "30003",
  });
  expect(source.hash).toBe("");
});
it("draws only the selected rectangle and bounds the output resolution", async () => {
  class FakeImage {
    naturalWidth = 3200;
    naturalHeight = 1800;
    onload = null;
    set src(_value) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", FakeImage);
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
    function (type) {
      expect(type).toBe("image/jpeg");
      expect(Math.max(this.width, this.height)).toBeLessThanOrEqual(1280);
      return picture;
    },
  );
  await expect(
    cropCandidate(
      picture,
      { x: 100, y: 50, width: 1400, height: 800 },
      { width: 1600, height: 900 },
    ),
  ).resolves.toBe(picture);
  expect(drawImage).toHaveBeenCalledWith(
    expect.any(FakeImage),
    200,
    100,
    2800,
    1600,
    0,
    0,
    1280,
    731,
  );
});
it("captures and copies only after separate user actions and a selection", async () => {
  document.body.innerHTML = new DOMParser().parseFromString(
    popupHTML,
    "text/html",
  ).body.innerHTML;
  mountPopup({ chromeApi, root: document, clipboard, crop });
  expect(chromeApi.tabs.query).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "采集当前可见图片" }));
  const radio = await screen.findByRole("radio", { name: "图片 1" });
  expect(chromeApi.scripting.executeScript).toHaveBeenCalledWith(
    expect.objectContaining({ world: "ISOLATED" }),
  );
  expect(chromeApi.tabs.captureVisibleTab).toHaveBeenCalledWith(2, {
    format: "jpeg",
    quality: 80,
  });
  expect(screen.getByRole("button", { name: "复制到衣间" })).toBeDisabled();
  expect(clipboard.writeText).not.toHaveBeenCalled();
  fireEvent.click(radio);
  fireEvent.click(screen.getByRole("button", { name: "复制到衣间" }));
  await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1));
  const payload = clipboard.writeText.mock.calls[0][0];
  expect(payload.startsWith(CAPTURE_PREFIX)).toBe(true);
  expect(JSON.parse(payload.slice(CAPTURE_PREFIX.length))).toEqual({
    version: 1,
    title: page.title,
    source_url: page.source_url,
    image: picture,
  });
  expect(screen.getByRole("status")).toHaveTextContent("已复制");
});
it("rejects non-HTTP tabs before reading or capturing their content", async () => {
  chromeApi.tabs.query.mockResolvedValue([
    { id: 7, windowId: 2, url: "chrome://settings" },
  ]);
  document.body.innerHTML = new DOMParser().parseFromString(
    popupHTML,
    "text/html",
  ).body.innerHTML;
  mountPopup({ chromeApi, root: document, clipboard, crop });
  fireEvent.click(screen.getByRole("button", { name: "采集当前可见图片" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("浏览器设置页无法采集"),
  );
  expect(chromeApi.scripting.executeScript).not.toHaveBeenCalled();
  expect(chromeApi.tabs.captureVisibleTab).not.toHaveBeenCalled();
});
it("rejects oversized selected image payloads", () => {
  expect(dataBytes(picture)).toBe(4);
  expect(() =>
    capturePayload(
      page,
      "data:image/jpeg;base64," + "A".repeat(3 * 1024 * 1024),
    ),
  ).toThrow(/过大/);
});
