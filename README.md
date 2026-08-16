# Whereabouts

A location app that runs entirely in the browser. It shows where you are, tracks
where you go, and remembers the places you save — with no account, no server, and
no build step.

## Running it

Geolocation requires a secure context, so `file://` won't work. Serve the folder
over `localhost` (which counts as secure) or over HTTPS:

```sh
python3 -m http.server 8080
# or: npx http-server -p 8080
```

Then open <http://localhost:8080>. The browser will ask for location permission
the first time you tap **Find my location**.

## What it does

**Now** — your current latitude and longitude, plus accuracy, altitude, speed and
heading when the device reports them. Toggle between decimal degrees and
degrees/minutes/seconds, copy the coordinates, share them as an OpenStreetMap
link, or jump the map to coordinates you paste in.

**Trip** — start tracking and the app keeps a live location watch open, drawing
your path on the map and totalling distance, duration, average and top speed,
point count and cumulative climb. Export the track as GPX for any mapping tool.
Standing-still GPS jitter is filtered out (hops smaller than half the reported
accuracy are ignored) so distance doesn't creep upward while you're stationary.

**Places** — save the spot you're standing on with a name. Saved places are
listed nearest-first with distance and compass bearing from your current
position, drawn as pins on the map, and exportable as JSON.

Preferences (metric/imperial, coordinate format, theme) and saved places persist
in `localStorage`.

## How it's built

Three files, no dependencies, no toolchain:

- `index.html` — structure
- `styles.css` — light/dark theming via CSS custom properties; the side panel
  becomes a bottom sheet under 760px
- `map.js` — `MiniMap`, a small slippy map over OpenStreetMap tiles: Web
  Mercator projection, pointer panning, wheel and pinch zoom, marker layer, and
  an SVG overlay for the accuracy circle and track polyline
- `app.js` — geolocation, formatting, trip maths, storage, and UI wiring

`MiniMap` exists so the app has no CDN dependency. It covers what this app needs
— pan, integer zoom, markers, one circle, one polyline — and deliberately not
much else.

## Privacy

Positions never leave the device. There is no analytics, no backend, and no
network traffic beyond map tile images fetched from `tile.openstreetmap.org`. If
tiles can't load, the app says so and everything except the map imagery keeps
working.

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
Tiles come from the public OSM tile servers, which are fine for personal use but
are not meant to carry production traffic — point `tileUrl` at your own tile
source (or a provider) before deploying this anywhere busy.
