# TraceFlow

**TraceFlow** is a lightweight, client-side tool for visualizing GPX files.

<img width="1409" height="930" alt="image" src="https://github.com/user-attachments/assets/95834ff9-e04c-4d83-877a-ae64f7cd4415" />

## Features

- Animated ride playback with adjustable speed (30×–120×)
- Open any GPX via the folder button or by dragging a file onto the page
- Handles recorded tracks (`<trkpt>`) and planned routes (`<rtept>`); files without timestamps get playback timing synthesized at a nominal 20 km/h
- Live stats: distance, smoothed speed, elevation, cumulative elevation gain
- Selectable marker icon, including loading your own image at runtime (remembered across visits)
- Scrubbable elevation profile (click or drag to seek)
- Keyboard shortcuts: `Space` play/pause, `←`/`→` skip ±10 s
- Works offline after first load (service worker)

## Marker icons

Pick a marker from the icon row in the control panel, or hit **+** to load any image file — the choice is saved in `localStorage`. To bundle your own icon permanently, drop an image into `assets/` and add an entry to the `ICONS` array at the top of `js/script.js`:

```js
{ id: 'kayak', label: 'Kayak', src: 'assets/kayak.png', rotates: true },
```

`rotates: true` makes the icon turn to follow the direction of travel, so the image should point up (north). Emoji entries (`emoji: '🏃'`) stay upright instead.

## Running

Serve the folder with any static file server, e.g.:

```sh
python -m http.server 8000
# or: npx serve
```

Map tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
