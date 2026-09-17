/**
 * Persists recorded sessions (see `ui/session-recorder.ts`) to IndexedDB, on-device only — never
 * sent anywhere. Split across two object stores so listing past sessions (for the sessions tab)
 * never has to load every session's full sample array into memory, only the small summary row;
 * the bulky `samples` array is only read when a specific session is actually downloaded.
 */
import type { RawSample } from "../protocol/index.js";

/** The lightweight row shown in the sessions list — no sample data. */
export interface SessionMeta {
  readonly id: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly modelId: string | undefined;
  readonly sampleCount: number;
  /** `false` if the session's last write was a mid-ride checkpoint, not a clean disconnect. */
  readonly complete: boolean;
}

/** A full session, as downloaded/exported. */
export interface RecordedSession extends SessionMeta {
  readonly samples: readonly RawSample[];
}

const DB_NAME = "ado-bike-sessions";
const DB_VERSION = 1;
const META_STORE = "sessions";
const SAMPLES_STORE = "samples";

interface SamplesRecord {
  readonly id: string;
  readonly samples: readonly RawSample[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SAMPLES_STORE)) {
        db.createObjectStore(SAMPLES_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("failed to open IndexedDB"));
  });
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function promisifyTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Overwrites any existing session with the same `id` — how a checkpoint re-saves in place. */
export async function saveSession(session: RecordedSession): Promise<void> {
  const db = await openDb();
  try {
    const meta: SessionMeta = {
      id: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      modelId: session.modelId,
      sampleCount: session.samples.length,
      complete: session.complete,
    };
    const samplesRecord: SamplesRecord = { id: session.id, samples: session.samples };
    const tx = db.transaction([META_STORE, SAMPLES_STORE], "readwrite");
    tx.objectStore(META_STORE).put(meta);
    tx.objectStore(SAMPLES_STORE).put(samplesRecord);
    await promisifyTransaction(tx);
  } finally {
    db.close();
  }
}

/** Every recorded session's summary, most recently started first. */
export async function listSessions(): Promise<SessionMeta[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(META_STORE, "readonly");
    const all = await promisifyRequest(tx.objectStore(META_STORE).getAll() as IDBRequest<SessionMeta[]>);
    return all.sort((a, b) => b.startedAt - a.startedAt);
  } finally {
    db.close();
  }
}

/** The full session including its samples, or `undefined` if `id` isn't known. */
export async function loadSession(id: string): Promise<RecordedSession | undefined> {
  const db = await openDb();
  try {
    const tx = db.transaction([META_STORE, SAMPLES_STORE], "readonly");
    const meta = await promisifyRequest(
      tx.objectStore(META_STORE).get(id) as IDBRequest<SessionMeta | undefined>,
    );
    if (!meta) return undefined;
    const samplesRecord = await promisifyRequest(
      tx.objectStore(SAMPLES_STORE).get(id) as IDBRequest<SamplesRecord | undefined>,
    );
    return { ...meta, samples: samplesRecord?.samples ?? [] };
  } finally {
    db.close();
  }
}
