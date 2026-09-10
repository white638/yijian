import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { createApp } from "./app.js";
import { createAuth, normalizePublicOrigin } from "./auth.js";
import { createCloudflarePlatform } from "./adapters/cloudflare.js";
import type { RegistrationMode, Runtime } from "./platform.js";

export interface WorkerBindings {
  DB: D1Database;
  ASSETS: R2Bucket;
  PUBLIC_ORIGIN: string;
  BETTER_AUTH_SECRET: string;
  REGISTRATION_MODE?: RegistrationMode;
  INVITE_CODE?: string;
}

export function createWorkerRuntime(bindings: WorkerBindings): Runtime {
  if (!bindings.BETTER_AUTH_SECRET || !bindings.PUBLIC_ORIGIN) throw new Error("请配置认证密钥和网站地址。");
  const platform = createCloudflarePlatform(bindings);
  const publicOrigin = normalizePublicOrigin(bindings.PUBLIC_ORIGIN);
  const registrationMode = bindings.REGISTRATION_MODE ?? "closed";
  const auth = createAuth({
    database: platform.authDatabase,
    secret: bindings.BETTER_AUTH_SECRET,
    publicOrigin,
    registrationMode,
    inviteCode: bindings.INVITE_CODE,
    clientAddress: (request) => request.headers.get("CF-Connecting-IP"),
  });
  return { db: platform.db, blobs: platform.blobs, auth, publicOrigin, registrationMode };
}

const instances = new WeakMap<object, ReturnType<typeof createApp>>();
const heavyPaths = new Set([
  "/api/items/upload", "/api/backup", "/api/migration/preview", "/api/migration/import", "/api/shares",
  "/api/auth/sign-up/email", "/api/auth/sign-in/email", "/api/auth/change-password", "/api/auth/delete-user",
]);

export function createHeavyRequestGate() {
  let active = false;
  return async (request: Request, handle: () => Promise<Response>): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const heavy = heavyPaths.has(path) && (request.method === "POST" || (request.method === "GET" && path === "/api/backup"));
    if (!heavy) return handle();
    if (active) return Response.json(
      { detail: "正在处理另一项较大的操作，请稍后重试。" },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "1" } },
    );
    active = true;
    const release = () => { active = false; };
    try {
      const response = await handle();
      if (!response.body) { release(); return response; }
      const reader = response.body.getReader();
      // The response can retain a complete archive until it drains; keep the slot until then.
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) { reader.releaseLock(); release(); controller.close(); }
            else controller.enqueue(result.value);
          } catch (error) { release(); controller.error(error); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { release(); throw error; }
  };
}

// Workers share one memory budget across simultaneous requests in an isolate.
const heavyRequestGate = createHeavyRequestGate();

export default {
  async fetch(request: Request, bindings: WorkerBindings): Promise<Response> {
    let app = instances.get(bindings);
    if (!app) {
      try {
        app = createApp(createWorkerRuntime(bindings));
        instances.set(bindings, app);
      } catch {
        return Response.json({ detail: "网站配置尚未完成，请稍后再试。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }
    return heavyRequestGate(request, () => Promise.resolve(app!.fetch(request)));
  },
};
