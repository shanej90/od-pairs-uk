"""
Pre-processes the ODM CSV into per-origin JSON files for the web app.

Outputs:
  docs/stations.json        - station reference data (name, lat, lng)
  docs/od-data/{TLC}.json   - per-origin OD pairs, sorted by journeys desc
  docs/meta.json            - build metadata (e.g. the financial year the ODM covers)
  docs/lines.json           - named line -> ordered station TLCs (from scripts/lines_source.json)

By default, looks for a single file matching data/ODM_for_RDM_*.csv. To use a
specific file (e.g. when data/ holds more than one year), pass --odm-file:

  python scripts/build_od_data.py --odm-file ODM_for_RDM_2025-26.csv
"""

#imports###############################################
import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DOCS_DIR = ROOT / "docs"
LINES_SOURCE = ROOT / "scripts" / "lines_source.json"

#windows device names that cannot be used as filenames; prefix with _ to avoid
_WIN_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(10)),
    *(f"LPT{i}" for i in range(10)),
}


#helpers###############################################
def safe_filename(tlc: str) -> str:

    """
    Prefix a TLC with `_` if it collides with a reserved Windows device name.

    Args:
        tlc: Three-letter station code.

    Returns:
        The TLC unchanged, or `_`-prefixed if reserved.
    """

    return f"_{tlc}" if tlc.upper() in _WIN_RESERVED else tlc


def find_odm_file(explicit_name: str | None) -> Path:

    """
    Resolve the ODM CSV to build from.

    Args:
        explicit_name: Filename (relative to `data/`) or absolute path from
            `--odm-file`. If `None`, auto-detects the one `ODM_for_RDM_*.csv`
            file in `data/`.

    Returns:
        Path to the ODM CSV.

    Raises:
        SystemExit: If the named file doesn't exist, or auto-detection finds
            zero or more than one candidate.
    """

    if explicit_name:
        path = Path(explicit_name) if Path(explicit_name).is_absolute() else DATA_DIR / explicit_name
        if not path.is_file():
            sys.exit(f"ODM file not found: {path}")
        return path

    candidates = sorted(DATA_DIR.glob("ODM_for_RDM_*.csv"))
    if not candidates:
        sys.exit(
            "No ODM file found in data/. Expected a file matching ODM_for_RDM_*.csv "
            "(e.g. ODM_for_RDM_2025-26.csv). Place the file in data/ or pass "
            "--odm-file <name>."
        )
    if len(candidates) > 1:
        names = "\n  ".join(c.name for c in candidates)
        sys.exit(
            f"Multiple ODM files found in data/:\n  {names}\n"
            "Pass --odm-file <name> to pick one."
        )
    return candidates[0]


def parse_odm_period(odm_path: Path) -> str | None:
    """Pull a 'YYYY-YY' style period out of the filename, e.g. ODM_for_RDM_2024-25.csv -> '2024/25'."""
    m = re.search(r"(\d{4})-(\d{2})", odm_path.name)
    return f"{m.group(1)}/{m.group(2)}" if m else None


def load_stations() -> dict[str, dict]:

    """
    Read station reference data out of `data/stations.csv`.

    Returns:
        `{tlc: {"n": name, "la": lat, "lo": lng}}`, skipping rows with
        missing or unparseable coordinates.
    """

    stations = {}

    with open(DATA_DIR / "stations.csv", encoding = "utf-8") as f:
        for row in csv.DictReader(f):
            tlc = row["crsCode"].strip()
            try:
                stations[tlc] = {
                    "n": row["stationName"].strip(),
                    "la": round(float(row["lat"]), 5),
                    "lo": round(float(row["long"]), 5),
                }
            except ValueError:
                pass  #skip rows with missing coords

    return stations


def build_od_data(odm_path: Path) -> dict[str, list]:

    """
    Group the ODM CSV into per-origin destination/journey pairs.

    Args:
        odm_path: Path to the ODM CSV.

    Returns:
        `{origin_tlc: [[dest_tlc, journeys], ...]}`, unsorted.
    """

    od = defaultdict(list)
    total = 0

    with open(odm_path, encoding = "utf-8") as f:
        for row in csv.DictReader(f):
            od[row["origin_tlc"].strip()].append(
                [row["destination_tlc"].strip(), int(row["journeys"])]
            )
            total += 1
            if total % 200_000 == 0:
                print(f"  {total:,} rows processed...")

    print(f"  {total:,} total OD pairs across {len(od)} origins")
    return od


def build_lines(stations: dict[str, dict]) -> dict[str, list]:

    """
    Filter the curated line definitions down to stations that actually exist.

    Args:
        stations: `{tlc: {...}}` as returned by `load_stations()`.

    Returns:
        `{line_name: [tlc, ...]}`, in the source file's route order, skipping
        any line left with fewer than 2 known stations.
    """

    if not LINES_SOURCE.is_file():
        print(f"No line definitions found at {LINES_SOURCE.relative_to(ROOT)}; skipping lines.json")
        return {}

    raw = json.loads(LINES_SOURCE.read_text(encoding = "utf-8"))
    lines = {}
    dropped_total = 0

    for name, tlcs in raw.items():
        kept = [tlc for tlc in tlcs if tlc in stations]
        dropped_total += len(tlcs) - len(kept)
        if len(kept) >= 2:
            lines[name] = kept
        else:
            print(f"  Skipping '{name}': fewer than 2 known stations")

    if dropped_total:
        print(f"  Dropped {dropped_total} station code(s) not found in stations.csv")

    return dict(sorted(lines.items()))


#entry point###############################################
def main():

    parser = argparse.ArgumentParser(description = __doc__, formatter_class = argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--odm-file",
        help = "ODM CSV filename, relative to data/ (or an absolute path). "
               "If omitted, auto-detects a single ODM_for_RDM_*.csv file in data/.",
    )
    args = parser.parse_args()

    odm_path = find_odm_file(args.odm_file)
    try:
        display_path = odm_path.relative_to(ROOT)
    except ValueError:
        display_path = odm_path  #--odm-file pointed outside the project; show the absolute path instead
    print(f"Using ODM file: {display_path}")

    print("Loading stations...")
    stations = load_stations()
    DOCS_DIR.mkdir(exist_ok = True)
    (DOCS_DIR / "stations.json").write_text(json.dumps(stations, separators = (",", ":")))
    print(f"Written stations.json ({len(stations)} stations)")

    print("Building line definitions...")
    lines = build_lines(stations)
    (DOCS_DIR / "lines.json").write_text(json.dumps(lines, separators = (",", ":")))
    print(f"Written lines.json ({len(lines)} lines)")

    print("Processing OD matrix (this takes ~30s)...")
    od = build_od_data(odm_path)

    out_dir = DOCS_DIR / "od-data"
    out_dir.mkdir(exist_ok = True)
    for origin, pairs in od.items():
        pairs.sort(key = lambda x: x[1], reverse = True)
        (out_dir / f"{safe_filename(origin)}.json").write_text(json.dumps(pairs, separators = (",", ":")))
    print(f"Written {len(od)} origin files to docs/od-data/")

    period = parse_odm_period(odm_path)
    (DOCS_DIR / "meta.json").write_text(json.dumps({"odmPeriod": period} if period else {}))
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
