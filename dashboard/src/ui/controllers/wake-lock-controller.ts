import type { ReactiveController, ReactiveControllerHost } from "lit";

/**
 * Keeps the screen from sleeping while this dashboard is open and visible — glancing at speed
 * mid-ride shouldn't require unlocking the phone every time the screen times out. Uses the
 * Screen Wake Lock API: Chrome/Edge/Android only, same rough support surface as Web Bluetooth,
 * and silently a no-op on any browser that lacks it.
 *
 * The platform itself releases a wake lock whenever the document becomes hidden (tab
 * backgrounded, screen locked) — that's not a bug to work around, it's the documented contract
 * of the API. What it does mean is a lock silently doesn't come back on its own once the
 * document is visible again, so this listens for `visibilitychange` and re-requests one each
 * time visibility returns.
 */
export class WakeLockController implements ReactiveController {
  #sentinel: WakeLockSentinel | undefined;

  constructor(host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostConnected(): void {
    document.addEventListener("visibilitychange", this.#handleVisibilityChange);
    void this.#acquire();
  }

  hostDisconnected(): void {
    document.removeEventListener("visibilitychange", this.#handleVisibilityChange);
    void this.#sentinel?.release();
    this.#sentinel = undefined;
  }

  #handleVisibilityChange = (): void => {
    if (document.visibilityState === "visible") void this.#acquire();
  };

  async #acquire(): Promise<void> {
    if (!navigator.wakeLock) return;
    if (this.#sentinel && !this.#sentinel.released) return; // already held

    try {
      this.#sentinel = await navigator.wakeLock.request("screen");
    } catch {
      // Expected in plenty of ordinary situations — document not visible yet, battery saver
      // mode, no lock available right now — none of it actionable, so nothing to surface.
      this.#sentinel = undefined;
    }
  }
}
