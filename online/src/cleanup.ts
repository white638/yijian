import type { Runtime, Statement } from "./platform.js";
import { validateObjectKey } from "./platform.js";
import { assertBatchCapacity } from "./limits.js";

export function blobDeletionStatements(
  ownerId: string,
  keys: readonly string[],
  writeToken?: string,
  delaySeconds = 0,
): Statement[] {
  const unique = [...new Set(keys)];
  for (const key of unique) validateObjectKey(key);
  assertBatchCapacity(unique);
  if (!unique.length) return [];
  const delay = Number.isFinite(delaySeconds)
    ? Math.min(60, Math.max(0, delaySeconds))
    : 0;
  return [
    {
      sql: `INSERT OR IGNORE INTO blob_delete_jobs(owner_id,object_key,created_at)
      SELECT ?,value,? FROM json_each(?)${writeToken === undefined ? "" : " WHERE EXISTS(SELECT 1 FROM workspaces WHERE owner_id=? AND write_token=?)"}`,
      params: [
        ownerId,
        new Date(Date.now() + delay * 1000).toISOString(),
        JSON.stringify(unique),
        ...(writeToken === undefined ? [] : [ownerId, writeToken]),
      ],
    },
  ];
}

const objectReferences = `SELECT 1 FROM assets WHERE object_key=?
  UNION ALL SELECT 1 FROM share_items i JOIN shares s ON s.id=i.share_id WHERE i.object_key=?
  UNION ALL SELECT 1 FROM migration_previews WHERE object_key=?`;

export async function flushBlobDeletes(
  runtime: Runtime,
  ownerId: string,
  limit = 8,
): Promise<void> {
  const count = Number.isFinite(limit)
    ? Math.min(8, Math.max(0, Math.trunc(limit)))
    : 8;
  if (!count) return;
  try {
    const jobs = await runtime.db.all<{
      object_key: string;
      created_at: string;
    }>(
      "SELECT object_key,created_at FROM blob_delete_jobs WHERE owner_id=? AND created_at<=? ORDER BY created_at,object_key LIMIT ?",
      [ownerId, new Date().toISOString(), count],
    );
    for (const job of jobs) {
      try {
        validateObjectKey(job.object_key);
        const referenceKeys = [job.object_key, job.object_key, job.object_key];
        const references = await runtime.db.all(
          `${objectReferences} LIMIT 1`,
          referenceKeys,
        );
        if (references.length) {
          // A database commit can succeed before its response fails. Live references, including those
          // owned by another account, must survive cleanup of an apparently failed staging operation.
          await runtime.db.run(
            `DELETE FROM blob_delete_jobs WHERE owner_id=? AND object_key=? AND created_at=? AND EXISTS(${objectReferences})`,
            [ownerId, job.object_key, job.created_at, ...referenceKeys],
          );
          continue;
        }
        await runtime.blobs.delete(job.object_key);
        await runtime.db.run(
          "DELETE FROM blob_delete_jobs WHERE owner_id=? AND object_key=? AND created_at=?",
          [ownerId, job.object_key, job.created_at],
        );
      } catch {
        // Failed jobs stay durable; another authenticated request can retry them.
      }
    }
  } catch {
    // Cleanup availability must not change the result of an already committed wardrobe operation.
  }
}
