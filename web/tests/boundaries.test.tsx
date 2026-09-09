import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { AppProvider, useSnapshot } from "../src/Store";
import { AIConnect } from "../src/components/AIConnect";
import { AddSheet, ItemEditor } from "../src/components/Items";
import { Looks } from "../src/pages/Looks";
import { Recommendations } from "../src/pages/Home";
import { type AppState, today } from "../src/types";
import { fixture, shirt } from "./fixtures";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  send: vi.fn(),
  refresh: vi.fn(),
  notify: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../src/api", () => ({
  api: mocks.api,
  send: mocks.send,
  failure: (e: Error) => e.message,
  downloadBackup: vi.fn(),
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
        openPlan: vi.fn(),
        openItem: vi.fn(),
        openAdd: vi.fn(),
        openOutfit: vi.fn(),
        navigate: vi.fn(),
      }}
    >
      {children}
    </AppProvider>
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.send.mockResolvedValue({});
  mocks.refresh.mockResolvedValue(undefined);
  mocks.api.mockResolvedValue({});
  history.replaceState(null, "", "/");
});
it.each([
  { image_url: null, original_url: null },
  { image_url: "/api/images/photo.png", original_url: null },
  { image_url: null, original_url: "/api/images/original.jpg" },
])(
  "offers background removal only for a garment with a photograph: %j",
  (photos) => {
    render(
      <Harness>
        <ItemEditor item={{ ...shirt, ...photos }} onClose={mocks.close} />
      </Harness>,
    );
    const button = screen.queryByRole("button", { name: "去背景" });
    if (photos.image_url || photos.original_url) expect(button).toBeEnabled();
    else expect(button).not.toBeInTheDocument();
    expect(mocks.api).not.toHaveBeenCalled();
  },
);
it("offers a visible top skip action with no provider save", () => {
  render(
    <Harness>
      <AIConnect onFinish={mocks.close} />
    </Harness>,
  );
  expect(screen.getByRole("button", { name: "Codex" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
  expect(screen.getByRole("button", { name: "Claude Code" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "Codex" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  fireEvent.click(screen.getByRole("button", { name: "暂时跳过" }));
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.api).not.toHaveBeenCalled();
});
it("removes the one-time local entry code from the URL before sending it", async () => {
  history.replaceState(null, "", "/#open=test-entry-code");
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(path === "/state" ? fixture() : {}),
  );
  const hook = renderHook(() => useSnapshot());
  expect(location.hash).toBe("");
  await waitFor(() => expect(hook.result.current.state).not.toBeNull());
  expect(mocks.api).toHaveBeenCalledWith("/session", {
    method: "POST",
    body: JSON.stringify({ code: "test-entry-code" }),
  });
  expect(sessionStorage.length).toBe(0);
  expect(localStorage.length).toBe(0);
});
it("explains the local entry requirement if no browser session exists", async () => {
  mocks.api.mockRejectedValue(new Error("未授权"));
  const hook = renderHook(() => useSnapshot());
  await waitFor(() =>
    expect(hook.result.current.error).toBe("请从衣间启动窗口打开本机入口。"),
  );
  expect(mocks.api).toHaveBeenCalledTimes(1);
});
it("keeps AI setup open when saving fails and does not test the provider", async () => {
  mocks.send.mockRejectedValue(new Error("接口地址无效"));
  render(
    <Harness>
      <AIConnect onFinish={mocks.close} />
    </Harness>,
  );
  fireEvent.click(screen.getByRole("button", { name: "保存并开始" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("接口地址无效");
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.api).not.toHaveBeenCalled();
});
it("tests only after the explicit save-and-test action", async () => {
  mocks.api.mockResolvedValue({
    text: true,
    vision: false,
    message: "文字连接正常",
  });
  render(
    <Harness>
      <AIConnect />
    </Harness>,
  );
  fireEvent.click(screen.getByRole("button", { name: "OpenAI" }));
  fireEvent.change(screen.getByLabelText("文本模型"), {
    target: { value: "test-model" },
  });
  expect(mocks.api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存并测试连接" }));
  await waitFor(() =>
    expect(mocks.api).toHaveBeenCalledWith("/ai/test", { method: "POST" }),
  );
  expect(mocks.send.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.api.mock.invocationCallOrder[0],
  );
  expect(
    screen.getByText("文本：测试通过 · 视觉：未通过或未配置"),
  ).toBeInTheDocument();
});
it.each([true, false])(
  "sends the actual upload background-removal choice: %s",
  async (remove) => {
    mocks.api.mockResolvedValue({ items: [shirt], warnings: [] });
    const { container } = render(
      <Harness>
        <AddSheet onClose={mocks.close} />
      </Harness>,
    );
    const photo = container.querySelector(
      'input[type="file"][multiple]',
    ) as HTMLInputElement;
    fireEvent.change(photo, {
      target: {
        files: [new File(["test"], "shirt.png", { type: "image/png" })],
      },
    });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
    if (!remove) fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "添加 1 件衣物" }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalled());
    const form = mocks.api.mock.calls[0][1].body as FormData;
    expect(form.get("remove_background")).toBe(String(remove));
    expect(form.getAll("files")).toHaveLength(1);
  },
);
it("offers completed recognition without overwriting a manual draft", () => {
  const item = { ...shirt, ai_status: "processing" as const };
  const view = render(
    <Harness>
      <ItemEditor item={item} onClose={mocks.close} />
    </Harness>,
  );
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "我的手动备注名称" },
  });
  view.rerender(
    <Harness>
      <ItemEditor
        item={{
          ...item,
          name: "AI 识别名称",
          colors: ["blue"],
          seasons: ["spring"],
          ai_status: "review",
          updated_at: "2026-09-10T01:00:00Z",
        }}
        onClose={mocks.close}
      />
    </Harness>,
  );
  expect(screen.getByLabelText("名称")).toHaveValue("我的手动备注名称");
  fireEvent.click(screen.getByRole("button", { name: "填入最新识别结果" }));
  expect(screen.getByLabelText("名称")).toHaveValue("AI 识别名称");
  expect(screen.getByLabelText("颜色")).toHaveValue("蓝色");
  expect(screen.getByLabelText("适合季节")).toHaveValue("春季");
});
it("saves localized seasons as values understood by the recommendation rules", async () => {
  render(
    <Harness>
      <ItemEditor item={shirt} onClose={mocks.close} />
    </Harness>,
  );
  fireEvent.change(screen.getByLabelText("适合季节"), {
    target: { value: "春季、秋季" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "/items/top",
      expect.objectContaining({ seasons: ["spring", "autumn"] }),
      "PATCH",
    ),
  );
});
it("records a calendar plan only when the person confirms wearing it", async () => {
  const state = fixture();
  state.plans = [
    {
      id: "plan",
      name: "今天的计划",
      date: today(),
      item_ids: ["top"],
      notes: "",
      outfit_id: null,
    },
  ];
  render(
    <Harness state={state}>
      <Looks tab="calendar" />
    </Harness>,
  );
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "记录穿着" }));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "/wear",
      expect.objectContaining({
        item_ids: ["top"],
        date: today(),
        request_id: expect.any(String),
      }),
    ),
  );
});
it("keeps historical clothing names readable after garments were deleted", () => {
  const state = fixture();
  state.wear_events = [
    {
      id: "wear",
      date: today(),
      item_ids: [],
      item_names: { removed: "曾经的蓝色外套" },
      notes: "",
      created_at: "2026-09-09T00:00:00Z",
    },
  ];
  render(
    <Harness state={state}>
      <Looks tab="calendar" />
    </Harness>,
  );
  expect(screen.getByText("曾经的蓝色外套")).toBeInTheDocument();
});
it("translates missing recommendation categories into Chinese", async () => {
  mocks.send.mockResolvedValue({
    outfits: [],
    missing: ["top", "shoes"],
    message: "再添加一些衣物，就能开始搭配。",
  });
  render(
    <Harness>
      <Recommendations />
    </Harness>,
  );
  expect(await screen.findByText("上衣、鞋履")).toBeInTheDocument();
});
