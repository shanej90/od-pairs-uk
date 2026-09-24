// Hand-written JS, not an R/Python web layer: the OD matrix is pre-split into a few
// thousand per-station JSON files (see scripts/build_od_data.py) and fetched lazily as
// the user picks stations or draws a circle. That rules out crosstalk/ojs, which ship
// one shared dataset to the browser up front, and a full Shiny/Dash server is overkill
// for a GitHub Pages static site with no server-side state.

// CON and PRN are reserved Windows filenames; build script prefixes them with _
const WIN_RESERVED = new Set(['CON','PRN','AUX','NUL','COM0','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9','LPT0','LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9']);
function safeFilename(tlc) { return WIN_RESERVED.has(tlc.toUpperCase()) ? `_${tlc}` : tlc; }

let map, stationLayer, odLayer;
let stations = {};       // { TLC: { n, la, lo } }
let stationMarkers = {}; // { TLC: L.circleMarker }
let tlcByName = {};      // { "Station Name": TLC }
let selectedOrigin = null;
let currentPairs = [];   // [[dest_tlc, journeys], ...] sorted desc
let displayLimit = 15;   // number of top destinations to show; Infinity = all
let destFilter = null;   // TLC string when filtering to a single destination, else null
const odCache = {};      // { TLC: pairs[] } — avoids re-fetching OD files

// --- circle mode: pick a point + radius to analyse journeys in that area ---
let circleShapeLayer, circleOdLayer; // the circle itself, and its drawn OD lines
let circle = null;          // L.Circle, or null when no circle is active
let placingCircle = false;  // true while waiting for the user to click the map to set/move the centre
let circleRadiusKm = 10;    // current radius, editable via the panel's number input
let circleDisplayLimit = 15; // how many "both" routes to draw, busiest first; Infinity = all
let circleStats = null;     // { stations: [tlc,...], startJourneys, bothJourneys, bothEdges: [[o,d,journeys],...] }
let circleComputeToken = 0; // guards a stale async recompute against a newer one superseding it

const STATION_STYLE = { radius: 3, fillColor: '#607d8b', color: '#37474f', weight: 0.5, fillOpacity: 0.8 };
const ORIGIN_STYLE  = { radius: 8, fillColor: '#fdd835', color: '#fff', weight: 1.5, fillOpacity: 1 };
const LINE_STATION_STYLE = { radius: 4, fillColor: '#66bb6a', color: '#2e7d32', weight: 1, fillOpacity: 0.9 };

// --- line mode: pick a named line to see journey stats for its stations ---
let lineShapeLayer, lineOdLayer;   // the route backbone, and its drawn "both ends on the line" OD edges
let lines = {};              // { "Line Name": [tlc, ...] } in route order, from lines.json
let selectedLine = null;     // line name string, or null when no line is selected
let lineDisplayLimit = 15;   // how many "both" routes to draw, busiest first; Infinity = all
let lineStatsData = null;    // { stations: [tlc,...], startJourneys, bothJourneys, bothEdges: [[o,d,journeys],...] }
let lineComputeToken = 0;    // guards a stale async recompute against a newer one superseding it

// --- colour ramp: blue → cyan → orange → red (log-scaled) ---
function journeyColor(ratio) {
    const stops = [
        [0,   79, 195, 247],
        [0.5, 79, 195, 247],
        [0.7, 255, 152,   0],
        [1,   229,  57,  53],
    ];
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
        if (ratio >= stops[i][0] && ratio <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
    }
    const t = lo[0] === hi[0] ? 0 : (ratio - lo[0]) / (hi[0] - lo[0]);
    return `rgb(${Math.round(lo[1]+t*(hi[1]-lo[1]))},${Math.round(lo[2]+t*(hi[2]-lo[2]))},${Math.round(lo[3]+t*(hi[3]-lo[3]))})`;
}

function logRatio(journeys, logMax) {
    return logMax > 0 ? Math.log10(journeys + 1) / logMax : 0;
}

// --- map init with selectable base layers ---
function initMap() {
    const dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_matter/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19,
    });
    const light = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19,
    });
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
        maxZoom: 19,
    });

    map = L.map('map', { zoomControl: false, layers: [osm] }).setView([54.5, -2.5], 6);
    L.control.layers({ 'Street map': osm, 'Light': light, 'Dark': dark }, {}, { position: 'topright' }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    stationLayer = L.layerGroup().addTo(map);
    odLayer = L.layerGroup().addTo(map);
    circleOdLayer = L.layerGroup().addTo(map);
    circleShapeLayer = L.layerGroup().addTo(map);
    lineShapeLayer = L.layerGroup().addTo(map);
    lineOdLayer = L.layerGroup().addTo(map);

    // let the user cut a flyTo short by clicking/dragging, rather than fighting the animation
    map.on('mousedown', () => map.stop());
}

// --- load stations.json and render dots ---
async function loadStations() {
    const resp = await fetch('stations.json');
    stations = await resp.json();

    const listEl = document.getElementById('station-list');
    const entries = Object.entries(stations).sort((a, b) => a[1].n.localeCompare(b[1].n));

    for (const [tlc, s] of entries) {
        tlcByName[s.n] = tlc;
        const opt = document.createElement('option');
        opt.value = s.n;
        listEl.appendChild(opt);

        const marker = L.circleMarker([s.la, s.lo], { ...STATION_STYLE });
        marker.bindTooltip(s.n, { direction: 'top', offset: [0, -4] });
        marker.on('click', () => selectOrigin(tlc));
        marker.addTo(stationLayer);
        stationMarkers[tlc] = marker;
    }
}

// --- origin search box ---
function initSearch() {
    const input = document.getElementById('search');
    input.addEventListener('change', () => {
        const tlc = tlcByName[input.value.trim()];
        if (tlc) selectOrigin(tlc);
    });
    input.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        const val = input.value.trim().toLowerCase();
        const match = Object.entries(tlcByName).find(([n]) => n.toLowerCase().startsWith(val));
        if (match) selectOrigin(match[1]);
    });
}

// --- select origin station and load its OD data ---
async function selectOrigin(tlc) {
    if (!stations[tlc] || placingCircle) return; // mid-pick for a circle owns the next map click
    if (circle) clearCircle();
    if (selectedLine) clearLine();

    if (selectedOrigin && stationMarkers[selectedOrigin]) {
        stationMarkers[selectedOrigin].setStyle({ ...STATION_STYLE });
    }

    selectedOrigin = tlc;
    destFilter = null;
    displayLimit = 15;
    stationMarkers[tlc].setStyle({ ...ORIGIN_STYLE });
    stationMarkers[tlc].bringToFront();
    document.getElementById('search').value = stations[tlc].n;
    setPanelLoading();

    const s = stations[tlc];
    map.flyTo([s.la, s.lo], Math.max(map.getZoom(), 9), { duration: 1.2 }); // gradual pan, not a snap-jump; a click interrupts it

    try {
        const resp = await fetch(`od-data/${safeFilename(tlc)}.json`);
        if (!resp.ok) throw new Error('not found');
        currentPairs = await resp.json();
        odCache[tlc] = currentPairs;
    } catch {
        setPanelError();
        return;
    }

    renderOD();
    renderPanel();
    document.getElementById('legend').style.display = '';
}

// --- returns the pairs that should currently be drawn / shown ---
function getVisiblePairs() {
    if (destFilter) return currentPairs.filter(([dest]) => dest === destFilter);
    return displayLimit === Infinity ? currentPairs : currentPairs.slice(0, displayLimit);
}

// --- draw OD lines ---
function renderOD() {
    if (circle) return; // circle mode owns the map view while active
    odLayer.clearLayers();
    if (!selectedOrigin) return;

    const origin = stations[selectedOrigin];
    const logMax = currentPairs.length ? Math.log10(currentPairs[0][1] + 1) : 1;

    for (const [dest, journeys] of getVisiblePairs()) {
        const d = stations[dest];
        if (!d) continue;

        const ratio = logRatio(journeys, logMax);
        const color = journeyColor(ratio);
        const line = L.polyline([[origin.la, origin.lo], [d.la, d.lo]], {
            color,
            weight: 0.5 + ratio * 4,
            opacity: 0.15 + ratio * 0.7,
        });
        line.bindTooltip(
            `<strong>${d.n}</strong><br>${journeys.toLocaleString()} journeys`,
            { sticky: true }
        );
        line.on('mouseover', function () { this.setStyle({ weight: this.options.weight + 1.5 }); });
        line.on('mouseout',  function () { this.setStyle({ weight: this.options.weight - 1.5 }); });
        line.addTo(odLayer);
    }
}

// =====================================================================
// Circle mode — pick a point and a radius to analyse the journeys in
// that area, independent of whichever origin station was selected.
// =====================================================================

// --- suspends station-search mode while circle or line mode is active ---
function deactivateOriginSelection(message = 'Circle mode active') {
    if (selectedOrigin && stationMarkers[selectedOrigin]) {
        stationMarkers[selectedOrigin].setStyle({ ...STATION_STYLE });
    }
    selectedOrigin = null;
    currentPairs = [];
    destFilter = null;
    odLayer.clearLayers();
    document.getElementById('legend').style.display = 'none';

    const search = document.getElementById('search');
    search.value = '';
    search.disabled = true;
    search.placeholder = message;
}

// --- hands map/panel control back to station-search mode ---
function reactivateOriginSelection() {
    const search = document.getElementById('search');
    search.disabled = false;
    search.placeholder = 'Search for an origin station…';
    document.getElementById('panel-body').innerHTML = '<p class="text-muted small">Search above or click a station on the map to explore journey patterns.</p>';
}

// --- "Draw circle" button: starts placing a new circle, or cancels if already placing ---
function toggleDrawCircle() {
    if (placingCircle) { cancelPlacing(); return; }
    enterPlacingMode();
}

// --- waits for one map click to set the circle's centre (a fresh circle, or moving an existing one) ---
function enterPlacingMode() {
    if (placingCircle) return; // already waiting on a click; don't stack a second listener
    if (selectedLine) clearLine();
    placingCircle = true;
    map.getContainer().style.cursor = 'crosshair';
    map.once('click', onMapPickCenter);

    if (!circle) {
        deactivateOriginSelection();
        document.getElementById('panel-body').innerHTML = '<p class="text-muted small text-center py-2">Click the map to place the circle’s centre…</p>';
        document.getElementById('circle-btn').textContent = 'Click the map…';
        document.getElementById('circle-btn').classList.add('picking');
    } else {
        const moveBtn = document.getElementById('circle-move-btn');
        if (moveBtn) { moveBtn.textContent = 'Click the map…'; moveBtn.classList.add('picking'); moveBtn.disabled = true; }
    }
}

// --- Escape, or re-clicking "Draw circle", backs out of placing mode without side effects ---
function cancelPlacing() {
    if (!placingCircle) return;
    placingCircle = false;
    map.getContainer().style.cursor = '';
    map.off('click', onMapPickCenter);

    if (circle) {
        renderCirclePanel(); // full re-render restores the normal "Move centre" button
    } else {
        document.getElementById('circle-btn').textContent = 'Draw circle';
        document.getElementById('circle-btn').classList.remove('picking');
        reactivateOriginSelection();
    }
}

function onMapPickCenter(e) {
    placingCircle = false;
    map.getContainer().style.cursor = '';
    document.getElementById('circle-btn').classList.remove('picking');

    if (!circle) {
        circle = L.circle(e.latlng, { radius: circleRadiusKm * 1000, color: '#26c6da', weight: 2, fillOpacity: 0.06 }).addTo(circleShapeLayer);
        document.getElementById('circle-btn').style.display = 'none';
        document.getElementById('legend').style.display = '';
    } else {
        circle.setLatLng(e.latlng);
    }
    recomputeCircle();
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') cancelPlacing();
});

// --- removes the circle entirely and restores station-search mode ---
function clearCircle() {
    if (!circle) return;
    if (placingCircle) {
        placingCircle = false;
        map.getContainer().style.cursor = '';
        map.off('click', onMapPickCenter); // don't let a stray later click create a fresh circle
    }

    circleShapeLayer.clearLayers();
    circleOdLayer.clearLayers();
    circle = null;
    circleStats = null;
    circleDisplayLimit = 15;
    circleComputeToken++; // invalidate any in-flight recompute

    document.getElementById('circle-btn').style.display = '';
    document.getElementById('circle-btn').textContent = 'Draw circle';
    document.getElementById('circle-btn').classList.remove('picking');
    document.getElementById('legend').style.display = 'none';

    reactivateOriginSelection();
}

async function fetchOutbound(tlc) {
    if (odCache[tlc]) return odCache[tlc];
    try {
        const resp = await fetch(`od-data/${safeFilename(tlc)}.json`);
        odCache[tlc] = resp.ok ? await resp.json() : [];
    } catch { odCache[tlc] = []; }
    return odCache[tlc];
}

// --- sums journeys starting in the circle, and those staying entirely within it ---
async function recomputeCircle() {
    if (!circle) return;
    const token = ++circleComputeToken;
    const editingRadius = document.activeElement && document.activeElement.id === 'circle-radius-input';

    circleOdLayer.clearLayers();
    if (!editingRadius) setCirclePanelLoading();

    const center = circle.getLatLng();
    const radius = circle.getRadius();
    const inCircle = Object.keys(stations).filter(
        tlc => center.distanceTo(L.latLng(stations[tlc].la, stations[tlc].lo)) <= radius
    );
    const inSet = new Set(inCircle);

    const outboundLists = await Promise.all(inCircle.map(fetchOutbound));
    if (token !== circleComputeToken) return; // a newer recompute superseded this one

    let startJourneys = 0; // every journey starting at a station in the circle, to any destination
    let bothJourneys = 0;  // journeys where both origin and destination are in the circle
    const bothEdges = [];  // [[origin, dest, journeys], ...], for drawing

    inCircle.forEach((tlc, i) => {
        for (const [dest, journeys] of outboundLists[i]) {
            startJourneys += journeys;
            if (inSet.has(dest)) {
                bothJourneys += journeys;
                bothEdges.push([tlc, dest, journeys]);
            }
        }
    });
    bothEdges.sort((a, b) => b[2] - a[2]); // busiest first, so "top N" and the colour ramp both make sense

    circleStats = { stations: inCircle, startJourneys, bothJourneys, bothEdges };
    renderCircleOD();
    renderCirclePanel();
    updateCircleTooltip();
}

// --- the "both" edges currently on screen, limited by circleDisplayLimit ---
function getVisibleCircleEdges() {
    if (!circleStats) return [];
    const { bothEdges } = circleStats;
    return circleDisplayLimit === Infinity ? bothEdges : bothEdges.slice(0, circleDisplayLimit);
}

// --- draws only the journeys that stay entirely within the circle, capped to the display limit ---
function renderCircleOD() {
    circleOdLayer.clearLayers();
    if (!circleStats) return;

    const { bothEdges } = circleStats;
    const logMax = bothEdges.length ? Math.log10(bothEdges[0][2] + 1) : 1; // scale is fixed to the busiest route, regardless of how many are shown

    for (const [o, d, journeys] of getVisibleCircleEdges()) {
        const os = stations[o], ds = stations[d];
        if (!os || !ds) continue;

        const ratio = logRatio(journeys, logMax);
        const line = L.polyline([[os.la, os.lo], [ds.la, ds.lo]], {
            color: journeyColor(ratio),
            weight: 0.5 + ratio * 4,
            opacity: 0.2 + ratio * 0.7,
        });
        line.bindTooltip(`<strong>${os.n} → ${ds.n}</strong><br>${journeys.toLocaleString()} journeys`, { sticky: true });
        line.on('mouseover', function () { this.setStyle({ weight: this.options.weight + 1.5 }); });
        line.on('mouseout',  function () { this.setStyle({ weight: this.options.weight - 1.5 }); });
        line.addTo(circleOdLayer);
    }
}

// --- permanent label on the circle itself, giving an at-a-glance summary ---
function updateCircleTooltip() {
    if (!circle || !circleStats) return;
    const { stations: sList, startJourneys, bothJourneys } = circleStats;
    const html = `<strong>${sList.length.toLocaleString()}</strong> station${sList.length === 1 ? '' : 's'}<br>`
        + `${startJourneys.toLocaleString()} journeys start here<br>`
        + `${bothJourneys.toLocaleString()} stay within the circle`;
    circle.unbindTooltip();
    circle.bindTooltip(html, { permanent: true, direction: 'center', className: 'circle-tooltip' });
}

function setCirclePanelLoading() {
    document.getElementById('panel-body').innerHTML = '<p class="text-muted small text-center py-2">Computing journeys in circle…</p>';
}

// --- detailed stats panel for circle mode ---
function renderCirclePanel() {
    if (!circleStats) return;

    // Don't blow away the radius input (and its focus) while the user is actively editing it
    if (document.activeElement && document.activeElement.id === 'circle-radius-input') {
        refreshCircleStats();
        return;
    }

    const { stations: sList, startJourneys, bothJourneys, bothEdges } = circleStats;
    const visible = getVisibleCircleEdges();
    const visibleJourneys = visible.reduce((sum, [, , j]) => sum + j, 0);

    const sliderVal = circleDisplayLimit === Infinity ? bothEdges.length : Math.min(circleDisplayLimit, bothEdges.length);
    const limitLabel = circleDisplayLimit === Infinity ? `All (${bothEdges.length.toLocaleString()})` : sliderVal.toLocaleString();

    document.getElementById('panel-body').innerHTML = `
      <div class="origin-name">Circle analysis</div>
      <div class="mb-3">
        <div class="stat-row">
          <span class="stat-label">Stations in circle</span>
          <span class="stat-value" id="circle-station-count">${sList.length.toLocaleString()}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Journeys starting in circle</span>
          <span class="stat-value" id="circle-start-journeys">${startJourneys.toLocaleString()}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Start &amp; end in circle (all routes)</span>
          <span class="stat-value" id="circle-both-journeys">${bothJourneys.toLocaleString()}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Routes shown</span>
          <span class="stat-value" id="circle-routes-shown">${visible.length.toLocaleString()} / ${bothEdges.length.toLocaleString()}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Journeys shown</span>
          <span class="stat-value" id="circle-journeys-shown">${visibleJourneys.toLocaleString()}</span>
        </div>
      </div>

      <div class="mb-3">
        <div class="d-flex justify-content-between text-muted mb-1" style="font-size:0.7rem">
          <label for="circle-limit-slider" class="mb-0">Routes shown (busiest first)</label>
          <span id="circle-limit-label" class="text-info fw-semibold">${limitLabel}</span>
        </div>
        <div class="d-flex gap-1 mb-2">
          <button class="${circleDisplayLimit === 15 ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary'} flex-fill" onclick="setCircleLimit(15)">Top 15</button>
          <button class="${circleDisplayLimit === 50 ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary'} flex-fill" onclick="setCircleLimit(50)">Top 50</button>
          <button class="${circleDisplayLimit === 100 ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary'} flex-fill" onclick="setCircleLimit(100)">Top 100</button>
          <button class="${circleDisplayLimit === Infinity ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary'} flex-fill" onclick="setCircleLimit(Infinity)">All</button>
        </div>
        <input id="circle-limit-slider" type="range" class="form-range" min="1" max="${Math.max(bothEdges.length, 1)}" value="${sliderVal}" />
      </div>

      <div class="mb-3">
        <label class="text-uppercase text-muted mb-1 d-block" style="font-size:0.7rem;letter-spacing:0.06em" for="circle-radius-input">Radius (km)</label>
        <input id="circle-radius-input" type="number" min="0.5" step="0.5" class="form-control form-control-sm" value="${circleRadiusKm}" />
      </div>
      <div class="d-flex gap-1">
        <button id="circle-move-btn" class="btn btn-sm btn-outline-info flex-fill" onclick="enterPlacingMode()">Move centre</button>
        <button class="btn btn-sm btn-outline-danger px-2" onclick="clearCircle()" title="Clear circle">✕</button>
      </div>
    `;
    document.getElementById('circle-radius-input').addEventListener('input', onRadiusInput);
    document.getElementById('circle-limit-slider').addEventListener('input', onCircleLimitSlider);
}

// --- lightweight stat refresh that doesn't touch the radius input (preserves focus/cursor) ---
function refreshCircleStats() {
    if (!circleStats) return;
    const { stations: sList, startJourneys, bothJourneys, bothEdges } = circleStats;
    const visible = getVisibleCircleEdges();
    const visibleJourneys = visible.reduce((sum, [, , j]) => sum + j, 0);

    const countEl = document.getElementById('circle-station-count');
    const startEl = document.getElementById('circle-start-journeys');
    const bothEl = document.getElementById('circle-both-journeys');
    const shownRoutesEl = document.getElementById('circle-routes-shown');
    const shownJourneysEl = document.getElementById('circle-journeys-shown');
    if (countEl) countEl.textContent = sList.length.toLocaleString();
    if (startEl) startEl.textContent = startJourneys.toLocaleString();
    if (bothEl) bothEl.textContent = bothJourneys.toLocaleString();
    if (shownRoutesEl) shownRoutesEl.textContent = `${visible.length.toLocaleString()} / ${bothEdges.length.toLocaleString()}`;
    if (shownJourneysEl) shownJourneysEl.textContent = visibleJourneys.toLocaleString();
}

// --- set the "both" routes display limit via button ---
function setCircleLimit(n) {
    if (!circleStats) return;
    circleDisplayLimit = n;
    renderCircleOD();
    renderCirclePanel();
}

// --- slider drives the same display limit ---
function onCircleLimitSlider(e) {
    if (!circleStats) return;
    const val = parseInt(e.target.value, 10);
    const atMax = val >= circleStats.bothEdges.length;
    circleDisplayLimit = atMax ? Infinity : val;
    const label = document.getElementById('circle-limit-label');
    if (label) label.textContent = atMax ? `All (${circleStats.bothEdges.length.toLocaleString()})` : val.toLocaleString();
    renderCircleOD();
    refreshCircleStats();
}

let radiusDebounceTimer = null;
function onRadiusInput(e) {
    const km = parseFloat(e.target.value);
    if (!isFinite(km) || km <= 0) return;
    circleRadiusKm = km;
    clearTimeout(radiusDebounceTimer);
    radiusDebounceTimer = setTimeout(() => {
        if (!circle) return;
        circle.setRadius(circleRadiusKm * 1000);
        recomputeCircle();
    }, 400);
}

// =====================================================================
// Line mode — pick a named line to see journey stats for its stations,
// independent of whichever origin station or circle was active.
// =====================================================================

// --- load lines.json and populate the line search datalist ---
async function loadLines() {
    try {
        const resp = await fetch('lines.json');
        if (!resp.ok) return;
        lines = await resp.json();
    } catch {
        return; // no lines.json (older build, or none configured) — feature just stays unused
    }

    const listEl = document.getElementById('line-list');
    for (const name of Object.keys(lines).sort()) {
        const opt = document.createElement('option');
        opt.value = name;
        listEl.appendChild(opt);
    }
}

// --- line search box ---
function initLineSearch() {
    const input = document.getElementById('line-search');
    input.addEventListener('change', () => {
        const name = input.value.trim();
        if (lines[name]) selectLine(name);
    });
    input.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        const val = input.value.trim().toLowerCase();
        const match = Object.keys(lines).find(n => n.toLowerCase().startsWith(val));
        if (match) selectLine(match);
    });
}

// --- select a named line and load journey stats for its stations ---
async function selectLine(name) {
    if (!lines[name] || placingCircle) return;
    if (circle) clearCircle();

    deactivateOriginSelection('Line mode active');
    selectedLine = name;
    lineDisplayLimit = 15;
    document.getElementById('line-search').value = name;
    setLinePanelLoading();

    const tlcs = lines[name].filter(tlc => stations[tlc]);
    const coords = tlcs.map(tlc => [stations[tlc].la, stations[tlc].lo]);

    for (const tlc of tlcs) {
        stationMarkers[tlc].setStyle({ ...LINE_STATION_STYLE });
        stationMarkers[tlc].bringToFront();
    }
    L.polyline(coords, { color: '#66bb6a', weight: 3, opacity: 0.6 }).addTo(lineShapeLayer);

    if (coords.length) {
        map.flyToBounds(L.latLngBounds(coords), { padding: [50, 50], duration: 1.2 });
    }

    document.getElementById('legend').style.display = '';
    await recomputeLine();
}

// --- sums journeys starting on the line, and those staying entirely on it ---
async function recomputeLine() {
    if (!selectedLine) return;
    const token = ++lineComputeToken;

    const tlcs = lines[selectedLine].filter(tlc => stations[tlc]);
    const lineSet = new Set(tlcs);

    const outboundLists = await Promise.all(tlcs.map(fetchOutbound));
    if (token !== lineComputeToken) return; // a newer recompute superseded this one

    let startJourneys = 0; // every journey starting at a station on the line, to any destination
    let bothJourneys = 0;  // journeys where both origin and destination are on the line
    const bothEdges = [];  // [[origin, dest, journeys], ...], for drawing

    tlcs.forEach((tlc, i) => {
        for (const [dest, journeys] of outboundLists[i]) {
            startJourneys += journeys;
            if (lineSet.has(dest)) {
                bothJourneys += journeys;
                bothEdges.push([tlc, dest, journeys]);
            }
        }
    });
    bothEdges.sort((a, b) => b[2] - a[2]); // busiest first, so "top N" and the colour ramp both make sense

    lineStatsData = { stations: tlcs, startJourneys, bothJourneys, bothEdges };
    renderLineOD();
    renderLinePanel();
}

// --- the "both" edges currently on screen, limited by lineDisplayLimit ---
function getVisibleLineEdges() {
    if (!lineStatsData) return [];
    const { bothEdges } = lineStatsData;
    return lineDisplayLimit === Infinity ? bothEdges : bothEdges.slice(0, lineDisplayLimit);
}

// --- draws only the journeys that stay entirely on the line, capped to the display limit ---
function renderLineOD() {
    lineOdLayer.clearLayers();
    if (!lineStatsData) return;

    const { bothEdges } = lineStatsData;
    const logMax = bothEdges.length ? Math.log10(bothEdges[0][2] + 1) : 1; // scale is fixed to the busiest route, regardless of how many are shown

    for (const [o, d, journeys] of getVisibleLineEdges()) {
        const os = stations[o], ds = stations[d];
        if (!os || !ds) continue;

        const ratio = logRatio(journeys, logMax);
        const line = L.polyline([[os.la, os.lo], [ds.la, ds.lo]], {
            color: journeyColor(ratio),
            weight: 0.5 + ratio * 4,
            opacity: 0.2 + ratio * 0.7,
        });
        line.bindTooltip(`<strong>${os.n} → ${ds.n}</strong><br>${journeys.toLocaleString()} journeys`, { sticky: true });
        line.on('mouseover', function () { this.setStyle({ weight: this.options.weight + 1.5 }); });
        line.on('mouseout',  function () { this.setStyle({ weight: this.options.weight - 1.5 }); });
        line.addTo(lineOdLayer);
    }
}

function setLinePanelLoading() {
    document.getElementById('panel-body').innerHTML = '<p class="text-muted small text-center py-2">Computing journeys on line…</p>';
}

// --- detailed stats panel for line mode ---
function renderLinePanel() {
    if (!lineStatsData) return;

    const { stations: sList, startJourneys, bothJourneys, bothEdges } = lineStatsData;
    const visible = getVisibleLineEdges();
    const visibleJourneys = visible.reduce((sum, [, , j]) => sum + j, 0);

    const sliderVal = lineDisplayLimit === Infinity ? bothEdges.length : Math.min(lineDisplayLimit, bothEdges.length);
    const limitLabel = lineDisplayLimit === Infinity ? `All (${bothEdges.length.toLocaleString()})` : sliderVal.toLocaleString();

    document.getElementById('panel-body').innerHTML = `
      <div class="origin-name">${selectedLine}</div>
      <div class="mb-3">
        <div class="stat-row">
          <span class="stat-label">Stations on line</span>
          <span class="stat-value" id="line-station-count">${sList.length.toLocaleString()}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Journeys starting on line</span>
          <span class="stat-value" id="line-start-journeys">${startJourneys.toLocaleString()}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Start &amp; end on line (all routes)</span>
          <span class="stat-value" id="line-both-journeys">${bothJourneys.toLocaleString()}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Routes shown</span>
          <span class="stat-value" id="line-routes-shown">${visible.length.toLocaleString()} / ${bothEdges.length.toLocaleString()}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Journeys shown</span>
          <span class="stat-value" id="line-journeys-shown">${visibleJourneys.toLocaleString()}</span>
        </div>
      </div>

      <div class="mb-3">
        <div class="d-flex justify-content-between text-muted mb-1" style="font-size:0.7rem">
          <label for="line-limit-slider" class="mb-0">Routes shown (busiest first)</label>
          <span id="line-limit-label" class="text-info fw-semibold">${limitLabel}</span>
        </div>
        <div class="d-flex gap-1 mb-2">
          <button class="${lineDisplayLimit === 15 ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary'} flex-fill" onclick="setLineLimit(15)">Top 15</button>
          <button class="${lineDisplayLimit === 50 ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary'} flex-fill" onclick="setLineLimit(50)">Top 50</button>
          <button class="${lineDisplayLimit === 100 ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary'} flex-fill" onclick="setLineLimit(100)">Top 100</button>
          <button class="${lineDisplayLimit === Infinity ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary'} flex-fill" onclick="setLineLimit(Infinity)">All</button>
        </div>
        <input id="line-limit-slider" type="range" class="form-range" min="1" max="${Math.max(bothEdges.length, 1)}" value="${sliderVal}" />
      </div>

      <button class="btn btn-sm btn-outline-danger w-100" onclick="clearLine()">Clear line</button>
    `;
    document.getElementById('line-limit-slider').addEventListener('input', onLineLimitSlider);
}

// --- set the "both" routes display limit via button ---
function setLineLimit(n) {
    if (!lineStatsData) return;
    lineDisplayLimit = n;
    renderLineOD();
    renderLinePanel();
}

// --- slider drives the same display limit ---
function onLineLimitSlider(e) {
    if (!lineStatsData) return;
    const val = parseInt(e.target.value, 10);
    const atMax = val >= lineStatsData.bothEdges.length;
    lineDisplayLimit = atMax ? Infinity : val;
    const label = document.getElementById('line-limit-label');
    if (label) label.textContent = atMax ? `All (${lineStatsData.bothEdges.length.toLocaleString()})` : val.toLocaleString();
    renderLineOD();
    refreshLineStats();
}

// --- lightweight stat refresh that avoids a full panel re-render ---
function refreshLineStats() {
    if (!lineStatsData) return;
    const { bothEdges } = lineStatsData;
    const visible = getVisibleLineEdges();
    const visibleJourneys = visible.reduce((sum, [, , j]) => sum + j, 0);

    const shownRoutesEl = document.getElementById('line-routes-shown');
    const shownJourneysEl = document.getElementById('line-journeys-shown');
    if (shownRoutesEl) shownRoutesEl.textContent = `${visible.length.toLocaleString()} / ${bothEdges.length.toLocaleString()}`;
    if (shownJourneysEl) shownJourneysEl.textContent = visibleJourneys.toLocaleString();
}

// --- removes the line entirely and restores station-search mode ---
function clearLine() {
    if (!selectedLine) return;

    for (const tlc of lines[selectedLine]) {
        if (stationMarkers[tlc]) stationMarkers[tlc].setStyle({ ...STATION_STYLE });
    }
    lineShapeLayer.clearLayers();
    lineOdLayer.clearLayers();
    selectedLine = null;
    lineStatsData = null;
    lineDisplayLimit = 15;
    lineComputeToken++; // invalidate any in-flight recompute

    document.getElementById('line-search').value = '';
    document.getElementById('legend').style.display = 'none';

    reactivateOriginSelection();
}

// --- panel state helpers ---
function setPanelLoading() {
    document.getElementById('panel-body').innerHTML = '<p class="text-muted small text-center py-2">Loading…</p>';
}

function setPanelError() {
    document.getElementById('panel-body').innerHTML = '<p class="text-muted small">No OD data found for this station.</p>';
}

// --- full panel render ---
function renderPanel() {
    if (circle) return; // circle mode owns the panel while active
    const s = stations[selectedOrigin];
    const totalDests = currentPairs.length;
    const totalJourneys = currentPairs.reduce((sum, [, j]) => sum + j, 0);
    const visible = getVisiblePairs();
    const visibleJ = visible.reduce((sum, [, j]) => sum + j, 0);

    const sliderVal = destFilter ? 0
        : (displayLimit === Infinity ? totalDests : Math.min(displayLimit, totalDests));
    const limitLabel = destFilter ? '—'
        : (displayLimit === Infinity ? `All (${totalDests.toLocaleString()})` : Math.min(displayLimit, totalDests).toLocaleString());

    // Destination datalist options (all pairs for this origin)
    const destOptions = currentPairs.map(([dest]) => {
        const name = stations[dest]?.n ?? dest;
        return `<option value="${name}">`;
    }).join('');

    // Top list: show up to 10 from visible, or the filtered single entry
    const listPairs = visible.slice(0, destFilter ? visible.length : 10);
    const topItems = listPairs.length
        ? listPairs.map(([dest, j]) => {
            const name = stations[dest]?.n ?? dest;
            return `<div class="top-item" onclick="flyToStation('${dest}')">
              <span class="dest-name">${name}</span>
              <span class="journey-count">${j.toLocaleString()}</span>
            </div>`;
          }).join('')
        : '<p class="text-muted small mt-1">No matching destination.</p>';

    const destFilterName = destFilter ? (stations[destFilter]?.n ?? destFilter) : '';

    document.getElementById('panel-body').innerHTML = `
      <div class="origin-name">${s.n}</div>

      <div class="mb-3">
        <div class="stat-row">
          <span class="stat-label">Origin code</span>
          <span class="stat-value mono">${selectedOrigin}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Total destinations</span>
          <span class="stat-value">${totalDests.toLocaleString()}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Total journeys (all)</span>
          <span class="stat-value">${totalJourneys.toLocaleString()}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Destinations shown</span>
          <span class="stat-value" id="dest-count">${visible.length.toLocaleString()}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Journeys shown</span>
          <span class="stat-value" id="journey-total">${visibleJ.toLocaleString()}</span>
        </div>
      </div>

      <div class="mb-3">
        <div class="d-flex justify-content-between text-muted mb-1" style="font-size:0.7rem">
          <label for="dest-limit" class="mb-0">Destinations shown</label>
          <span id="limit-label" class="text-info fw-semibold">${limitLabel}</span>
        </div>
        <div class="d-flex gap-1 mb-2">
          <button class="${!destFilter && displayLimit === 15 ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary'} flex-fill" onclick="setLimit(15)">Top 15</button>
          <button class="${!destFilter && displayLimit === 50 ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary'} flex-fill" onclick="setLimit(50)">Top 50</button>
          <button class="${!destFilter && displayLimit === 100 ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary'} flex-fill" onclick="setLimit(100)">Top 100</button>
          <button class="${!destFilter && displayLimit === Infinity ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary'} flex-fill" onclick="setLimit(Infinity)">All</button>
        </div>
        <input id="dest-limit" type="range" class="form-range" min="1" max="${totalDests}" value="${sliderVal}" ${destFilter ? 'disabled' : ''} />
      </div>

      <div class="mb-3">
        <label for="dest-search" class="text-uppercase text-muted mb-1 d-block" style="font-size:0.7rem;letter-spacing:0.06em">Filter to destination</label>
        <div class="d-flex gap-2 align-items-center mb-1">
          <input id="dest-search" class="form-control form-control-sm flex-fill${destFilter ? ' border-warning' : ''}" type="text"
            list="dest-list-options" placeholder="Any destination…" autocomplete="off"
            value="${destFilterName}" />
          ${destFilter ? `<button class="btn btn-sm btn-outline-danger px-2" onclick="clearDestFilter()" title="Clear filter">✕</button>` : ''}
        </div>
        <datalist id="dest-list-options">${destOptions}</datalist>
        ${destFilter ? (() => {
          const outbound = visible[0]?.[1] ?? null;
          const inbound = getReverseJourneys(destFilter);
          const rank = currentPairs.findIndex(([d]) => d === destFilter) + 1;
          const destName = stations[destFilter]?.n ?? destFilter;
          return `
        <div class="rounded p-2 mt-1" style="background:rgba(0,0,0,0.25)">
          <div class="stat-row"><span class="stat-label">Destination code</span><span class="stat-value mono">${destFilter}</span></div>
          <div class="stat-row"><span class="stat-label">Rank from ${s.n.split(' ')[0]}</span><span class="stat-value">#${rank.toLocaleString()}</span></div>
          <div class="stat-row"><span class="stat-label">${s.n.split(' ')[0]} → ${destName.split(' ')[0]}</span><span class="stat-value">${outbound !== null ? outbound.toLocaleString() : '—'}</span></div>
          <div class="stat-row"><span class="stat-label">${destName.split(' ')[0]} → ${s.n.split(' ')[0]}</span><span class="stat-value">${inbound !== null ? inbound.toLocaleString() : '…'}</span></div>
        </div>`;
        })() : ''}
      </div>

      <div class="text-uppercase text-muted mb-1" style="font-size:0.7rem;letter-spacing:0.06em">Top destinations</div>
      <div id="top-list">${topItems}</div>
    `;

    document.getElementById('dest-limit').addEventListener('input', onLimitSlider);
    document.getElementById('dest-search').addEventListener('change', onDestFilterChange);
}

// --- set display limit via button ---
function setLimit(n) {
    if (!selectedOrigin) return;
    destFilter = null;
    displayLimit = n;
    renderOD();
    renderPanel();
}

// --- slider drives display limit ---
function onLimitSlider(e) {
    const val = parseInt(e.target.value, 10);
    const atMax = val >= currentPairs.length;
    displayLimit = atMax ? Infinity : val;
    const label = document.getElementById('limit-label');
    if (label) label.textContent = atMax ? `All (${currentPairs.length.toLocaleString()})` : val.toLocaleString();
    renderOD();
    refreshStats();
}

// --- lightweight stat refresh without full panel re-render ---
function refreshStats() {
    const visible = getVisiblePairs();
    const visibleJ = visible.reduce((sum, [, j]) => sum + j, 0);
    const dcEl = document.getElementById('dest-count');
    const jtEl = document.getElementById('journey-total');
    if (dcEl) dcEl.textContent = visible.length.toLocaleString();
    if (jtEl) jtEl.textContent = visibleJ.toLocaleString();
}

// --- destination filter ---
async function onDestFilterChange(e) {
    const val = e.target.value.trim();
    if (!val) { clearDestFilter(); return; }
    const tlc = tlcByName[val];
    if (!tlc || !currentPairs.find(([d]) => d === tlc)) return;
    await applyDestFilter(tlc);
}

async function applyDestFilter(tlc) {
    destFilter = tlc;
    renderOD();
    renderPanel(); // renders immediately with "…" for reverse count

    if (!odCache[tlc]) {
        try {
            const resp = await fetch(`od-data/${safeFilename(tlc)}.json`);
            if (resp.ok) odCache[tlc] = await resp.json();
        } catch {}
    }
    // Re-render only if the user hasn't changed the filter in the meantime
    if (destFilter === tlc) renderPanel();
}

function getReverseJourneys(destTlc) {
    const pairs = odCache[destTlc];
    if (!pairs) return null; // still loading
    const pair = pairs.find(([d]) => d === selectedOrigin);
    return pair ? pair[1] : 0;
}

function clearDestFilter() {
    destFilter = null;
    renderOD();
    renderPanel();
}

// --- fly to a destination station (called from top-list onclick) ---
function flyToStation(tlc) {
    const s = stations[tlc];
    if (!s) return;
    map.flyTo([s.la, s.lo], Math.max(map.getZoom(), 9), { duration: 0.8 });
    if (stationMarkers[tlc]) stationMarkers[tlc].openTooltip();
}

// --- pulls the ODM period (e.g. "2024/25") out of meta.json, if the build wrote one ---
async function loadMeta() {
    try {
        const resp = await fetch('meta.json');
        if (!resp.ok) return;
        const meta = await resp.json();
        if (meta.odmPeriod) {
            document.getElementById('panel-year').textContent = `Based on ${meta.odmPeriod} estimates`;
        }
    } catch {
        // no meta.json (older build) — static label in index.html stands
    }
}

// --- boot ---
async function init() {
    initMap();
    await loadStations();
    await loadMeta();
    await loadLines();
    initSearch();
    initLineSearch();
    await selectOrigin('KGX');
}

document.addEventListener('DOMContentLoaded', init);
