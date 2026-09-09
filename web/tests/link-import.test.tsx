import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppProvider } from "../src/Store";
import { AddSheet } from "../src/components/Items";
import { LinkImport } from "../src/components/LinkImport";
import { fixture, shirt } from "./fixtures";
import { CAPTURE_PREFIX, parseCapture } from "../src/capture";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  refresh: vi.fn(),
  notify: vi.fn(),
  close: vi.fn(),
  back: vi.fn(),
  openItem: vi.fn(),
  readText: vi.fn(),
}));
vi.mock("../src/api", () => ({
  api: vi.fn(),
  send: mocks.send,
  failure: (error: Error) => error.message,
}));
const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
const preview = {
  preview_id: "preview-one",
  title: "棉质短袖衬衫",
  source_url: "https://shop.example.com/products/shirt",
  images: [
    { id: "front", url: "https://images.example.com/front.jpg" },
    { id: "back", url: "https://images.example.com/back.jpg" },
  ],
};
const captured = {
  version: 1,
  title: "蓝色短袖",
  source_url: "https://item.example.com/product/1",
  image: "data:image/jpeg;base64,/9j/2Q==",
};
function renderImporter({ addSheet = false, vision = true } = {}) {
  const state = fixture();
  state.ai.provider = "codex";
  state.ai.capabilities.vision = vision;
  return render(
    <AppProvider
      value={{
        state,
        refresh: mocks.refresh,
        notify: mocks.notify,
        openItem: mocks.openItem,
        openAdd: vi.fn(),
        openOutfit: vi.fn(),
        openPlan: vi.fn(),
        navigate: vi.fn(),
      }}
    >
      {addSheet ? (
        <AddSheet onClose={mocks.close} />
      ) : (
        <LinkImport onClose={mocks.close} onBack={mocks.back} />
      )}
    </AppProvider>,
  );
}
async function parse() {
  fireEvent.change(screen.getByLabelText("商品页或图片链接"), {
    target: { value: "推荐这件衬衫 https://shop.example.com/products/shirt" },
  });
  fireEvent.click(screen.getByRole("button", { name: "解析链接" }));
  await screen.findByRole("group", { name: "选择一张衣物照片" });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockResolvedValue(undefined);
  mocks.readText.mockResolvedValue("https://shop.example.com/products/shirt");
  mocks.send.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/import/preview" ? preview : { items: [shirt], warnings: [] },
    ),
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: mocks.readText },
  });
});
afterEach(() => {
  if (originalClipboard)
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

it("opens link import from the add sheet and can return to photo upload", () => {
  renderImporter({ addSheet: true });
  fireEvent.click(screen.getByRole("button", { name: /手动记录衣物/ }));
  fireEvent.click(screen.getByRole("button", { name: /从链接导入/ }));
  expect(
    screen.getByRole("dialog", { name: "从链接导入" }),
  ).toBeInTheDocument();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.readText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "返回相册上传" }));
  expect(screen.getByRole("dialog", { name: "添加衣物" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /从相册选择/ }),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("衣物名称")).not.toBeInTheDocument();
});

it.each([true, false])(
  "parses, selects a single proxied picture, and imports with automatic options %s",
  async (automatic) => {
    const view = renderImporter();
    await parse();
    expect(mocks.send).toHaveBeenCalledWith("/import/preview", {
      text: "推荐这件衬衫 https://shop.example.com/products/shirt",
    });
    expect(
      screen.getByRole("heading", { name: preview.title }),
    ).toBeInTheDocument();
    expect(
      [...view.container.querySelectorAll("img")].map((image) =>
        image.getAttribute("src"),
      ),
    ).toEqual([
      "/api/import/preview/preview-one/images/front",
      "/api/import/preview/preview-one/images/back",
    ]);
    expect(screen.getByRole("button", { name: "导入这张照片" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "图片 2" }));
    expect(screen.getByRole("radio", { name: "图片 1" })).not.toBeChecked();
    const recognition = screen.getByRole("checkbox", {
      name: /导入后自动识别衣物信息/,
    });
    const background = screen.getByRole("checkbox", {
      name: /自动去除照片背景/,
    });
    expect(recognition).toBeChecked();
    expect(background).toBeChecked();
    if (!automatic) {
      fireEvent.click(recognition);
      fireEvent.click(background);
    }
    fireEvent.click(screen.getByRole("button", { name: "导入这张照片" }));
    await waitFor(() => expect(mocks.openItem).toHaveBeenCalledWith(shirt.id));
    expect(mocks.send).toHaveBeenLastCalledWith("/import/items", {
      preview_id: "preview-one",
      image_id: "back",
      remove_background: automatic,
      auto_analyze: automatic,
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  },
);

it("reads the clipboard only after a click, without automatically parsing its contents", async () => {
  renderImporter();
  expect(mocks.readText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
  await waitFor(() =>
    expect(screen.getByLabelText("商品页或图片链接")).toHaveValue(
      "https://shop.example.com/products/shirt",
    ),
  );
  expect(mocks.send).not.toHaveBeenCalled();
});

it("offers manual paste when clipboard permission is denied", async () => {
  mocks.readText.mockRejectedValue(new Error("NotAllowedError"));
  renderImporter();
  fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "无法读取剪贴板，请在输入框中手动粘贴链接。",
  );
  expect(screen.getByLabelText("商品页或图片链接")).toBeEnabled();
  expect(mocks.send).not.toHaveBeenCalled();
});

it("explains a restricted page and keeps the photo-upload fallback available", async () => {
  mocks.send.mockRejectedValue(
    new Error("该页面需要登录或限制访问，请保存商品图片或截图后上传。"),
  );
  renderImporter();
  fireEvent.change(screen.getByLabelText("商品页或图片链接"), {
    target: { value: "https://shop.example.com/private" },
  });
  fireEvent.click(screen.getByRole("button", { name: "解析链接" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "该页面需要登录或限制访问",
  );
  expect(
    screen.queryByRole("button", { name: "导入这张照片" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "返回相册上传" }));
  expect(mocks.back).toHaveBeenCalledTimes(1);
});

it("clears the previous selection when the link text changes", async () => {
  renderImporter();
  await parse();
  fireEvent.click(screen.getByRole("radio", { name: "图片 1" }));
  fireEvent.change(screen.getByLabelText("商品页或图片链接"), {
    target: { value: "https://shop.example.com/another" },
  });
  expect(
    screen.queryByRole("group", { name: "选择一张衣物照片" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "导入这张照片" }),
  ).not.toBeInTheDocument();
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

it("prevents importing a preview picture that fails to load", async () => {
  const view = renderImporter();
  await parse();
  fireEvent.click(screen.getByRole("radio", { name: "图片 1" }));
  fireEvent.error(view.container.querySelector("img")!);
  expect(
    screen.getByRole("radio", { name: /图片无法加载\s+图片 1/ }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "导入这张照片" })).toBeDisabled();
  fireEvent.click(screen.getByRole("radio", { name: "图片 2" }));
  expect(screen.getByRole("button", { name: "导入这张照片" })).toBeEnabled();
});

it("shows an empty-image result without enabling import", async () => {
  mocks.send.mockResolvedValue({ ...preview, images: [] });
  renderImporter();
  fireEvent.change(screen.getByLabelText("商品页或图片链接"), {
    target: { value: "https://shop.example.com/empty" },
  });
  fireEvent.click(screen.getByRole("button", { name: "解析链接" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "这个页面没有找到可用图片",
  );
  expect(
    screen.queryByRole("button", { name: "导入这张照片" }),
  ).not.toBeInTheDocument();
});

it("prevents duplicate import while processing and reports an expired preview", async () => {
  renderImporter();
  await parse();
  let rejectImport!: (error: Error) => void;
  mocks.send.mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejectImport = reject;
      }),
  );
  fireEvent.click(screen.getByRole("radio", { name: "图片 1" }));
  const button = screen.getByRole("button", { name: "导入这张照片" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(button).toBeDisabled();
  await act(async () =>
    rejectImport(new Error("预览已过期，请重新解析链接。")),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "预览已过期，请重新解析链接。",
  );
  expect(screen.getByRole("button", { name: "解析链接" })).toBeEnabled();
  expect(mocks.openItem).not.toHaveBeenCalled();
});

it("imports without a vision model and preserves nonfatal processing warnings", async () => {
  renderImporter({ vision: false });
  await parse();
  expect(
    screen.queryByRole("checkbox", { name: /导入后自动识别衣物信息/ }),
  ).not.toBeInTheDocument();
  mocks.send.mockResolvedValue({
    items: [shirt],
    warnings: ["去背景未完成，已保留原图。"],
  });
  fireEvent.click(screen.getByRole("radio", { name: "图片 1" }));
  fireEvent.click(screen.getByRole("button", { name: "导入这张照片" }));
  await waitFor(() => expect(mocks.openItem).toHaveBeenCalledWith(shirt.id));
  expect(mocks.notify).toHaveBeenCalledWith(
    "去背景未完成，已保留原图。",
    "info",
  );
});

it.each(["button", "paste"])(
  "accepts a browser capture through %s without exposing image encoding or submitting automatically",
  async (method) => {
    const payload = CAPTURE_PREFIX + JSON.stringify(captured);
    mocks.readText.mockResolvedValue(payload);
    mocks.send.mockResolvedValue(preview);
    renderImporter();
    if (method === "button") {
      fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
    } else {
      fireEvent.paste(screen.getByLabelText("商品页或图片链接"), {
        clipboardData: { getData: () => payload },
      });
    }
    await screen.findByText("已接收 1 张采集图片，点击“解析链接”查看预览。");
    expect(screen.getByLabelText("商品页或图片链接")).toHaveValue("");
    expect(document.body.textContent).not.toContain("data:image/jpeg");
    expect(screen.getByText("来源：item.example.com")).toBeInTheDocument();
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "解析链接" }));
    await screen.findByRole("group", { name: "选择一张衣物照片" });
    expect(mocks.send).toHaveBeenCalledWith("/import/capture", captured);
    mocks.send.mockResolvedValue({ items: [shirt], warnings: [] });
    fireEvent.click(screen.getByRole("radio", { name: "图片 1" }));
    fireEvent.click(screen.getByRole("button", { name: "导入这张照片" }));
    await waitFor(() => expect(mocks.openItem).toHaveBeenCalledWith(shirt.id));
  },
);

it("clears captured data when a normal link replaces it", async () => {
  renderImporter();
  fireEvent.paste(screen.getByLabelText("商品页或图片链接"), {
    clipboardData: { getData: () => CAPTURE_PREFIX + JSON.stringify(captured) },
  });
  fireEvent.change(screen.getByLabelText("商品页或图片链接"), {
    target: { value: "https://shop.example.com/shirt" },
  });
  expect(screen.queryByText(/已接收 1 张采集图片/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "解析链接" }));
  await screen.findByRole("group", { name: "选择一张衣物照片" });
  expect(mocks.send).toHaveBeenCalledWith("/import/preview", {
    text: "https://shop.example.com/shirt",
  });
});

it.each([
  ["version", "YIJIAN_CAPTURE_V2\n{}"],
  ["invalid JSON", CAPTURE_PREFIX + "not json"],
  [
    "private protocol",
    CAPTURE_PREFIX +
      JSON.stringify({ ...captured, source_url: "file:///private" }),
  ],
  [
    "HTML image",
    CAPTURE_PREFIX +
      JSON.stringify({
        ...captured,
        image: "data:text/html;base64,PHNjcmlwdD4=",
      }),
  ],
  ["oversize", CAPTURE_PREFIX + "x".repeat(4 * 1024 * 1024)],
])("rejects %s capture data before sending it", (_kind, value) => {
  expect(() => parseCapture(value)).toThrow();
  renderImporter();
  fireEvent.paste(screen.getByLabelText("商品页或图片链接"), {
    clipboardData: { getData: () => value },
  });
  expect(screen.getByRole("alert")).toHaveTextContent(/采集/);
  expect(screen.getByRole("button", { name: "解析链接" })).toBeDisabled();
  expect(mocks.send).not.toHaveBeenCalled();
});

it.each(["jpeg", "png", "webp"])(
  "accepts the backend's %s capture image format",
  (format) => {
    const data = { ...captured, image: `data:image/${format};base64,AAAA` };
    expect(parseCapture(CAPTURE_PREFIX + JSON.stringify(data))).toEqual(data);
  },
);

it.each(["页面售价", "起售价", "发售价格"])(
  "shows a parsed %s as a reference price",
  async (label) => {
    mocks.send.mockResolvedValue({
      ...preview,
      reference_price: {
        amount: 198.5,
        currency: "CNY",
        label,
        source_url: preview.source_url,
        observed_at: "2026-09-09T12:00:00Z",
      },
    });
    renderImporter();
    await parse();
    const reference = screen.getByRole("complementary", { name: "参考价格" });
    expect(reference).toHaveTextContent(`参考价 · ${label}`);
    expect(reference).toHaveTextContent("198.50");
    expect(reference).toHaveTextContent(
      label === "发售价格"
        ? "仅供参考，不代表实际支付金额。"
        : "价格随款式与活动变化。",
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
  },
);

it("omits reference-price UI when no verifiable price was returned", async () => {
  mocks.send.mockResolvedValue({ ...preview, reference_price: null });
  renderImporter();
  await parse();
  expect(
    screen.queryByRole("complementary", { name: "参考价格" }),
  ).not.toBeInTheDocument();
});
