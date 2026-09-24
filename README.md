# UK Rail O/D Explorer

**v0.4** - see [CHANGELOG.md](CHANGELOG.md) for release history.

ORR publishes origin-destination ticket estimates for UK rail as a raw CSV - 1.6 million-odd station-pair rows, readable only as a spreadsheet. This turns it into a map. Pick a station, or let the default (London King's Cross) load: it draws a line to every station it sells tickets to, sized and coloured by journey volume. Filter down to the busiest 15, 50, or 100 destinations, show everything at once, or narrow to a single destination to see the count in both directions.

Draw a circle, or an arbitrary polygon, on the map to switch to area mode: for a circle, click a point and set its radius in km; for a polygon, click out points and close the shape with a double-click or the Finish button. Either way it finds every station inside, totals journeys starting there against journeys that both start and end there, and draws the busiest of those fully-contained routes - choosing 15, 50, 100, or all, the same as the station view - so dense areas stay readable. `Move centre` repositions a circle without redrawing it; a polygon is redrawn from scratch instead.

Or search for a named line - "West Coast Main Line", "Elizabeth Line (Reading-Shenfield)", and around 60 others - to switch to line mode. It highlights the line's stations, draws the route, and totals journeys starting anywhere on the line against journeys that both start and end on it. The busiest of those routes get drawn, with the same 15/50/100/all control as the other two modes. Line coverage is hand-curated, not official - see Data sources below for what that means for accuracy.

It's a static site. A Python script turns the source CSVs and a curated line list into a few thousand small JSON files once; the browser does the rest with [Leaflet](https://leafletjs.com/).

## Data sources and acknowledgements

- **Origin-destination journey estimates** - Office of Rail and Road (ORR), file `ODM_for_RDM_<year>.csv`. Estimated annual journeys between station pairs, derived from ticket sales data. Search the [ORR data portal](https://dataportal.orr.gov.uk/) for that year's origin-destination release. Published material from ORR is generally under the Open Government Licence v3.0, but check the terms attached to the specific release you download.
- **Station names and coordinates** - [davwheat/uk-railway-stations](https://github.com/davwheat/uk-railway-stations) on GitHub, file `stations.csv`. Check that repository for its current licence and attribution terms.
- **Named line definitions** - `scripts/lines_source.json`, hand-compiled from Wikipedia route diagrams and cross-checked station-by-station against `stations.csv`. There's no single authoritative UK source mapping stations to line names, so treat this as a good-faith approximation rather than National Rail's own record. Where a line forks, only the principal branch is included; a handful of open stations are missing because they're absent from `stations.csv` itself, not because they're off the line.

Neither source CSV is committed to this repo - `data/` is gitignored, partly because the ODM CSV alone runs to 150MB+. `scripts/lines_source.json` is the exception: it's original curated content, not a large third-party download, so it's committed and versioned like any other source file. What's committed either way is the *output* of the build (`docs/stations.json`, `docs/od-data/*.json`, `docs/lines.json`), so the site works as soon as you clone it. You only need the raw CSVs if you want to rebuild the data yourself.

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

   This regenerates `docs/stations.json`, every file under `docs/od-data/`, `docs/meta.json`, and `docs/lines.json`. `meta.json` records the year detected from the filename, which the app reads on load to update its "Based on YYYY/YY estimates" label automatically - no manual edit needed. If the filename doesn't contain a recognisable year, the build still runs, but the app falls back to the static label already in `docs/index.html`.

   `lines.json` comes from `scripts/lines_source.json`, filtered to stations that exist in that run's `stations.csv`. A line left with fewer than two stations gets dropped; the build prints how many station codes it discarded. To add or fix a line, edit `scripts/lines_source.json` directly - it's `{"Line Name": ["TLC", "TLC", ...]}`, in route order - and rerun the build.

4. **Check it, then commit.** Run `bash serve.sh` and look it over before committing the changed files under `docs/`.

## Future developments

- Only one ODM year loads at a time. Rebuilding for a new year overwrites the last one's output entirely, so comparing two years means re-running the build against an older CSV and diffing the JSON yourself.
- Area mode fetches one file per station inside the shape. Fine for a city-sized circle or polygon (a few hundred stations) - a shape spanning most of the network means a few thousand individual fetches, with no warning or cap on that yet.
- The layout assumes a desktop-sized window. The 300px side panel hasn't been adapted for a phone screen.
- Line mode covers around 60 named lines, not every branch and loop on the network. A station not on a covered line just won't come up in a line search - there's no "nearest line" fallback.

Forks welcome for any of the above.

## A note on the AI involved

The web app, the build script, and this README were written with assistance from Claude (Anthropic), via Claude Code across several sessions. The project owner directed the changes and tested each one. The underlying data - the ORR journey estimates and the station list - comes entirely from the sources credited above, not from the model. 
