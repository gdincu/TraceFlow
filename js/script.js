let map, trackMarker, trackLayers = null, points = [];
let totalDistanceKm = 0, totalDurationSec = 0, hasTiming = true;

const slider = document.getElementById('time-slider');
const playPauseBtn = document.getElementById('play-pause-btn');
const speedSelector = document.getElementById('speed-selector');
const elevationSvg = document.getElementById('elevation-svg');
const trackNameEl = document.getElementById('track-name');
const elapsedTimeEl = document.getElementById('elapsed-time');
const totalTimeEl = document.getElementById('total-time');
const fileInput = document.getElementById('file-input');
const dropOverlay = document.getElementById('drop-overlay');
const iconRow = document.getElementById('icon-row');
const iconFileInput = document.getElementById('icon-file-input');
const statEls = {
    distance: document.getElementById('stat-distance'),
    totalDistance: document.getElementById('stat-total-distance'),
    speed: document.getElementById('stat-speed'),
    elevation: document.getElementById('stat-elevation'),
    gain: document.getElementById('stat-gain'),
};

const PROFILE_W = 400, PROFILE_H = 90, PROFILE_PAD = 6;
const NOMINAL_SPEED_KMH = 20; // assumed pace when a file has no usable timestamps
const SPEED_HALF_WINDOW_SEC = 2.5; // speed is averaged over ±2.5 s to tame GPS jitter

// Built-in marker icons. To add your own: drop an image into assets/ and add an
// { id, label, src, rotates } entry here — or load one at runtime with the + button.
// `rotates: true` spins the icon to follow the direction of travel, so the image
// should point up (north); emoji don't, so they stay upright.
const ICONS = [
    { id: 'bike', label: 'Bike', src: 'assets/bike.png', rotates: true },
    { id: 'run', label: 'Runner', emoji: '🏃', rotates: false },
    { id: 'hike', label: 'Hiker', emoji: '🥾', rotates: false },
    { id: 'car', label: 'Car', emoji: '🚗', rotates: false },
];
const ICON_STORAGE_KEY = 'traceflow-icon';
let currentIcon = ICONS[0];

function makeLeafletIcon(entry) {
    const imgSrc = entry.src || entry.dataUrl;
    const html = imgSrc
        ? `<img class="marker-inner" src="${imgSrc}" alt="${entry.label}">`
        : `<span class="marker-inner">${entry.emoji}</span>`;
    return L.divIcon({ className: 'track-marker', html, iconSize: [32, 32], iconAnchor: [16, 16] });
}

function selectIcon(entry) {
    currentIcon = entry;
    for (const btn of iconRow.querySelectorAll('button')) {
        btn.classList.toggle('selected', btn.dataset.iconId === entry.id);
    }
    if (trackMarker) {
        trackMarker.setIcon(makeLeafletIcon(entry));
        update(); // reapply rotation to the freshly created marker element
    }
    persistIconChoice();
}

function setCustomIcon(dataUrl) {
    const entry = { id: 'custom', label: 'Custom', dataUrl, rotates: true };
    let btn = iconRow.querySelector('[data-icon-id="custom"]');
    if (!btn) {
        btn = document.createElement('button');
        btn.dataset.iconId = 'custom';
        btn.title = 'Custom icon';
        iconRow.insertBefore(btn, document.getElementById('icon-upload-btn'));
    }
    btn.innerHTML = `<img src="${dataUrl}" alt="Custom icon">`;
    btn.onclick = () => selectIcon(entry);
    selectIcon(entry);
}

function buildIconRow() {
    for (const entry of ICONS) {
        const btn = document.createElement('button');
        btn.dataset.iconId = entry.id;
        btn.title = entry.label;
        btn.innerHTML = entry.src ? `<img src="${entry.src}" alt="${entry.label}">` : entry.emoji;
        btn.onclick = () => selectIcon(entry);
        iconRow.appendChild(btn);
    }
    const uploadBtn = document.createElement('button');
    uploadBtn.id = 'icon-upload-btn';
    uploadBtn.title = 'Load custom icon image';
    uploadBtn.setAttribute('aria-label', 'Load custom icon image');
    uploadBtn.innerHTML = '<i class="fas fa-plus"></i>';
    uploadBtn.onclick = () => iconFileInput.click();
    iconRow.appendChild(uploadBtn);
}

function persistIconChoice() {
    try {
        localStorage.setItem(ICON_STORAGE_KEY, JSON.stringify(
            currentIcon.id === 'custom' ? { dataUrl: currentIcon.dataUrl } : { id: currentIcon.id }
        ));
    } catch { /* storage full or unavailable — selection just won't persist */ }
}

function restoreIconChoice() {
    try {
        const saved = JSON.parse(localStorage.getItem(ICON_STORAGE_KEY));
        if (saved?.dataUrl) {
            setCustomIcon(saved.dataUrl);
            return true;
        }
        const entry = ICONS.find(ic => ic.id === saved?.id);
        if (entry) {
            selectIcon(entry);
            return true;
        }
    } catch { /* ignore corrupt stored value */ }
    return false;
}

function initMap() {
    map = L.map('map').setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
    }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
}

function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingDegrees(a, b) {
    const toRad = deg => deg * Math.PI / 180, toDeg = rad => rad * 180 / Math.PI;
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const dLon = toRad(b.lon - a.lon);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function parseGPX(xmlText) {
    const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('Not a valid GPX file');

    const trackName =
        xml.querySelector('trk > name')?.textContent?.trim() ||
        xml.querySelector('rte > name')?.textContent?.trim() ||
        xml.querySelector('metadata > name')?.textContent?.trim() || '';

    // Recorded tracks use <trkpt>; planned routes use <rtept>.
    let nodes = [...xml.querySelectorAll('trkpt')];
    if (!nodes.length) nodes = [...xml.querySelectorAll('rtept')];

    const rawPoints = nodes.map(pt => {
        const timeText = pt.querySelector('time')?.textContent;
        return {
            lat: parseFloat(pt.getAttribute('lat')),
            lon: parseFloat(pt.getAttribute('lon')),
            ele: parseFloat(pt.querySelector('ele')?.textContent ?? '0') || 0,
            timeMs: timeText ? Date.parse(timeText) : NaN,
        };
    }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));

    return { trackName, rawPoints };
}

// Enriches raw trackpoints with cumulative distance, elapsed time, elevation gain,
// smoothed speed and bearing, so the rest of the app can index into a single flat,
// precomputed array.
function buildDerivedData(rawPoints) {
    const n = rawPoints.length;

    const cumDistKm = new Array(n).fill(0);
    let cum = 0;
    for (let i = 1; i < n; i++) {
        cum += haversineMeters(rawPoints[i - 1], rawPoints[i]);
        cumDistKm[i] = cum / 1000;
    }

    // Elapsed seconds per point. Real timestamps are clamped monotonic; files
    // without usable timing (e.g. planned routes) get time synthesized from
    // distance at a nominal pace so playback still works.
    let elapsed = null;
    if (rawPoints.every(p => Number.isFinite(p.timeMs))) {
        const startMs = rawPoints[0].timeMs;
        elapsed = rawPoints.map(p => (p.timeMs - startMs) / 1000);
        for (let i = 1; i < n; i++) elapsed[i] = Math.max(elapsed[i], elapsed[i - 1]);
    }
    const hasTiming = !!(elapsed && elapsed[n - 1] > 0);
    if (!hasTiming) elapsed = cumDistKm.map(d => (d / NOMINAL_SPEED_KMH) * 3600);

    // Light smoothing keeps GPS elevation noise from inflating the gain total.
    const smoothEle = rawPoints.map((_, i) => {
        const j0 = Math.max(0, i - 2), j1 = Math.min(n - 1, i + 2);
        let sum = 0;
        for (let j = j0; j <= j1; j++) sum += rawPoints[j].ele;
        return sum / (j1 - j0 + 1);
    });
    const cumGain = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
        const climb = smoothEle[i] - smoothEle[i - 1];
        cumGain[i] = cumGain[i - 1] + (climb > 0 ? climb : 0);
    }

    // Speed over a time window instead of a single GPS segment, which is jittery.
    const speeds = rawPoints.map((_, i) => {
        let j0 = i, j1 = i;
        while (j0 > 0 && elapsed[i] - elapsed[j0 - 1] <= SPEED_HALF_WINDOW_SEC) j0--;
        while (j1 < n - 1 && elapsed[j1 + 1] - elapsed[i] <= SPEED_HALF_WINDOW_SEC) j1++;
        const dt = elapsed[j1] - elapsed[j0];
        return dt > 0 ? ((cumDistKm[j1] - cumDistKm[j0]) / dt) * 3600 : 0;
    });

    // Bearing towards the next point; carried over when nearly stationary so the
    // marker doesn't spin on GPS noise, and at the last point.
    const bearings = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        if (i < n - 1 && haversineMeters(rawPoints[i], rawPoints[i + 1]) > 0.5) {
            bearings[i] = bearingDegrees(rawPoints[i], rawPoints[i + 1]);
        } else if (i > 0) {
            bearings[i] = bearings[i - 1];
        }
    }

    let minEle = Infinity, maxEle = -Infinity;
    for (const p of rawPoints) {
        if (p.ele < minEle) minEle = p.ele;
        if (p.ele > maxEle) maxEle = p.ele;
    }

    return {
        points: rawPoints.map((p, i) => ({
            lat: p.lat, lon: p.lon, ele: p.ele,
            elapsedSec: elapsed[i],
            cumDistKm: cumDistKm[i],
            cumGain: cumGain[i],
            speedKmh: speeds[i],
            bearing: bearings[i],
        })),
        totalDistanceKm: cum / 1000,
        totalDurationSec: elapsed[n - 1],
        hasTiming,
        minEle,
        maxEle,
    };
}

function renderRoute() {
    if (trackLayers) trackLayers.remove();
    trackLayers = L.layerGroup().addTo(map);

    const latlngs = points.map(p => [p.lat, p.lon]);
    const routeLine = L.polyline(latlngs, { color: '#ff5722', weight: 4, opacity: 0.85 }).addTo(trackLayers);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });

    L.circleMarker(latlngs[0], { radius: 7, color: '#2e7d32', fillColor: '#4caf50', fillOpacity: 1, weight: 2 })
        .addTo(trackLayers).bindPopup('<b>Start</b>');
    L.circleMarker(latlngs[latlngs.length - 1], { radius: 7, color: '#b71c1c', fillColor: '#f44336', fillOpacity: 1, weight: 2 })
        .addTo(trackLayers).bindPopup('<b>Finish</b>');

    trackMarker = L.marker(latlngs[0], { icon: makeLeafletIcon(currentIcon) }).addTo(trackLayers);
}

function buildElevationProfile(minEle, maxEle) {
    const eleRange = Math.max(1, maxEle - minEle);
    const distRange = Math.max(1e-6, totalDistanceKm);
    const yFor = ele => PROFILE_H - PROFILE_PAD - ((ele - minEle) / eleRange) * (PROFILE_H - 2 * PROFILE_PAD);
    const xFor = distKm => (distKm / distRange) * PROFILE_W;

    // One bucket per horizontal unit, keeping each bucket's min and max point so
    // downsampling doesn't shave off peaks and dips.
    const n = points.length;
    const buckets = Math.min(n, PROFILE_W);
    const coords = [];
    for (let b = 0; b < buckets; b++) {
        const i0 = Math.floor(b * n / buckets);
        const i1 = Math.max(i0 + 1, Math.floor((b + 1) * n / buckets));
        let minI = i0, maxI = i0;
        for (let i = i0; i < i1; i++) {
            if (points[i].ele < points[minI].ele) minI = i;
            if (points[i].ele > points[maxI].ele) maxI = i;
        }
        const idxs = minI === maxI ? [minI] : (minI < maxI ? [minI, maxI] : [maxI, minI]);
        for (const i of idxs) {
            coords.push(`${xFor(points[i].cumDistKm).toFixed(1)},${yFor(points[i].ele).toFixed(1)}`);
        }
    }
    coords.push(`${PROFILE_W},${yFor(points[n - 1].ele).toFixed(1)}`);

    const linePoints = coords.join(' ');
    const areaPoints = `0,${PROFILE_H} ${linePoints} ${PROFILE_W},${PROFILE_H}`;

    elevationSvg.innerHTML = `
        <polygon points="${areaPoints}" fill="rgba(255,87,34,0.15)"></polygon>
        <polyline points="${linePoints}" fill="none" stroke="#ff5722" stroke-width="1.5" vector-effect="non-scaling-stroke"></polyline>
        <line id="elevation-cursor" x1="0" y1="0" x2="0" y2="${PROFILE_H}" stroke="#0078ff" stroke-width="1.5" vector-effect="non-scaling-stroke"></line>
    `;
}

function updateElevationCursor(cumDistKm) {
    const cursor = document.getElementById('elevation-cursor');
    if (!cursor) return;
    const x = (cumDistKm / Math.max(1e-6, totalDistanceKm)) * PROFILE_W;
    cursor.setAttribute('x1', x.toFixed(1));
    cursor.setAttribute('x2', x.toFixed(1));
}

function findIndexForTime(t) {
    let lo = 0, hi = points.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (points[mid].elapsedSec <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
}

function findIndexForDistance(distKm) {
    let lo = 0, hi = points.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (points[mid].cumDistKm <= distKm) lo = mid; else hi = mid - 1;
    }
    return lo;
}

function interpolateAt(t) {
    const i = findIndexForTime(t);
    const a = points[i];
    const b = points[Math.min(i + 1, points.length - 1)];
    const span = b.elapsedSec - a.elapsedSec;
    const frac = span > 0 ? Math.min(1, Math.max(0, (t - a.elapsedSec) / span)) : 0;

    return {
        lat: a.lat + (b.lat - a.lat) * frac,
        lon: a.lon + (b.lon - a.lon) * frac,
        ele: a.ele + (b.ele - a.ele) * frac,
        cumDistKm: a.cumDistKm + (b.cumDistKm - a.cumDistKm) * frac,
        cumGain: a.cumGain,
        bearing: a.bearing,
        speedKmh: a.speedKmh + (b.speedKmh - a.speedKmh) * frac,
    };
}

function secondsToClock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

function update() {
    if (!points.length) return;
    const t = parseFloat(slider.value);
    elapsedTimeEl.textContent = secondsToClock(t);

    const pos = interpolateAt(t);
    trackMarker.setLatLng([pos.lat, pos.lon]);
    const inner = trackMarker.getElement()?.querySelector('.marker-inner');
    if (inner) inner.style.transform = currentIcon.rotates ? `rotate(${pos.bearing}deg)` : '';

    statEls.distance.textContent = pos.cumDistKm.toFixed(1);
    statEls.speed.textContent = hasTiming ? pos.speedKmh.toFixed(1) : '–';
    statEls.elevation.textContent = Math.round(pos.ele);
    statEls.gain.textContent = Math.round(pos.cumGain);

    updateElevationCursor(pos.cumDistKm);
}

function seekToClientX(clientX) {
    const rect = elevationSvg.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const idx = findIndexForDistance(frac * totalDistanceKm);
    slider.value = points[idx].elapsedSec;
    update();
}

const autoPlay = {
    active: false,
    speedMultiplier: 30,
    lastTimestamp: 0,
    toggle() { this.active ? this.stop() : this.start(); },
    start() {
        if (this.active || !points.length) return;
        if (parseFloat(slider.value) >= totalDurationSec) slider.value = 0;
        this.active = true;
        this.lastTimestamp = performance.now();
        playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
        requestAnimationFrame(this.step.bind(this));
    },
    stop() {
        this.active = false;
        playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
    },
    setSpeed(v) { this.speedMultiplier = parseFloat(v); },
    step(now) {
        if (!this.active) return;
        // Clamped so returning to a background tab (where rAF is paused)
        // doesn't fast-forward the whole hidden period at once.
        const dt = Math.min((now - this.lastTimestamp) / 1000, 0.1);
        this.lastTimestamp = now;
        const t = parseFloat(slider.value) + dt * this.speedMultiplier;

        if (t >= totalDurationSec) {
            slider.value = totalDurationSec;
            update();
            this.stop();
            return;
        }
        slider.value = t;
        update();
        requestAnimationFrame(this.step.bind(this));
    },
};

function applyTrack(gpxText, fallbackName) {
    const { trackName, rawPoints } = parseGPX(gpxText);
    if (rawPoints.length < 2) throw new Error('No track points found in GPX file');

    autoPlay.stop();
    const derived = buildDerivedData(rawPoints);
    points = derived.points;
    totalDistanceKm = derived.totalDistanceKm;
    totalDurationSec = derived.totalDurationSec;
    hasTiming = derived.hasTiming;

    const name = trackName || fallbackName || 'Track';
    trackNameEl.textContent = name;
    document.title = `TraceFlow – ${name}`;
    statEls.totalDistance.textContent = totalDistanceKm.toFixed(1);
    totalTimeEl.textContent = secondsToClock(totalDurationSec);

    slider.max = Math.ceil(totalDurationSec);
    slider.value = 0;

    renderRoute();
    buildElevationProfile(derived.minEle, derived.maxEle);
    update();
    autoPlay.start();
}

async function loadDefaultTrack() {
    try {
        const res = await fetch('data/ride.gpx');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        applyTrack(await res.text(), 'ride');
    } catch (err) {
        console.error('Failed to load bundled GPX track:', err);
        trackNameEl.textContent = 'Open a GPX file to begin';
    }
}

async function loadFile(file) {
    try {
        applyTrack(await file.text(), file.name.replace(/\.gpx$/i, ''));
    } catch (err) {
        console.error('Failed to load GPX file:', err);
        trackNameEl.textContent = err.message || 'Failed to load GPX file';
    }
}

slider.addEventListener('input', () => { autoPlay.stop(); update(); });
playPauseBtn.addEventListener('click', () => autoPlay.toggle());
speedSelector.addEventListener('change', e => autoPlay.setSpeed(e.target.value));

document.getElementById('load-btn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) loadFile(file);
    fileInput.value = ''; // allow re-selecting the same file
});

iconFileInput.addEventListener('change', () => {
    const file = iconFileInput.files[0];
    iconFileInput.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCustomIcon(reader.result);
    reader.readAsDataURL(file);
});

window.addEventListener('dragover', e => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    dropOverlay.classList.add('visible');
});
window.addEventListener('dragleave', e => {
    if (!e.relatedTarget) dropOverlay.classList.remove('visible');
});
window.addEventListener('drop', e => {
    e.preventDefault();
    dropOverlay.classList.remove('visible');
    const file = e.dataTransfer.files?.[0];
    if (file) loadFile(file);
});

let profileDragging = false;
elevationSvg.addEventListener('pointerdown', e => {
    profileDragging = true;
    elevationSvg.setPointerCapture(e.pointerId);
    autoPlay.stop();
    seekToClientX(e.clientX);
});
elevationSvg.addEventListener('pointermove', e => { if (profileDragging) seekToClientX(e.clientX); });
elevationSvg.addEventListener('pointerup', () => { profileDragging = false; });

window.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (e.key === ' ') {
        e.preventDefault();
        autoPlay.toggle();
    } else if (e.key === 'ArrowRight') {
        autoPlay.stop();
        slider.value = Math.min(totalDurationSec, parseFloat(slider.value) + 10);
        update();
    } else if (e.key === 'ArrowLeft') {
        autoPlay.stop();
        slider.value = Math.max(0, parseFloat(slider.value) - 10);
        update();
    }
});

buildIconRow();
if (!restoreIconChoice()) selectIcon(currentIcon);
initMap();
loadDefaultTrack();
