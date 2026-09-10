import { HTTPException } from "hono/http-exception";
import { assertWorkspaceCapacity, assertBatchCapacity } from "./limits.js";
import type { Runtime, Statement } from "./platform.js";
import {
  collections,
  emptyWorkspace,
  type Workspace,
  type Collection,
  checkRelations,
} from "./models.js";

export interface Snapshot {
  state: Workspace;
  revision: number;
}
export async function readWorkspace(
  runtime: Runtime,
  ownerId: string,
): Promise<Snapshot> {
  await runtime.db.run(
    "INSERT OR IGNORE INTO workspaces(owner_id,revision,settings) VALUES(?,0,?)",
    [ownerId, JSON.stringify(emptyWorkspace().settings)],
  );
  // One SELECT gives the workspace revision and records the same database snapshot.
  const rows = await runtime.db.all<{
    revision: number;
    settings: string;
    collection: Collection | null;
    data: string | null;
  }>(
    `SELECT w.revision,w.settings,e.collection,e.data FROM workspaces w LEFT JOIN entries e ON e.owner_id=w.owner_id WHERE w.owner_id=? ORDER BY e.rowid`,
    [ownerId],
  );
  const state = emptyWorkspace();
  state.settings = JSON.parse(rows[0].settings);
  for (const row of rows)
    if (row.collection && row.data)
      state[row.collection].push(JSON.parse(row.data));
  return { state, revision: rows[0].revision };
}
export type ExtraStatements = (token: string) => Statement[];
export async function commitWorkspace(
  runtime: Runtime,
  ownerId: string,
  before: Snapshot,
  state: Workspace,
  extra?: ExtraStatements,
) {
  checkRelations(state);
  assertWorkspaceCapacity(state);
  for (const key of collections)
    if (state[key].length > (key === "items" ? 2000 : 20000))
      throw new HTTPException(413, { message: "衣柜记录已达到容量上限。" });
  const token = crypto.randomUUID();
  const statements: Statement[] = [
    {
      sql: "UPDATE workspaces SET revision=revision+1,settings=?,write_token=? WHERE owner_id=? AND revision=?",
      params: [JSON.stringify(state.settings), token, ownerId, before.revision],
    },
  ];
  for (const key of collections) {
    const previous = new Map(
      before.state[key].map((e) => [e.id, JSON.stringify(e)]),
    );
    const ids = new Set(state[key].map((e) => e.id));
    const deleted = before.state[key]
      .filter((e) => !ids.has(e.id))
      .map((e) => e.id);
    const changed = state[key].filter(
      (e) => previous.get(e.id) !== JSON.stringify(e),
    );
    if (deleted.length)
      statements.push({
        sql: "DELETE FROM entries WHERE owner_id=? AND collection=? AND id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM workspaces WHERE owner_id=? AND write_token=?)",
        params: [ownerId, key, JSON.stringify(deleted), ownerId, token],
      });
    // Bounded chunks keep SQL parameters below the D1 row-size limit.
    for (let index = 0; index < changed.length; index += 20)
      statements.push({
        sql: `INSERT INTO entries(owner_id,collection,id,data) SELECT ?,?,json_extract(value,'$.id'),value FROM json_each(?) WHERE EXISTS(SELECT 1 FROM workspaces WHERE owner_id=? AND write_token=?) ON CONFLICT(owner_id,collection,id) DO UPDATE SET data=excluded.data`,
        params: [
          ownerId,
          key,
          JSON.stringify(changed.slice(index, index + 20)),
          ownerId,
          token,
        ],
      });
  }
  statements.push(...(extra?.(token) ?? []));
  assertBatchCapacity(statements);
  const result = await runtime.db.batch(statements);
  if (result[0].changes !== 1)
    throw new HTTPException(409, {
      message: "衣柜刚刚发生变化，请刷新后再试。",
    });
}
export async function mutateWorkspace<T>(
  runtime: Runtime,
  ownerId: string,
  mutate: (state: Workspace) => T,
  extra?: ExtraStatements,
): Promise<T> {
  const before = await readWorkspace(runtime, ownerId);
  const state = structuredClone(before.state);
  const result = mutate(state);
  await commitWorkspace(runtime, ownerId, before, state, extra);
  return result;
}
export function find(state: Workspace, key: Collection, id: string) {
  const record = state[key].find((value) => value.id === id);
  if (!record)
    throw new HTTPException(404, { message: "内容不存在，可能已被删除。" });
  return record;
}
