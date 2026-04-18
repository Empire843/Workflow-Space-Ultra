import Dexie, { type Table } from "dexie";

export interface WorkflowRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  data: { nodes: unknown[]; edges: unknown[] };
}

export interface AssetRecord {
  id: string;
  kind: "image" | "video" | "audio";
  mimeType: string;
  blob: Blob;
  url?: string;
  sourceNodeId?: string;
  createdAt: number;
}

class WSUDatabase extends Dexie {
  workflows!: Table<WorkflowRecord, string>;
  assets!: Table<AssetRecord, string>;

  constructor() {
    super("workflow-space-ultra");
    this.version(1).stores({
      workflows: "id, updatedAt",
      assets: "id, kind, createdAt",
    });
    this.version(2).stores({
      workflows: "id, updatedAt, createdAt",
      assets: "id, kind, createdAt",
    }).upgrade((tx) => {
      return tx.table("workflows").toCollection().modify((wf) => {
        if (!wf.createdAt) wf.createdAt = wf.updatedAt || Date.now();
      });
    });
  }
}

let _db: WSUDatabase | null = null;

export function db(): WSUDatabase {
  if (typeof window === "undefined") throw new Error("Dexie chỉ dùng ở client");
  if (!_db) _db = new WSUDatabase();
  return _db;
}

// ---------------------------------------------------------------------------
// Workflow CRUD helpers
// ---------------------------------------------------------------------------

export async function getAllWorkflows(): Promise<WorkflowRecord[]> {
  return db().workflows.orderBy("updatedAt").reverse().toArray();
}

export async function getWorkflow(id: string): Promise<WorkflowRecord | undefined> {
  return db().workflows.get(id);
}

export async function putWorkflow(record: WorkflowRecord): Promise<void> {
  await db().workflows.put(record);
}

export async function deleteWorkflowRecord(id: string): Promise<void> {
  await db().workflows.delete(id);
}

export async function duplicateWorkflowRecord(
  id: string,
  newId: string,
  newName: string,
): Promise<WorkflowRecord | undefined> {
  const src = await db().workflows.get(id);
  if (!src) return undefined;
  const now = Date.now();
  const cloned: WorkflowRecord = {
    ...src,
    id: newId,
    name: newName,
    createdAt: now,
    updatedAt: now,
    data: JSON.parse(JSON.stringify(src.data)),
  };
  await db().workflows.put(cloned);
  return cloned;
}
