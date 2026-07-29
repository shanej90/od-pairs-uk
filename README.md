# UK Rail O/D Explorer

**v0.2** - see [CHANGELOG.md](CHANGELOG.md) for release history.

ORR publishes origin-destination ticket estimates for UK rail as a raw CSV - 1.6 million-odd station-pair rows, readable only as a spreadsheet. This turns it into a map. Pick a station, or let the default (London King's Cross) load: it draws a line to every station it sells tickets to, sized and coloured by journey volume. Filter down to the busiest 15, 50, or 100 destinations, show everything at once, or narrow to a single destination to see the count in both directions.

Draw a circle on the map to switch to area mode: click a point, set its radius in km, and it finds every station inside. It totals journeys starting there against journeys that both start and end there. It also draws the busiest of those fully-contained routes - choosing 15, 50, 100, or all, the same as the station view - so dense areas stay readable. `Move centre` repositions the circle without redrawing it.

It's a static site. A Python script turns two source CSVs into a few thousand small JSON files once; the browser does the rest with [Leaflet](https://leafletjs.com/).

## Data sources and acknowledgements

- **Origin-destination journey estimates** - Office of Rail and Road (ORR), file `ODM_for_RDM_<year>.csv`. Estimated annual journeys between station pairs, derived from ticket sales data. Search the [ORR data portal](https://dataportal.orr.gov.uk/) for that year's origin-destination release. Published material from ORR is generally under the Open Government Licence v3.0, but check the terms attached to the specific release you download.
- **Station names and coordinates** - [davwheat/uk-railway-stations](https://github.com/davwheat/uk-railway-stations) on GitHub, file `stations.csv`. Check that repository for its current licence and attribution terms.

Neither source file is committed to this repo - `data/` is gitignored, partly because the ODM CSV alone runs to 150MB+. What's committed is the *output* of the build (`docs/stations.json`, `docs/od-data/*.json`), so the site works as soon as you clone it. You only need the raw CSVs if you want to rebuild the data yourself.

Theme is [darkly](https://bootswatch.com/darkly/) from Bootswatch.

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
   - The ODM CSV from ORR's data portal, for whichever year you want. The build script expects the columns `origin_tlc`, `destination_tlc`, and `journeys` (among others) - if a future ORR release renames these, update `build_od_data()` in `scripts/build_od_data.py` to match.

2. **Place both files in `data/`.** Name the ODM file `ODM_for_RDM_<year>.csv`, eg, `ODM_for_RDM_2025-26.csv` - the build script looks for that pattern and reads the year straight out of the filename. If you keep more than one year's file in `data/` at once, you'll need to tell it which one to use (step 3).

3. **Run the build.** Takes about 30 seconds for a year's worth of the OD matrix, most of it writing out the few thousand per-station JSON files.

   ```bash
   bash build.sh                                        # auto-detects the one ODM file in data/
   bash build.sh --odm-file ODM_for_RDM_2025-26.csv      # or name it explicitly
   ```

   This regenerates `docs/stations.json`, every file under `docs/od-data/`, and `docs/meta.json`. `meta.json` records the year detected from the filename, which the app reads on load to update its "Based on YYYY/YY estimates" label automatically - no manual edit needed. If the filename doesn't contain a recognisable year, the build still runs, but the app falls back to the static label already in `docs/index.html`.

4. **Check it, then commit.** Run `bash serve.sh` and look it over before committing the changed files under `docs/`.

## Future developments

- Only one ODM year loads at a time. Rebuilding for a new year overwrites the last one's output entirely, so comparing two years means re-running the build against an older CSV and diffing the JSON yourself.
- Area mode fetches one file per station inside the circle. Fine for a city-sized circle (a few hundred stations) - a circle spanning most of the network means a few thousand individual fetches, with no warning or cap on that yet.
- The layout assumes a desktop-sized window. The 300px side panel hasn't been adapted for a phone screen.

Forks welcome for any of the above.

## A note on the AI involved

The web app, the build script, and this README were written with assistance from Claude (Anthropic), via Claude Code across several sessions. The project owner directed the changes and tested each one. The underlying data - the ORR journey estimates and the station list - comes entirely from the sources credited above, not from the model. 
