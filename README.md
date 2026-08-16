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
heading when the device reports them. Once you've granted permission the readout
updates by itself as you move, and the map follows — the **Live** pill shows
that it's running and pauses it when you want the battery back. Panning the map
by hand stops it recentring on you, without stopping the updates. Toggle between
decimal degrees and degrees/minutes/seconds, copy the coordinates, share them as
an OpenStreetMap link, or jump the map to coordinates you paste in.

A precision line under the coordinates grades the current fix — Precise (±20 m
or better), Good, Approximate, or Coarse — so you can tell a satellite fix from
a network one. If a fix is coarser than 500 m the app says so once and points at
the OS setting that causes it, since that's a device permission rather than
something the page can fix. A fix that is both much vaguer than the last one and
somewhere else is held briefly rather than shown, so a GPS dropping to Wi-Fi
positioning doesn't fling the marker across town; a vaguer reading of the *same*
spot is still accepted, so the precision shown never goes stale.

**Full screen** — the ⛶ control (or `f`) hides the panel and fills the screen
with the map, leaving a compact readout of coordinates, accuracy and speed in
the corner. It requests real browser fullscreen where that exists and falls back
to the immersive layout where it doesn't, so it still does something useful on
iOS Safari. `Esc` or the same button returns.

**Trip** — start recording and the app draws your path on the map and totals
distance, duration, average and top speed, point count and cumulative climb.
Export the track as GPX for any mapping tool. Live updates and trip recording
share a single `watchPosition` watch rather than opening two, and the watch is
released while the page is hidden unless a trip is recording.
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
  becomes a bottom sheet under 760px. OSM publishes one light tile set, so dark
  mode inverts the tile layer and rotates the hue back, keeping water blue and
  parks green without a second tile source.
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
