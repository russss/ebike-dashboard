import { LitElement, css, html } from "lit";
import { customElement } from "lit/decorators.js";

/** Only shown while disconnected — explains what this app is before there's any live data to show. */
@customElement("about-tab")
export class AboutTab extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: var(--space-4);
    }
    h3 {
      margin: 0 0 var(--space-3);
      color: var(--fg-dim);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    p {
      margin: 0 0 var(--space-4);
      color: var(--fg-dim);
      font-size: 13px;
      line-height: 1.6;
    }
    p:last-child {
      margin-bottom: 0;
    }
    strong {
      color: var(--fg);
    }
  `;

  override render() {
    return html`
      <h3>About this app</h3>
      <p>
        An unofficial live telemetry dashboard for ADO e-bikes, built directly on top of a
        reverse-engineered Bluetooth protocol — not an app from ADO itself.
      </p>
      <p>
        Tap <strong>connect to bike</strong> above to pair over Web Bluetooth. Only <strong
          >Chrome, Edge or Opera</strong
        >
        support it, and only on desktop or Android — there's no Web Bluetooth on iOS in any
        browser, with no workaround.
      </p>
      <p>
        This app only ever reads a fixed, confirmed-safe set of registers — some reads have been
        found to lock up the bike's internal bus on the hardware this was developed against, so
        nothing exploratory or arbitrary is ever requested.
      </p>
      <p>
        Every ride is recorded on this device — never uploaded anywhere — and can be downloaded
        as JSON from the <strong>sessions</strong> tab.
      </p>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "about-tab": AboutTab;
  }
}
