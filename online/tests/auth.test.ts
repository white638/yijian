import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNodePlatform } from "../src/adapters/node.js";
import { createAuth, requireSameOrigin } from "../src/auth.js";
import type { AuthOptions } from "../src/auth.js";
import type { AuthService } from "../src/platform.js";
import { CompiledQuery } from "kysely";

const ORIGIN = "http://localhost:3218";
const PASSWORD = "a-strong-password-9173";
const SECRET = "auth-tests-independent-secret-8917522";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function fixture(options: Partial<AuthOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "yijian-online-auth-"));
  const platform = createNodePlatform({ databasePath: join(directory, "account.sqlite"), blobDirectory: join(directory, "blobs") });
  cleanups.push(async () => {
    await auth.getSession(new Headers());
    await platform.close();
    if (resolve(directory).startsWith(resolve(tmpdir()) + "\\yijian-online-auth-") || resolve(directory).startsWith(resolve(tmpdir()) + "/yijian-online-auth-")) rmSync(directory, { recursive: true, force: true });
  });
  const auth = createAuth({ database: platform.authDatabase, secret: SECRET, publicOrigin: ORIGIN, registrationMode: "open", ...options });
  return { ...platform, auth, directory };
}

async function request(auth: AuthService, path: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}) {
  const headers = new Headers({ Origin: ORIGIN, ...extra });
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return auth.handler(new Request(`${ORIGIN}/api/auth${path}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

function cookies(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

async function signup(auth: AuthService, email = "one@example.com", extra: Record<string, string> = {}) {
  const response = await request(auth, "/sign-up/email", { name: "衣间用户", email, password: PASSWORD }, undefined, extra);
  expect(response.status, await response.clone().text()).toBe(200);
  return { cookie: cookies(response), data: await response.json() as { user: { id: string; name: string }; token: string } };
}

describe("account authentication", () => {
  it("stores password hashes, creates UUID users, and sets HttpOnly same-site cookies", async () => {
    const { auth, db } = fixture();
    const user = await signup(auth);
    expect(user.data.user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const [account] = await db.all<{ password: string }>("SELECT password FROM account");
    expect(account.password).not.toBe(PASSWORD);
    expect(account.password).not.toContain(PASSWORD);
    const response = await request(auth, "/sign-in/email", { email: "one@example.com", password: PASSWORD });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=Strict/i);
    const session = await auth.getSession(new Headers({ cookie: user.cookie }));
    expect(session?.user.id).toBe(user.data.user.id);
    expect(session?.user.emailVerified).toBe(false);
    expect(session?.session).not.toHaveProperty("token");
  });

  it("defaults to closed registration and rejects empty invite configuration", async () => {
    const { db, authDatabase } = fixture();
    const auth = createAuth({ database: authDatabase, secret: SECRET, publicOrigin: ORIGIN });
    const result = await request(auth, "/sign-up/email", { name: "甲", email: "one@example.com", password: PASSWORD });
    expect(result.status).toBe(403);
    expect(await db.all("SELECT id FROM user")).toHaveLength(0);
    expect(() => createAuth({ database: authDatabase, secret: SECRET, publicOrigin: ORIGIN, registrationMode: "invite" })).toThrow(/邀请码/);
  });

  it("checks invitation before provisioning an account", async () => {
    const code = "invite-only-6ea01e357f11";
    const { auth, db } = fixture({ registrationMode: "invite", inviteCode: code });
    const invalid = await request(auth, "/sign-up/email", { name: "甲", email: "one@example.com", password: PASSWORD }, undefined, { "x-yijian-invite-code": "wrong" });
    expect(invalid.status).toBe(403);
    expect(await db.all("SELECT id FROM user")).toHaveLength(0);
    await signup(auth, "one@example.com", { "x-yijian-invite-code": code });
    expect(await db.all("SELECT id FROM user")).toHaveLength(1);
  });

  it("rejects cross-origin and origin-less writes without provisioning users", async () => {
    const { auth, db } = fixture();
    for (const origin of [undefined, "https://other.example.com"]) {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (origin) headers.set("Origin", origin);
      const response = await auth.handler(new Request(`${ORIGIN}/api/auth/sign-up/email`, { method: "POST", headers, body: JSON.stringify({ name: "甲", email: "one@example.com", password: PASSWORD }) }));
      expect(response.status).toBe(403);
    }
    expect(await db.all("SELECT id FROM user")).toHaveLength(0);
    expect(() => requireSameOrigin(new Request(`${ORIGIN}/api/items`, { method: "POST" }), ORIGIN)).toThrow();
  });

  it("requires strong passwords and bounds profile names", async () => {
    const { auth, db } = fixture();
    for (const body of [
      { name: "甲", email: "one@example.com", password: "short" },
      { name: " ", email: "one@example.com", password: PASSWORD },
      { name: "长".repeat(61), email: "one@example.com", password: PASSWORD },
    ]) {
      const response = await request(auth, "/sign-up/email", body);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(await db.all("SELECT id FROM user")).toHaveLength(0);
  });

  it("isolates session lists and profile changes, including forged user IDs", async () => {
    const { auth } = fixture();
    const first = await signup(auth);
    const second = await signup(auth, "two@example.com");
    const response = await request(auth, "/update-user", { name: "修改昵称", userId: second.data.user.id }, first.cookie);
    expect(response.status).toBe(200);
    expect((await auth.getSession(new Headers({ cookie: first.cookie })))?.user.name).toBe("修改昵称");
    expect((await auth.getSession(new Headers({ cookie: second.cookie })))?.user.name).toBe("衣间用户");
    const sessions = await request(auth, "/list-sessions", undefined, first.cookie);
    expect(sessions.status).toBe(200);
    const values = await sessions.json() as { userId: string }[];
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((session) => session.userId === first.data.user.id)).toBe(true);
    const revoke = await request(auth, "/revoke-session", { token: second.data.token }, first.cookie);
    expect(revoke.status).toBe(200);
    expect(await auth.getSession(new Headers({ cookie: second.cookie }))).not.toBeNull();
  });

  it("rejects bad passwords, expires sessions, and revokes on sign out", async () => {
    const { auth, db } = fixture();
    const user = await signup(auth);
    const bad = await request(auth, "/sign-in/email", { email: "one@example.com", password: "wrong-password-9000" });
    expect(bad.status).toBe(401);
    const signout = await request(auth, "/sign-out", {}, user.cookie);
    expect(signout.status).toBe(200);
    expect(await auth.getSession(new Headers({ cookie: user.cookie }))).toBeNull();
    const login = await request(auth, "/sign-in/email", { email: "one@example.com", password: PASSWORD });
    expect(login.status).toBe(200);
    await db.run("UPDATE session SET expiresAt = ?", [new Date(0).toISOString()]);
    expect(await auth.getSession(new Headers({ cookie: cookies(login) }))).toBeNull();
  });

  it("requires current password before account deletion and invokes owner cleanup", async () => {
    const deleted: string[] = [];
    const { auth, db } = fixture({ beforeDeleteUser: async (owner) => { deleted.push(owner); } });
    const user = await signup(auth);
    const other = await signup(auth, "two@example.com");
    for (const body of [{}, { password: "incorrect-password-9123" }]) {
      const result = await request(auth, "/delete-user", body, user.cookie);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(deleted).toHaveLength(0);
    }
    const result = await request(auth, "/delete-user", { password: PASSWORD }, user.cookie);
    expect(result.status, await result.clone().text()).toBe(200);
    expect(deleted).toEqual([user.data.user.id]);
    expect(await db.all("SELECT id FROM user WHERE id = ?", [user.data.user.id])).toHaveLength(0);
    expect(await auth.getSession(new Headers({ cookie: user.cookie }))).toBeNull();
    expect((await auth.getSession(new Headers({ cookie: other.cookie })))?.user.id).toBe(other.data.user.id);
  });

  it("keeps users if account data cleanup fails", async () => {
    const { auth, db } = fixture({ beforeDeleteUser: async () => { throw new Error("storage unavailable"); } });
    const user = await signup(auth);
    const result = await request(auth, "/delete-user", { password: PASSWORD }, user.cookie);
    expect(result.status).toBe(500);
    expect(await db.all("SELECT id FROM user WHERE id = ?", [user.data.user.id])).toHaveLength(1);
  });

  it("blocks API surfaces not enabled by this deployment", async () => {
    const { auth } = fixture();
    expect((await request(auth, "/request-password-reset", { email: "one@example.com" })).status).toBe(404);
    expect((await request(auth, "/sign-in/social", { provider: "google" })).status).toBe(404);
  });

  it("does not let callers evade sign-in limits through forged address headers", async () => {
    const { auth } = fixture();
    await signup(auth);
    for (let index = 0; index < 10; index++) {
      const attempt = await request(auth, "/sign-in/email", { email: "one@example.com", password: "wrong-password-9173" }, undefined, { "x-forwarded-for": `198.51.100.${index}`, "x-yijian-auth-ip": `198.51.100.${index}` });
      expect(attempt.status).toBe(401);
    }
    const limited = await request(auth, "/sign-in/email", { email: "one@example.com", password: PASSWORD }, undefined, { "x-yijian-auth-ip": "203.0.113.90" });
    expect(limited.status).toBe(429);
  });

  it("marks cookies Secure on HTTPS origins", async () => {
    const secureOrigin = "https://wardrobe.example.com";
    const { auth } = fixture({ publicOrigin: secureOrigin });
    const response = await auth.handler(new Request(`${secureOrigin}/api/auth/sign-up/email`, {
      method: "POST", headers: { Origin: secureOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "甲", email: "one@example.com", password: PASSWORD }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/; Secure/i);
  });
});

describe("platform persistence", () => {
  it("shares one connection mutex between authentication and workspace transactions", async () => {
    const { auth, db } = fixture();
    await db.run("CREATE TABLE mutex_test (id TEXT PRIMARY KEY)");
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const transaction = db.kysely.transaction().execute(async (connection) => {
      await connection.executeQuery(CompiledQuery.raw("INSERT INTO mutex_test VALUES ('rollback')"));
      entered();
      await hold;
      throw new Error("rollback transaction");
    });
    const rolledBack = expect(transaction).rejects.toThrow("rollback transaction");
    await started;
    const batch = db.batch([{ sql: "INSERT INTO mutex_test VALUES ('committed')" }]);
    const registration = signup(auth);
    release();
    await rolledBack;
    await batch;
    await registration;
    expect(await db.all("SELECT id FROM mutex_test")).toEqual([{ id: "committed" }]);
    expect(await db.all("SELECT id FROM user")).toHaveLength(1);
  });

  it("rolls back all batch statements on a constraint failure", async () => {
    const { db } = fixture();
    await db.run("CREATE TABLE batch_test (id TEXT PRIMARY KEY, value TEXT)");
    await expect(db.batch([
      { sql: "INSERT INTO batch_test VALUES (?,?)", params: ["a", "first"] },
      { sql: "INSERT INTO batch_test VALUES (?,?)", params: ["a", "second"] },
    ])).rejects.toThrow();
    expect(await db.all("SELECT * FROM batch_test")).toEqual([]);
  });

  it("round-trips private blobs and rejects traversal keys", async () => {
    const { blobs } = fixture();
    const content = new Uint8Array([1, 2, 3]);
    await blobs.put("owners/abc/image.jpg", content);
    expect(await blobs.get("owners/abc/image.jpg")).toEqual(content);
    for (const key of ["../secret", "/secret", "a/../../secret", "C:\\secret", "a//b"]) {
      await expect(blobs.get(key)).rejects.toThrow();
      await expect(blobs.put(key, content)).rejects.toThrow();
      await expect(blobs.delete(key)).rejects.toThrow();
    }
    await blobs.delete("owners/abc/image.jpg");
    expect(await blobs.get("owners/abc/image.jpg")).toBeNull();
  });
});
