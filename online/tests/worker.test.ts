import { describe, expect, it, vi } from "vitest";
import worker, { createHeavyRequestGate, type WorkerBindings } from "../src/worker.js";
import * as authentication from "../src/auth.js";
import * as cloudflare from "../src/adapters/cloudflare.js";

const upload = () => new Request("https://wardrobe.example/api/items/upload", { method: "POST" });
const backup = () => new Request("https://wardrobe.example/api/backup");

describe("Worker buffered-operation capacity", () => {
  it("allows ordinary requests while holding one heavy response until it drains", async () => {
    const gate = createHeavyRequestGate();
    const first = await gate(backup(), async () => new Response("archive"));
    const blocked = vi.fn(async () => new Response("second archive"));
    const response = await gate(upload(), blocked);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(blocked).not.toHaveBeenCalled();
    const state = await gate(new Request("https://wardrobe.example/api/state"), async () => new Response("state"));
    expect(await state.text()).toBe("state");
    expect(await first.text()).toBe("archive");
    expect(await (await gate(upload(), blocked)).text()).toBe("second archive");
  });

  it("releases its slot after an operation throws", async () => {
    const gate = createHeavyRequestGate();
    await expect(gate(upload(), async () => { throw new Error("storage failed"); })).rejects.toThrow("storage failed");
    expect(await (await gate(backup(), async () => new Response("ready"))).text()).toBe("ready");
  });

  it("releases its slot when the client cancels the response", async () => {
    const gate = createHeavyRequestGate();
    const cancel = vi.fn();
    const response = await gate(backup(), async () => new Response(new ReadableStream({ cancel })));
    await response.body!.cancel("download canceled");
    expect(cancel).toHaveBeenCalledWith("download canceled");
    expect(await (await gate(upload(), async () => new Response("ready"))).text()).toBe("ready");
  });

  it("releases its slot if response streaming fails", async () => {
    const gate = createHeavyRequestGate();
    const response = await gate(backup(), async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("stream failed")); } })));
    await expect(response.text()).rejects.toThrow("stream failed");
    expect(await (await gate(upload(), async () => new Response("ready"))).text()).toBe("ready");
  });

  it("serializes memory-intensive password operations with uploads", async () => {
    const gate = createHeavyRequestGate();
    const login = new Request("https://wardrobe.example/api/auth/sign-in/email", { method: "POST" });
    let finish!: (response: Response) => void;
    const pending = gate(login, () => new Promise<Response>(resolve => { finish = resolve; }));
    expect((await gate(upload(), async () => new Response("unexpected"))).status).toBe(429);
    finish(new Response(null, { status: 204 }));
    expect((await pending).status).toBe(204);
    expect(await (await gate(upload(), async () => new Response("ready"))).text()).toBe("ready");
  });

  it("releases a completed password operation before the client reads its JSON body", async () => {
    const gate = createHeavyRequestGate();
    const response = await gate(new Request("https://wardrobe.example/api/auth/sign-in/email", { method: "POST" }), async () => Response.json({ ok: true }));
    expect(await (await gate(upload(), async () => new Response("ready"))).text()).toBe("ready");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("waits for cancellation of a heavy response before admitting another operation", async () => {
    const gate = createHeavyRequestGate();
    const abort = new AbortController();
    let finishCancel!: () => void;
    const cancel = vi.fn(() => new Promise<void>(resolve => { finishCancel = resolve; }));
    const response = await gate(new Request("https://wardrobe.example/api/backup", { signal: abort.signal }), async () => new Response(new ReadableStream({ cancel })));
    abort.abort();
    expect(cancel).toHaveBeenCalledOnce();
    expect((await gate(upload(), async () => new Response("unexpected"))).status).toBe(429);
    finishCancel();
    await response.text();
    expect(await (await gate(upload(), async () => new Response("ready"))).text()).toBe("ready");
  });

  it("does not free a new slot when an older response is canceled again", async () => {
    const gate = createHeavyRequestGate();
    const abort = new AbortController();
    const first = await gate(new Request("https://wardrobe.example/api/backup", { signal: abort.signal }), async () => new Response(new ReadableStream()));
    abort.abort();
    await new Promise(resolve => setTimeout(resolve, 0));
    const next = await gate(backup(), async () => new Response("archive"));
    await first.body!.cancel();
    expect((await gate(upload(), async () => new Response("unexpected"))).status).toBe(429);
    expect(await next.text()).toBe("archive");
  });
});

describe("Worker authentication request isolation", () => {
  it("does not reuse authentication initialization belonging to an aborted request", async () => {
    const hanging = vi.fn(() => new Promise<null>(() => {}));
    const session = { user: { id: "owner", name: "Test", email: "test@example.com", emailVerified: false }, session: { id: "session", expiresAt: new Date(Date.now() + 60000) } };
    const createAuth = vi.spyOn(authentication, "createAuth")
      .mockReturnValueOnce({ handler: async () => new Response(), getSession: hanging })
      .mockReturnValue({ handler: async () => new Response(), getSession: async () => session });
    const platform = vi.spyOn(cloudflare, "createCloudflarePlatform").mockReturnValue({
      db: { connection: {} as WorkerBindings["DB"], all: async () => [], run: async () => ({ changes: 0 }), batch: async () => [] },
      blobs: { bucket: {} as WorkerBindings["ASSETS"], get: async () => null, put: async () => {}, delete: async () => {} },
      authDatabase: {} as WorkerBindings["DB"],
    });
    try {
      const bindings = { DB: {}, ASSETS: {}, PUBLIC_ORIGIN: "https://wardrobe.example", BETTER_AUTH_SECRET: "a".repeat(40) } as WorkerBindings;
      const controller = new AbortController();
      void worker.fetch(new Request("https://wardrobe.example/api/account", { signal: controller.signal }), bindings);
      await vi.waitFor(() => expect(hanging).toHaveBeenCalled());
      controller.abort();
      const response = await worker.fetch(new Request("https://wardrobe.example/api/account"), bindings);
      expect(response.status).toBe(200);
      expect((await response.json()).user.id).toBe("owner");
      expect(createAuth).toHaveBeenCalledTimes(2);
    } finally { createAuth.mockRestore(); platform.mockRestore(); }
  });
});
