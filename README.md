# Investia

A static website about investing and economics, hosted on GitHub Pages.
It shows chart panels built from public data. A GitHub Action fetches fresh
data every day and redeploys the site, so there is no server and no API key.

## What's on the page

- **Summary tiles:** ECB main refinancing rate, the latest 12-month and 3-month
  Letras del Tesoro marginal yields, S&P 500, US 10-year Treasury, US CPI inflation, WTI oil
  and Bitcoin. Each shows its latest value and its change over the selected range.
- **Spain & euro area:**
  - *Letras del Tesoro: auction yields.* The marginal (highest accepted) yield of
    every Spanish Treasury bill auction for the 3-, 6-, 9- and 12-month maturities, from 2000 on.
  - *Latest Letras auctions.* Amount bid, amount allotted, second-round amount,
    bid-to-cover ratio, marginal and average yield, and the change since the
    previous auction (marginal yield), for each maturity.
  - *ECB main refinancing rate.* The interest rate on the ECB's main refinancing operations.
- **United States & global markets:** S&P 500, US interest rates, the yield
  curve, inflation, unemployment, WTI oil, EUR/USD and Bitcoin.
- One range filter (1Y, 5Y, 10Y or Max) controls every chart. Each chart has a
  hover or keyboard tooltip and a monthly table view. Light and dark themes are included.

### Data sources (all public, no API keys)

| Data | Source |
|---|---|
| Letras del Tesoro auctions | [Tesoro Público](https://www.tesoro.es/deuda-publica/historico-de-estadisticas/subastas): the historical auctions workbook (2001 to last year), monthly bulletin table 11 (current year) and the [latest results page](https://www.tesoro.es/deuda-publica/subastas/resultado-ultimas-subastas/letras-del-tesoro) |
| ECB main refinancing rate | [ECB Data Portal](https://data.ecb.europa.eu/) API, series FM.D.U2.EUR.4F.KR.MRR_FR.LEV |
| US and market series | [FRED](https://fred.stlouisfed.org/) CSV download endpoint |

The Tesoro workbooks store each auction's day and month correctly, but often
with the wrong year. The fetcher takes the year from the sheet name instead.

## Project layout

```
scripts/fetch_data.py         downloads the series and writes site/data/*.json (stdlib only)
scripts/xlsx.py               minimal .xlsx reader used for the Tesoro workbooks
site/index.html               the whole page in one file: styles, chart code, and the
                              panel and summary tile configuration (see its section comments)
site/data/                    generated JSON data (not in git; created by the fetcher)
.github/workflows/deploy.yml  daily data refresh and GitHub Pages deploy
```

## Run locally

```bash
python3 scripts/fetch_data.py         # fetch data into site/data/
cd site && python3 -m http.server 8000
# open http://localhost:8000
```

## Publish on GitHub Pages

1. Create an empty repository on GitHub, for example `investia`.
2. Push this folder to its `main` branch:
   ```bash
   git remote add origin https://github.com/<you>/Investia.git
   git push -u origin main
   ```
3. In the repository, go to **Settings → Pages → Build and deployment → Source**
   and choose **GitHub Actions**.
4. The workflow runs on every push to `main`, every day at 06:17 UTC, and
   manually from the **Actions** tab. The site will be at
   `https://<you>.github.io/investia/`.

## Add a new panel

1. Find the series on FRED and copy its ID from the URL, for example `MORTGAGE30US`.
2. Add it to `FRED_SERIES` in `scripts/fetch_data.py` (or `ECB_SERIES` for an ECB series).
3. Add a panel to one of the `SECTIONS` (and, if you like, a summary tile to `KPIS`) in the script inside `site/index.html`.

Other public sources, such as the World Bank, ECB or Eurostat APIs, can be added
the same way. Write a fetch function that returns `[(date, value), ...]`.

*For information only. This is not investment advice.*
