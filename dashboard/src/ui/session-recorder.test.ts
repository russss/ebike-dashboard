import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRecorder } from "./session-recorder.js";
import * as sessionStore from "../storage/session-store.js";
import type { RawSample } from "../protocol/index.js";

function sample(variable: string, value: number): RawSample {
  return { variable, timestamp: Date.now(), value };
}

describe("SessionRecorder", () => {
  let saveSession: ReturnType<typeof vi.spyOn>;
  let recorder: SessionRecorder | undefined;

  beforeEach(() => {
    saveSession = vi.spyOn(sessionStore, "saveSession").mockResolvedValue(undefined);
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    recorder?.dispose();
    recorder = undefined;
    vi.restoreAllMocks();
  });

  it("saves nothing until a session has actually recorded a sample", () => {
    recorder = new SessionRecorder();
    recorder.start();
    recorder.end();
    expect(saveSession).not.toHaveBeenCalled();
  });

  it("persists a complete session, with model id, on a clean end()", () => {
    recorder = new SessionRecorder();
    recorder.start();
    recorder.setModelId("B02H");
    recorder.record([sample("controller.speedKmh", 250)]);
    recorder.end();

    expect(saveSession).toHaveBeenCalledOnce();
    const saved = saveSession.mock.calls[0]![0] as sessionStore.RecordedSession;
    expect(saved.modelId).toBe("B02H");
    expect(saved.complete).toBe(true);
    expect(saved.samples).toHaveLength(1);
  });

  it("ignores samples recorded before start() or after end()", () => {
    recorder = new SessionRecorder();
    recorder.record([sample("controller.speedKmh", 1)]); // before start()
    recorder.start();
    recorder.record([sample("controller.speedKmh", 2)]);
    recorder.end();
    recorder.record([sample("controller.speedKmh", 3)]); // after end()

    const saved = saveSession.mock.calls[0]![0] as sessionStore.RecordedSession;
    expect(saved.samples.map((s) => s.value)).toEqual([2]);
  });

  it("checkpoints in place, marked incomplete, without clearing accumulated samples", () => {
    recorder = new SessionRecorder();
    recorder.start();
    recorder.record([sample("controller.speedKmh", 250)]);
    recorder.checkpoint();

    expect(saveSession).toHaveBeenCalledOnce();
    const firstSave = saveSession.mock.calls[0]![0] as sessionStore.RecordedSession;
    expect(firstSave.complete).toBe(false);
    const sessionId = firstSave.id;

    recorder.record([sample("controller.speedKmh", 260)]);
    recorder.end();

    expect(saveSession).toHaveBeenCalledTimes(2);
    const finalSave = saveSession.mock.calls[1]![0] as sessionStore.RecordedSession;
    expect(finalSave.id).toBe(sessionId); // same session, not a new one
    expect(finalSave.complete).toBe(true);
    expect(finalSave.samples).toHaveLength(2); // both the checkpointed and later sample
  });

  it("checkpoints automatically when the document becomes hidden", () => {
    recorder = new SessionRecorder();
    recorder.start();
    recorder.record([sample("controller.speedKmh", 250)]);

    (document as unknown as { visibilityState: string }).visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(saveSession).toHaveBeenCalledOnce();
    expect((saveSession.mock.calls[0]![0] as sessionStore.RecordedSession).complete).toBe(false);
  });

  it("checkpoints automatically on pagehide", () => {
    recorder = new SessionRecorder();
    recorder.start();
    recorder.record([sample("controller.speedKmh", 250)]);

    window.dispatchEvent(new Event("pagehide"));

    expect(saveSession).toHaveBeenCalledOnce();
  });

  it("checkpoints a still-open previous session before starting a new one", () => {
    recorder = new SessionRecorder();
    recorder.start();
    recorder.record([sample("controller.speedKmh", 250)]);

    recorder.start(); // e.g. a lockup-triggered reconnect without a clean end() in between

    expect(saveSession).toHaveBeenCalledOnce();
    const checkpointed = saveSession.mock.calls[0]![0] as sessionStore.RecordedSession;
    expect(checkpointed.complete).toBe(false);
  });

  it("doesn't reject or throw when the underlying save fails — e.g. IndexedDB unavailable", async () => {
    saveSession.mockRejectedValue(new Error("IndexedDB is not available"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    recorder = new SessionRecorder();
    recorder.start();
    recorder.record([sample("controller.speedKmh", 250)]);
    expect(() => recorder!.end()).not.toThrow();

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
  });

  it("stops listening once disposed", () => {
    recorder = new SessionRecorder();
    recorder.start();
    recorder.record([sample("controller.speedKmh", 250)]);
    recorder.dispose();

    window.dispatchEvent(new Event("pagehide"));
    expect(saveSession).not.toHaveBeenCalled();
  });
});
