export type SQLValue = string | number | null | Uint8Array;

export interface Statement {
  sql: string;
  params?: SQLValue[];
}

export interface Database {
  all<T>(sql: string, params?: SQLValue[]): Promise<T[]>;
  run(sql: string, params?: SQLValue[]): Promise<{ changes: number }>;
  batch(statements: Statement[]): Promise<{ changes: number }[]>;
}

export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AuthSession {
  user: { id: string; name: string; email: string; emailVerified: boolean };
  session: { id: string; expiresAt: Date };
}

export interface AuthService {
  handler(request: Request): Promise<Response>;
  getSession(headers: Headers): Promise<AuthSession | null>;
}

export type RegistrationMode = "closed" | "invite" | "open";

export interface Runtime {
  db: Database;
  blobs: BlobStore;
  auth?: AuthService;
  publicOrigin: string;
  registrationMode: RegistrationMode;
  inviteCode?: string;
}

export function validateObjectKey(key: string): string[] {
  const parts = key.split("/");
  if (
    key.length > 600 ||
    parts.length > 12 ||
    parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(part) || part === "." || part === "..")
  ) {
    throw new Error("图片存储标识无效。");
  }
  return parts;
}
