import { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Kysely, CompiledQuery } from "kysely";
import { NodeSqliteDialect } from "@better-auth/kysely-adapter/node-sqlite-dialect";
import type { BlobStore, Database, SQLValue, Statement } from "../platform.js";
import { validateObjectKey } from "../platform.js";

export class SQLiteDatabase implements Database {
  readonly kysely: Kysely<Record<string, Record<string, unknown>>>;

  constructor(readonly connection: DatabaseSync) {
    this.kysely = new Kysely({ dialect: new NodeSqliteDialect({ database: connection }) });
  }

  async all<T>(sql: string, params: SQLValue[] = []): Promise<T[]> {
    return (await this.kysely.executeQuery(CompiledQuery.raw(sql, params))).rows as T[];
  }

  async run(sql: string, params: SQLValue[] = []): Promise<{ changes: number }> {
    const result = await this.kysely.executeQuery(CompiledQuery.raw(sql, params));
    return { changes: Number(result.numAffectedRows ?? 0) };
  }

  async batch(statements: Statement[]): Promise<{ changes: number }[]> {
    if (!statements.length) return [];
    return this.kysely.transaction().execute(async (transaction) => {
      const result = [];
      for (const { sql, params = [] } of statements) {
        const row = await transaction.executeQuery(CompiledQuery.raw(sql, params));
        result.push({ changes: Number(row.numAffectedRows ?? 0) });
      }
      return result;
    });
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class FileBlobStore implements BlobStore {
  readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private async path(key: string, createParents = false): Promise<string> {
    const parts = validateObjectKey(key);
    let current = this.root;
    const rootStat = await lstat(current);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("图片目录无效。");
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const isParent = index < parts.length - 1;
      if (isParent && createParents) await mkdir(current, { recursive: true, mode: 0o700 });
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || (isParent && !stat.isDirectory()) || (!isParent && !stat.isFile())) {
          throw new Error("图片路径无效。");
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    return current;
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(await this.path(key), { flag: constants.O_RDONLY | constants.O_NOFOLLOW }));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = await this.path(key, true);
    const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await this.path(key);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error) => { if (!missing(error)) throw error; });
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(await this.path(key));
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}

export function migrateSQLite(connection: DatabaseSync, directory: string): void {
  connection.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)");
  for (const name of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
    const sql = readFileSync(join(directory, name), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    const previous = connection.prepare("SELECT sha256 FROM schema_migrations WHERE name = ?").get(name);
    if (previous) {
      if (previous.sha256 !== sha256) throw new Error(`数据库迁移 ${name} 已改变，请保留已发布迁移并新增文件。`);
      continue;
    }
    connection.exec("BEGIN IMMEDIATE");
    try {
      connection.exec(sql);
      connection.prepare("INSERT INTO schema_migrations(name, sha256) VALUES (?, ?)").run(name, sha256);
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  }
}

export function createNodePlatform(options: {
  databasePath: string;
  blobDirectory: string;
  migrationsDirectory?: string;
}) {
  const databasePath = options.databasePath === ":memory:" ? ":memory:" : resolve(options.databasePath);
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const connection = new DatabaseSync(databasePath);
  connection.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 15000; PRAGMA journal_mode = WAL;");
  try {
    migrateSQLite(connection, options.migrationsDirectory ?? fileURLToPath(new URL("../../migrations/", import.meta.url)));
  } catch (error) {
    connection.close();
    throw error;
  }
  const db = new SQLiteDatabase(connection);
  return {
    db,
    blobs: new FileBlobStore(options.blobDirectory),
    authDatabase: { db: db.kysely, type: "sqlite" as const, transaction: true },
    close: () => db.kysely.destroy(),
  };
}
