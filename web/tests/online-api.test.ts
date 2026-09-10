import { afterEach, expect, it, vi } from "vitest";
import { api, RequestError } from "../src/api";
afterEach(() => vi.unstubAllGlobals());
it("expired private API authorization signals the account boundary", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: "unauthorized" }), {
          status: 401,
        }),
      ),
  );
  const listener = vi.fn();
  window.addEventListener("yijian:unauthorized", listener);
  try {
    await expect(api("/state")).rejects.toBeInstanceOf(RequestError);
    expect(listener).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("yijian:unauthorized", listener);
  }
});
it("a failed public link or login does not expire an owner session", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD" }), {
            status: 401,
          }),
        ),
      ),
  );
  const listener = vi.fn();
  window.addEventListener("yijian:unauthorized", listener);
  try {
    await expect(
      api("/auth/sign-in/email", { method: "POST", body: "{}" }),
    ).rejects.toThrow("邮箱或密码不正确");
    await expect(
      api("/share/view", { method: "POST", body: "{}" }),
    ).rejects.toBeInstanceOf(RequestError);
    expect(listener).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("yijian:unauthorized", listener);
  }
});
it("displays the service's Chinese invitation message", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "FORBIDDEN",
            message: "邀请码无效，请检查后重试。",
          }),
          { status: 403 },
        ),
      ),
  );
  await expect(
    api("/auth/sign-up/email", { method: "POST", body: "{}" }),
  ).rejects.toThrow("邀请码无效，请检查后重试。");
});
