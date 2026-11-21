// Minimal dependency-free SVG line chart with crosshair tooltip and keyboard support.
const NS = "http://www.w3.org/2000/svg";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

function niceTicks(min, max, count) {
  if (min === max) { min -= 1; max += 1; }
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function timeTicks(t0, t1, maxTicks) {
  const years = (t1 - t0) / (365.25 * 864e5);
  const out = [];
  if (years > 2) {
    const every = [1, 2, 5, 10].find((n) => years / n <= maxTicks) || 10;
    let y = new Date(t0).getUTCFullYear() + 1;
    y = Math.ceil(y / every) * every;
    for (; ; y += every) {
      const t = Date.UTC(y, 0, 1);
      if (t > t1) break;
      out.push({ t, label: String(y) });
    }
  } else {
    const months = years * 12;
    const every = [1, 2, 3, 6].find((n) => months / n <= maxTicks) || 6;
    const d = new Date(t0);
    let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    m = Math.ceil(m / every) * every;
    for (; ; m += every) {
      const t = Date.UTC(y + Math.floor(m / 12), m % 12, 1);
      if (t > t1) break;
      const dt = new Date(t);
      const mm = dt.getUTCMonth();
      out.push({ t, label: mm === 0 ? String(dt.getUTCFullYear()) : MONTHS[mm] });
    }
  }
  return out;
}

// Keep the shape on screen by retaining min and max of each pixel bucket.
function downsample(points, buckets) {
  if (points.length <= buckets * 2) return points;
  const out = [];
  const size = points.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size), end = Math.min(points.length, Math.floor((b + 1) * size));
    let lo = start, hi = start;
    for (let i = start; i < end; i++) {
      if (points[i][1] < points[lo][1]) lo = i;
      if (points[i][1] > points[hi][1]) hi = i;
    }
    if (lo === hi) out.push(points[lo]);
    else if (lo < hi) out.push(points[lo], points[hi]);
    else out.push(points[hi], points[lo]);
  }
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function bisect(points, t) {
  let lo = 0, hi = points.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1][0] - t) < Math.abs(points[lo][0] - t)) lo--;
  return lo;
}

export function formatDate(t, monthly) {
  const d = new Date(t);
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return monthly ? base : `${d.getUTCDate()} ${base}`;
}

/**
 * series: [{ name, color: "var(--series-1)", data: [[ms, value], ...] }]
 * opts: { format(v), tickFormat(v), refLines: [{ y, label }], monthly, includeZero }
 */
export function lineChart(container, series, opts = {}) {
  const format = opts.format || ((v) => v.toLocaleString());
  const tickFormat = opts.tickFormat || format;
  let range = [-Infinity, Infinity];
  let hoverIndex = null; // index into the primary series' visible points
  let state = null;

  container.tabIndex = 0;
  container.setAttribute("role", "img");
  const svg = el("svg", {}, container);
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  container.appendChild(tip);

  function render() {
    const W = container.clientWidth, H = container.clientHeight;
    if (!W || !H) return;
    svg.replaceChildren();
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    const visible = series.map((s) => {
      const pts = s.data.filter((p) => p[0] >= range[0] && p[0] <= range[1]);
      if (opts.step) {
        // Step series store only change points: carry the rate in force at the range start.
        const before = s.data.filter((p) => p[0] < range[0]);
        if (before.length) pts.unshift([range[0], before[before.length - 1][1]]);
      }
      return pts;
    });
    const all = visible.flat();
    if (!all.length) return;
    let t0 = Infinity, t1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [t, v] of all) {
      if (t < t0) t0 = t; if (t > t1) t1 = t;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    for (const r of opts.refLines || []) { v0 = Math.min(v0, r.y); v1 = Math.max(v1, r.y); }
    if (opts.includeZero) { v0 = Math.min(v0, 0); v1 = Math.max(v1, 0); }
    const pad = (v1 - v0) * 0.06 || 1;
    const lo = v0 >= 0 && v0 - pad < 0 ? 0 : v0 - pad; // don't invent negative axis room
    const yt = niceTicks(lo, v1 + pad, H < 220 ? 4 : 5);
    // If the short tick format collapses neighbours (4%, 4%), fall back to the full format.
    let fmtTick = tickFormat;
    if (new Set(yt.map(tickFormat)).size < yt.length) fmtTick = format;
    const yMin = yt[0], yMax = yt[yt.length - 1];

    const labelW = Math.max(...yt.map((v) => fmtTick(v).length)) * 6.6 + 10;
    const endLabels = series.length > 1;
    const m = { top: 8, right: endLabels ? 44 : 8, bottom: 24, left: labelW };
    const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
    const x = (t) => m.left + ((t - t0) / (t1 - t0 || 1)) * iw;
    const y = (v) => m.top + (1 - (v - yMin) / (yMax - yMin)) * ih;

    // Grid + y ticks
    for (const v of yt) {
      el("line", { class: "gridline", x1: m.left, x2: m.left + iw, y1: y(v), y2: y(v) }, svg);
      const lbl = el("text", { class: "tick", x: m.left - 8, y: y(v) + 4, "text-anchor": "end" }, svg);
      lbl.textContent = fmtTick(v);
    }
    el("line", { class: "baseline", x1: m.left, x2: m.left + iw, y1: m.top + ih, y2: m.top + ih }, svg);

    // X ticks
    for (const tk of timeTicks(t0, t1, Math.max(2, Math.floor(iw / 70)))) {
      const lbl = el("text", { class: "tick", x: x(tk.t), y: H - 6, "text-anchor": "middle" }, svg);
      lbl.textContent = tk.label;
    }

    // Reference lines
    for (const r of opts.refLines || []) {
      el("line", { class: "refline", x1: m.left, x2: m.left + iw, y1: y(r.y), y2: y(r.y) }, svg);
      if (r.label) {
        const lbl = el("text", { class: "reflabel", x: m.left + iw - 4, y: y(r.y) + 14, "text-anchor": "end" }, svg);
        lbl.textContent = r.label;
      }
    }

    // Lines
    const buckets = Math.max(50, Math.floor(iw));
    const ends = [];
    visible.forEach((pts, i) => {
      if (!pts.length) return;
      const ds = downsample(pts, buckets);
      const d = ds.map((p, j) => `${j ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
      el("path", { class: "series", d, stroke: series[i].color }, svg);
      const last = pts[pts.length - 1];
      ends.push({ i, y: y(last[1]), x: x(last[0]) });
    });

    // Direct labels at the right end, nudged apart so they never collide
    if (endLabels) {
      ends.sort((a, b) => a.y - b.y);
      for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 14) ends[k].y = ends[k - 1].y + 14;
      for (const e of ends) {
        const lbl = el("text", { class: "endlabel", x: m.left + iw + 6, y: e.y + 4 }, svg);
        lbl.textContent = series[e.i].short || series[e.i].name;
      }
    }

    // Hover layer
    const hover = el("g", { "pointer-events": "none" }, svg);
    // Hover stops: every date present in any visible series, so series observed on
    // different days (e.g. Letras tenors auctioned on alternate weeks) are all reachable.
    const stops = [...new Set(all.map((p) => p[0]))].sort((a, b) => a - b).map((t) => [t]);
    state = { x, y, m, iw, ih, visible, hover, W, t0, t1, stops };
    container.setAttribute("aria-label", opts.label || series.map((s) => s.name).join(", "));
    if (hoverIndex !== null) drawHover();
  }

  function drawHover() {
    const { x, y, m, ih, visible, hover, W } = state;
    hover.replaceChildren();
    const stops = state.stops;
    if (!stops.length) { tip.hidden = true; return; }
    hoverIndex = Math.max(0, Math.min(stops.length - 1, hoverIndex));
    const t = stops[hoverIndex][0];
    const tolerance = (opts.toleranceDays ?? (opts.monthly ? 35 : 7)) * 864e5;
    const px = x(t);
    el("line", { class: "crosshair", x1: px, x2: px, y1: m.top, y2: m.top + ih }, hover);

    tip.replaceChildren();
    const date = document.createElement("div");
    date.className = "tip-date";
    date.textContent = formatDate(t, opts.monthly);
    tip.appendChild(date);
    visible.forEach((pts, i) => {
      let j = bisect(pts, t);
      if (j < 0) return;
      if (opts.step && pts[j][0] > t) j -= 1; // rate in force on that date
      if (j < 0) return;
      const p = pts[j];
      if (!opts.step && Math.abs(p[0] - t) > tolerance) return; // no nearby value
      el("circle", { class: "dot", cx: x(opts.step ? t : p[0]), cy: y(p[1]), r: 4.5, fill: series[i].color }, hover);
      const row = document.createElement("div");
      row.className = "tip-row";
      const key = document.createElement("span");
      key.className = "key";
      key.style.background = series[i].color;
      const val = document.createElement("b");
      val.textContent = format(p[1]);
      const name = document.createElement("span");
      name.textContent = series[i].name;
      row.append(key, val, name);
      if (p[0] !== t && !opts.monthly && !opts.step) {
        const when = document.createElement("span");
        when.className = "tip-when";
        when.textContent = formatDate(p[0]);
        row.appendChild(when);
      }
      tip.appendChild(row);
    });
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const left = px + 14 + tw > W ? px - 14 - tw : px + 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${m.top}px`;
  }

  function onPointer(ev) {
    if (!state) return;
    const rect = container.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const { m, iw, visible } = state;
    if (px < m.left - 10 || px > m.left + iw + 10) return hide();
    if (!state.stops.length) return;
    const t = state.t0 + ((px - m.left) / iw) * (state.t1 - state.t0);
    hoverIndex = bisect(state.stops, t);
    drawHover();
  }

  function hide() {
    hoverIndex = null;
    tip.hidden = true;
    if (state) state.hover.replaceChildren();
  }

  container.addEventListener("pointermove", onPointer);
  container.addEventListener("pointerdown", onPointer);
  container.addEventListener("pointerleave", hide);
  container.addEventListener("blur", hide);
  container.addEventListener("keydown", (ev) => {
    if (!state) return;
    const n = state.stops.length;
    const stepSize = ev.shiftKey ? Math.max(1, Math.round(n / 20)) : 1;
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      if (hoverIndex === null) hoverIndex = n - 1;
      else hoverIndex += ev.key === "ArrowRight" ? stepSize : -stepSize;
    } else if (ev.key === "Home") hoverIndex = 0;
    else if (ev.key === "End") hoverIndex = n - 1;
    else if (ev.key === "Escape") return hide();
    else return;
    ev.preventDefault();
    drawHover();
  });

  new ResizeObserver(() => render()).observe(container);

  return {
    setRange(from, to = Infinity) { range = [from, to]; hide(); render(); },
  };
}
