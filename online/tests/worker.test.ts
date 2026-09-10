import { describe, expect, it, vi } from "vitest";
import { createHeavyRequestGate } from "../src/worker.js";

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
});
