import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { loadSession, listSessions, saveSession, type RecordedSession } from "./session-store.js";
import type { RawSample } from "../protocol/index.js";

function sample(variable: string, timestamp: number, value: number): RawSample {
  return { variable, timestamp, value };
}

function makeSession(overrides: Partial<RecordedSession> = {}): RecordedSession {
  return {
    id: crypto.randomUUID(),
    startedAt: 1000,
    endedAt: 2000,
    modelId: "B02H",
    sampleCount: 2,
    complete: true,
    samples: [sample("controller.speedKmh", 1500, 250), sample("controller.speedKmh", 1600, 260)],
    ...overrides,
  };
}

afterEach(async () => {
  // fake-indexeddb persists across tests in the same module instance — start each test clean.
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("ado-bike-sessions");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

describe("session-store", () => {
  it("round-trips a session through save and load, including its samples", async () => {
    const session = makeSession();
    await saveSession(session);

    const loaded = await loadSession(session.id);
    expect(loaded?.id).toBe(session.id);
    expect(loaded?.modelId).toBe("B02H");
    expect(loaded?.samples).toEqual(session.samples);
  });

  it("returns undefined for an id that was never saved", async () => {
    expect(await loadSession("does-not-exist")).toBeUndefined();
  });

  it("lists session summaries without needing their samples, most recent first", async () => {
    const older = makeSession({ id: "a", startedAt: 1000 });
    const newer = makeSession({ id: "b", startedAt: 2000 });
    await saveSession(older);
    await saveSession(newer);

    const list = await listSessions();
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
    expect(list[0]?.sampleCount).toBe(2);
    // SessionMeta has no `samples` field at all — confirm listing really is the lightweight row.
    expect((list[0] as unknown as RecordedSession).samples).toBeUndefined();
  });

  it("overwrites a session saved again under the same id — how a checkpoint re-saves in place", async () => {
    const session = makeSession({ complete: false });
    await saveSession(session);

    const updated: RecordedSession = {
      ...session,
      endedAt: 3000,
      complete: true,
      samples: [...session.samples, sample("controller.speedKmh", 1700, 270)],
    };
    await saveSession(updated);

    const list = await listSessions();
    expect(list).toHaveLength(1);
    expect(list[0]?.complete).toBe(true);
    expect(list[0]?.sampleCount).toBe(3);

    const loaded = await loadSession(session.id);
    expect(loaded?.samples).toHaveLength(3);
  });
});
