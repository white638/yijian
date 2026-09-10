import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import App from "../src/App";
import { AppProvider, useSnapshot } from "../src/Store";
import { AccountForm, OnlineEntry } from "../src/components/Account";
import { Migration } from "../src/components/Migration";
import { ShareGuest, ShareManager } from "../src/components/Sharing";
import { AddSheet, ItemEditor } from "../src/components/Items";
import { OutfitEditor } from "../src/components/Outfits";
import { Home } from "../src/pages/Home";
import { Settings } from "../src/pages/Settings";
import { fixture, shirt } from "./fixtures";
import type { AppState } from "../src/types";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  send: vi.fn(),
  refresh: vi.fn(),
  notify: vi.fn(),
  openOutfit: vi.fn(),
  download: vi.fn(),
  normalize: vi.fn(),
}));
vi.mock("../src/api", () => ({
  api: mocks.api,
  send: mocks.send,
  failure: (e: Error) => e.message,
  downloadBackup: mocks.download,
}));
vi.mock("../src/online-images", () => ({ normalizeUpload: mocks.normalize }));
const account = { id: "owner-one", email: "me@example.test", name: "我的衣柜" };
const config = {
  edition: "online",
  registrationMode: "invite" as const,
  features: {},
};
function onlineState(): AppState {
  const state = fixture();
  state.settings.onboarded = true;
  state.edition = "online";
  state.features = {
    background_removal: false,
    background_removal_ready: false,
    online: true,
    capabilities: {
      ai: false,
      background_removal: false,
      product_import: false,
      sharing: true,
      migration: true,
    },
  };
  return state;
}
function Harness({
  children,
  state = onlineState(),
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
        navigate: vi.fn(),
        openItem: vi.fn(),
        openAdd: vi.fn(),
        openPlan: vi.fn(),
        openOutfit: mocks.openOutfit,
        account,
        signOut: vi.fn(),
      }}
    >
      {children}
    </AppProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  history.replaceState(null, "", "/");
  localStorage.clear();
  sessionStorage.clear();
  mocks.api.mockResolvedValue({});
  mocks.send.mockResolvedValue({});
  mocks.refresh.mockResolvedValue(undefined);
  mocks.normalize.mockResolvedValue(
    new File(["jpeg"], "clean.jpg", { type: "image/jpeg" }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("online snapshot skips local bootstrap and fetches private state only when mounted", async () => {
  mocks.api.mockResolvedValue(onlineState());
  const view = renderHook(() => useSnapshot({ online: true }));
  await waitFor(() => expect(view.result.current.state).not.toBeNull());
  expect(mocks.api).toHaveBeenCalledExactlyOnceWith("/state");
});

it("leaving the private application prevents a queued refresh from requesting wardrobe data", async () => {
  mocks.api.mockResolvedValue(onlineState());
  const view = renderHook(() => useSnapshot({ online: true }));
  const refresh = view.result.current.refresh;
  view.unmount();
  await act(async () => {
    await refresh();
  });
  expect(mocks.api).not.toHaveBeenCalled();
});
it("online anonymous entry never requests the private wardrobe or local session", async () => {
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(path === "/account/config" ? config : null),
  );
  render(<OnlineEntry>{() => <div>private wardrobe</div>}</OnlineEntry>);
  await screen.findByRole("heading", { name: "欢迎回到衣间" });
  expect(mocks.api.mock.calls.map((c) => c[0])).toEqual([
    "/account/config",
    "/auth/get-session",
  ]);
  expect(screen.queryByText("private wardrobe")).not.toBeInTheDocument();
});
it("registration submits the invite header and retains credentials only in the form", async () => {
  const done = vi.fn().mockResolvedValue(undefined);
  render(<AccountForm config={config} onSuccess={done} />);
  fireEvent.click(screen.getByText("第一次使用，创建账户"));
  fireEvent.change(screen.getByLabelText("怎么称呼你"), {
    target: { value: "阿衣" },
  });
  fireEvent.change(screen.getByLabelText("邮箱"), {
    target: { value: "a@example.test" },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "a-long-password" },
  });
  fireEvent.change(screen.getByLabelText("邀请码"), {
    target: { value: "private-invitation" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建账户" }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(mocks.api).toHaveBeenCalledWith("/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({
      email: "a@example.test",
      password: "a-long-password",
      name: "阿衣",
    }),
    headers: { "x-yijian-invite-code": "private-invitation" },
  });
  expect(screen.getByLabelText("密码")).toHaveValue("");
  expect(localStorage.length + sessionStorage.length).toBe(0);
});
it("closed registration exposes only login", () => {
  render(
    <AccountForm
      config={{ ...config, registrationMode: "closed" }}
      onSuccess={vi.fn()}
    />,
  );
  expect(screen.queryByText("第一次使用，创建账户")).not.toBeInTheDocument();
  expect(screen.getByText(/暂未开放注册/)).toBeInTheDocument();
});
it("signing out immediately unmounts the private application after server acknowledgement", async () => {
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/account/config"
        ? config
        : path === "/auth/get-session"
          ? { user: account }
          : {},
    ),
  );
  render(
    <OnlineEntry>
      {(_, signOut) => (
        <div>
          <p>private wardrobe</p>
          <button onClick={() => void signOut()}>exit</button>
        </div>
      )}
    </OnlineEntry>,
  );
  await screen.findByText("private wardrobe");
  fireEvent.click(screen.getByText("exit"));
  await screen.findByRole("heading", { name: "欢迎回到衣间" });
  expect(screen.queryByText("private wardrobe")).not.toBeInTheDocument();
  expect(mocks.api).toHaveBeenCalledWith("/auth/sign-out", {
    method: "POST",
    body: "{}",
  });
});
it("expired authentication discards private UI and a late bootstrap response cannot reopen it", async () => {
  let resolveSession!: (value: unknown) => void;
  mocks.api.mockImplementation((path: string) =>
    path === "/account/config"
      ? Promise.resolve(config)
      : new Promise((resolve) => {
          resolveSession = resolve;
        }),
  );
  render(<OnlineEntry>{() => <div>private wardrobe</div>}</OnlineEntry>);
  await waitFor(() =>
    expect(mocks.api).toHaveBeenCalledWith("/auth/get-session", {
      signal: expect.any(AbortSignal),
    }),
  );
  act(() => window.dispatchEvent(new Event("yijian:unauthorized")));
  await act(async () => resolveSession({ user: account }));
  expect(screen.queryByText("private wardrobe")).not.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "欢迎回到衣间" }),
  ).toBeInTheDocument();
});

const publicView = {
  question: "这样穿合适吗？",
  items: [
    {
      id: "snapshot-one",
      name: "白色衬衫",
      category: "top",
      brand: "",
      image_id: null,
    },
  ],
  expires_at: "2026-12-01T00:00:00Z",
  accepting: true,
};
it("public share branches before all account and wardrobe requests", async () => {
  history.replaceState(null, "", "/#share=guest-secret");
  mocks.api.mockResolvedValue(publicView);
  render(<App />);
  await screen.findByRole("heading", { name: publicView.question });
  expect(mocks.api.mock.calls.map((c) => c[0])).toEqual(["/share/view"]);
  const options = mocks.api.mock.calls[0][1];
  expect(options.headers.Authorization).toBe("Bearer guest-secret");
  expect(options.credentials).toBe("omit");
  expect(
    mocks.api.mock.calls.every((c) => !c[0].includes("guest-secret")),
  ).toBe(true);
  expect(localStorage.length + sessionStorage.length).toBe(0);
});
it("guest replies use snapshot IDs and a stable request ID, with no private state", async () => {
  mocks.api.mockResolvedValue(publicView);
  render(<ShareGuest token="guest-secret" />);
  await screen.findByRole("heading", { name: publicView.question });
  fireEvent.click(screen.getByRole("button", { name: /白色衬衫/ }));
  fireEvent.change(screen.getByLabelText("你的建议"), {
    target: { value: "可以配浅色长裤" },
  });
  fireEvent.click(screen.getByRole("button", { name: "送出建议" }));
  await screen.findByRole("heading", { name: "建议已送达" });
  const call = mocks.api.mock.calls.find((c) => c[0] === "/share/reply")!;
  expect(JSON.parse(call[1].body)).toMatchObject({
    text: "可以配浅色长裤",
    item_ids: ["snapshot-one"],
    nickname: "",
  });
  expect(JSON.parse(call[1].body).request_id).toBeTruthy();
  expect(call[1].headers).toEqual({ Authorization: "Bearer guest-secret" });
  expect(screen.queryByLabelText("你的建议")).not.toBeInTheDocument();
});
it("closed replies retain the snapshot but prevent submitting", async () => {
  mocks.api.mockResolvedValue({ ...publicView, accepting: false });
  render(<ShareGuest token="guest-secret" />);
  await screen.findByText(/主人已关闭回复/);
  expect(screen.getByRole("button", { name: "送出建议" })).toBeDisabled();
  expect(screen.getByLabelText("你的建议")).toBeDisabled();
});
it("invalid share does not display any wardrobe or reply form", async () => {
  mocks.api.mockRejectedValue(new Error("分享链接已失效。"));
  render(<ShareGuest token="revoked-secret" />);
  await screen.findByRole("alert");
  expect(screen.queryByLabelText("你的建议")).not.toBeInTheDocument();
  expect(screen.queryByText("白色衬衫")).not.toBeInTheDocument();
});

it("visitor photos use bearer fetches and revoke temporary URLs when leaving", async () => {
  mocks.api.mockResolvedValue({
    ...publicView,
    items: [{ ...publicView.items[0], image_id: "image-one" }],
  });
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    blob: () => Promise.resolve(new Blob(["jpeg"], { type: "image/jpeg" })),
  });
  vi.stubGlobal("fetch", fetcher);
  const create = vi.fn().mockReturnValue("blob:private-preview");
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  const view = render(<ShareGuest token="guest-secret" />);
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls[0][0]).toBe("/api/share/images/image-one");
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    credentials: "omit",
    headers: { Authorization: "Bearer guest-secret" },
    cache: "no-store",
  });
  expect(screen.getByRole("img", { name: "白色衬衫" })).toHaveAttribute(
    "src",
    "blob:private-preview",
  );
  expect(
    screen.getByRole("img", { name: "白色衬衫" }).getAttribute("src"),
  ).not.toContain("guest-secret");
  view.unmount();
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:private-preview");
});

it("revoked snapshot photo access clears the displayed share", async () => {
  mocks.api.mockResolvedValue({
    ...publicView,
    items: [{ ...publicView.items[0], image_id: "image-one" }],
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 410 }));
  render(<ShareGuest token="revoked-secret" />);
  await screen.findByRole("alert");
  expect(screen.queryByLabelText("你的建议")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: publicView.question }),
  ).not.toBeInTheDocument();
});

it("migration previews without writing and cancellation keeps the wardrobe untouched", async () => {
  mocks.api.mockResolvedValue({
    preview_id: "preview",
    counts: { items: 4, outfits: 2 },
    duplicates: 1,
    conflicts: [{ collection: "items", id: "top", name: "白衬衫" }],
    requires_empty: false,
    expires_at: "2026-12-01",
  });
  const view = render(
    <Harness>
      <Migration />
    </Harness>,
  );
  const input = view.container.querySelector('input[type="file"]')!;
  fireEvent.change(input, {
    target: { files: [new File(["zip"], "wardrobe.zip")] },
  });
  await screen.findByRole("dialog", { name: "确认导入衣柜" });
  expect(mocks.send).not.toHaveBeenCalled();
  expect(screen.getByText(/保留当前衣柜的内容/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(mocks.send).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("migration confirms only the preview ID and refreshes after successful import", async () => {
  mocks.api.mockResolvedValue({
    preview_id: "preview",
    counts: { items: 1 },
    duplicates: 0,
    conflicts: [],
    requires_empty: false,
    expires_at: "2026-12-01",
  });
  const view = render(
    <Harness>
      <Migration />
    </Harness>,
  );
  fireEvent.change(view.container.querySelector('input[type="file"]')!, {
    target: { files: [new File(["zip"], "wardrobe.zip")] },
  });
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith("/migration/import", {
    preview_id: "preview",
  });
});
it("online upload normalizes photos and disables unavailable image and AI jobs", async () => {
  mocks.api.mockResolvedValue({ items: [shirt], warnings: [] });
  const view = render(
    <Harness>
      <AddSheet onClose={vi.fn()} />
    </Harness>,
  );
  expect(screen.queryByText("从链接导入")).not.toBeInTheDocument();
  const original = new File(["png"], "original.png", { type: "image/png" });
  fireEvent.change(view.container.querySelector("input[multiple]")!, {
    target: { files: [original] },
  });
  fireEvent.click(screen.getByRole("button", { name: "添加 1 件衣物" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  expect(mocks.normalize).toHaveBeenCalledExactlyOnceWith(original);
  const body = mocks.api.mock.calls.find((c) => c[0] === "/items/upload")![1]
    .body as FormData;
  expect((body.get("files") as File).name).toBe("clean.jpg");
  expect(body.get("remove_background")).toBe("false");
  expect(body.get("auto_analyze")).toBe("false");
});
it("online item editor hides unavailable processing controls while retaining editable attributes", () => {
  render(
    <Harness>
      <ItemEditor
        item={{ ...shirt, image_url: "/api/images/photo.jpg" }}
        onClose={vi.fn()}
      />
    </Harness>,
  );
  expect(
    screen.queryByRole("button", { name: "去背景" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "图片美化" }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("名称")).toBeInTheDocument();
});

it("deleting a shared item previews affected shares and cancellation preserves the item", async () => {
  mocks.api.mockResolvedValue({
    shares: [
      {
        question: "周末这样搭可以吗",
        status: "active",
        items: [{ item_id: "top" }],
      },
    ],
  });
  const confirm = vi.fn().mockReturnValue(false);
  vi.stubGlobal("confirm", confirm);
  render(
    <Harness>
      <ItemEditor item={shirt} onClose={vi.fn()} />
    </Harness>,
  );
  fireEvent.click(screen.getByRole("button", { name: "删除衣物" }));
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(confirm.mock.calls[0][0]).toContain("周末这样搭可以吗");
  expect(mocks.api).toHaveBeenCalledExactlyOnceWith("/shares");
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it("online home and settings never probe the local assistant or recommendations", () => {
  const view = render(
    <Harness>
      <Home />
    </Harness>,
  );
  expect(mocks.api).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
  view.unmount();
  render(
    <Harness>
      <Settings />
    </Harness>,
  );
  expect(screen.getByRole("heading", { name: "我的账户" })).toBeInTheDocument();
  expect(screen.queryByText("连接 Codex")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "个人资料" })).toBeInTheDocument();
  expect(screen.queryByLabelText("给造型师的备注")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("参考气温（°C）")).not.toBeInTheDocument();
  expect(mocks.api).not.toHaveBeenCalled();
});

it("online onboarding initializes the wardrobe nickname from the registered account", async () => {
  const state = onlineState();
  state.settings.onboarded = false;
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/health"
        ? { edition: "online" }
        : path === "/account/config"
          ? config
          : path === "/auth/get-session"
            ? { user: account }
            : state,
    ),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "打开我的衣柜" }));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "/settings",
      { onboarded: true, name: account.name },
      "PATCH",
    ),
  );
  expect(mocks.api.mock.calls.some(([path]) => path === "/session")).toBe(
    false,
  );
});

it("share creation only offers items with saved photographs and does not reveal private attributes", async () => {
  mocks.api.mockResolvedValue({ shares: [] });
  const state = onlineState();
  state.items = [
    {
      ...shirt,
      name: "可分享衬衫",
      image_url: "/api/images/photo",
      notes: "private-note",
      price: "999.00",
      size: "XL",
    },
    { ...shirt, id: "no-photo", name: "还没有照片" },
    {
      ...shirt,
      id: "archived",
      name: "归档衬衫",
      status: "archived",
      image_url: "/api/images/archived",
    },
  ];
  render(
    <Harness state={state}>
      <ShareManager />
    </Harness>,
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "创建分享" }));
  expect(
    screen.queryByRole("button", { name: /还没有照片/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /归档衬衫/ }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("想问朋友什么"), {
    target: { value: "周末怎么搭？" },
  });
  fireEvent.click(screen.getByRole("button", { name: /可分享衬衫/ }));
  fireEvent.click(screen.getByRole("button", { name: "预览分享内容" }));
  const preview = screen.getByRole("dialog", { name: "朋友将看到的内容" });
  expect(within(preview).getByText("可分享衬衫")).toBeInTheDocument();
  expect(preview.textContent).not.toContain("private-note");
  expect(preview.textContent).not.toContain("999.00");
  expect(preview.textContent).not.toContain("XL");
  expect(mocks.send).not.toHaveBeenCalled();
});

it.each(["active", "imported"])(
  "deleting a %s share requires confirmation and removes it from the list",
  async (status) => {
    const share = {
      id: "share-delete",
      question: "这份分享可以删除",
      status,
      items: [],
      expires_at: "2026-12-01",
      created_at: "2026-09-10",
    };
    let deleted = false;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (options?.method === "DELETE") {
        deleted = true;
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(
        path === "/shares"
          ? { shares: deleted ? [] : [share] }
          : { share, suggestions: [] },
      );
    });
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirm);
    render(
      <Harness>
        <ShareManager />
      </Harness>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /这份分享可以删除/ }),
    );
    const button = await screen.findByRole("button", { name: "删除这份分享" });
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("旧链接会立即失效"),
    );
    expect(deleted).toBe(false);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    confirm.mockReturnValue(true);
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(mocks.api).toHaveBeenCalledWith("/shares/share-delete", {
      method: "DELETE",
    });
    expect(
      screen.queryByRole("button", { name: /这份分享可以删除/ }),
    ).not.toBeInTheDocument();
  },
);
it("friend suggestion opens a manual draft without silently saving a new outfit", async () => {
  const share = {
    id: "share-one",
    question: "怎么穿？",
    status: "active",
    items: [{ ...publicView.items[0], item_id: "top" }],
    expires_at: "2026-12-01",
    created_at: "2026-09-10",
  };
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/shares"
        ? { shares: [share] }
        : {
            share,
            suggestions: [
              {
                id: "reply-one",
                nickname: "朋友",
                text: "就选白衬衫",
                item_ids: ["top"],
                snapshot_item_ids: ["snapshot-one"],
                created_at: "2026-09-10",
              },
            ],
          },
    ),
  );
  render(
    <Harness>
      <ShareManager />
    </Harness>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /怎么穿/ }));
  await screen.findByRole("button", { name: "保存为搭配" });
  fireEvent.click(screen.getByRole("button", { name: "保存为搭配" }));
  expect(mocks.openOutfit).toHaveBeenCalledWith(undefined, {
    name: "朋友的搭配建议",
    item_ids: ["top"],
    notes: "就选白衬衫",
    source: "manual",
  });
  expect(mocks.send).not.toHaveBeenCalled();
});
it("outfit draft preserves selected clothes and notes in the existing editor", () => {
  render(
    <Harness>
      <OutfitEditor
        initialDraft={{
          name: "朋友的建议",
          item_ids: ["top"],
          notes: "试试这件",
        }}
        onClose={vi.fn()}
      />
    </Harness>,
  );
  expect(screen.getByLabelText("搭配名称")).toHaveValue("朋友的建议");
  expect(screen.getByLabelText("搭配笔记")).toHaveValue("试试这件");
  expect(
    screen.queryByRole("button", { name: /AI 推荐/ }),
  ).not.toBeInTheDocument();
  expect(mocks.send).not.toHaveBeenCalled();
});

it.each(["none", "openai", "codex"] as const)(
  "online %s state uses rules only after the user requests them, and preserves the source when saving",
  async (provider) => {
    const state = onlineState();
    state.ai.provider = provider;
    state.ai.capabilities.text = provider !== "none";
    state.settings.preferences.excluded_ids = ["excluded-item"];
    const result = {
      outfits: [
        {
          name: "周末的轻松组合",
          item_ids: ["top", "bottom", "shoes"],
          source: "rules",
          reason: "适合周末出行",
        },
      ],
      missing: [],
      message: "",
    };
    mocks.send.mockResolvedValue(result);
    render(
      <Harness state={state}>
        <OutfitEditor initialDraft={{ item_ids: ["top"] }} onClose={vi.fn()} />
      </Harness>,
    );
    const modes = screen.getByRole("group", { name: "创建穿搭方式" });
    fireEvent.click(within(modes).getByRole("button", { name: /规则推荐/ }));
    expect(
      within(modes).queryByRole("button", { name: /AI 推荐/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "生成 AI 推荐" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Codex 中运行/)).not.toBeInTheDocument();
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("参考气温（°C）"), {
      target: { value: "18" },
    });
    fireEvent.change(screen.getByLabelText("搭配场合"), {
      target: { value: "work" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: /保留已选单品再推荐/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "生成规则推荐" }));
    await screen.findByRole("button", { name: "选用并编辑" });
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith("/recommendations", {
      temperature: 18,
      occasion: "work",
      locked_ids: ["top"],
      excluded_ids: ["excluded-item"],
      seed: 0,
    });
    fireEvent.click(screen.getByRole("button", { name: "选用并编辑" }));
    expect(screen.getByLabelText("搭配名称")).toHaveValue("周末的轻松组合");
    expect(screen.getByLabelText("搭配笔记")).toHaveValue("适合周末出行");
    fireEvent.click(screen.getByRole("button", { name: "保存穿搭" }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenLastCalledWith(
        "/outfits",
        expect.objectContaining({
          item_ids: ["top", "bottom", "shoes"],
          source: "rules",
          layout: expect.objectContaining({ mode: "free" }),
        }),
        "POST",
      ),
    );
    expect(
      mocks.send.mock.calls.some(([path]) => path.startsWith("/ai/")),
    ).toBe(false);
  },
);

it("online rules describe missing categories without creating an outfit", async () => {
  mocks.send.mockResolvedValue({
    outfits: [],
    missing: ["bottom", "shoes"],
    message: "请补充并确认所需单品。",
  });
  render(
    <Harness>
      <OutfitEditor onClose={vi.fn()} />
    </Harness>,
  );
  fireEvent.click(
    within(screen.getByRole("group", { name: "创建穿搭方式" })).getByRole(
      "button",
      { name: /规则推荐/ },
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "生成规则推荐" }));
  expect(await screen.findByText(/可以补充：下装、鞋履/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "选用并编辑" }),
  ).not.toBeInTheDocument();
  expect(mocks.send.mock.calls.some(([path]) => path === "/outfits")).toBe(
    false,
  );
});
