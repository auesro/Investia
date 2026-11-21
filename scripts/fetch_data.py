#!/usr/bin/env python3
"""Download public economic/market series and write them as JSON for the site.

Uses only the Python standard library. Sources:
  * FRED (Federal Reserve Bank of St. Louis): public CSV endpoint, no API key
  * ECB Data Portal: key interest rates
  * Tesoro Público (Spain): Letras del Tesoro auction results

Run locally with:

    python3 scripts/fetch_data.py

Output: site/data/<key>.json plus site/data/index.json

If a source fails and the SITE_URL environment variable is set (the deployed
site), the previously published file is reused so one flaky source never
blanks a panel.
"""
from __future__ import annotations

import csv
import html
import io
import json
import os
import re
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xlsx  # noqa: E402  (tiny stdlib .xlsx reader next to this file)

START = "2000-01-01"
OUT_DIR = Path(__file__).resolve().parent.parent / "site" / "data"
USER_AGENT = "Mozilla/5.0 (compatible; investia-data-fetcher/1.0)"

FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={id}&cosd={start}"
FRED_PAGE = "https://fred.stlouisfed.org/series/{id}"
ECB_CSV = "https://data-api.ecb.europa.eu/service/data/FM/{id}?format=csvdata&detail=dataonly&startPeriod={start}"
ECB_PAGE = "https://data.ecb.europa.eu/data/datasets/FM/{id}"
TESORO = "https://www.tesoro.es"
TESORO_FILES = [
    # Every auction 2001 to last year, one sheet per year
    f"{TESORO}/documents/d/tesoro/historico_subastas-xlsx",
    # Monthly bulletin table 11: auctions of the current and previous year
    f"{TESORO}/documents/d/tesoro/11-xlsx",
]
TESORO_LATEST = f"{TESORO}/deuda-publica/subastas/resultado-ultimas-subastas/letras-del-tesoro"
TESORO_PAGE = f"{TESORO}/deuda-publica/historico-de-estadisticas/subastas"

FRED_SERIES = [
    {"key": "sp500", "id": "SP500", "name": "S&P 500", "unit": "index"},
    {"key": "dgs10", "id": "DGS10", "name": "10-year Treasury", "unit": "%"},
    {"key": "dgs2", "id": "DGS2", "name": "2-year Treasury", "unit": "%"},
    {"key": "dff", "id": "DFF", "name": "Fed funds rate", "unit": "%"},
    {"key": "t10y2y", "id": "T10Y2Y", "name": "10Y minus 2Y spread", "unit": "pp"},
    {"key": "cpi_yoy", "id": "CPIAUCSL", "name": "CPI inflation (YoY)", "unit": "%",
     "transform": "yoy", "fetch_start": "1999-01-01"},
    {"key": "unrate", "id": "UNRATE", "name": "Unemployment rate", "unit": "%"},
    {"key": "wti", "id": "DCOILWTICO", "name": "WTI crude oil", "unit": "USD/bbl"},
    {"key": "eurusd", "id": "DEXUSEU", "name": "EUR / USD", "unit": "USD per EUR"},
    {"key": "btc", "id": "CBBTCUSD", "name": "Bitcoin", "unit": "USD"},
]

ECB_SERIES = [
    {"key": "ecb_mrr", "id": "D.U2.EUR.4F.KR.MRR_FR.LEV", "name": "Main refinancing operations", "unit": "%"},
]

LETRAS_TENORS = [3, 6, 9, 12]  # months


# ---- HTTP -----------------------------------------------------------------
def get(url: str, retries: int = 4) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return resp.read()
        except Exception as err:  # network hiccup: back off and retry
            last_err = err
            time.sleep(2 ** attempt)
    raise RuntimeError(f"failed to fetch {url}: {last_err}")


# ---- FRED -----------------------------------------------------------------
def fetch_fred(series_id: str, start: str) -> list[tuple[str, float]]:
    text = get(FRED_CSV.format(id=series_id, start=start)).decode("utf-8")
    rows = []
    reader = csv.reader(io.StringIO(text))
    next(reader, None)  # header
    for row in reader:
        if len(row) < 2 or row[1] in ("", "."):
            continue  # FRED marks missing values (holidays) with "."
        try:
            rows.append((row[0], round(float(row[1]), 4)))
        except ValueError:
            continue
    return rows


def yoy(rows: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Year-over-year % change for a monthly series."""
    by_date = dict(rows)
    out = []
    for d, value in rows:
        prev = by_date.get(f"{int(d[:4]) - 1}{d[4:]}")
        if prev:
            out.append((d, round((value / prev - 1) * 100, 2)))
    return out


# ---- ECB ------------------------------------------------------------------
def fetch_ecb(series_id: str, start: str) -> list[tuple[str, float]]:
    text = get(ECB_CSV.format(id=series_id, start=start)).decode("utf-8")
    rows = []
    for rec in csv.DictReader(io.StringIO(text)):
        try:
            rows.append((rec["TIME_PERIOD"], float(rec["OBS_VALUE"])))
        except (KeyError, ValueError):
            continue
    return rows


def compress_steps(rows: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Keep only the points where a policy rate changes (plus the day before,
    so the line draws as a step) and the latest day. Cuts ~9k rows to ~100."""
    out = []
    for i, (d, v) in enumerate(rows):
        if i == 0 or i == len(rows) - 1 or v != rows[i - 1][1]:
            if i > 0 and v != rows[i - 1][1] and (not out or out[-1][0] != rows[i - 1][0]):
                out.append(rows[i - 1])
            out.append((d, v))
    return out


# ---- Tesoro: Letras del Tesoro auctions -----------------------------------
def excel_date(serial: str, year: int | None = None) -> str:
    d = date(1899, 12, 30) + timedelta(days=int(float(serial)))
    if year and d.year != year:
        # The Tesoro sheets store day and month correctly but often a wrong year
        # (e.g. the 2001 sheet holds 2022 serials); the sheet name is authoritative.
        d = d.replace(year=year, day=min(d.day, 28) if (d.month, d.day) == (2, 29) else d.day)
    return d.isoformat()


def num(cell: str | None) -> float | None:
    try:
        return float(cell) if cell not in (None, "", "-") else None
    except ValueError:
        return None


def parse_auction_workbook(data: bytes) -> list[dict]:
    """Short-term columns of the Tesoro auction sheets:
    A date (only on the first row of each auction day), B instrument ("L-3m"),
    C requested, D second-round amount, E allotted, F marginal yield, G average yield.
    """
    auctions = []
    for sheet, rows in xlsx.read(data).items():
        year = int(sheet) if sheet.isdigit() else None
        current = None
        for _, c in rows:
            a = c.get("A", "")
            if re.fullmatch(r"\d{5}(\.0+)?", a or ""):
                current = excel_date(a, year)
            m = re.fullmatch(r"L-\s*(\d+)\s*m", (c.get("B") or "").strip())
            if not (m and current):
                continue
            avg = num(c.get("G"))
            if avg is None:
                continue
            auctions.append({
                "date": current, "tenor": int(m.group(1)),
                "requested": num(c.get("C")), "allotted": num(c.get("E")),
                "second_round": num(c.get("D")) or 0.0,
                "marginal": num(c.get("F")), "average": avg,
            })
    return auctions


def es_num(s: str) -> float | None:
    s = s.strip().replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def parse_latest_page(page: str) -> list[dict]:
    """The 'results of the latest auctions' page: one column per tenor."""
    text = html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"<(script|style).*?</\1>", " ", page, flags=re.S)))
    text = re.sub(r"\s+", " ", text)
    num_re = r"(-?[\d.]+,\d+)"

    def row(label: str, pattern: str) -> list[str]:
        m = re.search(re.escape(label) + r"\s+" + r"\s+".join([pattern] * 4), text)
        return list(m.groups()) if m else []

    tenors = re.search(r"Plazo\s+(\d+) MESES\s+(\d+) MESES\s+(\d+) MESES\s+(\d+) MESES", text)
    dates = row("Fecha subasta", r"(\d{2}/\d{2}/\d{4})")
    requested = row("Nominal solicitado", num_re)
    allotted = row("Nominal adjudicado", num_re)
    second = row("Nominal adjudicado (2ª vuelta)", num_re)
    marginal = row("Tipo de interés marginal", num_re)
    average = row("Tipo de interés medio", num_re)
    if not (tenors and dates and average):
        return []
    out = []
    for i in range(4):
        d, mth, y = dates[i].split("/")
        out.append({
            "date": f"{y}-{mth}-{d}", "tenor": int(tenors.group(i + 1)),
            "requested": es_num(requested[i]) if requested else None,
            "allotted": es_num(allotted[i]) if allotted else None,
            "second_round": (es_num(second[i]) or 0.0) if second else 0.0,
            "marginal": es_num(marginal[i]) if marginal else None,
            "average": es_num(average[i]),
        })
    return out


def fetch_letras() -> list[dict]:
    merged: dict[tuple[str, int], dict] = {}
    errors = []
    for url in TESORO_FILES:
        try:
            for a in parse_auction_workbook(get(url)):
                merged[(a["date"], a["tenor"])] = a
        except Exception as err:
            errors.append(f"{url}: {err}")
    try:
        for a in parse_latest_page(get(TESORO_LATEST).decode("utf-8", "replace")):
            merged.setdefault((a["date"], a["tenor"]), a)
    except Exception as err:
        errors.append(f"{TESORO_LATEST}: {err}")
    for e in errors:
        print(f"  ! letras: {e}", file=sys.stderr)
    auctions = sorted(merged.values(), key=lambda a: (a["date"], a["tenor"]))
    for a in auctions:
        if a["requested"] and a["allotted"]:
            a["cover"] = round(a["requested"] / a["allotted"], 2)
    return [a for a in auctions if a["date"] >= START]


# ---- Output ---------------------------------------------------------------
def write_series(meta: dict, rows: list[tuple[str, float]], index: dict) -> None:
    meta = {**meta, "last_date": rows[-1][0]}
    payload = {**meta, "data": [[d, v] for d, v in rows]}
    (OUT_DIR / f"{meta['key']}.json").write_text(json.dumps(payload, separators=(",", ":")))
    index["series"].append(meta)
    print(f"  {meta['key']:10} {len(rows):6} obs, last {rows[-1][0]} = {rows[-1][1]}")


def fallback(key: str, index: dict) -> bool:
    """Reuse the file published on the live site when a source is down."""
    base = os.environ.get("SITE_URL", "").rstrip("/")
    if not base:
        return False
    try:
        payload = json.loads(get(f"{base}/data/{key}.json", retries=2))
        (OUT_DIR / f"{key}.json").write_text(json.dumps(payload, separators=(",", ":")))
        if "data" in payload:
            index["series"].append({k: v for k, v in payload.items() if k != "data"})
        print(f"  {key:10} reused previously published file")
        return True
    except Exception as err:
        print(f"  ! {key}: fallback failed: {err}", file=sys.stderr)
        return False


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "series": []}
    failures, total = 0, 0

    for s in FRED_SERIES:
        total += 1
        try:
            rows = fetch_fred(s["id"], s.get("fetch_start", START))
            if s.get("transform") == "yoy":
                rows = yoy(rows)
            rows = [r for r in rows if r[0] >= START]
            if not rows:
                raise RuntimeError("no observations")
            write_series({
                "key": s["key"], "id": s["id"], "name": s["name"], "unit": s["unit"],
                "source": "FRED, Federal Reserve Bank of St. Louis", "source_short": "FRED",
                "url": FRED_PAGE.format(id=s["id"]),
            }, rows, index)
        except Exception as err:
            print(f"  ! {s['key']}: {err}", file=sys.stderr)
            failures += 0 if fallback(s["key"], index) else 1

    for s in ECB_SERIES:
        total += 1
        try:
            rows = compress_steps(fetch_ecb(s["id"], START))
            if not rows:
                raise RuntimeError("no observations")
            write_series({
                "key": s["key"], "id": s["id"].split(".")[5], "name": s["name"], "unit": s["unit"],
                "source": "European Central Bank Data Portal", "source_short": "ECB",
                "url": ECB_PAGE.format(id=s["id"]), "step": True,
            }, rows, index)
        except Exception as err:
            print(f"  ! {s['key']}: {err}", file=sys.stderr)
            failures += 0 if fallback(s["key"], index) else 1

    total += 1
    keys = [f"letras_{t}m" for t in LETRAS_TENORS] + ["letras_auctions"]
    try:
        auctions = fetch_letras()
        if not auctions:
            raise RuntimeError("no auctions parsed")
        for t in LETRAS_TENORS:
            rows = [(a["date"], a["marginal"]) for a in auctions
                    if a["tenor"] == t and a["marginal"] is not None]
            write_series({
                "key": f"letras_{t}m", "id": f"L-{t}m", "name": f"{t}-month Letras",
                "unit": "%", "source": "Tesoro Público (Spain)", "source_short": "Tesoro",
                "url": TESORO_PAGE, "auction": True,
            }, rows, index)
        (OUT_DIR / "letras_auctions.json").write_text(json.dumps(
            {"source": "Tesoro Público (Spain)", "url": TESORO_LATEST, "auctions": auctions},
            separators=(",", ":")))
        print(f"  letras_auctions {len(auctions)} auctions, last {auctions[-1]['date']}")
    except Exception as err:
        print(f"  ! letras: {err}", file=sys.stderr)
        if not all([fallback(k, index) for k in keys]):
            failures += 1

    (OUT_DIR / "index.json").write_text(json.dumps(index, indent=1))
    # Fail the job only if everything failed, so one flaky source doesn't block a deploy.
    return 1 if failures == total else 0


if __name__ == "__main__":
    sys.exit(main())
