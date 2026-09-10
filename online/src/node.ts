import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createNodePlatform } from "./adapters/node.js";
import { createAuth, normalizePublicOrigin } from "./auth.js";
import { createApp, type AppEnv } from "./app.js";
import type { RegistrationMode } from "./platform.js";

const directory = resolve(process.env.YIJIAN_DATA_DIR ?? ".local/data");
const port = Number(process.env.PORT ?? 3117);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("端口无效。");
const publicOrigin = normalizePublicOrigin(
  process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
);
const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) throw new Error("请设置 BETTER_AUTH_SECRET，至少 32 个字符。");
const platform = createNodePlatform({
  databasePath: resolve(directory, "yijian.sqlite3"),
  blobDirectory: resolve(directory, "objects"),
});
const addresses = new WeakMap<Request, string>();
const registrationMode = (process.env.REGISTRATION_MODE ??
  "closed") as RegistrationMode;
const auth = createAuth({
  database: platform.authDatabase,
  secret,
  publicOrigin,
  registrationMode,
  inviteCode: process.env.INVITE_CODE,
  clientAddress: (request) => addresses.get(request) ?? null,
});
const runtime = { ...platform, auth, publicOrigin, registrationMode };
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  const address = getConnInfo(c).remote.address;
  if (address) addresses.set(c.req.raw, address);
  await next();
});
app.route("/", createApp(runtime));
const staticRoot =
  process.env.YIJIAN_WEB_DIR ??
  fileURLToPath(new URL("../../web/dist-online/", import.meta.url));
if (existsSync(resolve(staticRoot, "index.html"))) {
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
    await next();
  });
  app.get("*", serveStatic({ root: staticRoot }));
  app.get("*", serveStatic({ path: resolve(staticRoot, "index.html") }));
}
const server = serve({
  fetch: app.fetch,
  port,
  hostname: process.env.HOST ?? "127.0.0.1",
});
console.info(`衣间账号版已启动：${publicOrigin}`);
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  server.close(async () => {
    await platform.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
