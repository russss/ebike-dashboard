import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { listSessions, loadSession, type SessionMeta } from "../../storage/session-store.js";

function formatDuration(startedAt: number, endedAt: number): string {
  const totalSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatStartedAt(startedAt: number): string {
  return new Date(startedAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Lists past recorded sessions from IndexedDB and lets each be downloaded as JSON. */
@customElement("sessions-tab")
export class SessionsTab extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: var(--space-4);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-4);
    }
    h3 {
      margin: 0;
      color: var(--fg-dim);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    button {
      font: inherit;
      font-size: 12px;
      padding: var(--space-1) var(--space-2);
      border-radius: 4px;
      border: 1px solid var(--hairline);
      background: transparent;
      color: var(--fg-dim);
      cursor: pointer;
    }
    button:hover {
      border-color: var(--fg-dim);
      color: var(--fg);
    }
    .empty,
    .loading {
      color: var(--fg-dim);
      font-size: 13px;
      text-align: center;
      padding: var(--space-5);
    }
    .error {
      padding: var(--space-3);
      border-radius: 4px;
      background: var(--fault-bg);
      color: var(--fault);
      font-size: 13px;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      padding: var(--space-3) 0;
      border-bottom: 1px solid var(--hairline);
    }
    li:last-child {
      border-bottom: none;
    }
    .session-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .started-at {
      font-size: 14px;
      color: var(--fg);
    }
    .meta {
      font-size: 12px;
      color: var(--fg-dim);
    }
    .meta .incomplete {
      color: var(--caution);
    }
    .download-button {
      flex-shrink: 0;
      color: var(--fg);
    }
    .download-button[disabled] {
      opacity: 0.5;
      cursor: default;
    }
  `;

  @state() private sessions: SessionMeta[] = [];
  @state() private loading = true;
  @state() private loadError: string | undefined;
  @state() private downloadingId: string | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.#load();
  }

  async #load(): Promise<void> {
    this.loading = true;
    this.loadError = undefined;
    try {
      this.sessions = await listSessions();
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  #handleRefresh = (): void => {
    void this.#load();
  };

  #handleDownload = async (id: string): Promise<void> => {
    this.downloadingId = id;
    try {
      const session = await loadSession(id);
      if (!session) return;
      const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `ado-session-${session.id}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    } finally {
      this.downloadingId = undefined;
    }
  };

  override render() {
    return html`
      <div class="header">
        <h3>Recorded sessions</h3>
        <button @click=${this.#handleRefresh}>refresh</button>
      </div>
      ${this.loadError ? html`<div class="error">${this.loadError}</div>` : null}
      ${this.loading
        ? html`<div class="loading">Loading…</div>`
        : this.sessions.length === 0
          ? html`<div class="empty">
              No recorded sessions yet — one is saved automatically each time you connect and
              then disconnect from the bike.
            </div>`
          : html`
              <ul>
                ${this.sessions.map((session) => this.#renderSession(session))}
              </ul>
            `}
    `;
  }

  #renderSession(session: SessionMeta) {
    const downloading = this.downloadingId === session.id;
    return html`
      <li>
        <div class="session-info">
          <span class="started-at">${formatStartedAt(session.startedAt)}</span>
          <span class="meta">
            ${formatDuration(session.startedAt, session.endedAt)} ·
            ${session.sampleCount.toLocaleString()} samples
            ${session.modelId ? html` · ${session.modelId}` : null}
            ${session.complete ? null : html`<span class="incomplete"> · incomplete</span>`}
          </span>
        </div>
        <button
          class="download-button"
          ?disabled=${downloading}
          @click=${() => this.#handleDownload(session.id)}
        >
          ${downloading ? "…" : "download"}
        </button>
      </li>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sessions-tab": SessionsTab;
  }
}
