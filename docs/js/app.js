// CON and PRN are reserved Windows filenames; build script prefixes them with _
const WIN_RESERVED = new Set(['CON','PRN','AUX','NUL','COM0','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9','LPT0','LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9']);
function safeFilename(tlc) { return WIN_RESERVED.has(tlc.toUpperCase()) ? `_${tlc}` : tlc; }

let map, stationLayer, odLayer;
let stations = {};      // { TLC: { n, la, lo } }
let stationMarkers = {}; // { TLC: L.circleMarker }
let tlcByName = {};     // { "Station Name": TLC }
let selectedOrigin = null;
let currentPairs = [];  // [[dest_tlc, journeys], ...] sorted desc
let minJourneys = 1;

const STATION_STYLE = { radius: 3, fillColor: '#607d8b', color: '#37474f', weight: 0.5, fillOpacity: 0.8 };
const ORIGIN_STYLE  = { radius: 8, fillColor: '#fdd835', color: '#fff', weight: 1.5, fillOpacity: 1 };

// --- colour ramp: blue → cyan → orange → red (log-scaled journey count) ---
function journeyColor(ratio) {
    // 0 → #4fc3f7 (light blue), 1 → #e53935 (red) via orange
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
    const r = Math.round(lo[1] + t * (hi[1] - lo[1]));
    const g = Math.round(lo[2] + t * (hi[2] - lo[2]));
    const b = Math.round(lo[3] + t * (hi[3] - lo[3]));
    return `rgb(${r},${g},${b})`;
}

function logRatio(journeys, logMax) {
    return logMax > 0 ? Math.log10(journeys + 1) / logMax : 0;
}

// --- map init ---
function initMap() {
    map = L.map('map', { zoomControl: false }).setView([54.5, -2.5], 6);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_matter/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19,
    }).addTo(map);
    stationLayer = L.layerGroup().addTo(map);
    odLayer = L.layerGroup().addTo(map);
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

// --- search box ---
function initSearch() {
    const input = document.getElementById('search');
    input.addEventListener('change', () => {
        const tlc = tlcByName[input.value.trim()];
        if (tlc) selectOrigin(tlc);
    });
    // also respond to Enter when a partial match exists
    input.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        const val = input.value.trim().toLowerCase();
        const match = Object.entries(tlcByName).find(([n]) => n.toLowerCase().startsWith(val));
        if (match) selectOrigin(match[1]);
    });
}

// --- select origin station and load its OD data ---
async function selectOrigin(tlc) {
    if (!stations[tlc]) return;

    // reset previous origin marker
    if (selectedOrigin && stationMarkers[selectedOrigin]) {
        stationMarkers[selectedOrigin].setStyle({ ...STATION_STYLE });
    }

    selectedOrigin = tlc;
    stationMarkers[tlc].setStyle({ ...ORIGIN_STYLE });
    stationMarkers[tlc].bringToFront();

    document.getElementById('search').value = stations[tlc].n;
    setPanelLoading();

    try {
        const resp = await fetch(`od-data/${safeFilename(tlc)}.json`);
        if (!resp.ok) throw new Error('not found');
        currentPairs = await resp.json();
    } catch {
        setPanelError();
        return;
    }

    minJourneys = 1;
    resetSlider();
    renderOD();
    renderPanel();
    document.getElementById('legend').style.display = '';
}

// --- draw OD lines ---
function renderOD() {
    odLayer.clearLayers();
    if (!selectedOrigin) return;

    const origin = stations[selectedOrigin];
    const logMax = currentPairs.length ? Math.log10(currentPairs[0][1] + 1) : 1;

    for (const [dest, journeys] of currentPairs) {
        if (journeys < minJourneys) break; // sorted desc, safe to break early
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

// --- panel rendering ---
function setPanelLoading() {
    document.getElementById('panel-body').innerHTML = '<p class="loading">Loading…</p>';
}

function setPanelError() {
    document.getElementById('panel-body').innerHTML = '<p class="hint">No OD data found for this station.</p>';
}

function renderPanel() {
    const s = stations[selectedOrigin];
    const filtered = currentPairs.filter(([, j]) => j >= minJourneys);
    const totalJ = filtered.reduce((sum, [, j]) => sum + j, 0);
    const logMax = currentPairs.length ? Math.log10(currentPairs[0][1] + 1) : 1;
    // slider max maps to logMax (in tenths)
    const sliderMax = Math.ceil(logMax * 10);

    const topItems = filtered.slice(0, 10).map(([dest, j]) => {
        const name = stations[dest]?.n ?? dest;
        return `<div class="top-item" onclick="flyToStation('${dest}')">
          <span class="dest-name">${name}</span>
          <span class="journey-count">${j.toLocaleString()}</span>
        </div>`;
    }).join('');

    document.getElementById('panel-body').innerHTML = `
      <div class="origin-name">${s.n}</div>
      <div class="stat-block">
        <div class="stat-row">
          <span class="stat-label">Destinations shown</span>
          <span class="stat-value" id="dest-count">${filtered.length.toLocaleString()}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Journeys shown</span>
          <span class="stat-value" id="journey-total">${totalJ.toLocaleString()}</span>
        </div>
      </div>
      <div class="filter-block">
        <div class="filter-label">
          <span>Min journeys</span>
          <span id="min-label">${minJourneys.toLocaleString()}</span>
        </div>
        <input id="min-journeys" type="range" min="0" max="${sliderMax}" step="1" value="0" />
      </div>
      <div class="section-title">Top destinations</div>
      <div class="top-list" id="top-list">${topItems}</div>
    `;

    document.getElementById('min-journeys').addEventListener('input', onSliderChange);
}

function resetSlider() {
    // slider is re-created in renderPanel, nothing to do here
}

function onSliderChange(e) {
    const val = parseInt(e.target.value, 10);
    minJourneys = Math.max(1, Math.round(Math.pow(10, val / 10)));
    document.getElementById('min-label').textContent = minJourneys.toLocaleString();

    renderOD();

    const filtered = currentPairs.filter(([, j]) => j >= minJourneys);
    const totalJ = filtered.reduce((sum, [, j]) => sum + j, 0);
    document.getElementById('dest-count').textContent = filtered.length.toLocaleString();
    document.getElementById('journey-total').textContent = totalJ.toLocaleString();

    const topItems = filtered.slice(0, 10).map(([dest, j]) => {
        const name = stations[dest]?.n ?? dest;
        return `<div class="top-item" onclick="flyToStation('${dest}')">
          <span class="dest-name">${name}</span>
          <span class="journey-count">${j.toLocaleString()}</span>
        </div>`;
    }).join('');
    document.getElementById('top-list').innerHTML = topItems;
}

// --- fly to a destination station (called from top-list onclick) ---
function flyToStation(tlc) {
    const s = stations[tlc];
    if (!s) return;
    map.flyTo([s.la, s.lo], Math.max(map.getZoom(), 9), { duration: 0.8 });
    if (stationMarkers[tlc]) {
        stationMarkers[tlc].openTooltip();
    }
}

// --- boot ---
async function init() {
    initMap();
    await loadStations();
    initSearch();
}

document.addEventListener('DOMContentLoaded', init);
