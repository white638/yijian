import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { AppProvider } from "../src/Store";
import { ImageBeautySettings } from "../src/components/ImageBeautySettings";
import { ImageBeautyDialog } from "../src/components/ImageBeautyDialog";
import { ItemEditor } from "../src/components/Items";
import type { ImageBeautyJob, ImageBeautySettingsValue } from "../src/beautify";
import { fixture, shirt } from "./fixtures";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  send: vi.fn(),
  refresh: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("../src/api", () => ({
  api: mocks.api,
  send: mocks.send,
  failure: (error: Error) => error.message,
}));
const photo = {
  ...shirt,
  image_url: "/api/media/current.jpg",
  original_url: "/api/media/original.jpg",
};
const defaults: ImageBeautySettingsValue = {
  enabled: false,
  provider: "api",
  base_url: "https://api.openai.com/v1",
  model: "gpt-image-2",
  has_key: false,
  ready: false,
  reason: "请启用图片美化。",
};
const configured = {
  ...defaults,
  enabled: true,
  has_key: true,
  ready: true,
  reason: "",
};
const idle: ImageBeautyJob = {
  status: "idle",
  source_url: photo.original_url,
  preview_url: null,
  applied: false,
};
const completed: ImageBeautyJob = {
  ...idle,
  status: "completed",
  provider: "api",
  job_id: "job-one",
  preview_url: "/api/media/beautified.jpg",
};
let settings: ImageBeautySettingsValue;
let view: ImageBeautyJob;
function context(children: ReactNode) {
  return (
    <AppProvider
      value={{
        state: fixture(),
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
function mutations() {
  return mocks.api.mock.calls.filter(
    ([, options]) => options?.method === "POST",
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  settings = { ...configured };
  view = { ...idle };
  mocks.refresh.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(configured);
  mocks.api.mockImplementation(async (path: string) =>
    path === "/beautify/settings" ? settings : view,
  );
});
afterEach(() => {
  vi.useRealTimers();
});

it("loads default-off image settings without generating or changing recognition settings", async () => {
  settings = { ...defaults };
  render(<ImageBeautySettings />);
  expect(await screen.findByLabelText(/启用图片美化/)).not.toBeChecked();
  expect(screen.getByLabelText("图片模型接口地址")).toHaveValue(
    defaults.base_url,
  );
  expect(screen.getByLabelText("图片模型")).toHaveValue("gpt-image-2");
  expect(
    screen.getByRole("option", { name: "GPT Image 2.5 Flare" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("option", { name: "GPT Image 2.5 Sunburst" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Ollama" }),
  ).not.toBeInTheDocument();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mutations()).toHaveLength(0);
});

it("saves the selected image model and write-only key only on submit and clears the key afterward", async () => {
  render(<ImageBeautySettings initial={defaults} />);
  fireEvent.click(screen.getByLabelText(/启用图片美化/));
  fireEvent.change(screen.getByLabelText("图片模型"), {
    target: { value: "gpt-image-2.5-flare" },
  });
  const key = screen.getByLabelText("图片接口密钥");
  expect(key).toHaveAttribute("type", "password");
  expect(key).toHaveAttribute("autocomplete", "off");
  fireEvent.change(key, { target: { value: "example-user-key" } });
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存美化设置" }));
  await waitFor(() => expect(key).toHaveValue(""));
  expect(mocks.send).toHaveBeenCalledWith(
    "/beautify/settings",
    {
      enabled: true,
      provider: "api",
      base_url: defaults.base_url,
      model: "gpt-image-2.5-flare",
      api_key: "example-user-key",
    },
    "PUT",
  );
  expect(JSON.stringify(localStorage)).not.toContain("example-user-key");
  expect(JSON.stringify(sessionStorage)).not.toContain("example-user-key");
});

it("retains a saved key by omission and requires a new key for a changed endpoint", async () => {
  render(<ImageBeautySettings initial={configured} />);
  fireEvent.change(screen.getByLabelText("图片模型"), {
    target: { value: "custom" },
  });
  fireEvent.change(screen.getByLabelText("自定义图片模型名称"), {
    target: { value: "my-image-editor" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存美化设置" }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  expect(mocks.send.mock.calls[0][1]).toMatchObject({
    model: "my-image-editor",
  });
  expect(mocks.send.mock.calls[0][1]).not.toHaveProperty("api_key");
  fireEvent.change(screen.getByLabelText("图片模型接口地址"), {
    target: { value: "https://images.example.com/v1" },
  });
  expect(screen.getByLabelText("图片接口密钥")).toBeRequired();
  expect(
    screen.getByText("接口地址已变更，需要填写新接口的密钥。"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "保存美化设置" }));
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

it("supports explicitly clearing the image credential with the feature disabled", async () => {
  render(<ImageBeautySettings initial={configured} />);
  fireEvent.click(screen.getByLabelText(/启用图片美化/));
  fireEvent.click(screen.getByLabelText("清除已保存的图片接口密钥"));
  fireEvent.click(screen.getByRole("button", { name: "保存美化设置" }));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "/beautify/settings",
      expect.objectContaining({ enabled: false, clear_key: true }),
      "PUT",
    ),
  );
});

it("Codex settings discard the API draft and point to the existing connection", async () => {
  const openAI = vi.fn();
  render(<ImageBeautySettings initial={configured} onOpenAI={openAI} />);
  fireEvent.change(screen.getByLabelText("图片接口密钥"), {
    target: { value: "unsaved-api-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Codex" }));
  expect(screen.getByRole("button", { name: "Codex" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.queryByLabelText("图片模型")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看 Codex 连接设置" }));
  expect(openAI).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "保存美化设置" }));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "/beautify/settings",
      { enabled: true, provider: "codex", base_url: "", model: "" },
      "PUT",
    ),
  );
});

it("keeps an unsaved image API key available to retry after a settings error", async () => {
  mocks.send.mockRejectedValueOnce(new Error("图片接口地址不可用。"));
  render(<ImageBeautySettings initial={defaults} />);
  fireEvent.click(screen.getByLabelText(/启用图片美化/));
  fireEvent.change(screen.getByLabelText("图片接口密钥"), {
    target: { value: "retry-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存美化设置" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "图片接口地址不可用。",
  );
  expect(screen.getByLabelText("图片接口密钥")).toHaveValue("retry-key");
  expect(screen.getByRole("button", { name: "保存美化设置" })).toBeEnabled();
});

it("opening the photo dialog only reads settings and allows original/current comparison", async () => {
  render(context(<ImageBeautyDialog item={photo} onClose={vi.fn()} />));
  await screen.findByRole("button", { name: "生成美化预览" });
  expect(screen.getByRole("img", { name: "处理前照片" })).toHaveAttribute(
    "src",
    photo.original_url,
  );
  fireEvent.change(screen.getByLabelText("对比照片"), {
    target: { value: "current" },
  });
  expect(screen.getByRole("img", { name: "当前照片" })).toHaveAttribute(
    "src",
    photo.image_url,
  );
  expect(mutations()).toHaveLength(0);
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it("generates only on click, blocks duplicate creation and applies only after preview approval", async () => {
  const creation = deferred<ImageBeautyJob>();
  mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
    if (options?.method === "POST")
      return path.endsWith("/apply")
        ? { ...completed, applied: true }
        : creation.promise;
    return path === "/beautify/settings" ? settings : view;
  });
  render(context(<ImageBeautyDialog item={photo} onClose={vi.fn()} />));
  const generate = await screen.findByRole("button", { name: "生成美化预览" });
  fireEvent.click(generate);
  fireEvent.click(generate);
  expect(generate).toBeDisabled();
  expect(screen.getByText("正在创建美化任务…")).toBeInTheDocument();
  expect(mutations()).toHaveLength(1);
  await act(async () => creation.resolve(completed));
  expect(screen.getByRole("img", { name: "美化预览" })).toHaveAttribute(
    "src",
    completed.preview_url,
  );
  expect(mutations()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "采用美化图" }));
  await screen.findByText("已采用这张美化图。");
  expect(mutations().map(([path]) => path)).toEqual([
    "/beautify/items/top",
    "/beautify/items/top/apply",
  ]);
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
});

it("polls pending API work sequentially, stops when finished and never applies automatically", async () => {
  vi.useFakeTimers();
  view = { ...idle, job_id: "queued", status: "processing", provider: "api" };
  const result = deferred<ImageBeautyJob>();
  await act(async () => {
    render(context(<ImageBeautyDialog item={photo} onClose={vi.fn()} />));
  });
  expect(screen.getByText("正在处理美化图片…")).toBeInTheDocument();
  mocks.api.mockImplementation(() => result.promise);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(
    mocks.api.mock.calls.filter(([path]) => path === "/beautify/items/top"),
  ).toHaveLength(2);
  await act(async () => result.resolve(completed));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(
    mocks.api.mock.calls.filter(([path]) => path === "/beautify/items/top"),
  ).toHaveLength(2);
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "采用美化图" }),
  ).toBeInTheDocument();
  expect(mutations()).toHaveLength(0);
});

it("cancel rejects a stale pending read and leaves the photo unchanged", async () => {
  vi.useFakeTimers();
  view = { ...idle, job_id: "pending", status: "processing", provider: "api" };
  const read = deferred<ImageBeautyJob>();
  await act(async () => {
    render(context(<ImageBeautyDialog item={photo} onClose={vi.fn()} />));
  });
  mocks.api.mockImplementation((path: string) =>
    path.endsWith("/cancel")
      ? Promise.resolve({ ...idle, status: "cancelled" })
      : read.promise,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  const signal = mocks.api.mock.calls.at(-1)?.[1].signal as AbortSignal;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
  });
  expect(signal.aborted).toBe(true);
  await act(async () => read.resolve(completed));
  expect(
    screen.getByText("美化任务已取消，照片保持不变。"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "采用美化图" }),
  ).not.toBeInTheDocument();
  expect(mutations()).toHaveLength(1);
});

it("aborts an in-flight poll when the dialog unmounts", async () => {
  vi.useFakeTimers();
  view = { ...idle, job_id: "pending", status: "queued", provider: "api" };
  let mounted!: ReturnType<typeof render>;
  await act(async () => {
    mounted = render(
      context(<ImageBeautyDialog item={photo} onClose={vi.fn()} />),
    );
  });
  const read = deferred<ImageBeautyJob>();
  mocks.api.mockImplementation(() => read.promise);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  const signal = mocks.api.mock.calls.at(-1)?.[1].signal as AbortSignal;
  mounted.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => read.resolve(completed));
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it("Codex queue waits for an explicit copied skill request and does not claim it is generating", async () => {
  settings = {
    ...configured,
    provider: "codex",
    base_url: "",
    model: "",
    has_key: false,
  };
  view = { ...idle, provider: "codex", status: "queued", job_id: "codex-job" };
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(context(<ImageBeautyDialog item={photo} onClose={vi.fn()} />));
  expect(await screen.findByText("待 Codex 处理")).toBeInTheDocument();
  expect(screen.queryByText("正在处理美化图片…")).not.toBeInTheDocument();
  expect(writeText).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "复制给 Codex 的处理请求" }),
  );
  await screen.findByRole("button", { name: "已复制处理请求" });
  expect(writeText).toHaveBeenCalledWith(
    "使用衣间技能处理待处理的图片美化任务。",
  );
  expect(mutations()).toHaveLength(0);
});

it("surfaces failed generation and permits adopting an earlier valid preview without regeneration", async () => {
  view = { ...completed, status: "failed", error: "图片服务额度不足。" };
  render(context(<ImageBeautyDialog item={photo} onClose={vi.fn()} />));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "图片服务额度不足。",
  );
  expect(screen.getByRole("button", { name: "采用美化图" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "重新生成预览" })).toBeEnabled();
  expect(mutations()).toHaveLength(0);
});

it("restore keeps the generated preview available for adoption without a new model call", async () => {
  view = { ...completed, applied: true };
  mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === "/beautify/settings") return settings;
    if (path === "/items/top/restore" && options?.method === "POST") {
      view = { ...completed, applied: false };
      return photo;
    }
    return view;
  });
  render(
    context(
      <ImageBeautyDialog
        item={{ ...photo, beautified_url: completed.preview_url }}
        onClose={vi.fn()}
      />,
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: "恢复原图" }));
  await screen.findByRole("button", { name: "采用美化图" });
  expect(screen.getByRole("img", { name: "美化预览" })).toBeInTheDocument();
  expect(mutations().map(([path]) => path)).toEqual(["/items/top/restore"]);
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it("disabled configuration offers setup inside the dialog without starting a task", async () => {
  settings = { ...defaults };
  render(context(<ImageBeautyDialog item={photo} onClose={vi.fn()} />));
  expect(
    await screen.findByRole("button", { name: "生成美化预览" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "配置图片美化" }));
  expect(
    screen.getByRole("button", { name: "保存美化设置" }),
  ).toBeInTheDocument();
  expect(mutations()).toHaveLength(0);
});

it("adopting a preview preserves unsaved item fields and closing returns keyboard focus", async () => {
  view = { ...completed };
  mocks.api.mockImplementation(async (path: string) =>
    path === "/beautify/settings"
      ? settings
      : path.endsWith("/apply")
        ? { ...completed, applied: true }
        : view,
  );
  const onClose = vi.fn();
  const mounted = render(
    context(<ItemEditor item={photo} onClose={onClose} />),
  );
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "我的衬衫草稿" },
  });
  fireEvent.change(screen.getByLabelText("购买价格"), {
    target: { value: "88" },
  });
  fireEvent.change(screen.getByLabelText("备注"), {
    target: { value: "待保存的备注" },
  });
  const trigger = screen.getByRole("button", { name: "图片美化" });
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("button", { name: "采用美化图" }));
  await screen.findByText("已采用这张美化图。");
  mounted.rerender(
    context(
      <ItemEditor
        item={{
          ...photo,
          image_url: completed.preview_url,
          beautified_url: completed.preview_url,
        }}
        onClose={onClose}
      />,
    ),
  );
  const dialog = screen.getByRole("dialog", { name: "图片美化" });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(
    screen.queryByRole("dialog", { name: "图片美化" }),
  ).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(screen.getByLabelText("名称")).toHaveValue("我的衬衫草稿");
  expect(screen.getByLabelText("购买价格")).toHaveValue(88);
  expect(screen.getByLabelText("备注")).toHaveValue("待保存的备注");
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "/items/top",
      expect.objectContaining({
        name: "我的衬衫草稿",
        price: "88",
        notes: "待保存的备注",
      }),
      "PATCH",
    ),
  );
});

it("does not offer picture processing for a manually created item without a photo", () => {
  render(context(<ItemEditor item={shirt} onClose={vi.fn()} />));
  expect(
    screen.queryByRole("button", { name: "图片美化" }),
  ).not.toBeInTheDocument();
  expect(mocks.api).not.toHaveBeenCalled();
});

it("blocks closing during adoption and keeps the preview usable when adoption fails", async () => {
  view = { ...completed };
  let reject!: (error: Error) => void;
  const adopting = new Promise((_, fail) => {
    reject = fail;
  });
  mocks.api.mockImplementation((path: string) =>
    path.endsWith("/apply")
      ? adopting
      : Promise.resolve(path === "/beautify/settings" ? settings : view),
  );
  const close = vi.fn();
  render(context(<ImageBeautyDialog item={photo} onClose={close} />));
  fireEvent.click(await screen.findByRole("button", { name: "采用美化图" }));
  const dialog = screen.getByRole("dialog", { name: "图片美化" });
  fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
  expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
  expect(close).not.toHaveBeenCalled();
  await act(async () => {
    reject(new Error("暂时无法采用图片，请重试。"));
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "暂时无法采用图片，请重试。",
  );
  expect(screen.getByRole("button", { name: "采用美化图" })).toBeEnabled();
  expect(screen.getByRole("img", { name: "美化预览" })).toHaveAttribute(
    "src",
    completed.preview_url,
  );
  expect(mocks.refresh).not.toHaveBeenCalled();
  fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
});

it("stops polling on a read failure and lets the user explicitly retry status", async () => {
  vi.useFakeTimers();
  view = {
    ...idle,
    status: "processing",
    job_id: "poll-error",
    provider: "api",
  };
  await act(async () => {
    render(context(<ImageBeautyDialog item={photo} onClose={vi.fn()} />));
  });
  mocks.api.mockRejectedValueOnce(new Error("图片状态暂时无法读取。"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  const reads = mocks.api.mock.calls.length;
  expect(screen.getByRole("alert")).toHaveTextContent("图片状态暂时无法读取。");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(mocks.api).toHaveBeenCalledTimes(reads);
  view = { ...completed };
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "重新读取图片状态" }));
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "采用美化图" }),
  ).toBeInTheDocument();
  expect(mutations()).toHaveLength(0);
});
