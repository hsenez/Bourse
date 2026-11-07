"use strict";

/* Formatage ---------------------------------------------------------------- */

const _fmtCache = new Map();
function dateFormatter(tz, opts) {
  const key = tz + JSON.stringify(opts);
  if (!_fmtCache.has(key)) {
    let f;
    try {
      f = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, ...opts });
    } catch {
      f = new Intl.DateTimeFormat("fr-FR", opts);
    }
    _fmtCache.set(key, f);
  }
  return _fmtCache.get(key);
}

function decimalsFor(v) {
  const a = Math.abs(v);
  if (a >= 1) return 2;
  if (a >= 0.01) return 4;
  return 6;
}

function formatNumber(v, decimals) {
  if (v == null || !isFinite(v)) return "—";
  const d = decimals ?? decimalsFor(v);
  return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
}

function formatCompact(v) {
  if (v == null || !isFinite(v)) return "—";
  return new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

function formatPct(v, signed = true) {
  if (v == null || !isFinite(v)) return "—";
  const s = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  return (signed && v > 0 ? "+" : "") + s + " %";
}

const AXIS_DATE_FORMATS = {
  "1d": { hour: "2-digit", minute: "2-digit" },
  "5d": { weekday: "short", hour: "2-digit", minute: "2-digit" },
  "1mo": { day: "numeric", month: "short" },
  "6mo": { day: "numeric", month: "short" },
  ytd: { day: "numeric", month: "short" },
  "1y": { day: "numeric", month: "short" },
  "5y": { month: "short", year: "numeric" },
  max: { month: "short", year: "numeric" },
};

function formatAxisDate(ts, data) {
  return dateFormatter(data.timezone, AXIS_DATE_FORMATS[data.period] || AXIS_DATE_FORMATS["1y"]).format(ts * 1000);
}

function formatFullDate(ts, data) {
  const d = ts * 1000;
  if (data.intraday) {
    return dateFormatter(data.timezone, {
      weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(d);
  }
  const s = dateFormatter(data.timezone, { weekday: "short", day: "numeric", month: "long", year: "numeric" }).format(d);
  return data.interval === "1wk" ? "Semaine du " + s : s;
}

/* Indicateurs --------------------------------------------------------------- */

function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null) { sum += v; count++; }
    const old = i >= n ? values[i - n] : null;
    if (i >= n && old != null) { sum -= old; count--; }
    if (i >= n - 1 && count === n) out[i] = sum / n;
  }
  return out;
}

function bollinger(values, n = 20, k = 2) {
  const mid = sma(values, n);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    if (mid[i] == null) continue;
    let acc = 0;
    for (let j = i - n + 1; j <= i; j++) acc += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(acc / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}

/* Graphique ---------------------------------------------------------------- */

const OVERLAY_COLORS = { ma20: "#e8a23a", ma50: "#9b6cf0", ma200: "#20a4c4", boll: "#8b97a6" };

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function withAlpha(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

class StockChart {
  /**
   * @param {HTMLElement} el conteneur du graphique
   * @param {HTMLElement} rectEl rectangle de sélection (zoom sur une zone)
   * @param {(zoomed: boolean) => void} onZoomChange
   */
  constructor(el, rectEl, onZoomChange) {
    this.el = el;
    this.rectEl = rectEl;
    this.onZoomChange = onZoomChange || (() => {});
    this.chart = echarts.init(el, null, { renderer: "canvas" });
    this.data = null;
    this.opts = {};
    this.key = null;
    this.zoom = { start: 0, end: 100 };
    this.yRange = null;
    this._rectZooming = false;

    new ResizeObserver(() => this.chart.resize()).observe(el);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.render());

    this.chart.on("datazoom", () => this._onDataZoom());
    this.chart.getZr().on("dblclick", () => this.resetZoom());
    this._initRectZoom();
    this._initDoubleTap();
  }

  /** Affiche de nouvelles données. Le zoom est conservé si le symbole et la période sont inchangés. */
  setData(data, opts) {
    const key = data.symbol + "|" + data.period;
    if (key !== this.key) {
      this.zoom = { start: 0, end: 100 };
      this.yRange = null;
      this.key = key;
    }
    this.data = data;
    this.opts = { ...opts };
    this.render();
  }

  setOptions(opts) {
    const scaleChanged = !!opts.pct !== !!this.opts.pct || !!opts.log !== !!this.opts.log;
    this.opts = { ...opts };
    if (scaleChanged) this.yRange = null;
    this.render();
  }

  clear() {
    this.data = null;
    this.key = null;
    this.chart.clear();
  }

  isZoomed() {
    return this.zoom.start > 0.01 || this.zoom.end < 99.99 || this.yRange !== null;
  }

  resetZoom() {
    if (!this.data) return;
    this.yRange = null;
    this.chart.setOption({ yAxis: [{ id: "y", min: null, max: null }] });
    this.chart.dispatchAction({ type: "dataZoom", dataZoomId: "zx", start: 0, end: 100 });
  }

  _onDataZoom() {
    const dz = this.chart.getOption().dataZoom[0];
    this.zoom = { start: dz.start, end: dz.end };
    // Zoom molette / pincement / déplacement : l'axe vertical redevient automatique.
    if (!this._rectZooming && this.yRange) {
      this.yRange = null;
      setTimeout(() => this.chart.setOption({ yAxis: [{ id: "y", min: null, max: null }] }), 0);
    }
    this.onZoomChange(this.isZoomed());
  }

  /* Zoom sur une zone : clic molette (ou Maj + clic gauche) puis glisser. */
  _initRectZoom() {
    const el = this.el;
    el.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener("mousedown", (e) => {
      const middle = e.button === 1;
      const shiftLeft = e.button === 0 && e.shiftKey;
      if ((!middle && !shiftLeft) || !this.data) return;
      e.preventDefault();
      e.stopPropagation(); // empêche ECharts de démarrer un déplacement
      const box = el.getBoundingClientRect();
      const clampX = (x) => Math.min(Math.max(x - box.left, 0), box.width);
      const clampY = (y) => Math.min(Math.max(y - box.top, 0), box.height);
      const x0 = clampX(e.clientX);
      const y0 = clampY(e.clientY);
      let x1 = x0;
      let y1 = y0;
      const r = this.rectEl.style;
      const draw = () => {
        r.left = Math.min(x0, x1) + "px";
        r.top = Math.min(y0, y1) + "px";
        r.width = Math.abs(x1 - x0) + "px";
        r.height = Math.abs(y1 - y0) + "px";
      };
      draw();
      this.rectEl.hidden = false;

      const move = (ev) => {
        ev.stopPropagation();
        x1 = clampX(ev.clientX);
        y1 = clampY(ev.clientY);
        draw();
      };
      const up = (ev) => {
        ev.stopPropagation();
        window.removeEventListener("mousemove", move, true);
        window.removeEventListener("mouseup", up, true);
        this.rectEl.hidden = true;
        if (Math.abs(x1 - x0) < 8 || Math.abs(y1 - y0) < 8) return;
        this._zoomToRect(x0, y0, x1, y1);
      };
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mouseup", up, true);
    }, true);
  }

  _zoomToRect(x0, y0, x1, y1) {
    const n = this.data.t.length;
    const a = this.chart.convertFromPixel({ gridIndex: 0 }, [Math.min(x0, x1), Math.min(y0, y1)]);
    const b = this.chart.convertFromPixel({ gridIndex: 0 }, [Math.max(x0, x1), Math.max(y0, y1)]);
    if (!a || !b) return;
    const clampI = (i) => Math.min(Math.max(Math.round(i), 0), n - 1);
    const i0 = clampI(a[0]);
    const i1 = clampI(b[0]);
    if (i1 - i0 < 1) return;
    const yMin = Math.min(a[1], b[1]);
    const yMax = Math.max(a[1], b[1]);
    this._rectZooming = true;
    if (isFinite(yMin) && isFinite(yMax) && yMax > yMin && !(this.opts.log && !this.opts.pct && yMin <= 0)) {
      this.yRange = [yMin, yMax];
      this.chart.setOption({ yAxis: [{ id: "y", min: yMin, max: yMax }] });
    }
    this.chart.dispatchAction({ type: "dataZoom", dataZoomId: "zx", startValue: i0, endValue: i1 });
    setTimeout(() => { this._rectZooming = false; }, 0);
  }

  /* Double-tap sur écran tactile : réinitialise le zoom. */
  _initDoubleTap() {
    let start = null;
    let lastTap = 0;
    this.el.addEventListener("touchstart", (e) => {
      start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
    }, { passive: true });
    this.el.addEventListener("touchend", (e) => {
      if (!start || e.touches.length > 0) return;
      const t = e.changedTouches[0];
      const still = Math.hypot(t.clientX - start.x, t.clientY - start.y) < 12 && Date.now() - start.t < 300;
      start = null;
      if (!still) { lastTap = 0; return; }
      const now = Date.now();
      if (now - lastTap < 320) {
        lastTap = 0;
        this.resetZoom();
      } else {
        lastTap = now;
      }
    }, { passive: true });
  }

  render() {
    if (!this.data) return;
    this.chart.setOption(this._buildOption(), { notMerge: true });
  }

  _buildOption() {
    const data = this.data;
    const o = this.opts;
    const n = data.t.length;
    const colors = {
      text: cssVar("--text"), muted: cssVar("--muted"), border: cssVar("--border"),
      surface: cssVar("--surface"), up: cssVar("--up"), down: cssVar("--down"),
    };

    const base = data.c.find((v) => v != null);
    const pct = !!o.pct && base;
    const tf = pct ? (v) => (v == null ? null : (v / base - 1) * 100) : (v) => v;
    const fmtY = pct ? (v) => formatPct(v) : (v) => formatNumber(v);

    const closes = data.c.map(tf);
    const last = data.c[n - 1];
    const lineColor = last != null && base != null && last < base ? colors.down : colors.up;

    const hasVolume = !!o.volume && data.v.some((v) => v);
    const useLog = !!o.log && !pct;

    // Marge droite adaptée à la largeur des libellés de l'axe des valeurs.
    const maxVal = Math.max(...data.h.filter((v) => v != null).map((v) => Math.abs(tf(v))), 1);
    const right = Math.max(48, Math.round(fmtY(maxVal).length * 7.2 + 18));

    const grids = hasVolume
      ? [{ left: 10, right, top: 16, bottom: "28%" }, { left: 10, right, height: "16%", bottom: 26 }]
      : [{ left: 10, right, top: 16, bottom: 28 }];

    const xAxisCommon = {
      type: "category",
      data: data.t,
      boundaryGap: !!o.candles,
      axisLine: { lineStyle: { color: colors.border } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisPointer: { label: { formatter: (p) => formatFullDate(Number(p.value), data) } },
    };
    const xAxis = [{
      ...xAxisCommon,
      gridIndex: 0,
      axisLabel: {
        show: !hasVolume, color: colors.muted, hideOverlap: true, alignMinLabel: "left",
        formatter: (v) => formatAxisDate(Number(v), data),
      },
    }];
    if (hasVolume) {
      xAxis.push({
        ...xAxisCommon,
        gridIndex: 1,
        axisLabel: {
          color: colors.muted, hideOverlap: true, alignMinLabel: "left",
          formatter: (v) => formatAxisDate(Number(v), data),
        },
      });
    }

    const yAxis = [{
      id: "y",
      type: useLog ? "log" : "value",
      gridIndex: 0,
      position: "right",
      scale: true,
      min: this.yRange ? this.yRange[0] : null,
      max: this.yRange ? this.yRange[1] : null,
      axisLabel: { color: colors.muted, formatter: (v) => fmtY(v) },
      splitLine: { lineStyle: { color: colors.border, opacity: 0.7 } },
      axisPointer: { label: { formatter: (p) => fmtY(p.value) } },
    }];
    if (hasVolume) {
      yAxis.push({
        id: "yv", type: "value", gridIndex: 1, position: "right", splitNumber: 2,
        axisLabel: { color: colors.muted, formatter: (v) => formatCompact(v) },
        splitLine: { show: false },
        axisPointer: { label: { formatter: (p) => formatCompact(p.value) } },
      });
    }

    const series = [];
    if (o.candles) {
      series.push({
        id: "main", name: "Cours", type: "candlestick",
        data: data.t.map((_, i) => [tf(data.o[i]), tf(data.c[i]), tf(data.l[i]), tf(data.h[i])]),
        itemStyle: { color: colors.up, color0: colors.down, borderColor: colors.up, borderColor0: colors.down },
      });
    } else {
      series.push({
        id: "main", name: "Cours", type: "line", data: closes,
        showSymbol: false, connectNulls: true, sampling: "lttb",
        lineStyle: { width: 1.8, color: lineColor },
        itemStyle: { color: lineColor },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: withAlpha(lineColor, 0.18) },
            { offset: 1, color: withAlpha(lineColor, 0) },
          ]),
        },
        emphasis: { disabled: true },
      });
    }

    if (data.period === "1d" && data.previousClose && !pct) {
      series[0].markLine = {
        symbol: "none", silent: true, animation: false,
        data: [{ yAxis: data.previousClose }],
        lineStyle: { type: "dashed", color: colors.muted, width: 1 },
        label: { position: "insideStartTop", color: colors.muted, fontSize: 10, formatter: "Clôture préc." },
      };
    }

    const overlay = (id, name, values, color, dashed = false) => series.push({
      id, name, type: "line", data: values.map(tf), showSymbol: false, connectNulls: false,
      lineStyle: { width: 1.2, color, type: dashed ? "dashed" : "solid" }, itemStyle: { color },
      emphasis: { disabled: true }, z: 3,
    });
    if (o.ma20) overlay("ma20", "MM 20", sma(data.c, 20), OVERLAY_COLORS.ma20);
    if (o.ma50) overlay("ma50", "MM 50", sma(data.c, 50), OVERLAY_COLORS.ma50);
    if (o.ma200) overlay("ma200", "MM 200", sma(data.c, 200), OVERLAY_COLORS.ma200);
    if (o.bollinger) {
      const b = bollinger(data.c);
      overlay("bollU", "Bollinger haut", b.upper, OVERLAY_COLORS.boll, true);
      overlay("bollL", "Bollinger bas", b.lower, OVERLAY_COLORS.boll, true);
    }

    if (hasVolume) {
      series.push({
        id: "volume", name: "Volume", type: "bar", xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 12,
        data: data.v.map((v, i) => ({
          value: v,
          itemStyle: { color: withAlpha(data.c[i] >= data.o[i] ? colors.up : colors.down, 0.55) },
        })),
        emphasis: { disabled: true },
      });
    }

    return {
      animation: false,
      backgroundColor: "transparent",
      textStyle: { fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" },
      grid: grids,
      xAxis,
      yAxis,
      series,
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      dataZoom: [{
        type: "inside", id: "zx", xAxisIndex: hasVolume ? [0, 1] : [0],
        start: this.zoom.start, end: this.zoom.end,
        filterMode: "filter", minValueSpan: 3,
        zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false, preventDefaultMouseMove: true,
      }],
      tooltip: {
        trigger: "axis",
        confine: true,
        backgroundColor: colors.surface,
        borderColor: colors.border,
        textStyle: { color: colors.text, fontSize: 12 },
        axisPointer: {
          type: "cross",
          lineStyle: { color: colors.muted, type: "dashed" },
          crossStyle: { color: colors.muted },
          label: { backgroundColor: colors.muted, color: colors.surface },
        },
        formatter: (params) => this._tooltip(params, fmtY, colors),
      },
    };
  }

  _tooltip(params, fmtY, colors) {
    if (!params.length) return "";
    const i = params[0].dataIndex;
    const d = this.data;
    const rows = [`<div style="color:${colors.muted};margin-bottom:4px">${formatFullDate(d.t[i], d)}</div>`];
    const row = (label, value, color) =>
      `<div style="display:flex;justify-content:space-between;gap:16px">` +
      `<span style="color:${color || colors.muted}">${label}</span><b>${value}</b></div>`;
    for (const p of params) {
      if (p.seriesId === "main") {
        if (this.opts.candles) {
          const [oo, cc, ll, hh] = p.data; // [ouverture, clôture, bas, haut]
          rows.push(row("Ouv.", fmtY(oo)), row("Haut", fmtY(hh)), row("Bas", fmtY(ll)), row("Clôt.", fmtY(cc)));
        } else {
          rows.push(row("Cours", fmtY(p.value)));
        }
      } else if (p.seriesId === "volume") {
        rows.push(row("Volume", formatCompact(p.value?.value ?? p.value)));
      } else if (p.value != null) {
        rows.push(row(p.seriesName, fmtY(p.value), p.color));
      }
    }
    return rows.join("");
  }
}
