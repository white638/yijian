import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OnlineEntry } from "../src/components/Account";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../src/api", () => ({
  api: mocks.api,
  failure: (error: Error) => error.message,
}));
const config = { edition: "online", registrationMode: "invite", features: {} };
const account = { id: "owner", name: "阿衣", email: "owner@example.test" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function entry() {
  return render(
    <OnlineEntry>{(user) => <p>当前衣柜：{user.name}</p>}</OnlineEntry>,
  );
}
async function advance(milliseconds: number) {
  await act(() => vi.advanceTimersByTimeAsync(milliseconds));
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.api.mockReset();
});
afterEach(() => vi.useRealTimers());

it("ends a stalled configuration request at the deadline and ignores its late response", async () => {
  const pending = deferred<typeof config>();
  mocks.api.mockReturnValue(pending.promise);
  entry();
  const signal = mocks.api.mock.calls[0][1].signal as AbortSignal;
  await advance(14_999);
  expect(screen.getByRole("status")).toHaveTextContent("正在打开你的衣柜");
  await advance(1);
  expect(screen.getByText("连接超时，请检查网络后重新连接。")).toBeVisible();
  expect(screen.getByRole("button", { name: "重新连接" })).toBeEnabled();
  expect(signal.aborted).toBe(true);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await act(async () => pending.resolve(config));
  expect(mocks.api).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("heading", { name: "欢迎回到衣间" }),
  ).not.toBeInTheDocument();
  expect(vi.getTimerCount()).toBe(0);
});

it("uses one deadline for configuration and session, then retries the existing cookie without stale results", async () => {
  const pendingConfig = deferred<typeof config>();
  const pendingSession = deferred<{ user: typeof account }>();
  mocks.api
    .mockReturnValueOnce(pendingConfig.promise)
    .mockReturnValueOnce(pendingSession.promise)
    .mockResolvedValueOnce(config)
    .mockResolvedValueOnce({ user: account });
  entry();
  await advance(14_000);
  await act(async () => pendingConfig.resolve(config));
  const signal = mocks.api.mock.calls[1][1].signal as AbortSignal;
  await advance(1_000);
  expect(signal.aborted).toBe(true);
  expect(screen.getByText(/连接超时/)).toBeVisible();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  });
  expect(screen.getByText("当前衣柜：阿衣")).toBeVisible();
  await act(async () =>
    pendingSession.resolve({ user: { ...account, name: "旧响应" } }),
  );
  expect(screen.getByText("当前衣柜：阿衣")).toBeVisible();
  expect(screen.queryByText("当前衣柜：旧响应")).not.toBeInTheDocument();
  expect(mocks.api.mock.calls.map(([path]) => path)).toEqual([
    "/account/config",
    "/auth/get-session",
    "/account/config",
    "/auth/get-session",
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it("offers session recovery after a connection failure without requiring credentials again", async () => {
  mocks.api
    .mockResolvedValueOnce(config)
    .mockRejectedValueOnce(new Error("网络连接暂时不可用。"))
    .mockResolvedValueOnce(config)
    .mockResolvedValueOnce({ user: account });
  entry();
  await advance(0);
  expect(screen.getByText("网络连接暂时不可用。")).toBeVisible();
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  });
  expect(screen.getByText("当前衣柜：阿衣")).toBeVisible();
  expect(mocks.api.mock.calls.every(([path]) => !path.includes("sign-"))).toBe(
    true,
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels initialization on unmount and never starts a session request from a late configuration", async () => {
  const pending = deferred<typeof config>();
  mocks.api.mockReturnValue(pending.promise);
  const view = entry();
  const signal = mocks.api.mock.calls[0][1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => pending.resolve(config));
  expect(mocks.api).toHaveBeenCalledTimes(1);
});
