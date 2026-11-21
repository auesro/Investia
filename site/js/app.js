import { lineChart, formatDate } from "./chart.js";

// ---- What to show -------------------------------------------------------
// To add a panel: add the series to scripts/fetch_data.py, then list it here.
const num = (d) => (v) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (d) => (v) => `${num(d)(v)}%`;
const usd = (d) => (v) => `$${num(d)(v)}`;
const compactUsd = (v) => Math.abs(v) >= 1000 ? `$${num(0)(v / 1000)}k` : `$${num(0)(v)}`;

const KPIS = [
  { key: "ecb_mrr", label: "ECB main refinancing rate", format: pct(2), delta: "pp" },
  { key: "letras_12m", label: "Letras 12M (marginal)", format: pct(3), delta: "pp" },
  { key: "letras_3m", label: "Letras 3M (marginal)", format: pct(3), delta: "pp" },
  { key: "sp500", label: "S&P 500", format: num(0), delta: "pct" },
  { key: "dgs10", label: "US 10Y Treasury", format: pct(2), delta: "pp" },
  { key: "cpi_yoy", label: "US CPI inflation", format: pct(1), delta: "pp", monthly: true },
  { key: "wti", label: "WTI oil", format: usd(2), delta: "pct" },
  { key: "btc", label: "Bitcoin", format: usd(0), delta: "pct" },
];

const LETRAS = ["letras_3m", "letras_6m", "letras_9m", "letras_12m"];
const LETRAS_SHORT = { letras_3m: "3M", letras_6m: "6M", letras_9m: "9M", letras_12m: "12M" };

const SECTIONS = [
  {
    title: "Spain & euro area",
    panels: [
      {
        title: "Letras del Tesoro: auction yields", wide: true,
        sub: "Marginal (highest accepted) yield at each Spanish Treasury bill auction, by maturity (%)",
        series: LETRAS, short: LETRAS_SHORT, format: pct(3), tickFormat: pct(1), toleranceDays: 21,
      },
      { kind: "auctions", title: "Latest Letras auctions", sub: "Most recent auction for each maturity. Amounts in € millions." },
      {
        title: "ECB main refinancing rate", sub: "Interest rate on the ECB's main refinancing operations (%)",
        series: ["ecb_mrr"], format: pct(2), tickFormat: pct(1), step: true,
      },
    ],
  },
  {
    title: "United States & global markets",
    panels: [
      { title: "S&P 500", sub: "Index level, daily close", series: ["sp500"], format: num(0) },
      {
        title: "US interest rates", sub: "Percent per year, daily", series: ["dgs10", "dgs2", "dff"],
        short: { dgs10: "10Y", dgs2: "2Y", dff: "Fed" }, format: pct(2), tickFormat: pct(1),
      },
      {
        title: "US yield curve", sub: "10-year minus 2-year Treasury, percentage points", series: ["t10y2y"],
        format: (v) => `${num(2)(v)} pp`, tickFormat: num(1), refLines: [{ y: 0, label: "Below 0 = inverted" }],
      },
      {
        title: "US inflation", sub: "Consumer prices, % change from a year earlier, monthly", series: ["cpi_yoy"],
        format: pct(1), tickFormat: pct(0), refLines: [{ y: 2, label: "Fed target 2%" }], monthly: true,
      },
      { title: "US unemployment rate", sub: "Percent of labor force, monthly", series: ["unrate"], format: pct(1), tickFormat: pct(0), monthly: true },
      { title: "WTI crude oil", sub: "US dollars per barrel, daily", series: ["wti"], format: usd(2), tickFormat: usd(0) },
      { title: "EUR / USD", sub: "US dollars per euro, daily", series: ["eurusd"], format: num(4), tickFormat: num(2) },
      { title: "Bitcoin", sub: "US dollars, daily (Coinbase)", series: ["btc"], format: usd(0), tickFormat: compactUsd },
    ],
  },
];

const COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];

// ---- Theme toggle -------------------------------------------------------
const root = document.documentElement;
try { const saved = localStorage.getItem("theme"); if (saved) root.dataset.theme = saved; } catch {}
document.getElementById("theme-toggle").addEventListener("click", () => {
  const dark = root.dataset.theme
    ? root.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch {}
});

// ---- Data ---------------------------------------------------------------
async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function loadAll() {
  const index = await loadJSON("data/index.json");
  const entries = await Promise.all(index.series.map(async (meta) => {
    const s = await loadJSON(`data/${meta.key}.json`);
    s.points = s.data.map(([d, v]) => [Date.parse(d + "T00:00:00Z"), v]);
    return [meta.key, s];
  }));
  const data = Object.fromEntries(entries);
  let auctions = null;
  try {
    auctions = await loadJSON("data/letras_auctions.json");
  } catch (err) {
    console.warn("Letras auction details unavailable", err);
  }
  return { updated: index.updated, data, auctions };
}

// ---- Rendering ----------------------------------------------------------
function rangeStart(years, now) {
  if (!years) return -Infinity;
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.getTime();
}

function valueAtOrAfter(points, t) {
  return points.find((p) => p[0] >= t) || points[0];
}

function renderKpis(data, years) {
  const host = document.getElementById("kpis");
  host.replaceChildren();
  const label = years ? `${years}Y` : "since 2000";
  for (const k of KPIS) {
    const s = data[k.key];
    if (!s) continue;
    const last = s.points[s.points.length - 1];
    const first = valueAtOrAfter(s.points, rangeStart(years, last[0]));
    const tile = document.createElement("div");
    tile.className = "kpi";
    const l = document.createElement("div"); l.className = "kpi-label"; l.textContent = k.label;
    const v = document.createElement("div"); v.className = "kpi-value"; v.textContent = k.format(last[1]);
    const d = document.createElement("div"); d.className = "kpi-delta";
    const change = k.delta === "pct" ? (last[1] / first[1] - 1) * 100 : last[1] - first[1];
    const mark = document.createElement("span");
    mark.className = change >= 0 ? "up" : "down";
    const arrow = change >= 0 ? "▲" : "▼";
    mark.textContent = `${arrow} ${num(1)(Math.abs(change))}${k.delta === "pct" ? "%" : " pp"}`;
    d.append(mark, ` ${label}`);
    const asof = document.createElement("div"); asof.className = "kpi-date";
    asof.textContent = `as of ${formatDate(last[0], k.monthly)}`;
    tile.title = `${s.name}. Source: ${s.source}`;
    tile.append(l, v, d, asof);
    host.appendChild(tile);
  }
}

function monthlyRows(panel, data, from) {
  // One row per month (last observation), newest first, for the table view.
  const months = new Map();
  panel.series.forEach((key, i) => {
    for (const [t, v] of data[key].points) {
      if (t < from) continue;
      const d = new Date(t);
      const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      if (!months.has(mk)) months.set(mk, { t, vals: [] });
      const row = months.get(mk);
      row.t = Math.max(row.t, t);
      row.vals[i] = v;
    }
  });
  return [...months.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

function buildTable(panel, data, from) {
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  const th0 = document.createElement("th"); th0.textContent = "Month"; head.appendChild(th0);
  for (const key of panel.series) {
    const th = document.createElement("th");
    th.textContent = data[key].name;
    head.appendChild(th);
  }
  const body = table.createTBody();
  for (const [mk, row] of monthlyRows(panel, data, from)) {
    const tr = body.insertRow();
    tr.insertCell().textContent = formatDate(Date.parse(mk + "-01T00:00:00Z"), true);
    panel.series.forEach((_, i) => {
      tr.insertCell().textContent = row.vals[i] == null ? "–" : panel.format(row.vals[i]);
    });
  }
  return table;
}

function sourceLinks(keys, data) {
  const span = document.createElement("span");
  span.append("Source: ");
  const seen = new Set();
  for (const key of keys) {
    const d = data[key];
    if (!d || seen.has(d.url)) continue;
    if (seen.size) span.append(", ");
    seen.add(d.url);
    const a = document.createElement("a");
    a.href = d.url; a.rel = "noopener";
    a.textContent = d.source_short === "Tesoro" ? "Tesoro Público" : `${d.source_short || "FRED"} ${d.id}`;
    span.appendChild(a);
  }
  return span;
}

function cardShell(panel) {
  const card = document.createElement("article");
  card.className = panel.wide ? "card wide" : "card";
  const head = document.createElement("div"); head.className = "card-head";
  const titles = document.createElement("div");
  const h = document.createElement("h3"); h.textContent = panel.title;
  const sub = document.createElement("p"); sub.className = "sub"; sub.textContent = panel.sub;
  titles.append(h, sub);
  head.appendChild(titles);
  card.appendChild(head);
  return { card, head };
}

// Card with the latest auction for each Letras maturity (independent of the range filter).
function renderAuctionCard(panel, auctions, data) {
  const { card } = cardShell(panel);
  const tenors = [3, 6, 9, 12];
  const latest = tenors.map((t) => {
    const list = auctions.auctions.filter((a) => a.tenor === t);
    return { last: list[list.length - 1], prev: list[list.length - 2] };
  });
  const fmt = (v, d) => (v == null ? "–" : num(d)(v));
  const rows = [
    ["Auction date", ({ last }) => last && formatDate(Date.parse(last.date + "T00:00:00Z"))],
    ["Bid", ({ last }) => last && fmt(last.requested, 0)],
    ["Allotted", ({ last }) => last && fmt(last.allotted, 0)],
    ["Second round", ({ last }) => last && fmt(last.second_round, 0)],
    ["Bid-to-cover", ({ last }) => last && (last.cover ? `${fmt(last.cover, 2)}×` : "–")],
    ["Marginal yield", ({ last }) => last && pct(3)(last.marginal)],
    ["Average yield", ({ last }) => last && pct(3)(last.average)],
    ["Marginal vs previous", ({ last, prev }) => {
      if (!last || !prev) return "–";
      const d = last.marginal - prev.marginal;
      return `${d >= 0 ? "▲" : "▼"} ${num(3)(Math.abs(d))} pp`;
    }],
  ];
  const wrap = document.createElement("div"); wrap.className = "table-wrap static";
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  const th0 = document.createElement("th"); th0.textContent = "Maturity"; head.appendChild(th0);
  for (const t of tenors) {
    const th = document.createElement("th"); th.textContent = `${t}M`; th.title = `${t}-month Letras`; head.appendChild(th);
  }
  const body = table.createTBody();
  for (const [label, get] of rows) {
    const tr = body.insertRow();
    const th = document.createElement("th"); th.scope = "row"; th.textContent = label; tr.appendChild(th);
    for (const l of latest) tr.insertCell().textContent = get(l) ?? "–";
  }
  wrap.appendChild(table);
  card.appendChild(wrap);
  const foot = document.createElement("div"); foot.className = "card-foot";
  const src = document.createElement("span");
  src.append("Source: ");
  const a = document.createElement("a"); a.href = auctions.url; a.rel = "noopener"; a.textContent = "Tesoro Público, latest auction results";
  src.appendChild(a);
  foot.appendChild(src);
  card.appendChild(foot);
  return card;
}

function renderChartCard(panel, data) {
  const { card, head } = cardShell(panel);
  const toggle = document.createElement("button");
  toggle.className = "ghost"; toggle.type = "button"; toggle.textContent = "Table";
  toggle.setAttribute("aria-expanded", "false");
  head.appendChild(toggle);

  const series = panel.series.map((key, i) => ({
    name: data[key].name, short: panel.short?.[key], color: COLORS[i], data: data[key].points,
  }));
  if (series.length > 1) {
    const legend = document.createElement("ul"); legend.className = "legend";
    series.forEach((s) => {
      const li = document.createElement("li");
      const key = document.createElement("span"); key.className = "key"; key.style.background = s.color;
      li.append(key, s.name);
      legend.appendChild(li);
    });
    card.appendChild(legend);
  }

  const chartEl = document.createElement("div"); chartEl.className = "chart";
  const tableWrap = document.createElement("div"); tableWrap.className = "table-wrap"; tableWrap.hidden = true;
  card.append(chartEl, tableWrap);

  const foot = document.createElement("div"); foot.className = "card-foot";
  const hint = document.createElement("span"); hint.textContent = "Hover or use ← → keys";
  foot.append(sourceLinks(panel.series, data), hint);
  card.appendChild(foot);

  // The chart measures its container, so it is created once the card is in the page.
  let chart = null;
  let from = -Infinity;
  toggle.addEventListener("click", () => {
    const open = tableWrap.hidden;
    tableWrap.hidden = !open;
    chartEl.hidden = open;
    toggle.textContent = open ? "Chart" : "Table";
    toggle.setAttribute("aria-expanded", String(open));
    if (open) tableWrap.replaceChildren(buildTable(panel, data, from));
  });
  return {
    card,
    mount() { chart = lineChart(chartEl, series, { ...panel, label: `${panel.title}: ${panel.sub}` }); },
    setRange(f) {
      from = f; chart?.setRange(f);
      if (!tableWrap.hidden) tableWrap.replaceChildren(buildTable(panel, data, from));
    },
  };
}

function renderSections(data, auctions) {
  const host = document.getElementById("panels");
  const charts = [];
  for (const section of SECTIONS) {
    const sec = document.createElement("section");
    sec.className = "section";
    const h = document.createElement("h2"); h.className = "section-title"; h.textContent = section.title;
    const grid = document.createElement("div"); grid.className = "grid";
    for (const panel of section.panels) {
      if (panel.kind === "auctions") {
        if (auctions) grid.appendChild(renderAuctionCard(panel, auctions, data));
        continue;
      }
      if (!panel.series.every((k) => data[k])) continue;
      const c = renderChartCard(panel, data);
      grid.appendChild(c.card);
      charts.push(c);
    }
    if (!grid.children.length) continue;
    sec.append(h, grid);
    host.appendChild(sec);
  }
  charts.forEach((c) => c.mount());
  return charts;
}

async function main() {
  try {
    const { updated, data, auctions } = await loadAll();
    document.getElementById("updated").textContent =
      `Updated ${new Date(updated).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
    const charts = renderSections(data, auctions);
    const buttons = [...document.querySelectorAll("#range button")];
    const apply = (years) => {
      buttons.forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.range === years)));
      const from = rangeStart(years, Date.now());
      charts.forEach((c) => c.setRange(from));
      renderKpis(data, years);
    };
    buttons.forEach((b) => b.addEventListener("click", () => apply(+b.dataset.range)));
    apply(5);
  } catch (err) {
    const e = document.getElementById("error");
    e.hidden = false;
    e.textContent = `Could not load data (${err.message}). If running locally, run "python3 scripts/fetch_data.py" and serve the site folder with a local web server.`;
  }
}

main();
