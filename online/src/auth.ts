import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { HTTPException } from "hono/http-exception";
import type { AuthService, RegistrationMode } from "./platform.js";

const READ_PATHS = new Set(["/get-session", "/list-sessions"]);
const WRITE_PATHS = new Set([
  "/sign-up/email", "/sign-in/email", "/sign-out", "/update-user", "/change-password",
  "/revoke-session", "/revoke-other-sessions", "/revoke-sessions", "/delete-user",
]);

export function normalizePublicOrigin(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  ) throw new Error("公开网址需要 HTTPS；本机测试可使用 localhost HTTP。");
  return url.origin;
}

export function requireSameOrigin(request: Request, publicOrigin: string): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  if (!origin || origin !== publicOrigin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new HTTPException(403, { message: "请从衣间页面发起操作。" });
  }
}

async function secretMatches(value: unknown, expected: string): Promise<boolean> {
  if (typeof value !== "string" || value.length > 256) return false;
  const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const [actual, wanted] = await Promise.all([digest(value), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < wanted.length; index++) difference |= actual[index] ^ wanted[index];
  return difference === 0;
}

export interface AuthOptions {
  database: NonNullable<BetterAuthOptions["database"]>;
  secret: string;
  publicOrigin: string;
  registrationMode?: RegistrationMode;
  inviteCode?: string;
  beforeDeleteUser?: (ownerId: string) => Promise<void>;
  clientAddress?: (request: Request) => string | null;
}

export function createAuth(options: AuthOptions): AuthService {
  const publicOrigin = normalizePublicOrigin(options.publicOrigin);
  const registrationMode = options.registrationMode ?? "closed";
  if (!["closed", "invite", "open"].includes(registrationMode)) throw new Error("注册模式无效。");
  if (options.secret.length < 32) throw new Error("请配置至少 32 字符的独立认证密钥。");
  if (registrationMode === "invite" && (!options.inviteCode || options.inviteCode.length < 16 || options.inviteCode.length > 256)) {
    throw new Error("邀请注册需要配置 16 至 256 字符的邀请码。");
  }
  const auth = betterAuth({
    appName: "衣间",
    baseURL: publicOrigin,
    basePath: "/api/auth",
    secret: options.secret,
    database: options.database,
    trustedOrigins: [publicOrigin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: registrationMode === "closed",
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 10,
      cookieCache: { enabled: false },
    },
    user: {
      deleteUser: {
        enabled: Boolean(options.beforeDeleteUser),
        beforeDelete: async (user) => { await options.beforeDeleteUser?.(user.id); },
      },
    },
    advanced: {
      cookiePrefix: "yijian",
      useSecureCookies: publicOrigin.startsWith("https:"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "strict", path: "/" },
      database: { generateId: () => crypto.randomUUID() },
      ipAddress: { ipAddressHeaders: ["x-yijian-auth-ip"] },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 8 },
        "/change-password": { window: 60, max: 5 },
        "/delete-user": { window: 60, max: 5 },
        "/get-session": false,
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email") {
          if (registrationMode === "closed") throw new APIError("FORBIDDEN", { message: "当前实例尚未开放注册。" });
          if (registrationMode === "invite" && !await secretMatches(ctx.headers?.get("x-yijian-invite-code"), options.inviteCode!)) {
            throw new APIError("FORBIDDEN", { message: "邀请码无效，请检查后重试。" });
          }
        }
        if (ctx.path === "/sign-up/email" || ctx.path === "/update-user") {
          const name = ctx.body?.name;
          if ((ctx.path === "/sign-up/email" || name !== undefined) && (typeof name !== "string" || !name.trim() || name.trim().length > 60)) {
            throw new APIError("BAD_REQUEST", { message: "昵称需要 1 至 60 个字符。" });
          }
          if (typeof name === "string") ctx.body.name = name.trim();
        }
        if (ctx.path === "/delete-user" && (typeof ctx.body?.password !== "string" || !ctx.body.password)) {
          throw new APIError("BAD_REQUEST", { message: "请输入当前密码以确认删除账号。" });
        }
      }),
    },
  });
  return {
    async handler(request) {
      const path = new URL(request.url).pathname.slice("/api/auth".length);
      const allowed = request.method === "GET" ? READ_PATHS : request.method === "POST" ? WRITE_PATHS : new Set<string>();
      if (!allowed.has(path)) return Response.json({ detail: "此账号操作不可用。" }, { status: 404 });
      try {
        requireSameOrigin(request, publicOrigin);
      } catch (error) {
        if (error instanceof HTTPException) return Response.json({ detail: error.message }, { status: error.status });
        throw error;
      }
      const headers = new Headers(request.headers);
      headers.delete("x-yijian-auth-ip");
      // Only the runtime adapter can supply an address trusted for authentication throttling.
      headers.set("x-yijian-auth-ip", options.clientAddress?.(request) ?? "127.0.0.1");
      const response = await auth.handler(new Request(request, { headers }));
      response.headers.set("Cache-Control", "no-store");
      return response;
    },
    async getSession(headers) {
      const result = await auth.api.getSession({ headers });
      if (!result) return null;
      return {
        user: { id: result.user.id, name: result.user.name, email: result.user.email, emailVerified: result.user.emailVerified },
        session: { id: result.session.id, expiresAt: result.session.expiresAt },
      };
    },
  };
}
