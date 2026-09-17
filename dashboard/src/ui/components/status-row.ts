import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ConnectionState, LiveStatus } from "../../protocol/index.js";

/** Fault code, headlight, and — most importantly — the lockup-suspected warning banner. */
@customElement("status-row")
export class StatusRow extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-2) var(--space-4);
      font-size: 13px;
      color: var(--fg-dim);
    }
    .fault {
      color: var(--fault);
      font-weight: 600;
    }
    .banner {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin: var(--space-2) var(--space-4);
      padding: var(--space-3);
      border-radius: 4px;
      background: var(--fault-bg);
      color: var(--fault);
      font-size: 13px;
      line-height: 1.4;
    }
  `;

  @property({ attribute: false }) liveStatus: LiveStatus | undefined;
  @property() connectionState: ConnectionState = "disconnected";

  override render() {
    if (this.connectionState === "lockup-suspected") {
      return html`
        <div class="banner" role="alert">
          The bike has gone quiet — this usually means the internal bus has locked up. It
          should recover with a power-cycle; nothing here is trying to read from it further.
        </div>
      `;
    }

    const status = this.liveStatus;
    if (!status) return null;

    return html`
      <div class="row">
        <span class=${status.faultCode !== 0 ? "fault" : ""}>
          ${status.faultCode !== 0 ? `fault ${status.faultCode}` : "no fault"}
        </span>
        <span>headlight ${status.headlightOn ? "on" : "off"}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "status-row": StatusRow;
  }
}
