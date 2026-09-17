import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

export interface TabDefinition {
  readonly id: string;
  readonly label: string;
}

/** Dispatches a bubbling, composed `tab-selected` CustomEvent<string> on click. */
@customElement("tab-bar")
export class TabBar extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      gap: var(--space-1);
      padding: 0 var(--space-4);
    }
    button {
      appearance: none;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--fg-dim);
      font: inherit;
      font-size: 13px;
      padding: var(--space-2) var(--space-1);
      cursor: pointer;
    }
    button.active {
      color: var(--fg);
      border-bottom-color: var(--accent);
    }
    button:focus-visible {
      outline: 1px solid var(--accent);
      outline-offset: -1px;
    }
  `;

  @property({ type: Array }) tabs: TabDefinition[] = [];
  @property() active = "";

  #select(id: string): void {
    if (id === this.active) return;
    this.dispatchEvent(
      new CustomEvent<string>("tab-selected", { detail: id, bubbles: true, composed: true }),
    );
  }

  override render() {
    return html`
      <div role="tablist">
        ${this.tabs.map(
          (tab) => html`
            <button
              role="tab"
              type="button"
              aria-selected=${tab.id === this.active}
              class=${tab.id === this.active ? "active" : ""}
              @click=${() => this.#select(tab.id)}
            >
              ${tab.label}
            </button>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tab-bar": TabBar;
  }
}
