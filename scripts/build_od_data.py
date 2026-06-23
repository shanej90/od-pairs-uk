"""
Pre-processes the ODM CSV into per-origin JSON files for the web app.

Outputs:
  docs/stations.json        - station reference data (name, lat, lng)
  docs/od-data/{TLC}.json   - per-origin OD pairs, sorted by journeys desc
"""

import csv
import json
import os
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
DOCS_DIR = os.path.join(ROOT, "docs")

# Windows device names that cannot be used as filenames; prefix with _ to avoid
_WIN_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(10)),
    *(f"LPT{i}" for i in range(10)),
}


def safe_filename(tlc: str) -> str:
    return f"_{tlc}" if tlc.upper() in _WIN_RESERVED else tlc


def load_stations():
    stations = {}
    with open(os.path.join(DATA_DIR, "stations.csv"), encoding="utf-8") as f:
        for row in csv.DictReader(f):
            tlc = row["crsCode"].strip()
            try:
                stations[tlc] = {
                    "n": row["stationName"].strip(),
                    "la": round(float(row["lat"]), 5),
                    "lo": round(float(row["long"]), 5),
                }
            except ValueError:
                pass  # skip rows with missing coords
    return stations


def build_od_data():
    od = defaultdict(list)
    total = 0
    with open(os.path.join(DATA_DIR, "ODM_for_RDM_2024-25.csv"), encoding="utf-8") as f:
        for row in csv.DictReader(f):
            od[row["origin_tlc"].strip()].append(
                [row["destination_tlc"].strip(), int(row["journeys"])]
            )
            total += 1
            if total % 200_000 == 0:
                print(f"  {total:,} rows processed...")
    print(f"  {total:,} total OD pairs across {len(od)} origins")
    return od


def main():
    print("Loading stations...")
    stations = load_stations()
    os.makedirs(DOCS_DIR, exist_ok=True)
    with open(os.path.join(DOCS_DIR, "stations.json"), "w") as f:
        json.dump(stations, f, separators=(",", ":"))
    print(f"Written stations.json ({len(stations)} stations)")

    print("Processing OD matrix (this takes ~30s)...")
    od = build_od_data()

    out_dir = os.path.join(DOCS_DIR, "od-data")
    os.makedirs(out_dir, exist_ok=True)
    for origin, pairs in od.items():
        pairs.sort(key=lambda x: x[1], reverse=True)
        with open(os.path.join(out_dir, f"{safe_filename(origin)}.json"), "w") as f:
            json.dump(pairs, f, separators=(",", ":"))
    print(f"Written {len(od)} origin files to docs/od-data/")
    print("Done.")


if __name__ == "__main__":
    main()
