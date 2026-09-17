import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./sessions-tab.js";
import type { SessionsTab } from "./sessions-tab.js";
import * as sessionStore from "../../storage/session-store.js";
import type { RecordedSession, SessionMeta } from "../../storage/session-store.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "session-1",
    startedAt: Date.parse("2026-09-16T10:00:00Z"),
    endedAt: Date.parse("2026-09-16T10:30:00Z"),
    modelId: "B02H",
    sampleCount: 1234,
    complete: true,
    ...overrides,
  };
}

async function mount(): Promise<SessionsTab> {
  const el = document.createElement("sessions-tab") as SessionsTab;
  document.body.append(el);
  await el.updateComplete;
  // #load() is kicked off from connectedCallback and is itself async; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
  return el;
}

describe("<sessions-tab>", () => {
  let listSessions: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listSessions = vi.spyOn(sessionStore, "listSessions");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("shows an empty-state message when there are no recorded sessions", async () => {
    listSessions.mockResolvedValue([]);
    const el = await mount();
    expect(el.shadowRoot?.textContent).toContain("No recorded sessions yet");
  });

  it("lists each session with its date, duration, sample count and model", async () => {
    listSessions.mockResolvedValue([meta()]);
    const el = await mount();
    const text = el.shadowRoot?.textContent ?? "";
    expect(text).toContain("1,234 samples");
    expect(text).toContain("B02H");
    expect(el.shadowRoot?.querySelectorAll("li")).toHaveLength(1);
  });

  it("flags an incomplete session distinctly from a cleanly-ended one", async () => {
    listSessions.mockResolvedValue([meta({ complete: false })]);
    const el = await mount();
    expect(el.shadowRoot?.textContent).toContain("incomplete");
  });

  it("shows the load error instead of silently rendering an empty list", async () => {
    listSessions.mockRejectedValue(new Error("IndexedDB is not available"));
    const el = await mount();
    expect(el.shadowRoot?.textContent).toContain("IndexedDB is not available");
  });

  it("re-fetches the session list when refresh is clicked", async () => {
    listSessions.mockResolvedValue([]);
    const el = await mount();
    expect(listSessions).toHaveBeenCalledOnce();

    const button = [...(el.shadowRoot?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent?.trim() === "refresh",
    );
    button?.dispatchEvent(new Event("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it("downloads a session as a named JSON file", async () => {
    listSessions.mockResolvedValue([meta()]);
    const fullSession: RecordedSession = { ...meta(), samples: [{ variable: "x", timestamp: 1, value: 2 }] };
    const loadSession = vi.spyOn(sessionStore, "loadSession").mockResolvedValue(fullSession);

    const createObjectURL = vi.fn().mockReturnValue("blob:fake-url");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const el = await mount();
    const downloadButton = el.shadowRoot?.querySelector<HTMLButtonElement>(".download-button");
    downloadButton?.dispatchEvent(new Event("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadSession).toHaveBeenCalledWith("session-1");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");
  });
});
