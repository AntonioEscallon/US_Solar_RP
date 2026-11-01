"""Build the map's GeoJSON layers from EIA Form 860.

Downloads the EIA-860 annual release, rolls solar and battery generators up to
the plant level, attaches location / grid region / owner, and estimates the
energy uplift a repowering could deliver within the existing interconnection.

Usage:  python pipeline/build_data.py [--year 2025]
Output: docs/data/{solar,storage,isos}.geojson, docs/data/meta.json
"""

import argparse
import io
import json
import zipfile
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "pipeline" / "raw"
OUT = ROOT / "docs" / "data"

# Balancing authority code -> organized market. Everything else is a
# vertically integrated utility region (Southeast, most of the West).
ISO_BY_BA = {
    "MISO": "MISO",
    "SWPP": "SPP",
    "ERCO": "ERCOT",
    "CISO": "CAISO",
    "PJM": "PJM",
    "NYIS": "NYISO",
    "ISNE": "ISO-NE",
}

COMMONGRID = "https://raw.githubusercontent.com/internetblake/commongrid/HEAD/data/territories"
ISO_TERRITORIES = {
    "caiso": "CAISO", "ercot": "ERCOT", "miso": "MISO", "spp": "SPP", "pjm": "PJM",
    "nyiso": "NYISO", "iso-ne": "ISO-NE", "west-non-iso": "Non-RTO", "southeast-non-iso": "Non-RTO",
}

# --- Repowering uplift assumptions (indicative, see README) -----------------
DEGRADATION_PER_YEAR = 0.007   # typical c-Si annual output loss
TRACKER_GAIN = 0.20            # fixed-tilt -> single-axis tracking energy gain
BIFACIAL_GAIN = 0.05           # modern bifacial modules on trackers
TARGET_DC_AC = 1.35            # modern DC/AC ratio within the same AC limit
DC_AC_ENERGY_ELASTICITY = 0.6  # share of added DC that becomes energy after clipping
UPLIFT_CAP = 0.70              # study's "up to 70% more energy"
BASE_CF = {"fixed": 0.20, "tracking": 0.24}

# --- North Carolina legacy PURPA contracts ----------------------------------
# Pre-HB 589 standard-offer contracts ran 15 years; we assume the term starts at
# the in-service year. Duke's 2026 proposal offers a 10-year renewal to sites
# that add 4-hour storage sized at >=20% of export capacity.
NC_QF_TERM_YEARS = 15
NC_BATTERY_SHARE = 0.20
NC_BATTERY_HOURS = 4


def download(year: int) -> Path:
    dest = RAW / f"eia860{year}"
    if dest.exists():
        return dest
    url = f"https://www.eia.gov/electricity/data/eia860/xls/eia860{year}.zip"
    print(f"Downloading {url}")
    r = requests.get(url, timeout=300)
    r.raise_for_status()
    if not r.content.startswith(b"PK"):
        raise SystemExit(f"EIA-860 {year} not found at {url} (it may have moved to the archive)")
    zipfile.ZipFile(io.BytesIO(r.content)).extractall(dest)
    return dest


def read(src: Path, name: str, year: int, sheet=0) -> pd.DataFrame:
    return pd.read_excel(src / f"{name}_Y{year}.xlsx", sheet_name=sheet, header=1)


def yes(col: pd.Series) -> pd.Series:
    return col.astype(str).str.upper().eq("Y")


def estimate_uplift(age, fixed_share, dc_ac):
    """Energy uplift from swapping modules / racking, AC interconnection held constant."""
    degradation = 1 / max(1 - DEGRADATION_PER_YEAR * age, 0.5) - 1
    tracking = TRACKER_GAIN * fixed_share
    bifacial = BIFACIAL_GAIN
    dc = DC_AC_ENERGY_ELASTICITY * max(TARGET_DC_AC / dc_ac - 1, 0) if dc_ac else 0.0
    uplift = (1 + degradation) * (1 + tracking) * (1 + bifacial) * (1 + dc) - 1
    return min(uplift, UPLIFT_CAP)


def owners_by_plant(src: Path, year: int) -> pd.Series:
    own = read(src, "4___Owner", year)
    own = own.drop_duplicates(["Plant Code", "Owner Name"])
    return own.groupby("Plant Code")["Owner Name"].apply(lambda s: "; ".join(sorted(s.astype(str))))


def build_solar(src: Path, year: int, plants: pd.DataFrame, owners: pd.Series, storage: pd.DataFrame):
    s = read(src, "3_3_Solar", year, "Operable")
    s = s[s["Technology"] == "Solar Photovoltaic"].copy()
    s["mw"] = pd.to_numeric(s["Nameplate Capacity (MW)"], errors="coerce").fillna(0)
    s["dc"] = pd.to_numeric(s["DC Net Capacity (MW)"], errors="coerce")
    s["year"] = pd.to_numeric(s["Operating Year"], errors="coerce")
    s["fixed"] = (yes(s["Fixed Tilt?"]) | yes(s["East West Fixed Tilt?"])) & ~yes(s["Single-Axis Tracking?"]) & ~yes(s["Dual-Axis Tracking?"])
    s["thin"] = yes(s["Thin-Film (CdTe)?"]) | yes(s["Thin-Film (A-Si)?"]) | yes(s["Thin-Film (CIGS)?"]) | yes(s["Thin-Film (Other)?"])
    s["wyear"] = s["year"] * s["mw"]
    s["fixed_mw"] = s["mw"] * s["fixed"]
    s["thin_mw"] = s["mw"] * s["thin"]

    g = s.groupby("Plant Code").agg(
        name=("Plant Name", "first"),
        operator=("Utility Name", "first"),
        state=("State", "first"),
        county=("County", "first"),
        mw=("mw", "sum"),
        dc=("dc", lambda x: x.sum(min_count=1)),
        wyear=("wyear", "sum"),
        first_year=("year", "min"),
        last_year=("year", "max"),
        fixed_mw=("fixed_mw", "sum"),
        thin_mw=("thin_mw", "sum"),
        gens=("Generator ID", "count"),
    )
    g = g[g["mw"] > 0]
    g["year"] = (g["wyear"] / g["mw"]).round().astype(int)
    g = g.join(plants, how="inner").join(owners.rename("owners")).join(storage, how="left")

    features = []
    for code, r in g.iterrows():
        if pd.isna(r.lat) or pd.isna(r.lon):
            continue
        age = year - r.year
        fixed_share = r.fixed_mw / r.mw
        dc_ac = (r.dc / r.mw) if pd.notna(r.dc) and r.dc > 0 else None
        if dc_ac is None or not 1.0 <= dc_ac <= 2.0:
            # Missing or misreported DC; fall back to the fleet median for the vintage.
            dc_ac = 1.20 if r.year < 2013 else 1.28 if r.year < 2017 else 1.33
        uplift = estimate_uplift(age, fixed_share, dc_ac)
        cf = BASE_CF["fixed"] * fixed_share + BASE_CF["tracking"] * (1 - fixed_share)
        base_mwh = r.mw * 8760 * cf * (1 - DEGRADATION_PER_YEAR * age)
        nc_qf = r.state == "NC" and r.qf
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(r.lon, 5), round(r.lat, 5)]},
            "properties": {
                "id": int(code),
                "name": r["name"],
                "operator": r.operator,
                "owners": r.owners if isinstance(r.owners, str) else r.operator,
                "state": r.state,
                "county": r.county,
                "iso": r.iso,
                "ba": r.ba,
                "kv": r.kv,
                "mw": round(r.mw, 1),
                "dc": round(r.dc, 1) if pd.notna(r.dc) else None,
                "year": int(r.year),
                "years": f"{int(r.first_year)}" if r.first_year == r.last_year else f"{int(r.first_year)}-{int(r.last_year)}",
                "fixed": round(fixed_share, 2),
                "thin": round(r.thin_mw / r.mw, 2),
                "gens": int(r.gens),
                "st_mw": round(r.st_mw, 1) if pd.notna(r.st_mw) else 0,
                "st_mwh": round(r.st_mwh, 1) if pd.notna(r.st_mwh) else 0,
                "uplift": round(uplift, 3),
                "add_mwh": round(base_mwh * uplift),
                "qf": bool(r.qf),
                **({
                    "exp": int(r.year) + NC_QF_TERM_YEARS,
                    "bat_mw": round(r.mw * NC_BATTERY_SHARE, 2),
                    "bat_mwh": round(r.mw * NC_BATTERY_SHARE * NC_BATTERY_HOURS, 1),
                } if nc_qf else {}),
            },
        })
    return features


def build_storage(src: Path, year: int, plants: pd.DataFrame, owners: pd.Series):
    e = read(src, "3_4_Energy_Storage", year, "Operable")
    e["mw"] = pd.to_numeric(e["Nameplate Capacity (MW)"], errors="coerce").fillna(0)
    e["mwh"] = pd.to_numeric(e["Nameplate Energy Capacity (MWh)"], errors="coerce").fillna(0)
    e["year"] = pd.to_numeric(e["Operating Year"], errors="coerce")
    e["wyear"] = e["year"] * e["mw"]
    g = e.groupby("Plant Code").agg(
        name=("Plant Name", "first"),
        operator=("Utility Name", "first"),
        state=("State", "first"),
        county=("County", "first"),
        mw=("mw", "sum"),
        mwh=("mwh", "sum"),
        wyear=("wyear", "sum"),
        first_year=("year", "min"),
        chem=("Storage Technology 1", "first"),
    )
    g = g[g["mw"] > 0]
    by_plant = g[["mw", "mwh"]].rename(columns={"mw": "st_mw", "mwh": "st_mwh"})
    g["year"] = (g["wyear"] / g["mw"]).round().astype(int)
    g = g.join(plants, how="inner").join(owners.rename("owners"))

    features = []
    for code, r in g.iterrows():
        if pd.isna(r.lat) or pd.isna(r.lon):
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(r.lon, 5), round(r.lat, 5)]},
            "properties": {
                "id": int(code),
                "name": r["name"],
                "operator": r.operator,
                "owners": r.owners if isinstance(r.owners, str) else r.operator,
                "state": r.state,
                "county": r.county,
                "iso": r.iso,
                "ba": r.ba,
                "kv": r.kv,
                "mw": round(r.mw, 1),
                "mwh": round(r.mwh, 1),
                "year": int(r.year),
                "chem": r.chem if isinstance(r.chem, str) else None,
            },
        })
    return features, by_plant


def round_coords(c, nd=3):
    if isinstance(c[0], (int, float)):
        return [round(c[0], nd), round(c[1], nd)]
    return [round_coords(x, nd) for x in c]


def build_isos():
    """ISO/RTO territories (simplified) from CommonGrid, ODbL. Display only:
    plants are assigned to markets by their EIA balancing authority, which
    handles pseudo-tied plants (e.g. AZ/NV plants scheduled into CAISO)."""
    feats = []
    for slug, iso in ISO_TERRITORIES.items():
        r = requests.get(f"{COMMONGRID}/iso-{slug}.json", timeout=60)
        r.raise_for_status()
        for f in r.json()["features"]:
            g = f["geometry"]
            feats.append({"type": "Feature", "properties": {"iso": iso},
                          "geometry": {"type": g["type"], "coordinates": round_coords(g["coordinates"])}})
    return feats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=2025)
    year = ap.parse_args().year

    src = download(year)
    p = read(src, "2___Plant", year)
    plants = pd.DataFrame({
        "lat": pd.to_numeric(p["Latitude"], errors="coerce").values,
        "lon": pd.to_numeric(p["Longitude"], errors="coerce").values,
        "ba": p["Balancing Authority Code"].astype(str).replace("nan", "").values,
        "kv": pd.to_numeric(p["Grid Voltage (kV)"], errors="coerce").values,
        "qf": p["FERC Small Power Producer Status"].astype(str).str.upper().eq("Y").values,
    }, index=p["Plant Code"])
    plants["iso"] = plants["ba"].map(ISO_BY_BA).fillna("Non-RTO")
    plants["kv"] = plants["kv"].where(plants["kv"] > 0).round(1)
    plants["kv"] = plants["kv"].astype(object).where(plants["kv"].notna(), None)

    owners = owners_by_plant(src, year)
    storage, storage_by_plant = build_storage(src, year, plants, owners)
    solar = build_solar(src, year, plants, owners, storage_by_plant)

    OUT.mkdir(parents=True, exist_ok=True)
    for name, feats in [("solar", solar), ("storage", storage), ("isos", build_isos())]:
        with open(OUT / f"{name}.geojson", "w") as f:
            json.dump({"type": "FeatureCollection", "features": feats}, f, separators=(",", ":"), allow_nan=False)
    with open(OUT / "meta.json", "w") as f:
        json.dump({"source": f"EIA Form 860, {year} release", "data_year": year}, f)
    print(f"Wrote {len(solar)} solar plants and {len(storage)} storage plants to {OUT}")


if __name__ == "__main__":
    main()
