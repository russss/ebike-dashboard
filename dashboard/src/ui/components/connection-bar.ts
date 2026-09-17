import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ConnectionState } from "../../protocol/index.js";

const STATE_LABEL: Record<ConnectionState, string> = {
  disconnected: "not connected",
  connecting: "connecting…",
  authenticating: "authenticating…",
  ready: "connected",
  "lockup-suspected": "bike unresponsive",
  "unsupported-model": "unsupported bike model",
};

/**
 * Connect/disconnect controls. Dispatches `connect-requested`/`disconnect-requested` rather
 * than calling `AdoBike.requestDevice()` itself — the button's own click handler still fires
 * these dispatches synchronously, so the user-gesture requirement for `requestDevice()` is
 * preserved all the way up to whichever ancestor actually owns the `AdoBike` instance.
 */
@customElement("connection-bar")
export class ConnectionBar extends LitElement {
  static override styles = css`
    :host {
      display: block;
      border-bottom: 1px solid var(--hairline);
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-4);
    }
    .row.stacked {
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-3);
    }
    .status {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: 13px;
      color: var(--fg-dim);
      min-width: 0;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--fg-faint);
      flex-shrink: 0;
    }
    :host([data-state="ready"]) .dot {
      background: var(--nominal);
    }
    :host([data-state="lockup-suspected"]) .dot {
      background: var(--fault);
    }
    :host([data-state="connecting"]) .dot,
    :host([data-state="authenticating"]) .dot {
      background: var(--caution);
    }
    .device-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    button {
      font: inherit;
      font-size: 13px;
      padding: var(--space-2) var(--space-3);
      border-radius: 4px;
      border: 1px solid var(--hairline);
      background: transparent;
      color: var(--fg);
      cursor: pointer;
    }
    button:hover {
      border-color: var(--fg-dim);
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--bg);
      font-weight: 600;
    }
    button.large {
      padding: var(--space-4);
      font-size: 17px;
      border-radius: 8px;
    }
    .unsupported {
      padding: var(--space-3) var(--space-4);
      color: var(--caution);
      font-size: 13px;
      line-height: 1.4;
    }
  `;

  @property() connectionState: ConnectionState = "disconnected";
  @property() deviceName = "";

  override updated(): void {
    this.setAttribute("data-state", this.connectionState);
  }

  private handleConnectClick = (): void => {
    // Dispatched synchronously from this click handler so a listener up the tree can call
    // AdoBike.requestDevice() while the user-gesture activation is still live.
    this.dispatchEvent(new Event("connect-requested", { bubbles: true, composed: true }));
  };

  private handleDisconnectClick = (): void => {
    this.dispatchEvent(new Event("disconnect-requested", { bubbles: true, composed: true }));
  };

  override render() {
    if (typeof navigator !== "undefined" && !navigator.bluetooth) {
      return html`
        <div class="unsupported">
          This browser doesn't support Web Bluetooth. Use Chrome, Edge or Opera on desktop or
          Android — iOS Safari and Firefox can't connect to the bike at all.
        </div>
      `;
    }

    const connected =
      this.connectionState === "ready" ||
      this.connectionState === "lockup-suspected" ||
      this.connectionState === "unsupported-model";
    const disconnected = this.connectionState === "disconnected";
    const busy = this.connectionState === "connecting" || this.connectionState === "authenticating";

    return html`
      <div class="row ${disconnected ? "stacked" : ""}">
        <span class="status">
          <span class="dot"></span>
          <span class="device-name">
            ${this.deviceName || STATE_LABEL[this.connectionState]}
          </span>
        </span>
        ${connected
          ? html`<button @click=${this.handleDisconnectClick}>disconnect</button>`
          : html`<button
              class="primary ${disconnected ? "large" : ""}"
              ?disabled=${busy}
              @click=${this.handleConnectClick}
            >
              connect to bike
            </button>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "connection-bar": ConnectionBar;
  }
}
