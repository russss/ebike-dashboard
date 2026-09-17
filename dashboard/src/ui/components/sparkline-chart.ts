import { LitElement, css, svg } from "lit";
import { customElement, property } from "lit/decorators.js";

/**
 * A bare trend line for a stat tile — no axes, no gridlines, no tooltip. This is the documented
 * exception to "every chart gets a hover layer": a 12-ish-point sparkline whose only job is
 * "is this going up or down," not precise readback (the tile's own number already gives the
 * exact current value). Line is the de-emphasis colour; the most recent sample gets a small dot
 * in the accent colour so "now" still stands out against the trend.
 */
@customElement("sparkline-chart")
export class SparklineChart extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 64px;
      height: 18px;
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
      overflow: visible;
    }
  `;

  @property({ type: Array }) values: number[] = [];

  override render() {
    const w = 64;
    const h = 18;
    const values = this.values;
    if (values.length < 2) return svg`<svg viewBox="0 0 ${w} ${h}"></svg>`;

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const stepX = w / (values.length - 1);

    const points = values.map((v, i) => {
      const x = i * stepX;
      const y = range === 0 ? h / 2 : h - ((v - min) / range) * h;
      return [x, y] as const;
    });
    const pointsAttr = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const [lastX, lastY] = points[points.length - 1]!;

    return svg`
      <svg viewBox="0 0 ${w} ${h}">
        <polyline
          points=${pointsAttr}
          fill="none"
          stroke="var(--fg-dim)"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <circle cx=${lastX} cy=${lastY} r="2" fill="var(--accent)" />
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sparkline-chart": SparklineChart;
  }
}
