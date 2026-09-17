import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { WakeLockController } from "./wake-lock-controller.js";

function fakeHost(): ReactiveControllerHost {
  return {
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  };
}

interface FakeSentinel {
  released: boolean;
  release: ReturnType<typeof vi.fn>;
}

function fakeSentinel(): FakeSentinel {
  const sentinel: FakeSentinel = {
    released: false,
    release: vi.fn(async () => {
      sentinel.released = true;
    }),
  };
  return sentinel;
}

describe("WakeLockController", () => {
  let request: ReturnType<typeof vi.fn>;
  // `document` is a shared singleton across every test in this file, unlike a fresh element —
  // a controller whose listener outlives its test would leak into the next one, so every test
  // assigns the controller it creates here and afterEach() always tears it down.
  let controller: WakeLockController | undefined;

  beforeEach(() => {
    request = vi.fn();
    Object.defineProperty(navigator, "wakeLock", {
      value: { request },
      configurable: true,
    });
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    controller?.hostDisconnected();
    controller = undefined;
    vi.restoreAllMocks();
  });

  it("requests a wake lock as soon as the host connects", async () => {
    const sentinel = fakeSentinel();
    request.mockResolvedValue(sentinel);

    controller = new WakeLockController(fakeHost());
    controller.hostConnected();
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("screen");
  });

  it("does nothing, and never throws, on a browser without the Wake Lock API", async () => {
    Object.defineProperty(navigator, "wakeLock", { value: undefined, configurable: true });

    controller = new WakeLockController(fakeHost());
    expect(() => controller!.hostConnected()).not.toThrow();
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
  });

  it("swallows a rejected request instead of throwing — e.g. document not visible yet", async () => {
    request.mockRejectedValue(new Error("document is not visible"));

    controller = new WakeLockController(fakeHost());
    expect(() => controller!.hostConnected()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledOnce();
  });

  it("re-acquires once the document becomes visible again", async () => {
    const first = fakeSentinel();
    request.mockResolvedValueOnce(first);

    controller = new WakeLockController(fakeHost());
    controller.hostConnected();
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();

    // The platform releases the sentinel on its own when the tab is hidden — simulate both of
    // those happening together, as they would on a real backgrounding.
    first.released = true;
    (document as unknown as { visibilityState: string }).visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce(); // becoming hidden doesn't trigger a re-request

    const second = fakeSentinel();
    request.mockResolvedValueOnce(second);
    (document as unknown as { visibilityState: string }).visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("doesn't request a second lock while one is already held", async () => {
    const sentinel = fakeSentinel();
    request.mockResolvedValue(sentinel);

    controller = new WakeLockController(fakeHost());
    controller.hostConnected();
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();

    // Visibility flips true->true-again without the lock ever having been released.
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
  });

  it("releases the held lock and stops listening when the host disconnects", async () => {
    const sentinel = fakeSentinel();
    request.mockResolvedValue(sentinel);

    controller = new WakeLockController(fakeHost());
    controller.hostConnected();
    await Promise.resolve();
    await Promise.resolve();

    controller.hostDisconnected();
    await Promise.resolve();

    expect(sentinel.release).toHaveBeenCalledOnce();

    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce(); // no longer listening, so no re-request

    controller = undefined; // already disconnected; afterEach shouldn't double-disconnect
  });
});
