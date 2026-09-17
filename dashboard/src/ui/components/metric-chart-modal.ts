import { LitElement, css, html, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { MetricPoint } from "../metric-history.js";

const MARGIN = { top: 12, right: 12, bottom: 24, left: 12 };

/** Picks a "nice" gridline step (1/2/5 * 10^n) for a given raw span and target tick count. */
function niceStep(span: number, targetTicks: number): number {
  if (span <= 0) return 1;
  const rough = span / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10;
  return step * magnitude;
}

function formatTime(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Full-screen history graph for one metric, opened by clicking a `<stat-tile>`/`<hero-readout>`.
 * Deliberately full-viewport and fluid rather than a fixed-size dialog: on a phone that already
 * gives a "larger view" in landscape for free (more width for the same time range), with no
 * separate orientation-specific layout logic to keep in sync.
 */
@customElement("metric-chart-modal")
export class MetricChartModal extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 100;
      background: var(--bg);
    }
    .modal {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--hairline);
      flex-shrink: 0;
    }
    h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--fg);
      text-transform: none;
    }
    .close-button {
      appearance: none;
      background: none;
      border: 1px solid var(--hairline);
      border-radius: 4px;
      color: var(--fg-dim);
      font: inherit;
      font-size: 13px;
      padding: var(--space-1) var(--space-3);
      cursor: pointer;
    }
    .close-button:hover {
      color: var(--fg);
      border-color: var(--fg-dim);
    }
    .stats {
      display: flex;
      gap: var(--space-5);
      padding: var(--space-3) var(--space-4);
      flex-shrink: 0;
    }
    .stat {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .stat .label {
      color: var(--fg-dim);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .stat .value {
      color: var(--fg);
      font-size: 15px;
      font-weight: 600;
    }
    .chart-area {
      flex: 1;
      min-height: 0;
      padding: 0 var(--space-2) var(--space-3);
      touch-action: none;
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
      overflow: visible;
    }
    .gridline {
      stroke: var(--hairline);
      stroke-width: 1;
    }
    .axis-label {
      fill: var(--fg-dim);
      font-size: 10px;
    }
    .line {
      fill: none;
      stroke: var(--accent);
      stroke-width: 2;
      stroke-linejoin: round;
      stroke-linecap: round;
    }
    .area {
      fill: var(--accent);
      opacity: 0.1;
    }
    .crosshair {
      stroke: var(--fg-dim);
      stroke-width: 1;
    }
    .crosshair-dot {
      fill: var(--accent);
      stroke: var(--bg);
      stroke-width: 2;
    }
    .tooltip-bg {
      fill: var(--surface);
      stroke: var(--hairline);
      stroke-width: 1;
    }
    .tooltip-text {
      fill: var(--fg);
      font-size: 11px;
    }
    .empty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--fg-dim);
      font-size: 13px;
      text-align: center;
      padding: var(--space-5);
    }
  `;

  @property() metricId = "";
  @property() label = "";
  @property() unit = "";
  @property({ type: Number }) decimals = 0;
  @property({ type: Array }) points: readonly MetricPoint[] = [];

  @state() private hoverIndex: number | undefined;
  @state() private viewportW = 0;
  @state() private viewportH = 0;

  #resizeObserver: ResizeObserver | undefined;
  #previousBodyOverflow: string | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("keydown", this.#handleKeydown);
    // Without this, the page underneath keeps scrolling on touch even though this modal is
    // `position: fixed` and visually covers it.
    this.#previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Not available under jsdom (no real layout to observe there anyway); every real target
    // browser for this app (Chrome/Edge/Android) has had it for years.
    if (typeof ResizeObserver !== "undefined") {
      this.#resizeObserver = new ResizeObserver(() => this.#measure());
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this.#handleKeydown);
    document.body.style.overflow = this.#previousBodyOverflow ?? "";
    this.#resizeObserver?.disconnect();
  }

  override firstUpdated(): void {
    const chartArea = this.shadowRoot?.querySelector(".chart-area");
    // ResizeObserver fires once with the current size shortly after observe() starts, even
    // before anything's actually resized — that first async callback is the initial
    // measurement; no synchronous #measure() call needed here (and calling one would trip
    // Lit's "update scheduled during update" warning, since this runs at the tail of the very
    // update that just rendered .chart-area).
    if (chartArea) this.#resizeObserver?.observe(chartArea);
    this.shadowRoot?.querySelector<HTMLButtonElement>(".close-button")?.focus();
  }

  #measure(): void {
    const chartArea = this.shadowRoot?.querySelector(".chart-area");
    if (!chartArea) return;
    const rect = chartArea.getBoundingClientRect();
    this.viewportW = rect.width;
    this.viewportH = rect.height;
  }

  #handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.#close();
  };

  #close = (): void => {
    this.dispatchEvent(new Event("metric-chart-close", { bubbles: true, composed: true }));
  };

  #handleBackdropClick = (event: Event): void => {
    if (event.target === event.currentTarget) this.#close();
  };

  #format(value: number): string {
    return value.toFixed(this.decimals);
  }

  #handlePointerMove = (event: PointerEvent): void => {
    const svgEl = this.shadowRoot?.querySelector("svg");
    if (!svgEl || this.points.length === 0) return;
    const rect = svgEl.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const w = this.viewportW || rect.width;
    const innerW = w - MARGIN.left - MARGIN.right;
    if (innerW <= 0) return;

    const first = this.points[0]!.t;
    const last = this.points[this.points.length - 1]!.t;
    const span = last - first || 1;
    const targetT = first + ((x - MARGIN.left) / innerW) * span;

    let nearest = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const dist = Math.abs(this.points[i]!.t - targetT);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    }
    this.hoverIndex = nearest;
  };

  #handlePointerLeave = (): void => {
    this.hoverIndex = undefined;
  };

  override render() {
    const summary = this.#renderSummary();
    return html`
      <div class="modal" @click=${this.#handleBackdropClick}>
        <header>
          <h2>${this.label}${this.unit ? html` <span style="color: var(--fg-dim)">(${this.unit})</span>` : null}</h2>
          <button class="close-button" @click=${this.#close}>close</button>
        </header>
        ${summary}
        <div class="chart-area">${this.#renderChart()}</div>
      </div>
    `;
  }

  #renderSummary() {
    if (this.points.length === 0) return null;
    const values = this.points.map((p) => p.value);
    const current = values[values.length - 1]!;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return html`
      <div class="stats">
        <div class="stat">
          <span class="label">current</span>
          <span class="value tabular">${this.#format(current)}</span>
        </div>
        <div class="stat">
          <span class="label">min</span>
          <span class="value tabular">${this.#format(min)}</span>
        </div>
        <div class="stat">
          <span class="label">max</span>
          <span class="value tabular">${this.#format(max)}</span>
        </div>
      </div>
    `;
  }

  #renderChart() {
    if (this.points.length < 2) {
      return html`<div class="empty">Not enough data yet for a graph — check back in a moment.</div>`;
    }

    const w = this.viewportW || 320;
    const h = this.viewportH || 240;
    const innerW = Math.max(1, w - MARGIN.left - MARGIN.right);
    const innerH = Math.max(1, h - MARGIN.top - MARGIN.bottom);

    const values = this.points.map((p) => p.value);
    const dataMin = Math.min(...values);
    const dataMax = Math.max(...values);
    const step = niceStep(dataMax - dataMin || 1, 4);
    const yMin = dataMax === dataMin ? dataMin - step : Math.floor(dataMin / step) * step;
    const yMax = dataMax === dataMin ? dataMax + step : Math.ceil(dataMax / step) * step;
    const yRange = yMax - yMin || 1;

    const first = this.points[0]!.t;
    const last = this.points[this.points.length - 1]!.t;
    const tSpan = last - first || 1;

    const x = (t: number) => MARGIN.left + ((t - first) / tSpan) * innerW;
    const y = (v: number) => MARGIN.top + innerH - ((v - yMin) / yRange) * innerH;

    const linePoints = this.points.map((p) => `${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
    const areaPoints = `${x(first).toFixed(1)},${(MARGIN.top + innerH).toFixed(1)} ${linePoints} ${x(last).toFixed(1)},${(MARGIN.top + innerH).toFixed(1)}`;

    const gridlines: ReturnType<typeof svg>[] = [];
    for (let v = Math.ceil(yMin / step) * step; v <= yMax + 1e-9; v += step) {
      const gy = y(v);
      gridlines.push(svg`
        <line class="gridline" x1=${MARGIN.left} x2=${w - MARGIN.right} y1=${gy} y2=${gy} />
        <text class="axis-label" x=${MARGIN.left} y=${gy - 4}>${this.#format(v)}</text>
      `);
    }

    const timeTickCount = Math.min(4, this.points.length);
    const timeTicks: ReturnType<typeof svg>[] = [];
    for (let i = 0; i < timeTickCount; i++) {
      const t = first + (tSpan * i) / Math.max(1, timeTickCount - 1);
      timeTicks.push(svg`
        <text class="axis-label" x=${x(t)} y=${h - 6} text-anchor=${i === 0 ? "start" : i === timeTickCount - 1 ? "end" : "middle"}>
          ${formatTime(t)}
        </text>
      `);
    }

    const hovered = this.hoverIndex !== undefined ? this.points[this.hoverIndex] : undefined;

    return svg`
      <svg
        viewBox="0 0 ${w} ${h}"
        @pointermove=${this.#handlePointerMove}
        @pointerleave=${this.#handlePointerLeave}
      >
        ${gridlines}
        <polygon class="area" points=${areaPoints}></polygon>
        <polyline class="line" points=${linePoints}></polyline>
        ${timeTicks}
        ${hovered
          ? svg`
              <line class="crosshair" x1=${x(hovered.t)} x2=${x(hovered.t)} y1=${MARGIN.top} y2=${MARGIN.top + innerH} />
              <circle class="crosshair-dot" cx=${x(hovered.t)} cy=${y(hovered.value)} r="5" />
              ${this.#renderTooltip(x(hovered.t), y(hovered.value), w, hovered)}
            `
          : null}
      </svg>
    `;
  }

  #renderTooltip(px: number, py: number, chartW: number, point: MetricPoint) {
    const text = `${this.#format(point.value)}${this.unit ? " " + this.unit : ""}  ·  ${formatTime(point.t)}`;
    const boxW = Math.max(90, text.length * 5.6);
    const boxH = 22;
    const flipLeft = px + 8 + boxW > chartW;
    const boxX = flipLeft ? px - 8 - boxW : px + 8;
    const boxY = Math.max(0, py - boxH - 8);
    return svg`
      <rect class="tooltip-bg" x=${boxX} y=${boxY} width=${boxW} height=${boxH} rx="4"></rect>
      <text class="tooltip-text" x=${boxX + 8} y=${boxY + boxH / 2 + 4}>${text}</text>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "metric-chart-modal": MetricChartModal;
  }
}
