import type { LitElement } from "lit";
import { decimalsOf, METRIC_SELECTED_EVENT, type MetricSelectedDetail } from "./metric-selected-event.js";

type Constructor<T> = new (...args: any[]) => T;

/** The properties a clickable tile needs — each concrete tile declares these itself (as
 *  `@property()`s, with its own defaults). Accessed via a cast rather than a type constraint on
 *  `Base` below, so those `@property()` declarations stay plain new members, not overrides. */
interface MetricTileHost {
  readonly metricId: string;
  readonly label: string;
  readonly unit: string;
  readonly value: string;
}

/**
 * Shared by `<stat-tile>` and `<hero-readout>`: when `metricId` is set, the whole element
 * becomes a clickable/focusable button (mouse, Enter, Space) that dispatches `metric-selected`
 * to open that metric's history graph. A tile with no `metricId` stays inert — no role, no
 * tabindex, no listener effect.
 */
export function ClickableMetricTile<T extends Constructor<LitElement>>(Base: T) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...args);
      this.addEventListener("click", this.#activate);
      this.addEventListener("keydown", this.#handleKeydown);
    }

    override updated(): void {
      const clickable = (this as unknown as MetricTileHost).metricId !== "";
      this.toggleAttribute("clickable", clickable);
      if (clickable) {
        this.setAttribute("role", "button");
        this.setAttribute("tabindex", "0");
      } else {
        this.removeAttribute("role");
        this.removeAttribute("tabindex");
      }
    }

    #activate = (): void => {
      const host = this as unknown as MetricTileHost;
      if (!host.metricId) return;
      this.dispatchEvent(
        new CustomEvent<MetricSelectedDetail>(METRIC_SELECTED_EVENT, {
          detail: {
            metricId: host.metricId,
            label: host.label,
            unit: host.unit,
            decimals: decimalsOf(host.value),
          },
          bubbles: true,
          composed: true,
        }),
      );
    };

    #handleKeydown = (event: KeyboardEvent): void => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.#activate();
    };
  };
}
