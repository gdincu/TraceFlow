const map = L.map('map').setView([39.47, -0.40], 14);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

let trackPoints = [];
let bikeMarker, elevationChart;
let startTime, endTime, totalDuration;
let isLoaded = false;
let currentActiveIndex = 0; // Tracks the slider position for the chart

// 1. Icons and Images
const bikeIcon = L.icon({
    iconUrl: 'assets/bike.png',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -10],
    className: 'bike-marker'
});

// Create a native Image object for the Chart.js Canvas
const bikeImg = new Image();
bikeImg.src = 'assets/bike.png';

const slider = document.getElementById('time-slider');
const timeDisplay = document.getElementById('time-display');

// 2. Data Fetching
fetch('data/ride.gpx')
    .then(res => res.text())
    .then(xmlStr => {
        const xml = new DOMParser().parseFromString(xmlStr, "text/xml");
        const pts = xml.querySelectorAll("trkpt");

        pts.forEach((pt, i) => {
            const lat = parseFloat(pt.getAttribute("lat"));
            const lon = parseFloat(pt.getAttribute("lon"));
            const timeStr = pt.querySelector("time").textContent;
            const time = new Date(timeStr).getTime() / 1000;
            const ele = parseFloat(pt.querySelector("ele").textContent);

            let speed = 0;
            if (i > 0) {
                const prev = trackPoints[i - 1];
                const dist = map.distance([prev.lat, prev.lon], [lat, lon]);
                const dt = time - prev.time;
                speed = dt > 0 ? (dist / dt) * 3.6 : 0;
            }
            trackPoints.push({ lat, lon, time, ele, speed });
        });

        startTime = trackPoints[0].time;
        endTime = trackPoints[trackPoints.length - 1].time;
        totalDuration = endTime - startTime;

        slider.max = Math.floor(totalDuration);
        const polyline = L.polyline(trackPoints.map(p => [p.lat, p.lon]), { color: '#ff4400', weight: 4 }).addTo(map);
        map.fitBounds(polyline.getBounds());

        // Ensure the bike image is loaded before drawing the chart
        if (bikeImg.complete) {
            startApp();
        } else {
            bikeImg.onload = startApp;
        }
    });

function startApp() {
    initChart();
    isLoaded = true;
    updateUI(0);
}

// 3. Chart Logic
// 1. Update the Chart Logic to use a Plugin
function initChart() {
    const ctx = document.getElementById('elevationChart').getContext('2d');
    
    const bikePlugin = {
        id: 'bikePlugin',
        afterDatasetsDraw(chart) {
            if (!isLoaded) return;
            const { ctx, scales: { x, y } } = chart;
            const point = trackPoints[currentActiveIndex];
            const xPixel = x.getPixelForValue(currentActiveIndex);
            const yPixel = y.getPixelForValue(point.ele);

            ctx.save();
            
            // 1. Draw a vertical guide line
            ctx.beginPath();
            ctx.setLineDash([5, 5]); // Dashed line
            ctx.moveTo(xPixel, y.top);
            ctx.lineTo(xPixel, y.bottom);
            ctx.strokeStyle = 'rgba(255, 68, 0, 0.5)';
            ctx.stroke();

            // 2. Draw the bike image
            const size = 24; 
            ctx.drawImage(bikeImg, xPixel - size / 2, yPixel - size / 2, size, size);
            
            ctx.restore();
        }
    };

    elevationChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: trackPoints.map((_, i) => i),
            datasets: [{
                data: trackPoints.map(p => p.ele),
                borderColor: '#ff4400',
                backgroundColor: 'rgba(255, 68, 0, 0.1)',
                fill: true,
                borderWidth: 2,
                pointRadius: 0
            }]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            events: ['click', 'mousemove'], // Re-enable events if you want tooltips back later
            scales: { x: { display: false }, y: { beginAtZero: false } },
            plugins: { legend: { display: false }, tooltip: { enabled: false } }
        },
        plugins: [bikePlugin]
    });
}

// 2. Update the UI function
function updateUI(offset) {
    if (!isLoaded) return;
    const currentTime = startTime + parseInt(offset);
    let idx = trackPoints.findIndex(p => p.time >= currentTime);
    if (idx === -1) idx = trackPoints.length - 1;
    
    currentActiveIndex = idx;
    const point = trackPoints[idx];

    // --- Map Marker Logic ---
    const latlng = [point.lat, point.lon];
    const speedText = `${point.speed.toFixed(0)} km/h`;

    if (!bikeMarker) {
        // Create marker and bind popup once
        bikeMarker = L.marker(latlng, { icon: bikeIcon }).addTo(map);
        bikeMarker.bindPopup(speedText);
    } else {
        // Update position and popup content
        bikeMarker.setLatLng(latlng);
        bikeMarker.setPopupContent(speedText);
    }
    
    // --- Smooth Chart Update ---
    if (elevationChart) {
        // We use draw() instead of update() for maximum speed
        elevationChart.draw(); 
    }

    timeDisplay.innerText = new Date(currentTime * 1000).toISOString().substr(11, 8);
}

slider.addEventListener('input', (e) => updateUI(e.target.value));

// 5. Playback Controls
const playback = {
    active: false, 
    lastTimestamp: 0, 
    speedMultiplier: 10,
    updateSpeed(val) { this.speedMultiplier = parseFloat(val); },
    toggle() { this.active ? this.stop() : this.start(); },
    start() {
        if (this.active || !isLoaded) return;
        this.active = true; 
        this.lastTimestamp = performance.now();
        document.getElementById('play-pause-btn').innerHTML = '<i class="fas fa-pause"></i>';
        requestAnimationFrame(this.step.bind(this));
    },
    stop() {
        this.active = false;
        document.getElementById('play-pause-btn').innerHTML = '<i class="fas fa-play"></i>';
    },
    step(timestamp) {
        if (!this.active) return;
        const dt = (timestamp - this.lastTimestamp) / 1000;
        this.lastTimestamp = timestamp;
        let nextVal = parseFloat(slider.value) + (dt * this.speedMultiplier);
        
        if (nextVal >= totalDuration) {
            slider.value = totalDuration;
            updateUI(totalDuration);
            this.stop();
            return;
        }
        
        slider.value = nextVal;
        updateUI(nextVal);
        requestAnimationFrame(this.step.bind(this));
    }
};

// 6. Recorder Controls
const recorder = {
    mediaRecorder: null, chunks: [],
    async start() {
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 } });
            this.chunks = [];
            this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
            this.mediaRecorder.ondataavailable = e => this.chunks.push(e.data);
            this.mediaRecorder.onstop = () => {
                const blob = new Blob(this.chunks, { type: 'video/webm' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob); a.download = 'ride.webm'; a.click();
            };
            this.mediaRecorder.start();
        } catch(e) { console.error(e); }
    },
    stop() { if(this.mediaRecorder) this.mediaRecorder.stop(); }
};