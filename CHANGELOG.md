# Changelog

## v0.2 - 2026-07-29

- Added area mode: click a point on the map and set a radius in km to find every station within it. `Move centre` repositions it without redrawing.
- Added two headline stats for the circled area: journeys starting there (to any destination), and journeys that both start and end there.
- Limited circled-area routes to the busiest 15, 50, 100, or all, the same Top-N control as the single-station view, so dense areas (central London, etc.) stay readable and responsive instead of drowning in lines.
- Added a permanent on-map label summarising the circled area's stats at a glance.
- Changed station selection (search, Enter, or clicking a station) to pan the map to it gradually instead of snapping. Clicking or dragging mid-pan interrupts it.

## v0.1 - 2026-07-11

Initial release. Pick a station and see a line to every station it sells tickets to, sized and coloured by journey volume (log scale, blue to red). Filter to the busiest 15, 50, or 100 destinations, show all of them, or narrow to a single destination to see the journey count in both directions.
