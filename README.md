# UK Rail O/D Explorer

An interactive map of where people travel to and from on the UK rail network. Pick a station — or let the default (London King's Cross) load — and the map draws a line to every station it sells tickets to, sized and coloured by how many journeys were made. Filter down to the busiest 15, 50, or 100 destinations, show everything at once, or narrow to a single destination to see the journey count in both directions.

It's a static site. A Python script turns two source CSVs into a few thousand small JSON files once; the browser does the rest with [Leaflet](https://leafletjs.com/).

## Data sources

- **Origin–destination journey estimates** — Office of Rail and Road (ORR), file `ODM_for_RDM_<year>.csv`. Estimated annual journeys between station pairs, derived from ticket sales data. Search the [ORR data portal](https://dataportal.orr.gov.uk/) for that year's origin–destination release; published material from ORR is generally under the Open Government Licence v3.0, but check the terms attached to the specific release you download.
- **Station names and coordinates** — [davwheat/uk-railway-stations](https://github.com/davwheat/uk-railway-stations) on GitHub, file `stations.csv`. Check that repository for its current licence and attribution terms.

Neither source file is committed to this repo — `data/` is gitignored, partly because the ODM CSV alone runs to 150MB+. What's committed is the *output* of the build (`docs/stations.json`, `docs/od-data/*.json`), so the site works as soon as you clone it. You only need the raw CSVs if you want to rebuild the data yourself.

## Running it locally

Browsers block `fetch()` calls from `file://` URLs, so opening `docs/index.html` directly leaves the map empty. Serve it instead:

```bash
bash serve.sh        # serves docs/ at http://localhost:8000 and opens it in your browser
bash serve.sh 3000   # or pick a different port
```

## Rebuilding the data

Do this to bring in a new year's figures, or after fixing something in a source file.

1. **Get the two source files.**
   - `stations.csv` from davwheat/uk-railway-stations.
   - The ODM CSV from ORR's data portal, for whichever year you want. The build script expects the columns `origin_tlc`, `destination_tlc`, and `journeys` (among others) — if a future ORR release renames these, update `build_od_data()` in `scripts/build_od_data.py` to match.

2. **Place both files in `data/`.** Name the ODM file `ODM_for_RDM_<year>.csv`, e.g. `ODM_for_RDM_2025-26.csv` — the build script looks for that pattern and reads the year straight out of the filename. If you keep more than one year's file in `data/` at once, you'll need to tell it which one to use (step 3).

3. **Run the build.**

   ```bash
   bash build.sh                                        # auto-detects the one ODM file in data/
   bash build.sh --odm-file ODM_for_RDM_2025-26.csv      # or name it explicitly
   ```

   This regenerates `docs/stations.json`, every file under `docs/od-data/`, and `docs/meta.json`. `meta.json` records the year detected from the filename, which the app reads on load to update its "Based on YYYY/YY estimates" label automatically — no manual edit needed. If the filename doesn't contain a recognisable year, the build still runs, but the app falls back to the static label already in `docs/index.html`.

4. **Check it, then commit.** Run `bash serve.sh` and look it over before committing the changed files under `docs/`.

## A note on the AI involved

The web app, the build script, and this README were written with assistance from Claude (Anthropic), used through Claude Code across several sessions, with the project owner directing the changes and testing each one. The underlying data — the ORR journey estimates and the station list — comes entirely from the sources credited above, not from the model. Theme is [darkly](https://bootswatch.com/darkly/) from Bootswatch.
