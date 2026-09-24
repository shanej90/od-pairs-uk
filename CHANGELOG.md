# Changelog

## v0.3 - 2026-09-12

- Added line mode: search for a named line (eg, "West Coast Main Line") to highlight its stations and draw the route.
- Added two headline stats for line mode: journeys starting anywhere on the line, and journeys that both start and end on it.
- Added the busiest-15/50/100/all control to line mode, same as station and area mode, so dense lines stay readable.
- Added `scripts/lines_source.json` and `docs/lines.json`: around 60 hand-curated named lines, covering national main lines, regional and branch lines, the Elizabeth Line, Merseyrail, and London Overground's six post-2024 line names.
- Station search, area mode, and line mode now hand off to one another cleanly - selecting one clears whichever of the other two was active.

## v0.2 - 2026-07-29

- Added area mode: click a point on the map and set a radius in km to find every station within it. `Move centre` repositions it without redrawing.
- Added two headline stats for the circled area: journeys starting there (to any destination), and journeys that both start and end there.
- Limited circled-area routes to the busiest 15, 50, 100, or all, the same Top-N control as the single-station view, so dense areas (central London, etc.) stay readable and responsive instead of drowning in lines.
- Added a permanent on-map label summarising the circled area's stats at a glance.
- Changed station selection (search, Enter, or clicking a station) to pan the map to it gradually instead of snapping. Clicking or dragging mid-pan interrupts it.

## v0.1 - 2026-07-11

Initial release. Pick a station and see a line to every station it sells tickets to, sized and coloured by journey volume (log scale, blue to red). Filter to the busiest 15, 50, or 100 destinations, show all of them, or narrow to a single destination to see the journey count in both directions.
