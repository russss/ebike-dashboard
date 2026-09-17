/**
 * Accumulates every raw sample for the current bike connection and persists the run to
 * IndexedDB. `BikeController` owns the one instance of this and feeds it — see there for why
 * raw-sample recording piggybacks on the bind/unbind bookkeeping it already does, rather than
 * this listening to `AdoBike` independently.
 *
 * A ride can end by the bike disconnecting (`end()`) — but it can just as easily end by the
 * phone's browser discarding the backgrounded tab, which fires neither a clean disconnect nor a
 * reliable `beforeunload`. `checkpoint()` is the safety net for that: it re-saves the
 * in-progress session in place (same id, `complete: false`) without clearing it, so recording
 * carries on uninterrupted if the tab comes back, and at most the samples since the last
 * checkpoint are ever at risk if it doesn't.
 */
import type { RawSample } from "../protocol/index.js";
import { saveSession, type RecordedSession } from "../storage/session-store.js";

export class SessionRecorder {
  #sessionId: string | undefined;
  #startedAt: number | undefined;
  #modelId: string | undefined;
  #samples: RawSample[] = [];

  constructor() {
    document.addEventListener("visibilitychange", this.#handleVisibilityChange);
    window.addEventListener("pagehide", this.#handlePageHide);
  }

  /** Begins a new session. Any previous one that was never cleanly ended is checkpointed first. */
  start(): void {
    if (this.#sessionId !== undefined) this.checkpoint();
    this.#sessionId = crypto.randomUUID();
    this.#startedAt = Date.now();
    this.#modelId = undefined;
    this.#samples = [];
  }

  /** Called once the bike's model is known — usually a moment after `start()`, once identity's read. */
  setModelId(modelId: string | undefined): void {
    this.#modelId = modelId;
  }

  record(samples: readonly RawSample[]): void {
    if (this.#sessionId === undefined || samples.length === 0) return;
    this.#samples.push(...samples);
  }

  /** Re-saves the in-progress session in place, marked incomplete, without ending it. */
  checkpoint(): void {
    void this.#persist(false);
  }

  /** Ends the current session (a clean disconnect) with a final, complete save. */
  end(): void {
    void this.#persist(true);
    this.#sessionId = undefined;
    this.#startedAt = undefined;
    this.#modelId = undefined;
    this.#samples = [];
  }

  dispose(): void {
    document.removeEventListener("visibilitychange", this.#handleVisibilityChange);
    window.removeEventListener("pagehide", this.#handlePageHide);
  }

  async #persist(complete: boolean): Promise<void> {
    if (this.#sessionId === undefined || this.#startedAt === undefined) return;
    if (this.#samples.length === 0) return; // nothing worth a record for yet
    const session: RecordedSession = {
      id: this.#sessionId,
      startedAt: this.#startedAt,
      endedAt: Date.now(),
      modelId: this.#modelId,
      sampleCount: this.#samples.length,
      complete,
      samples: this.#samples,
    };
    try {
      await saveSession(session);
    } catch (error) {
      // IndexedDB can be unavailable (Safari private browsing, a user setting, quota
      // exhaustion) — this is fire-and-forget from start()/checkpoint()/end(), so a rejection
      // here would otherwise surface as an unhandled promise rejection instead of just a lost
      // save. Nothing else in the app depends on this succeeding.
      console.error("failed to save recorded session", error);
    }
  }

  #handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") this.checkpoint();
  };

  #handlePageHide = (): void => {
    this.checkpoint();
  };
}
