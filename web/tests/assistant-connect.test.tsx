import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "../src/Store";
import { AIConnect } from "../src/components/AIConnect";
import type { AISettings, AssistantDeviceRequest } from "../src/types";
import { fixture } from "./fixtures";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  send: vi.fn(),
  refresh: vi.fn(),
  notify: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("../src/api", () => ({
  api: mocks.api,
  send: mocks.send,
  failure: (error: Error) => error.message,
}));
const hostSettings = (): AISettings => ({
  ...fixture().ai,
  provider: "codex",
  configured: true,
  assistant_connected: false,
  assistant_connection: { status: "disconnected" },
  automatic_vision: {
    supported: true,
    enabled: false,
    ready: false,
    reason: "尚未开启上传自动识别。",
  },
});
const connectedSettings = (): AISettings => ({
  ...hostSettings(),
  assistant_connected: true,
  assistant_connection: {
    status: "connected",
    client_name: "Codex 本机会话",
    verified_at: Math.floor(Date.now() / 1000),
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    request_id: "device-one",
  },
});
const pendingRequest = (): AssistantDeviceRequest => ({
  id: "device-one",
  user_code: "ABCD-1234",
  client_name: "Codex",
  expires_at: Math.floor(Date.now() / 1000) + 300,
  status: "pending",
});
let serverSettings: AISettings;
let serverRequests: AssistantDeviceRequest[];
function mount(ai = fixture().ai) {
  const state = { ...fixture(), ai };
  return render(
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
      <AIConnect />
    </AppProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  history.replaceState(null, "", "/");
  serverSettings = hostSettings();
  serverRequests = [];
  mocks.refresh.mockResolvedValue(undefined);
  mocks.copy.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.copy },
  });
  mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path.startsWith("/ai/assistant/installation"))
      return { installed: false, provider: "codex" };
    if (path === "/ai/device/requests") return { requests: serverRequests };
    if (path === "/ai/settings") return serverSettings;
    if (path.endsWith("/approve")) {
      serverRequests = serverRequests.map((request) => ({
        ...request,
        status: "approved",
      }));
      serverSettings = {
        ...hostSettings(),
        assistant_connection: { status: "pending" },
      };
      return { approved: true };
    }
    if (path === "/ai/device/device-one" && options?.method === "DELETE") {
      serverRequests = [];
      return { ok: true };
    }
    if (path === "/ai/disconnect") {
      serverSettings = hostSettings();
      return { ok: true };
    }
    return {};
  });
  mocks.send.mockImplementation(
    async (path: string, body: { provider: AISettings["provider"] }) => {
      if (path === "/ai/settings")
        return { ...hostSettings(), provider: body.provider };
      if (path === "/ai/assistant/install")
        return {
          installed: true,
          provider: body.provider,
          path: "unused-private-path",
        };
      return {};
    },
  );
});
afterEach(() => vi.useRealTimers());

describe("verified assistant connection", () => {
  it("enables Codex upload recognition only after the verified user switches it on", async () => {
    const current = connectedSettings();
    serverSettings = current;
    mocks.send.mockResolvedValue({
      ...current,
      capabilities: { vision: true, text: false },
      automatic_vision: {
        supported: true,
        enabled: true,
        ready: true,
        reason: "",
      },
    });
    mount(current);
    const toggle = screen.getByRole("switch", {
      name: "上传后用 Codex 自动识别",
    });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    expect(
      screen.getByText(/会将上传的衣物照片发送给 Codex/),
    ).toBeInTheDocument();
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        "/ai/automatic-vision",
        { enabled: true },
        "PUT",
      ),
    );
    expect(toggle).toBeChecked();
    expect(
      screen.getByText("已准备好，上传照片后会自动填写衣物信息。"),
    ).toBeInTheDocument();
    expect(mocks.api.mock.calls.some(([path]) => path === "/ai/test")).toBe(
      false,
    );
  });
  it("keeps automatic recognition disabled until the Codex connection is verified", async () => {
    mount(hostSettings());
    expect(
      screen.getByRole("switch", { name: "上传后用 Codex 自动识别" }),
    ).toBeDisabled();
    await act(async () => {});
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("does not show automatic recognition as enabled after a rejected setting change", async () => {
    const current = connectedSettings();
    mocks.send.mockRejectedValue(new Error("本机 Codex 尚未登录。"));
    mount(current);
    fireEvent.click(
      screen.getByRole("switch", { name: "上传后用 Codex 自动识别" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "本机 Codex 尚未登录。",
    );
    expect(
      screen.getByRole("switch", { name: "上传后用 Codex 自动识别" }),
    ).not.toBeChecked();
  });
  it("installs only on request and saves the chosen host before installation", async () => {
    mount();
    expect(mocks.api).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "安装到 Codex" }));
    expect(await screen.findByText("衣间技能已安装。")).toBeInTheDocument();
    expect(mocks.send.mock.calls.slice(0, 2)).toEqual([
      [
        "/ai/settings",
        { provider: "codex", base_url: "", text_model: "", vision_model: "" },
        "PUT",
      ],
      ["/ai/assistant/install", { provider: "codex" }],
    ]);
    expect(
      mocks.api.mock.calls.some(
        ([path]) => path === "/ai/test" || path === "/ai/connection-code",
      ),
    ).toBe(false);
    expect(screen.queryByText("unused-private-path")).not.toBeInTheDocument();
  });
  it("restores installed status without installing again", async () => {
    mocks.api.mockImplementation(async (path: string) =>
      path.startsWith("/ai/assistant/installation")
        ? { installed: true }
        : path === "/ai/settings"
          ? serverSettings
          : { requests: [] },
    );
    mount(hostSettings());
    expect(
      await screen.findByRole("button", { name: "重新安装到 Codex" }),
    ).toBeInTheDocument();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("copies a natural connection request containing only the application origin", async () => {
    history.replaceState(null, "", "/?private=must-not-copy#open=secret-entry");
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "复制给 Codex 的连接请求" }),
    );
    await waitFor(() =>
      expect(mocks.copy).toHaveBeenCalledWith(
        `使用衣间技能连接 ${location.origin}，发起配对，验证连接后读取衣物数量。`,
      ),
    );
    expect(mocks.copy.mock.calls[0][0]).not.toMatch(
      /secret-entry|private|token|脚本/,
    );
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(
      mocks.api.mock.calls.some(
        ([path]) => path === "/ai/test" || path === "/ai/connection-code",
      ),
    ).toBe(false);
  });
  it("provides readable connection text when clipboard access fails", async () => {
    mocks.copy.mockRejectedValue(new Error("clipboard denied"));
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "复制给 Codex 的连接请求" }),
    );
    expect(await screen.findByLabelText("请手动复制连接请求")).toHaveValue(
      `使用衣间技能连接 ${location.origin}，发起配对，验证连接后读取衣物数量。`,
    );
    expect(screen.queryByText(/已复制，请粘贴/)).not.toBeInTheDocument();
  });
  it("requires approval and waits for the assistant verification before reporting success", async () => {
    vi.useFakeTimers();
    serverRequests = [pendingRequest()];
    mount(hostSettings());
    await act(async () => {});
    expect(screen.getByText("ABCD-1234")).toBeInTheDocument();
    expect(
      mocks.api.mock.calls.some(([path]) => path.endsWith("/approve")),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "确认连接 Codex，短码 ABCD-1234" }),
    );
    await act(async () => {});
    expect(mocks.api).toHaveBeenCalledWith("/ai/device/device-one/approve", {
      method: "POST",
    });
    expect(screen.getByText("等待助手保存凭据并验证…")).toBeInTheDocument();
    expect(screen.queryByText("已验证连接")).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.queryByText("已验证连接")).not.toBeInTheDocument();
    serverSettings = connectedSettings();
    serverRequests = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText("已验证连接")).toBeInTheDocument();
    expect(screen.getByText("Codex 本机会话")).toBeInTheDocument();
    expect(screen.getByText("最近验证")).toBeInTheDocument();
    const count = mocks.api.mock.calls.filter(
      ([path]) => path === "/ai/device/requests",
    ).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(
      mocks.api.mock.calls.filter(([path]) => path === "/ai/device/requests"),
    ).toHaveLength(count);
  });
  it("does not mistake an unverified issued session for a verified connection", async () => {
    const ai = {
      ...hostSettings(),
      assistant_connected: true,
      assistant_connection: { status: "pending" as const },
    };
    serverSettings = ai;
    mount(ai);
    expect(screen.queryByText("已验证连接")).not.toBeInTheDocument();
    expect(
      screen.getByText("助手尚未完成验证，请让助手继续连接。"),
    ).toBeInTheDocument();
    await act(async () => {});
  });
  it("does not let an older verified session complete a newly requested pairing", async () => {
    vi.useFakeTimers();
    const old = connectedSettings();
    old.assistant_connection!.request_id = "older-device";
    serverSettings = old;
    mount(old);
    expect(screen.getByText("已验证连接")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "复制给 Codex 的连接请求" }),
    );
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.queryByText("已验证连接")).not.toBeInTheDocument();
    serverRequests = [pendingRequest()];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "确认连接 Codex，短码 ABCD-1234" }),
    );
    await act(async () => {});
    serverSettings = old;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.queryByText("已验证连接")).not.toBeInTheDocument();
    serverSettings = connectedSettings();
    serverRequests = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText("已验证连接")).toBeInTheDocument();
  });
  it("rejects a pending request without approving it", async () => {
    serverRequests = [pendingRequest()];
    mount(hostSettings());
    fireEvent.click(
      await screen.findByRole("button", { name: "拒绝此次连接" }),
    );
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith("/ai/device/device-one", {
        method: "DELETE",
      }),
    );
    expect(
      mocks.api.mock.calls.some(([path]) => path.endsWith("/approve")),
    ).toBe(false);
    expect(screen.queryByText("ABCD-1234")).not.toBeInTheDocument();
  });
  it("ignores expired requests and does not keep displaying an expired verification", async () => {
    const ai = connectedSettings();
    ai.assistant_connection!.expires_at = Math.floor(Date.now() / 1000) - 1;
    serverSettings = ai;
    serverRequests = [
      {
        ...pendingRequest(),
        expires_at: Math.floor(Date.now() / 1000) - 1,
      },
    ];
    mount(ai);
    await act(async () => {});
    expect(screen.queryByText("ABCD-1234")).not.toBeInTheDocument();
    expect(screen.queryByText("已验证连接")).not.toBeInTheDocument();
  });
  it("cancels pending polling when switching providers", async () => {
    let resolveRequests: (value: {
      requests: AssistantDeviceRequest[];
    }) => void = () => {};
    let requestSignal: AbortSignal | undefined;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/ai/device/requests") {
        requestSignal = options?.signal as AbortSignal;
        return new Promise((resolve) => {
          resolveRequests = resolve;
        });
      }
      return Promise.resolve({ installed: false });
    });
    mount(hostSettings());
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    await act(async () => {
      resolveRequests({ requests: [pendingRequest()] });
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(screen.queryByText("ABCD-1234")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "复制给 Claude Code 的连接请求" }),
    ).toBeInTheDocument();
  });
  it("shows installation errors without claiming success or connecting models", async () => {
    mocks.send.mockRejectedValue(new Error("技能目录暂时无法写入"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "安装到 Codex" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "技能目录暂时无法写入",
    );
    expect(screen.queryByText("衣间技能已安装。")).not.toBeInTheDocument();
    expect(mocks.api).not.toHaveBeenCalled();
  });
});
