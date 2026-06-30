#!/usr/bin/env bash
# Serve the docs/ folder on a local HTTP server for development/testing.
# Usage: bash serve.sh [port]

PORT=${1:-8000}
URL="http://localhost:$PORT"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS_DIR="$SCRIPT_DIR/docs"

if ! command -v python &>/dev/null && ! command -v python3 &>/dev/null; then
  echo "Error: Python not found. Install Python 3 or run: npx serve docs/" >&2
  exit 1
fi

PYTHON=$(command -v python3 || command -v python)
PY_MAJOR=$("$PYTHON" -c "import sys; print(sys.version_info.major)")

echo "Serving docs/ at $URL"
echo "Press Ctrl+C to stop."
echo ""

# Open browser after a short delay so the server has time to start
(sleep 1 && cmd //c start "$URL" 2>/dev/null) &

if [ "$PY_MAJOR" = "3" ]; then
  "$PYTHON" -m http.server "$PORT" --directory "$DOCS_DIR"
else
  cd "$DOCS_DIR" && "$PYTHON" -m SimpleHTTPServer "$PORT"
fi
