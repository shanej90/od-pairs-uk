#!/usr/bin/env bash
# Rebuild docs/stations.json and docs/od-data/*.json from the source CSVs in data/.
# Usage:
#   bash build.sh                                  # auto-detects data/ODM_for_RDM_*.csv
#   bash build.sh --odm-file ODM_for_RDM_2025-26.csv   # picks a specific file

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v python &>/dev/null && ! command -v python3 &>/dev/null; then
  echo "Error: Python not found. Install Python 3 to run the build." >&2
  exit 1
fi
PYTHON=$(command -v python3 || command -v python)

if [ -f "$SCRIPT_DIR/.venv/Scripts/activate" ]; then
  source "$SCRIPT_DIR/.venv/Scripts/activate"
elif [ -f "$SCRIPT_DIR/.venv/bin/activate" ]; then
  source "$SCRIPT_DIR/.venv/bin/activate"
fi

"$PYTHON" "$SCRIPT_DIR/scripts/build_od_data.py" "$@"
