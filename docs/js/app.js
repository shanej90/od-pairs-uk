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

const STATION_STYLE = { radius: 3, fillColor: '#607d8b', color: '#37474f', weight: 0.5, fillOpacity: 0.8 };
const ORIGIN_STYLE  = { radius: 8, fillColor: '#fdd835', color: '#fff', weight: 1.5, fillOpacity: 1 };

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
    if (!stations[tlc]) return;

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

// --- panel state helpers ---
function setPanelLoading() {
    document.getElementById('panel-body').innerHTML = '<p class="loading">Loading…</p>';
}

function setPanelError() {
    document.getElementById('panel-body').innerHTML = '<p class="hint">No OD data found for this station.</p>';
}

// --- full panel render ---
function renderPanel() {
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
        : '<p class="hint" style="margin-top:4px">No matching destination.</p>';

    const destFilterName = destFilter ? (stations[destFilter]?.n ?? destFilter) : '';

    document.getElementById('panel-body').innerHTML = `
      <div class="origin-name">${s.n}</div>

      <div class="stat-block">
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

      <div class="filter-block">
        <div class="filter-label">
          <span>Destinations shown</span>
          <span id="limit-label">${limitLabel}</span>
        </div>
        <div class="preset-btns">
          <button class="preset-btn${!destFilter && displayLimit === 15 ? ' active' : ''}" onclick="setLimit(15)">Top 15</button>
          <button class="preset-btn${!destFilter && displayLimit === 50 ? ' active' : ''}" onclick="setLimit(50)">Top 50</button>
          <button class="preset-btn${!destFilter && displayLimit === 100 ? ' active' : ''}" onclick="setLimit(100)">Top 100</button>
          <button class="preset-btn${!destFilter && displayLimit === Infinity ? ' active' : ''}" onclick="setLimit(Infinity)">All</button>
        </div>
        <input id="dest-limit" type="range" min="1" max="${totalDests}" value="${sliderVal}" ${destFilter ? 'disabled' : ''} />
      </div>

      <div class="dest-filter-section">
        <div class="section-title">Filter to destination</div>
        <div class="dest-filter-row">
          <input id="dest-search" class="dest-search-input${destFilter ? ' active' : ''}" type="text"
            list="dest-list-options" placeholder="Any destination…" autocomplete="off"
            value="${destFilterName}" />
          ${destFilter ? `<button class="clear-btn" onclick="clearDestFilter()" title="Clear filter">✕</button>` : ''}
        </div>
        <datalist id="dest-list-options">${destOptions}</datalist>
        ${destFilter ? (() => {
          const outbound = visible[0]?.[1] ?? null;
          const inbound = getReverseJourneys(destFilter);
          const rank = currentPairs.findIndex(([d]) => d === destFilter) + 1;
          const destName = stations[destFilter]?.n ?? destFilter;
          return `
        <div class="dest-filter-stats">
          <div class="stat-row"><span class="stat-label">Destination code</span><span class="stat-value mono">${destFilter}</span></div>
          <div class="stat-row"><span class="stat-label">Rank from ${s.n.split(' ')[0]}</span><span class="stat-value">#${rank.toLocaleString()}</span></div>
          <div class="stat-row"><span class="stat-label">${s.n.split(' ')[0]} → ${destName.split(' ')[0]}</span><span class="stat-value">${outbound !== null ? outbound.toLocaleString() : '—'}</span></div>
          <div class="stat-row"><span class="stat-label">${destName.split(' ')[0]} → ${s.n.split(' ')[0]}</span><span class="stat-value">${inbound !== null ? inbound.toLocaleString() : '…'}</span></div>
        </div>`;
        })() : ''}
      </div>

      <div class="section-title">Top destinations</div>
      <div class="top-list" id="top-list">${topItems}</div>
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
    initSearch();
    await selectOrigin('KGX');
}

document.addEventListener('DOMContentLoaded', init);
