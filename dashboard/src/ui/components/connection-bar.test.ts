import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "./connection-bar.js";
import type { ConnectionBar } from "./connection-bar.js";

// jsdom has no Web Bluetooth implementation at all, so navigator.bluetooth is normally
// undefined — stub it so these tests exercise the "supported browser" branch, which is what
// they're actually about. The unsupported-browser branch itself is covered separately below.
beforeAll(() => {
  Object.defineProperty(navigator, "bluetooth", {
    value: {},
    configurable: true,
  });
});

async function mount(): Promise<ConnectionBar> {
  const el = document.createElement("connection-bar") as ConnectionBar;
  document.body.append(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<connection-bar>", () => {
  it("shows a connect button when disconnected", async () => {
    const el = await mount();
    const button = el.shadowRoot?.querySelector("button");
    expect(button?.textContent?.trim()).toContain("connect to bike");
    expect(button?.disabled).toBe(false);
  });

  it("disables the connect button while connecting", async () => {
    const el = await mount();
    el.connectionState = "connecting";
    await el.updateComplete;
    const button = el.shadowRoot?.querySelector("button");
    expect(button?.disabled).toBe(true);
  });

  it("shows a disconnect button once ready", async () => {
    const el = await mount();
    el.connectionState = "ready";
    await el.updateComplete;
    const button = el.shadowRoot?.querySelector("button");
    expect(button?.textContent?.trim()).toContain("disconnect");
  });

  it("dispatches connect-requested synchronously from the click handler", async () => {
    const el = await mount();
    const handler = vi.fn();
    el.addEventListener("connect-requested", handler);
    el.shadowRoot?.querySelector("button")?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("<connection-bar> without Web Bluetooth support", () => {
  it("shows an unsupported-browser message instead of a connect button", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "bluetooth");
    Object.defineProperty(navigator, "bluetooth", { value: undefined, configurable: true });
    try {
      const el = await mount();
      expect(el.shadowRoot?.querySelector("button")).toBeNull();
      expect(el.shadowRoot?.textContent).toContain("Web Bluetooth");
    } finally {
      if (original) Object.defineProperty(navigator, "bluetooth", original);
    }
  });
});
