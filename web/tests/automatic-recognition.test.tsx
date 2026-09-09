import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import App from "../src/App";
import { AppProvider } from "../src/Store";
import { AddSheet, ItemEditor } from "../src/components/Items";
import type { AppState, Item } from "../src/types";
import { fixture, shirt } from "./fixtures";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  send: vi.fn(),
  refresh: vi.fn(),
  notify: vi.fn(),
  close: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock("../src/api", () => ({
  api: mocks.api,
  send: mocks.send,
  failure: (error: Error) => error.message,
  downloadBackup: vi.fn(),
}));
vi.mock("../src/Store", async () => ({
  ...(await vi.importActual<typeof import("../src/Store")>("../src/Store")),
  useSnapshot: mocks.snapshot,
}));
function Harness({
  children,
  state = fixture(),
}: {
  children: ReactNode;
  state?: AppState;
}) {
  return (
    <AppProvider
      value={{
        state,
        refresh: mocks.refresh,
        notify: mocks.notify,
        openItem: vi.fn(),
        openAdd: vi.fn(),
        openOutfit: vi.fn(),
        openPlan: vi.fn(),
        navigate: vi.fn(),
      }}
    >
      {children}
    </AppProvider>
  );
}
const recognized = (): Item => ({
  ...shirt,
  name: "浅蓝色短袖衬衫",
  category: "outerwear",
  colors: ["blue"],
  brand: "可见品牌",
  seasons: ["spring", "summer"],
  occasions: ["casual", "work"],
  tags: ["短袖", "宽松"],
  ai_status: "review",
  updated_at: "2026-09-09T19:00:00Z",
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue({});
  mocks.api.mockResolvedValue({ items: [shirt], warnings: [] });
});
afterEach(() => vi.useRealTimers());

const visionProviders = ["openai", "compatible", "ollama", "codex"] as const;
it.each(
  visionProviders.flatMap((provider) =>
    [true, false].map((automatic) => ({ provider, automatic })),
  ),
)(
  "submits $provider upload recognition choice: $automatic",
  async ({ provider, automatic }) => {
    const state = fixture();
    state.ai = {
      ...state.ai,
      provider,
      capabilities: { vision: true, text: false },
    };
    const view = render(
      <Harness state={state}>
        <AddSheet onClose={mocks.close} />
      </Harness>,
    );
    fireEvent.change(
      view.container.querySelector('input[type="file"][multiple]')!,
      {
        target: {
          files: [new File(["photo"], "shirt.png", { type: "image/png" })],
        },
      },
    );
    const toggle = screen.getByRole("checkbox", {
      name: /上传后自动识别衣物信息/,
    });
    expect(toggle).toBeChecked();
    expect(
      screen.getByText(
        provider === "codex"
          ? /使用已连接的 Codex 识别，消耗当前账号额度/
          : /使用已配置的视觉模型识别照片/,
      ),
    ).toBeInTheDocument();
    if (!automatic) fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "添加 1 件衣物" }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalled());
    const form = mocks.api.mock.calls[0][1].body as FormData;
    expect(form.get("auto_analyze")).toBe(String(automatic));
    expect(form.get("remove_background")).toBe("true");
    expect(
      mocks.api.mock.calls.some(([path]) => path.startsWith("/ai/analyze")),
    ).toBe(false);
  },
);

it.each(["codex", "claude-code", "ollama"] as const)(
  "explains unavailable automatic recognition in %s mode",
  (provider) => {
    const state = fixture();
    state.ai.provider = provider;
    state.ai.automatic_vision = {
      supported: provider === "codex",
      enabled: false,
      ready: false,
      reason: "请先开启 Codex 上传自动识别。",
    };
    render(
      <Harness state={state}>
        <AddSheet onClose={mocks.close} />
      </Harness>,
    );
    expect(
      screen.queryByRole("checkbox", { name: /上传后自动识别衣物信息/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        provider === "codex"
          ? "请先开启 Codex 上传自动识别。"
          : provider === "ollama"
            ? /请在 AI 连接中为 Ollama 配置支持图片的视觉模型/
            : /Claude Code 模式需要在助手中使用衣间技能识别照片/,
      ),
    ).toBeInTheDocument();
    expect(mocks.api).not.toHaveBeenCalled();
  },
);

it.each(visionProviders)(
  "fills all %s recognized fields as soon as the result arrives, without saving automatically",
  (provider) => {
    const state = fixture();
    state.ai.provider = provider;
    state.ai.capabilities.vision = true;
    const view = render(
      <Harness state={state}>
        <ItemEditor
          item={{ ...shirt, ai_status: "processing" }}
          onClose={mocks.close}
        />
      </Harness>,
    );
    view.rerender(
      <Harness state={state}>
        <ItemEditor item={recognized()} onClose={mocks.close} />
      </Harness>,
    );
    for (const [label, value] of [
      ["名称", "浅蓝色短袖衬衫"],
      ["类别", "outerwear"],
      ["颜色", "蓝色"],
      ["品牌", "可见品牌"],
      ["适合季节", "春季、夏季"],
      ["适合场合", "日常、工作"],
      ["衣物标签", "短袖、宽松"],
    ])
      expect(screen.getByLabelText(label)).toHaveValue(value);
    expect(
      screen.getByText("识别信息已自动填入，请核对后保存。"),
    ).toBeInTheDocument();
    expect(mocks.send).not.toHaveBeenCalled();
  },
);

it.each([
  ["名称", "手动名称"],
  ["类别", "dress"],
  ["颜色", "手动颜色"],
  ["品牌", "手动品牌"],
  ["适合季节", "冬季"],
  ["适合场合", "正式"],
  ["衣物标签", "我的标签"],
])(
  "preserves a manually edited %s when recognition completes",
  (label, value) => {
    const view = render(
      <Harness>
        <ItemEditor
          item={{ ...shirt, ai_status: "processing" }}
          onClose={mocks.close}
        />
      </Harness>,
    );
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    view.rerender(
      <Harness>
        <ItemEditor item={recognized()} onClose={mocks.close} />
      </Harness>,
    );
    expect(screen.getByLabelText(label)).toHaveValue(value);
    expect(
      screen.getByText("识别结果已填入未修改的字段，你手动编辑的信息已保留。"),
    ).toBeInTheDocument();
  },
);

it("saves recognized occasions and tags together with the confirmed garment", async () => {
  render(
    <Harness>
      <ItemEditor item={recognized()} onClose={mocks.close} />
    </Harness>,
  );
  fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "/items/top",
      expect.objectContaining({
        name: "浅蓝色短袖衬衫",
        seasons: ["spring", "summer"],
        occasions: ["casual", "work"],
        tags: ["短袖", "宽松"],
        confirmed: true,
        price: "120.00",
        currency: null,
      }),
      "PATCH",
    ),
  );
});

it("shows the model failure reason while preserving the user's draft and allowing retry", () => {
  const state = fixture();
  state.ai.provider = "ollama";
  state.ai.capabilities.vision = true;
  const item: Item = {
    ...shirt,
    image_url: "/media/shirt.png",
    ai_status: "processing",
  };
  const view = render(
    <Harness state={state}>
      <ItemEditor item={item} onClose={mocks.close} />
    </Harness>,
  );
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "我的衬衫" },
  });
  view.rerender(
    <Harness state={state}>
      <ItemEditor
        item={{
          ...item,
          ai_status: "error",
          ai_error: "当前模型不支持图片，请换用视觉模型。",
        }}
        onClose={mocks.close}
      />
    </Harness>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "当前模型不支持图片，请换用视觉模型。",
  );
  expect(screen.getByLabelText("名称")).toHaveValue("我的衬衫");
  expect(screen.getByRole("button", { name: "重新识别" })).toBeEnabled();
});

it("stops polling after processing completes even if the garment still needs confirmation", async () => {
  vi.useFakeTimers();
  const state = fixture();
  state.ai.capabilities.vision = true;
  state.items = [{ ...shirt, confirmed: false, ai_status: "processing" }];
  mocks.snapshot.mockReturnValue({ state, refresh: mocks.refresh, error: "" });
  const view = render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  mocks.snapshot.mockReturnValue({
    state: { ...state, items: [{ ...state.items[0], ai_status: "review" }] },
    refresh: mocks.refresh,
    error: "",
  });
  view.rerender(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16000);
  });
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});
