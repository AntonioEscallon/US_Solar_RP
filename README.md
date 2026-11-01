# US Solar Repowering Map

An interactive map of aging US utility-scale solar and battery sites that could be repowered: new modules, trackers and inverters behind an interconnection that already exists.

It builds on Foundry-Logic and Crux's repowering study ([Heatmap coverage](https://heatmap.news/energy/solar-repowering-study)). The study finds that modern panels produce up to 70% more energy than older ones, and that repowering could unlock 9.6 GW by 2030 and 67 GW by 2040 without new land or a place in the interconnection queue. The visual style follows Robin Hawkes's [GB Renewables Map](https://renewables-map.robinhawkes.com/).

## What it shows

- Every operable utility-scale (≥1 MW) solar PV plant and battery plant in **EIA Form 860 (2025)**, about 7,300 solar and 960 battery plants
- Filters for commissioning year (defaults to 2010–2015, i.e. 10–15 years old), size, grid region (ISO/RTO), fixed vs. tracking racking, and battery on site
- One-click presets for the study's 2030 / 2035 / 2040 repowering waves
- ISO/RTO boundaries (from CommonGrid) drawn on a light basemap
- **NC contract cliff view** (built but hidden; set `SHOW_NC = true` in `docs/app.js` to enable). Every NC solar plant EIA flags as a PURPA qualifying facility, with an estimated contract expiry (15 years after entering service), a chart of MW expiring each year, and the battery each site would need under Duke's January 2026 proposal (10-year renewal for 4-hour storage sized at 20% or more of export). This gives 1.45 GW expiring in 2026–30 and 2.15 GW in 2026–31, which brackets Duke's 1.9 GW five-year figure.
- **Operator roll-up.** Portfolios ranked by MW for the current filter (EIA operator, usually the asset manager). Clicking an operator filters the map to their sites.
- Live totals for the current filter: site count, interconnected GW, and estimated added TWh/yr
- A ranked list of the sites with the largest estimated energy gain
- A detail card for each plant: capacity (AC/DC), age, racking, module technology, grid voltage, battery on site, operator and owners

With the default filters (2010–2015, ≥5 MW), there are about **483 sites totalling 10.1 GW<sub>AC</sub>**.

## Checks against the study

**Repowering waves.** EIA build years reproduce the study's totals if plants repower at about 15–18 years old:

| Study | EIA fleet (all sizes) | Built |
|---|---|---|
| 9.6 GW by 2030 | 12.1 GW | ≤2015 |
| 29 GW by 2035 | 30.6 GW | ≤2018 |
| 67 GW by 2040 | 72.2 GW | ≤2022 |

**Grid regions.** Plants are assigned to markets by their EIA balancing authority, not their location. A point-in-polygon check against the ISO boundaries shows why: about 2.3 GW of 2010–16 Arizona and Nevada solar is dynamically scheduled into CAISO, and LADWP and BANC plants sit inside California but outside the CAISO market. With the balancing-authority assignment, the 2030 wave is mostly CAISO and the non-RTO Southwest. MISO, which the study rates as having the most favorable repowering rules, has little old solar (0.4 GW built before 2017) but added 16 GW in 2023–25, so its rules matter most for the 2040 wave. SPP stays small in every vintage.

| GW<sub>AC</sub> by build year | ≤2012 | 2013–16 | 2017–19 | 2020–22 | 2023–25 |
|---|---|---|---|---|---|
| CAISO | 1.07 | 8.05 | 2.57 | 5.26 | 7.08 |
| Non-RTO | 0.97 | 6.74 | 7.48 | 12.15 | 24.63 |
| PJM | 0.49 | 1.16 | 1.72 | 4.22 | 10.47 |
| ERCOT | 0.08 | 0.50 | 2.02 | 8.77 | 18.66 |
| MISO | 0.01 | 0.43 | 1.00 | 3.16 | 16.20 |
| ISO-NE | 0.08 | 0.55 | 0.75 | 1.25 | 1.11 |
| SPP | 0.05 | 0.20 | 0.11 | 0.12 | 0.88 |
| NYISO | 0.04 | 0.08 | 0.42 | 0.80 | 1.61 |

**Batteries.** The study's 92 GW of storage by 2040 means new batteries added at repowered sites, about 1.4 MW of storage per MW of solar (13/9.6 and 92/67). Existing old batteries are a small pool: 0.7 GW built by 2015.

## Uplift estimate

The AC interconnection limit stays fixed. The "70%" figure refers to energy, not capacity. For each plant, the estimated uplift multiplies four effects:

| Effect | Assumption |
|---|---|
| Degradation recovered | 0.7%/yr of age |
| Fixed tilt → single-axis tracking | +20% on the fixed-tilt share |
| Bifacial modules | +5% |
| DC/AC ratio raised to 1.35 | 60% of the added DC becomes energy after clipping |

The result is capped at 70%. Added MWh uses an assumed capacity factor (20% fixed, 24% tracking). These are screening estimates; all the constants are at the top of [`pipeline/build_data.py`](pipeline/build_data.py).

## Run it

```bash
pip install -r pipeline/requirements.txt
python pipeline/build_data.py          # downloads EIA-860, writes docs/data/*.geojson
python -m http.server -d docs 8000     # open http://localhost:8000
```

`docs/` is a static site with no build step, so it can be served directly by GitHub Pages (Settings → Pages → `main` / `docs`).

## Possible next steps

- Replace the assumed capacity factors with actual generation from **EIA-923**, plus site-specific irradiance
- Overlay interconnection-queue data (LBNL *Queued Up*) and each ISO's repowering / surplus-interconnection rules (MISO and SPP are the most favorable, according to the study)
- Add site outlines and imagery from **USPVDB** (USGS/LBNL)
- Owner roll-ups showing which portfolios hold the most repowerable capacity

## Sources

EIA Form 860 (U.S. Energy Information Administration). ISO/RTO boundaries from [CommonGrid](https://github.com/internetblake/commongrid) (ODbL). Basemap © CARTO, © OpenStreetMap contributors.
