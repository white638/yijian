import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { BlobStore, Database, SQLValue, Statement } from "../platform.js";
import { validateObjectKey } from "../platform.js";

function bindings(params: SQLValue[]): unknown[] {
  return params.map((value) => value instanceof Uint8Array ? Array.from(value) : value);
}

export class D1DatabaseAdapter implements Database {
  constructor(readonly connection: D1Database) {}

  async all<T>(sql: string, params: SQLValue[] = []): Promise<T[]> {
    const result = await this.connection.prepare(sql).bind(...bindings(params)).all<T>();
    if (!result.success) throw new Error("数据库查询未完成。");
    return result.results;
  }

  async run(sql: string, params: SQLValue[] = []): Promise<{ changes: number }> {
    const result = await this.connection.prepare(sql).bind(...bindings(params)).run();
    if (!result.success) throw new Error("数据库写入未完成。");
    return { changes: result.meta.changes };
  }

  async batch(statements: Statement[]): Promise<{ changes: number }[]> {
    if (!statements.length) return [];
    const results = await this.connection.batch(statements.map(({ sql, params = [] }) =>
      this.connection.prepare(sql).bind(...bindings(params)),
    ));
    if (results.some((result) => !result.success)) throw new Error("数据库批量写入未完成。");
    return results.map((result) => ({ changes: result.meta.changes }));
  }
}

export class R2BlobStore implements BlobStore {
  constructor(readonly bucket: R2Bucket) {}

  async get(key: string): Promise<Uint8Array | null> {
    validateObjectKey(key);
    const object = await this.bucket.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    validateObjectKey(key);
    await this.bucket.put(key, bytes);
  }

  async delete(key: string): Promise<void> {
    validateObjectKey(key);
    await this.bucket.delete(key);
  }
}

export function createCloudflarePlatform(bindings: { DB: D1Database; ASSETS: R2Bucket }) {
  return {
    db: new D1DatabaseAdapter(bindings.DB),
    blobs: new R2BlobStore(bindings.ASSETS),
    authDatabase: bindings.DB,
  };
}
