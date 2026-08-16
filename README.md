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
on its own as soon as the page loads — there's no button to find first.

## What it does

The map fills the whole screen at every size. Everything else — coordinates,
trip stats, saved places — lives in a translucent glass sheet anchored to the
bottom, collapsed by default to a slim bar showing where you are. Tap it (or
the grip once it's open) to expand or collapse; tapping the map itself while
it's open collapses it back out of the way, the same as Apple/Google Maps.
Which tab was open and whether the sheet was left expanded both survive a
reload.

**Now** — your current latitude and longitude, plus accuracy, altitude, speed and
heading when the device reports them. The readout updates by itself as you
move, and the map follows — the **Live** pill shows that it's running and
pauses it when you want the battery back. Panning the map by hand stops it
recentring on you, without stopping the updates; the ◎ control forces a fresh
fix and recenters on demand. Toggle between decimal degrees and
degrees/minutes/seconds, copy the coordinates, share them as an OpenStreetMap
link, or jump the map to coordinates you paste in.

When it can, the app names the street you're on — shown above the coordinates
and, once known, in place of raw numbers in the collapsed sheet's summary
line. This comes from OSM's free Nominatim reverse-geocoding service, called
sparingly on purpose: at most once every 12 seconds and only once you've
actually moved far enough that the street plausibly changed, since it's a
shared public resource and this stays well inside its usage policy rather
than hammering it on every 1-second poll. A sudden large jump — jumping to
pasted coordinates, say — looks up immediately instead of waiting, since a
stale name right after that would just be wrong rather than merely behind. If
the lookup fails or the spot has no named road, the coordinates are the
fallback either way.

Current conditions — temperature and a short description — come from
[Open-Meteo](https://open-meteo.com), which needs no API key. Refreshed at
most every 10 minutes, or immediately after travelling far enough (20 km)
that the weather might actually be different; switching units just reformats
the reading already in hand rather than asking again.

Between real fixes, the dot doesn't just sit still and jump — while moving at
walking pace or faster, it's nudged forward using the last fix's own reported
speed and heading (dead reckoning), so it glides rather than stutters. This is
purely a rendering effect: the numeric readout, the saved-place coordinates,
and the trip track only ever see real fixes, never an estimate. A fresh real
fix always corrects it immediately, and pausing snaps straight back to the
last real position rather than leaving the dot wherever the estimate drifted.

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
A trip survives a reload — an accidental refresh, a crashed tab, a phone that
needed a restart — mid-walk: the track, its stats, and whether it was still
recording all come back, and recording resumes on its own rather than leaving
a paused trip you have to notice and restart by hand. A finished-but-unexported
trip sticks around the same way until you export it or tap **Clear trip**.

**Places** — save the spot you're standing on with a name. Saved places are
listed nearest-first with distance and compass bearing from your current
position, drawn as pins on the map, and exportable as JSON.

**Heading up** — the compass control turns the map so it points the way your
device is pointing, with the needle staying true to north and every marker
counter-rotated to stay upright. It uses `webkitCompassHeading` on iOS (behind
the permission prompt that platform requires, which is why it's a button press)
and absolute `deviceorientation` elsewhere, corrects for the screen's own
rotation, and low-pass filters the reading — raw magnetometer output is far too
jittery to drive a map. Devices without a magnetometer say so rather than
leaving a toggle that does nothing.

**Refreshing** — `watchPosition` only reports when the device decides you've
moved, which on a stationary phone can mean silence for a minute. A poll runs
alongside it for a genuinely current readout, at a rate you choose from the
footer: every 1s, 2s, 5s or 15s, defaulting to 1s. Consumer GNSS chips fix at
about 1 Hz, so 1s is the practical ceiling — polling faster returns the same
fix twice and only costs battery. This is the expensive part of the battery
bill, so it's a control rather than a fixed choice, and the Live pill pauses it
outright.

Preferences (metric/imperial, coordinate format, theme, refresh rate) and saved
places persist in `localStorage`.

## How it's built

Four source files plus a small set of icon assets, no dependencies, no toolchain:

- `index.html` — structure
- `styles.css` — light/dark theming via CSS custom properties. The map is
  always full-bleed; a single Liquid-Glass bottom sheet overlays it at every
  screen size, rather than a side panel on desktop and a different bottom
  sheet on mobile.
- `map.js` — `MiniMap`, a small slippy map: Web Mercator projection, pointer
  panning, wheel and pinch zoom, marker layer, swappable basemaps, map rotation
  (one transform over a padded layer, since a rotated square needs to be bigger
  than its viewport), and an SVG overlay for the accuracy circle and the track
  (drawn twice, casing under line, so it stays legible over any background)
- `app.js` — geolocation, formatting, trip maths, storage, and UI wiring

`MiniMap` exists so the app has no mapping-library dependency. It covers what
this app needs — pan, integer zoom, markers, one circle, one polyline — and
deliberately not much else.

## Icon

`favicon.svg` is the source of truth — a white bullseye on the app's own accent
blue, echoing the "you are here" marker drawn on the map itself, so the tab
icon and the home-screen icon are recognizably the same app. Every raster size
(`favicon-16/32/48.png`, `apple-touch-icon.png`, `icon-192/512.png`, and a
maskable 512 for Android's adaptive-icon safe zone) is rendered from that one
SVG rather than hand-edited, so a redesign only ever touches one file.
`manifest.webmanifest` wires the icons up for "Add to Home Screen" as a
standalone app (no browser chrome), and the page's `theme-color` meta tag
tracks the app's own light/dark choice — OS auto or an explicit override —
rather than only the OS scheme, so the browser/status bar always matches the
background actually on screen.

## The basemap

Tiles come from CARTO's Positron (light) and Dark Matter (dark) styles at `@2x`,
which are minimal enough that your position and track stay the loudest things on
screen. Having a real dark basemap beats inverting a light one: inversion gets
the ground right but turns every label into a photographic negative.

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
tiles © [CARTO](https://carto.com/attributions). Both are free for personal use
and neither is meant to carry production traffic — point `BASEMAP` at your own
tile source or a paid provider before deploying this anywhere busy.

## Privacy

Positions never leave the device. There is no analytics, no backend, and no
network traffic beyond map tile images. If tiles can't load, the app says so and
everything except the map imagery keeps working.
