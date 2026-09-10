import { HTTPException } from "hono/http-exception";

const MiB = 1024 * 1024;

export const starterLimits = Object.freeze({
  archiveBytes: 24 * MiB,
  expandedBytes: 24 * MiB,
  manifestBytes: 2 * MiB,
  workspaceBytes: MiB,
  historyBytes: 768 * 1024,
  imageBytes: 5 * MiB,
  imageStorageBytes: 16 * MiB,
  imageCount: 150,
  itemCount: 200,
  recordCount: 1000,
  shareCount: 50,
  historyEntryCount: 300,
  snapshotStorageBytes: 16 * MiB,
  pendingPreviews: 3,
  batchStatements: 800,
  jsonBodyBytes: 256 * 1024,
  uploadBodyBytes: 24 * MiB,
  multipartOverheadBytes: 64 * 1024,
});

export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function assertWorkspaceCapacity(state: Record<string, unknown> & { items: unknown[] }): void {
  const records = Object.values(state).reduce<number>((count, value) => count + (Array.isArray(value) ? value.length : 0), 0);
  if (state.items.length > starterLimits.itemCount || records > starterLimits.recordCount) {
    throw new HTTPException(413, { message: "当前实例最多保存 200 件单品和 1000 条衣柜记录，请整理后再试。" });
  }
  if (jsonBytes(state) > starterLimits.workspaceBytes) {
    throw new HTTPException(413, { message: "衣柜文字信息超过 1 MB，请精简记录后再试。" });
  }
}

export function assertBatchCapacity(statements: readonly unknown[]): void {
  // A paid D1 invocation allows 1000 queries, including authentication and reads before this batch.
  if (statements.length > starterLimits.batchStatements) {
    throw new HTTPException(413, { message: "本次操作涉及的记录过多，请分批整理后重试。" });
  }
}
