"""
Pre-processes the ODM CSV into per-origin JSON files for the web app.

Outputs:
  docs/stations.json        - station reference data (name, lat, lng)
  docs/od-data/{TLC}.json   - per-origin OD pairs, sorted by journeys desc
  docs/meta.json            - build metadata (e.g. the financial year the ODM covers)

By default, looks for a single file matching data/ODM_for_RDM_*.csv. To use a
specific file (e.g. when data/ holds more than one year), pass --odm-file:

  python scripts/build_od_data.py --odm-file ODM_for_RDM_2025-26.csv
"""

import argparse
import csv
import glob
import json
import os
import re
import sys
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


def find_odm_file(explicit_name: str | None) -> str:
    if explicit_name:
        path = explicit_name if os.path.isabs(explicit_name) else os.path.join(DATA_DIR, explicit_name)
        if not os.path.isfile(path):
            sys.exit(f"ODM file not found: {path}")
        return path

    candidates = sorted(glob.glob(os.path.join(DATA_DIR, "ODM_for_RDM_*.csv")))
    if not candidates:
        sys.exit(
            "No ODM file found in data/. Expected a file matching ODM_for_RDM_*.csv "
            "(e.g. ODM_for_RDM_2025-26.csv). Place the file in data/ or pass "
            "--odm-file <name>."
        )
    if len(candidates) > 1:
        names = "\n  ".join(os.path.basename(c) for c in candidates)
        sys.exit(
            f"Multiple ODM files found in data/:\n  {names}\n"
            "Pass --odm-file <name> to pick one."
        )
    return candidates[0]


def parse_odm_period(odm_path: str) -> str | None:
    """Pull a 'YYYY-YY' style period out of the filename, e.g. ODM_for_RDM_2024-25.csv -> '2024/25'."""
    m = re.search(r"(\d{4})-(\d{2})", os.path.basename(odm_path))
    return f"{m.group(1)}/{m.group(2)}" if m else None


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


def build_od_data(odm_path: str):
    od = defaultdict(list)
    total = 0
    with open(odm_path, encoding="utf-8") as f:
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
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--odm-file",
        help="ODM CSV filename, relative to data/ (or an absolute path). "
             "If omitted, auto-detects a single ODM_for_RDM_*.csv file in data/.",
    )
    args = parser.parse_args()

    odm_path = find_odm_file(args.odm_file)
    print(f"Using ODM file: {os.path.relpath(odm_path, ROOT)}")

    print("Loading stations...")
    stations = load_stations()
    os.makedirs(DOCS_DIR, exist_ok=True)
    with open(os.path.join(DOCS_DIR, "stations.json"), "w") as f:
        json.dump(stations, f, separators=(",", ":"))
    print(f"Written stations.json ({len(stations)} stations)")

    print("Processing OD matrix (this takes ~30s)...")
    od = build_od_data(odm_path)

    out_dir = os.path.join(DOCS_DIR, "od-data")
    os.makedirs(out_dir, exist_ok=True)
    for origin, pairs in od.items():
        pairs.sort(key=lambda x: x[1], reverse=True)
        with open(os.path.join(out_dir, f"{safe_filename(origin)}.json"), "w") as f:
            json.dump(pairs, f, separators=(",", ":"))
    print(f"Written {len(od)} origin files to docs/od-data/")

    period = parse_odm_period(odm_path)
    with open(os.path.join(DOCS_DIR, "meta.json"), "w") as f:
        json.dump({"odmPeriod": period} if period else {}, f)
    if period:
        print(f"Detected ODM period: {period} (written to docs/meta.json)")
    else:
        print(
            "Could not detect a year from the ODM filename; docs/meta.json will "
            "omit it and the site will fall back to its static label. Update the "
            "#panel-year text in docs/index.html manually if needed."
        )

    print("Done.")


if __name__ == "__main__":
    main()
