import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./stat-tile.js";
import type {
  BikeProfile,
  ControllerDetail,
  Identity,
  ModuleIdentities,
} from "../../protocol/index.js";

/** Hardware/firmware version, model, serial and manufacturer for all four bus nodes. */
@customElement("identity-tab")
export class IdentityTab extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: var(--space-4);
    }
    section {
      margin-bottom: var(--space-5);
    }
    h3 {
      margin: 0 0 var(--space-2);
      color: var(--fg-dim);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .empty {
      color: var(--fg-dim);
      font-size: 13px;
      text-align: center;
      padding: var(--space-5);
    }
    .profile-notes {
      color: var(--fg-dim);
      font-size: 12px;
      line-height: 1.5;
      border: 1px solid var(--hairline);
      border-radius: 6px;
      padding: var(--space-3);
      margin-bottom: var(--space-5);
    }
    .profile-notes strong {
      color: var(--fg);
    }
  `;

  @property({ attribute: false }) identities: ModuleIdentities | undefined;
  @property({ attribute: false }) profile: BikeProfile | undefined;
  @property({ attribute: false }) controller: ControllerDetail | undefined;

  #renderModule(label: string, identity: Identity) {
    const empty =
      !identity.hardwareVersion &&
      !identity.firmwareVersion &&
      !identity.model &&
      !identity.serialNumber &&
      !identity.manufacturer;
    return html`
      <section>
        <h3>${label}</h3>
        ${empty
          ? html`<stat-tile label="status" value="no data"></stat-tile>`
          : html`
              <stat-tile label="hardware" value=${identity.hardwareVersion || "—"}></stat-tile>
              <stat-tile label="firmware" value=${identity.firmwareVersion || "—"}></stat-tile>
              <stat-tile label="model" value=${identity.model || "—"}></stat-tile>
              <stat-tile label="serial" value=${identity.serialNumber || "—"}></stat-tile>
              <stat-tile label="manufacturer" value=${identity.manufacturer || "—"}></stat-tile>
            `}
      </section>
    `;
  }

  override render() {
    const identities = this.identities;
    if (!identities) return html`<div class="empty">Waiting for identity data…</div>`;

    return html`
      ${this.profile
        ? html`
            <div class="profile-notes">
              <strong>Profile: ${this.profile.modelId}</strong><br />
              ${this.profile.notes}
            </div>
          `
        : null}
      ${this.#renderModule("Controller (0xA3)", identities.controller)}
      ${this.#renderModule("Battery (0xA4)", identities.battery)}
      ${this.#renderModule("Display / meter (0xA5)", identities.meter)}
      ${this.#renderModule("Node 0xA7", identities.sensor)}
      ${this.controller
        ? html`
            <section>
              <h3>Configuration</h3>
              <stat-tile
                label="wheel diameter"
                value=${this.controller.wheelDiameterInches.toFixed(1)}
                unit="in"
              ></stat-tile>
              <stat-tile
                label="speed limit"
                value=${this.controller.speedLimitKmh}
                unit="km/h"
              ></stat-tile>
            </section>
          `
        : null}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "identity-tab": IdentityTab;
  }
}
