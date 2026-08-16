/* Whereabouts — location app logic.
 *
 * Everything is local: positions come from the browser's Geolocation API and
 * saved places live in localStorage. No account, no server, no telemetry.
 */
(function () {
  'use strict';

  var STORE_PLACES = 'whereabouts.places';
  var STORE_PREFS = 'whereabouts.prefs';
  var EARTH_RADIUS = 6371008.8; // metres, IUGG mean radius

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    position: null,      // most recent GeolocationPosition
    watchId: null,
    tracking: false,
    track: [],           // [{lat, lng, ts, alt, speed, accuracy}]
    trackStart: null,
    maxSpeed: 0,
    climb: 0,
    places: [],
    prefs: { units: 'metric', coordFormat: 'decimal', theme: 'auto' },
    followMe: true
  };

  var map;

  /* ---------------------------------------------------------------- utils */

  function toRad(d) { return d * Math.PI / 180; }

  // Haversine distance in metres.
  function distance(a, b) {
    var dLat = toRad(b.lat - a.lat);
    var dLng = toRad(b.lng - a.lng);
    var lat1 = toRad(a.lat);
    var lat2 = toRad(b.lat);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
    return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Initial bearing in degrees from a to b.
  function bearing(a, b) {
    var lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    var dLng = toRad(b.lng - a.lng);
    var y = Math.sin(dLng) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function compassPoint(deg) {
    var points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return points[Math.round(deg / 22.5) % 16];
  }

  function isMetric() { return state.prefs.units === 'metric'; }

  function formatDistance(m) {
    if (m == null || isNaN(m)) return '—';
    if (isMetric()) {
      return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
    }
    var feet = m * 3.280839895;
    return feet < 1000 ? Math.round(feet) + ' ft' : (feet / 5280).toFixed(feet < 52800 ? 2 : 1) + ' mi';
  }

  function formatSpeed(mps) {
    if (mps == null || isNaN(mps)) return '—';
    return isMetric()
      ? (mps * 3.6).toFixed(1) + ' km/h'
      : (mps * 2.236936292).toFixed(1) + ' mph';
  }

  function formatAltitude(m) {
    if (m == null || isNaN(m)) return '—';
    return isMetric() ? Math.round(m) + ' m' : Math.round(m * 3.280839895) + ' ft';
  }

  function toDMS(value, positive, negative) {
    var hemisphere = value >= 0 ? positive : negative;
    var abs = Math.abs(value);
    var deg = Math.floor(abs);
    var minFloat = (abs - deg) * 60;
    var min = Math.floor(minFloat);
    var sec = ((minFloat - min) * 60).toFixed(1);
    return deg + '° ' + min + "' " + sec + '" ' + hemisphere;
  }

  function formatLat(lat) {
    return state.prefs.coordFormat === 'dms' ? toDMS(lat, 'N', 'S') : lat.toFixed(6) + '°';
  }

  function formatLng(lng) {
    return state.prefs.coordFormat === 'dms' ? toDMS(lng, 'E', 'W') : lng.toFixed(6) + '°';
  }

  function formatDuration(ms) {
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var mm = (m < 10 && h > 0) ? '0' + m : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + (s < 10 ? '0' + s : s);
  }

  function relativeTime(ts) {
    var secs = Math.round((Date.now() - ts) / 1000);
    if (secs < 5) return 'just now';
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.round(secs / 60) + ' min ago';
    if (secs < 86400) return Math.round(secs / 3600) + ' h ago';
    return new Date(ts).toLocaleDateString();
  }

  var toastTimer = null;
  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.hidden = false;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('is-visible');
      setTimeout(function () { el.hidden = true; }, 250);
    }, 2600);
  }

  function banner(message, kind) {
    var el = $('banner');
    if (!message) { el.hidden = true; return; }
    el.textContent = message;
    el.className = 'banner' + (kind ? ' banner-' + kind : '');
    el.dataset.kind = kind || '';
    el.hidden = false;
  }

  // A good fix clears a location error, but not the standing offline notice.
  function clearBanner(kind) {
    var el = $('banner');
    if (!el.hidden && el.dataset.kind === kind) el.hidden = true;
  }

  function download(filename, text, type) {
    var blob = new Blob([text], { type: type || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* -------------------------------------------------------------- storage */

  function loadStorage() {
    try {
      state.places = JSON.parse(localStorage.getItem(STORE_PLACES) || '[]');
      if (!Array.isArray(state.places)) state.places = [];
    } catch (e) {
      state.places = [];
    }
    try {
      var prefs = JSON.parse(localStorage.getItem(STORE_PREFS) || '{}');
      Object.keys(prefs).forEach(function (k) {
        if (k in state.prefs) state.prefs[k] = prefs[k];
      });
    } catch (e) { /* defaults are fine */ }
  }

  function savePlaces() {
    try {
      localStorage.setItem(STORE_PLACES, JSON.stringify(state.places));
    } catch (e) {
      toast('Could not save — storage is full or blocked.');
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORE_PREFS, JSON.stringify(state.prefs));
    } catch (e) { /* non-fatal */ }
  }

  /* ---------------------------------------------------------- geolocation */

  function geoErrorMessage(err) {
    switch (err.code) {
      case err.PERMISSION_DENIED:
        return 'Location permission denied. Enable it for this site in your browser settings, then try again.';
      case err.POSITION_UNAVAILABLE:
        return 'Your position is unavailable right now. Try moving somewhere with a clearer view of the sky.';
      case err.TIMEOUT:
        return 'Timed out waiting for a fix. Try again.';
      default:
        return err.message || 'Could not get your location.';
    }
  }

  function preflight() {
    if (!('geolocation' in navigator)) {
      banner('This browser does not support geolocation.', 'error');
      return false;
    }
    if (!window.isSecureContext) {
      banner('Geolocation needs a secure context. Open this page over https:// or from http://localhost.', 'error');
      return false;
    }
    return true;
  }

  function locateOnce() {
    if (!preflight()) return;
    setLocateBusy(true);
    navigator.geolocation.getCurrentPosition(function (pos) {
      setLocateBusy(false);
      clearBanner('error');
      state.followMe = true;
      handlePosition(pos, true);
    }, function (err) {
      setLocateBusy(false);
      banner(geoErrorMessage(err), 'error');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  function setLocateBusy(busy) {
    var btn = $('locate');
    btn.classList.toggle('is-busy', busy);
    $('locate-label').textContent = busy ? 'Locating…' : (state.position ? 'Update location' : 'Find my location');
  }

  function startTracking() {
    if (!preflight()) return;
    state.tracking = true;
    state.trackStart = state.trackStart || Date.now();
    $('track-toggle').textContent = 'Stop tracking';
    $('track-toggle').classList.add('is-active');
    state.watchId = navigator.geolocation.watchPosition(function (pos) {
      clearBanner('error');
      handlePosition(pos, false);
    }, function (err) {
      banner(geoErrorMessage(err), 'error');
      if (err.code === err.PERMISSION_DENIED) stopTracking();
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 });
    toast('Tracking started');
  }

  function stopTracking() {
    if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    state.tracking = false;
    $('track-toggle').textContent = 'Start tracking';
    $('track-toggle').classList.remove('is-active');
  }

  function handlePosition(pos, recenter) {
    state.position = pos;
    var c = pos.coords;
    var point = {
      lat: c.latitude,
      lng: c.longitude,
      ts: pos.timestamp,
      alt: c.altitude,
      speed: c.speed,
      accuracy: c.accuracy
    };

    if (state.tracking) appendTrackPoint(point);

    map.setMarker('me', point.lat, point.lng, 'mm-marker-me', 'You are here');
    map.setAccuracy(point.lat, point.lng, c.accuracy);
    if (recenter || state.followMe) {
      // An explicit locate reframes the map; a passive watch update just slides.
      map.setView(point.lat, point.lng, recenter ? zoomForAccuracy(c.accuracy) : null);
    }

    renderNow();
    renderPlaces();
    syncHash();
  }

  // Pick a zoom where the accuracy circle is a sensible fraction of the view.
  function zoomForAccuracy(accuracy) {
    if (!accuracy || accuracy <= 0) return 16;
    if (accuracy < 25) return 17;
    if (accuracy < 100) return 16;
    if (accuracy < 500) return 14;
    if (accuracy < 2000) return 12;
    return 10;
  }

  function appendTrackPoint(point) {
    var last = state.track[state.track.length - 1];
    if (last) {
      var moved = distance(last, point);
      // Consumer GPS jitters while standing still; ignore hops inside the
      // noise floor so the trip distance doesn't drift upward.
      var noiseFloor = Math.max(3, (point.accuracy || 0) * 0.5);
      if (moved < noiseFloor) return;
      var dt = (point.ts - last.ts) / 1000;
      if (dt > 0) {
        var derived = moved / dt;
        if (derived < 120) state.maxSpeed = Math.max(state.maxSpeed, point.speed != null ? point.speed : derived);
      }
      if (last.alt != null && point.alt != null) {
        var gain = point.alt - last.alt;
        if (gain > 1) state.climb += gain;
      }
    }
    state.track.push(point);
    map.setTrack(state.track);
    renderTrip();
  }

  function trackDistance() {
    var total = 0;
    for (var i = 1; i < state.track.length; i++) total += distance(state.track[i - 1], state.track[i]);
    return total;
  }

  /* --------------------------------------------------------------- render */

  function renderNow() {
    var pos = state.position;
    if (!pos) return;
    var c = pos.coords;
    $('lat').textContent = formatLat(c.latitude);
    $('lng').textContent = formatLng(c.longitude);
    $('accuracy').textContent = c.accuracy != null ? '±' + formatDistance(c.accuracy) : '—';
    $('altitude').textContent = formatAltitude(c.altitude);
    $('speed').textContent = formatSpeed(c.speed);
    $('heading').textContent = (c.heading != null && !isNaN(c.heading))
      ? Math.round(c.heading) + '° ' + compassPoint(c.heading)
      : '—';
    $('fix-age').textContent = 'Fix from ' + relativeTime(pos.timestamp) +
      (state.tracking ? ' · tracking live' : '');
    $('locate-label').textContent = 'Update location';
  }

  function renderTrip() {
    var dist = trackDistance();
    var elapsed = state.trackStart ? Date.now() - state.trackStart : 0;
    $('trip-distance').textContent = formatDistance(dist);
    $('trip-duration').textContent = formatDuration(elapsed);
    $('trip-avg').textContent = elapsed > 1000 && dist > 0 ? formatSpeed(dist / (elapsed / 1000)) : '—';
    $('trip-max').textContent = state.maxSpeed > 0 ? formatSpeed(state.maxSpeed) : '—';
    $('trip-points').textContent = String(state.track.length);
    $('trip-climb').textContent = state.climb > 0 ? formatAltitude(state.climb) : '—';
  }

  function renderPlaces() {
    var list = $('places-list');
    var here = state.position
      ? { lat: state.position.coords.latitude, lng: state.position.coords.longitude }
      : null;

    $('places-empty').hidden = state.places.length > 0;
    list.innerHTML = '';

    state.places
      .slice()
      .sort(function (a, b) {
        if (!here) return b.savedAt - a.savedAt;
        return distance(here, a) - distance(here, b);
      })
      .forEach(function (place) {
        var li = document.createElement('li');
        li.className = 'place';

        var meta = here
          ? formatDistance(distance(here, place)) + ' · ' + compassPoint(bearing(here, place))
          : new Date(place.savedAt).toLocaleDateString();

        li.innerHTML =
          '<button class="place-main" type="button">' +
            '<span class="place-name">' + escapeHtml(place.name) + '</span>' +
            '<span class="place-meta">' + escapeHtml(meta) + '</span>' +
            '<span class="place-coords">' + place.lat.toFixed(5) + ', ' + place.lng.toFixed(5) + '</span>' +
          '</button>' +
          '<button class="place-del" type="button" title="Delete" aria-label="Delete ' + escapeHtml(place.name) + '">×</button>';

        li.querySelector('.place-main').addEventListener('click', function () {
          state.followMe = false;
          map.setView(place.lat, place.lng, 16);
        });
        li.querySelector('.place-del').addEventListener('click', function () {
          state.places = state.places.filter(function (p) { return p.id !== place.id; });
          savePlaces();
          syncPlaceMarkers();
          renderPlaces();
          toast('Deleted "' + place.name + '"');
        });

        list.appendChild(li);
      });
  }

  function syncPlaceMarkers() {
    map.clearMarkers('place:');
    state.places.forEach(function (p) {
      map.setMarker('place:' + p.id, p.lat, p.lng, 'mm-marker-place', p.name);
    });
  }

  /* ---------------------------------------------------------------- hash */

  function syncHash() {
    var v = map.getView();
    var next = '#' + v.lat.toFixed(5) + ',' + v.lng.toFixed(5) + ',' + v.zoom;
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  function parseHash() {
    var m = /^#(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+))?$/.exec(location.hash);
    if (!m) return null;
    return { lat: parseFloat(m[1]), lng: parseFloat(m[2]), zoom: m[3] ? parseInt(m[3], 10) : 15 };
  }

  function parseCoordInput(text) {
    var m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
    if (!m) return null;
    var lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat: lat, lng: lng };
  }

  /* --------------------------------------------------------------- export */

  function toGPX() {
    var head = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="Whereabouts" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      '  <trk><name>Trip ' + new Date(state.trackStart || Date.now()).toISOString() + '</name><trkseg>\n';
    var body = state.track.map(function (p) {
      return '    <trkpt lat="' + p.lat.toFixed(7) + '" lon="' + p.lng.toFixed(7) + '">' +
        (p.alt != null ? '<ele>' + p.alt.toFixed(1) + '</ele>' : '') +
        '<time>' + new Date(p.ts).toISOString() + '</time></trkpt>';
    }).join('\n');
    return head + body + '\n  </trkseg></trk>\n</gpx>\n';
  }

  /* ----------------------------------------------------------------- init */

  function applyTheme() {
    var theme = state.prefs.theme;
    document.documentElement.dataset.theme = theme === 'auto' ? '' : theme;
    if (theme === 'auto') delete document.documentElement.dataset.theme;
  }

  function wireUI() {
    $('locate').addEventListener('click', locateOnce);
    $('zoom-in').addEventListener('click', function () { map.zoomBy(1); });
    $('zoom-out').addEventListener('click', function () { map.zoomBy(-1); });
    $('recenter').addEventListener('click', function () {
      if (!state.position) { locateOnce(); return; }
      state.followMe = true;
      map.setView(state.position.coords.latitude, state.position.coords.longitude, 16);
    });

    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (t) {
          var active = t === tab;
          t.classList.toggle('is-active', active);
          t.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.querySelectorAll('.tab-panel').forEach(function (p) {
          p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab);
        });
      });
    });

    $('coord-format').addEventListener('click', function () {
      state.prefs.coordFormat = state.prefs.coordFormat === 'decimal' ? 'dms' : 'decimal';
      this.textContent = state.prefs.coordFormat;
      savePrefs();
      renderNow();
    });

    $('unit-toggle').addEventListener('click', function () {
      state.prefs.units = isMetric() ? 'imperial' : 'metric';
      this.textContent = state.prefs.units;
      savePrefs();
      renderNow();
      renderTrip();
      renderPlaces();
    });

    $('theme-toggle').addEventListener('click', function () {
      var order = ['auto', 'light', 'dark'];
      state.prefs.theme = order[(order.indexOf(state.prefs.theme) + 1) % order.length];
      this.textContent = state.prefs.theme;
      savePrefs();
      applyTheme();
    });

    $('copy').addEventListener('click', function () {
      if (!state.position) { toast('No fix yet.'); return; }
      var c = state.position.coords;
      var text = c.latitude.toFixed(6) + ', ' + c.longitude.toFixed(6);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { toast('Copied ' + text); },
          function () { toast(text); }
        );
      } else {
        toast(text);
      }
    });

    $('share').addEventListener('click', function () {
      if (!state.position) { toast('No fix yet.'); return; }
      var c = state.position.coords;
      var geoUrl = 'https://www.openstreetmap.org/?mlat=' + c.latitude.toFixed(6) +
                   '&mlon=' + c.longitude.toFixed(6) + '#map=17/' +
                   c.latitude.toFixed(5) + '/' + c.longitude.toFixed(5);
      if (navigator.share) {
        navigator.share({ title: 'My location', text: 'Here I am', url: geoUrl })
          .catch(function () { /* user dismissed the sheet */ });
      } else {
        window.open(geoUrl, '_blank', 'noopener');
      }
    });

    $('save-place').addEventListener('click', function () {
      if (!state.position) { toast('Find your location first.'); return; }
      var name = prompt('Name this place');
      if (name == null) return;
      name = name.trim() || 'Unnamed place';
      var c = state.position.coords;
      state.places.push({
        id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
        name: name,
        lat: c.latitude,
        lng: c.longitude,
        accuracy: c.accuracy,
        savedAt: Date.now()
      });
      savePlaces();
      syncPlaceMarkers();
      renderPlaces();
      toast('Saved "' + name + '"');
    });

    $('jump-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var parsed = parseCoordInput($('jump-input').value);
      if (!parsed) { toast('Enter coordinates as "lat, lng".'); return; }
      state.followMe = false;
      map.setView(parsed.lat, parsed.lng, 15);
    });

    $('track-toggle').addEventListener('click', function () {
      if (state.tracking) {
        stopTracking();
        toast('Tracking stopped');
      } else {
        startTracking();
      }
    });

    $('trip-clear').addEventListener('click', function () {
      state.track = [];
      state.trackStart = state.tracking ? Date.now() : null;
      state.maxSpeed = 0;
      state.climb = 0;
      map.setTrack([]);
      renderTrip();
      toast('Trip cleared');
    });

    $('trip-export').addEventListener('click', function () {
      if (state.track.length < 2) { toast('Not enough track points yet.'); return; }
      download('whereabouts-' + new Date().toISOString().slice(0, 19).replace(/:/g, '') + '.gpx',
               toGPX(), 'application/gpx+xml');
    });

    $('places-export').addEventListener('click', function () {
      if (!state.places.length) { toast('No places to export.'); return; }
      download('whereabouts-places.json', JSON.stringify(state.places, null, 2), 'application/json');
    });

    // Tile images fail silently; surface it once so a blank map isn't a mystery.
    var tileErrors = 0;
    map.el.addEventListener('error', function (e) {
      if (!e.target || !e.target.classList.contains('mm-tile')) return;
      if (++tileErrors === 4) {
        banner('Map tiles could not load — you may be offline. Coordinates and tracking still work.', 'warn');
      }
    }, true);

    // Dragging the map means the user is looking somewhere else on purpose.
    map.on('move', function () { syncHash(); });
    map.el.addEventListener('pointerdown', function () { state.followMe = false; });

    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'l') locateOnce();
      if (e.key === '+' || e.key === '=') map.zoomBy(1);
      if (e.key === '-') map.zoomBy(-1);
    });
  }

  function init() {
    loadStorage();
    applyTheme();

    var start = parseHash() || { lat: 20, lng: 0, zoom: 3 };
    map = new MiniMap($('map'), start);

    $('coord-format').textContent = state.prefs.coordFormat;
    $('unit-toggle').textContent = state.prefs.units;
    $('theme-toggle').textContent = state.prefs.theme;

    wireUI();
    syncPlaceMarkers();
    renderPlaces();
    renderTrip();

    if (!window.isSecureContext) {
      banner('Geolocation needs a secure context. Open this page over https:// or from http://localhost.', 'warn');
    }

    // Keep "fix from …" and the trip clock honest without extra fixes.
    setInterval(function () {
      if (state.position) renderNow();
      if (state.tracking) renderTrip();
    }, 1000);

    // A granted permission means we can locate without a second prompt.
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' }).then(function (status) {
        if (status.state === 'granted') locateOnce();
      }).catch(function () { /* Safari and friends: wait for the tap */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
