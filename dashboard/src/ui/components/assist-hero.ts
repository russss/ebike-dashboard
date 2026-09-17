import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./hero-readout.js";

@customElement("assist-hero")
export class AssistHero extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
  `;

  @property({ type: Number }) level = 0;
  @property({ type: Number }) levels = 0;
  @property({ type: Array }) history: number[] = [];

  override render() {
    return html`
      <hero-readout
        value=${this.level}
        unit=${this.levels ? `of ${this.levels}` : ""}
        label="assist"
        metricId="hero.assistLevel"
        .history=${this.history}
      ></hero-readout>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "assist-hero": AssistHero;
  }
}
