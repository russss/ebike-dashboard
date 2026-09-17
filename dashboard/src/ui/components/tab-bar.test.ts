import { afterEach, describe, expect, it, vi } from "vitest";
import "./tab-bar.js";
import type { TabBar } from "./tab-bar.js";

async function mount(): Promise<TabBar> {
  const el = document.createElement("tab-bar") as TabBar;
  el.tabs = [
    { id: "live", label: "live" },
    { id: "battery", label: "battery" },
    { id: "info", label: "info" },
  ];
  el.active = "live";
  document.body.append(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<tab-bar>", () => {
  it("renders one button per tab and marks the active one", async () => {
    const el = await mount();
    const buttons = el.shadowRoot?.querySelectorAll("button") ?? [];
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.classList.contains("active")).toBe(true);
    expect(buttons[1]?.classList.contains("active")).toBe(false);
  });

  it("dispatches a bubbling, composed tab-selected event with the clicked tab's id", async () => {
    const el = await mount();
    const handler = vi.fn();
    document.addEventListener("tab-selected", handler);

    const battery = [...(el.shadowRoot?.querySelectorAll("button") ?? [])][1] as HTMLButtonElement;
    battery.click();

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0]![0] as CustomEvent<string>;
    expect(event.detail).toBe("battery");
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);

    document.removeEventListener("tab-selected", handler);
  });

  it("does not dispatch when clicking the already-active tab", async () => {
    const el = await mount();
    const handler = vi.fn();
    document.addEventListener("tab-selected", handler);

    const live = [...(el.shadowRoot?.querySelectorAll("button") ?? [])][0] as HTMLButtonElement;
    live.click();

    expect(handler).not.toHaveBeenCalled();
    document.removeEventListener("tab-selected", handler);
  });
});
