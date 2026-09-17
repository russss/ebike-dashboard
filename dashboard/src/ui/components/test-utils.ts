import type { StatTile } from "./stat-tile.js";

/**
 * `<stat-tile>` renders its label/value inside its own shadow root, which a parent's
 * `shadowRoot.textContent` doesn't pierce — so assert on the child elements' properties
 * directly rather than scraping flattened text across a shadow-DOM boundary.
 */
export function tileValues(el: Element): string[] {
  return [...(el.shadowRoot?.querySelectorAll<StatTile>("stat-tile") ?? [])].map((t) => t.value);
}

export function tileLabels(el: Element): string[] {
  return [...(el.shadowRoot?.querySelectorAll<StatTile>("stat-tile") ?? [])].map((t) => t.label);
}
