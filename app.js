/* Whereabouts — location app logic.
 *
 * Everything is local: positions come from the browser's Geolocation API and
 * saved places live in localStorage. No account, no server, no telemetry.
 */
(function () {
  'use strict';

  var STORE_PLACES = 'whereabouts.places';
  var STORE_PREFS = 'whereabouts.prefs';
  var STORE_TRIP = 'whereabouts.trip';
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
    prefs: {
      units: 'metric', coordFormat: 'decimal', theme: 'auto', live: true, rate: 'turbo',
      headingUp: false, sheetExpanded: false, activeTab: 'now'
    },
    followMe: true,
    immersive: false,
    advisedOnPrecision: false,
    pollTimer: null,
    pollStartedAt: 0,
    headingUp: false,
    heading: null,
    appliedHeading: null,
    compassEvent: null,
    compassSeen: false,
    locateBusy: false,
    sheetExpanded: false,
    deadReckonTimer: null,
    streetName: null,
    streetLookupAt: 0,
    streetLookupPoint: null,
    weather: null,
    weatherAt: 0,
    weatherPoint: null
  };

  // WMO weather codes, as used by Open-Meteo. Collapsed to the common cases —
  // exact sub-variety (e.g. which of three fog codes) isn't worth showing.
  var WEATHER_CODES = {
    0: ['Clear sky', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
    45: ['Fog', '🌫️'], 48: ['Fog', '🌫️'],
    51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Dense drizzle', '🌦️'],
    56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
    61: ['Light rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
    66: ['Freezing rain', '🌨️'], 67: ['Freezing rain', '🌨️'],
    71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
    80: ['Rain showers', '🌦️'], 81: ['Rain showers', '🌦️'], 82: ['Violent showers', '⛈️'],
    85: ['Snow showers', '🌨️'], 86: ['Snow showers', '🌨️'],
    95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm (hail)', '⛈️'], 99: ['Thunderstorm (hail)', '⛈️']
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

  // The forward geodesic problem: where do you end up, given a start point,
  // a bearing, and a distance. Used to dead-reckon the marker forward from
  // the last real fix between updates.
  function destinationPoint(lat, lng, bearingDeg, meters) {
    var delta = meters / EARTH_RADIUS;
    var theta = toRad(bearingDeg);
    var phi1 = toRad(lat);
    var lambda1 = toRad(lng);
    var phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
    var lambda2 = lambda1 + Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
    );
    return { lat: phi2 * 180 / Math.PI, lng: ((lambda2 * 180 / Math.PI) + 540) % 360 - 180 };
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

  // Errors (permission denied, insecure context) matter more than the
  // merely informational warnings (offline tiles, a coarse fix) — without
  // this, whichever happened to fire last would silently win, and since
  // both auto-locate and tile loading now kick off immediately on load,
  // that race is no longer rare enough to leave to chance.
  var BANNER_PRIORITY = { error: 2, warn: 1, precision: 1 };

  function banner(message, kind) {
    var el = $('banner');
    if (!message) { el.hidden = true; return; }
    var shown = (BANNER_PRIORITY[kind] || 0);
    var current = el.hidden ? -1 : (BANNER_PRIORITY[el.dataset.kind] || 0);
    if (shown < current) return;
    // Only the text node is replaced — the dismiss button lives alongside it.
    $('banner-text').textContent = message;
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
    try {
      var trip = JSON.parse(localStorage.getItem(STORE_TRIP) || 'null');
      if (trip && Array.isArray(trip.track)) {
        state.track = trip.track;
        state.trackStart = trip.trackStart || null;
        state.tracking = !!trip.tracking;
        state.maxSpeed = trip.maxSpeed || 0;
        state.climb = trip.climb || 0;
      }
    } catch (e) { /* no trip to resume */ }
  }

  function savePlaces() {
    try {
      localStorage.setItem(STORE_PLACES, JSON.stringify(state.places));
    } catch (e) {
      toast('Could not save — storage is full or blocked.');
    }
  }

  // Recording a trip is exactly the situation where losing everything to an
  // accidental reload or a crashed tab would sting most, so this is saved on
  // every accepted point rather than only when you explicitly stop.
  function saveTrip() {
    try {
      localStorage.setItem(STORE_TRIP, JSON.stringify({
        track: state.track, trackStart: state.trackStart,
        tracking: state.tracking, maxSpeed: state.maxSpeed, climb: state.climb
      }));
    } catch (e) { /* non-fatal — the trip just won't survive a reload */ }
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
      // Permission is granted now, so the readout can start keeping itself current.
      syncWatch();
    }, function (err) {
      setLocateBusy(false);
      banner(geoErrorMessage(err), 'error');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  function setLocateBusy(busy) {
    state.locateBusy = busy;
    $('recenter').classList.toggle('is-busy', busy);
    renderSheetSummary();
  }

  /* One watch serves both jobs: keeping the readout live, and recording a
   * trip. Running two would ask the GPS for the same fixes twice. */

  function startWatch() {
    if (state.watchId != null) return true;
    if (!preflight()) return false;
    state.watchId = navigator.geolocation.watchPosition(function (pos) {
      clearBanner('error');
      handlePosition(pos, false);
    }, function (err) {
      if (err.code === err.PERMISSION_DENIED) {
        banner(geoErrorMessage(err), 'error');
        state.prefs.live = false;
        savePrefs();
        stopTracking();
        stopWatch();
        renderLive();
        return;
      }
      /* A watch that times out or briefly loses the satellites is routine, and
       * shouting about it while a current fix is on screen is just noise — the
       * watch and the poll both keep trying. Only speak up once the position
       * shown has actually gone stale. */
      var stale = !state.position || (Date.now() - state.position.timestamp) > 60000;
      if (stale) banner(geoErrorMessage(err), 'error');
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    return true;
  }

  function stopWatch() {
    if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    stopDeadReckoning();
  }

  /* Dead reckoning: watchPosition/poll only deliver a handful of fixes per
   * second at best, so on a moving device the dot would otherwise sit still
   * and then jump. Between real fixes, nudge the marker forward from the
   * last one using its own reported speed and heading — real GPS chips
   * already report both, so this needs no extra sensor. Purely a rendering
   * effect: state.position, the numeric readout, and the track never see
   * anything but real fixes, so nothing estimated can end up saved, shared,
   * or exported. */
  function startDeadReckoning() {
    if (state.deadReckonTimer) return;
    state.deadReckonTimer = setInterval(tickDeadReckoning, 200);
  }

  function stopDeadReckoning() {
    if (!state.deadReckonTimer) return;
    clearInterval(state.deadReckonTimer);
    state.deadReckonTimer = null;
    // Undo any drift the last few ticks introduced — once extrapolation
    // isn't actively running, the dot should only ever sit where the last
    // real fix put it.
    if (state.position) {
      var c = state.position.coords;
      map.setMarker('me', c.latitude, c.longitude, 'mm-marker-me', 'You are here');
      map.setAccuracy(c.latitude, c.longitude, c.accuracy);
    }
  }

  function tickDeadReckoning() {
    var pos = state.position;
    if (!pos) return;
    var c = pos.coords;
    // Below walking pace this would just be amplifying GPS speed noise into
    // a wandering dot; heading is meaningless without real movement anyway.
    if (c.speed == null || c.speed < 0.3 || c.heading == null || isNaN(c.heading)) return;
    var elapsed = (Date.now() - pos.timestamp) / 1000;
    // A fix that's gotten this stale isn't worth extrapolating further —
    // freeze rather than compound a guess on top of a guess.
    if (elapsed <= 0 || elapsed > 20) return;
    var dest = destinationPoint(c.latitude, c.longitude, c.heading, c.speed * elapsed);
    map.setMarker('me', dest.lat, dest.lng, 'mm-marker-me', 'You are here');
    map.setAccuracy(dest.lat, dest.lng, c.accuracy);
    if (state.followMe) map.setView(dest.lat, dest.lng, null);
  }

  /* watchPosition only fires when the device decides you've moved far enough,
   * which on a stationary phone can mean nothing for a minute. Polling for a
   * fresh fix alongside it keeps the readout genuinely current — at a rate the
   * user picks, because this is the expensive part of the battery bill. */
  var RATES = { turbo: 1000, fast: 2000, normal: 5000, saver: 15000 };

  // Long enough that a slow fix isn't abandoned, short enough that a stuck one
  // doesn't hold up the next attempt for long.
  function pollTimeout() {
    return Math.max(5000, (RATES[state.prefs.rate] || RATES.turbo) * 2);
  }

  function pollNow() {
    if (!state.prefs.live && !state.tracking) return;
    if (document.hidden && !state.tracking) return;

    /* Keep one request outstanding at a time, but expire the guard with the
     * request's own timeout: some providers answer neither callback, and a
     * plain boolean would then wedge polling for the rest of the session. */
    var now = Date.now();
    if (state.pollStartedAt && now - state.pollStartedAt < pollTimeout()) return;
    state.pollStartedAt = now;

    navigator.geolocation.getCurrentPosition(function (pos) {
      state.pollStartedAt = 0;
      clearBanner('error');
      handlePosition(pos, false);
    }, function () {
      // A missed poll isn't worth a banner — the watch reports real errors,
      // and the next poll is seconds away.
      state.pollStartedAt = 0;
    }, { enableHighAccuracy: true, timeout: pollTimeout(), maximumAge: 0 });
  }

  function rateLabel() {
    return 'every ' + (RATES[state.prefs.rate] || RATES.turbo) / 1000 + 's';
  }

  function syncPoll() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (state.watchId == null) return;
    if (!state.prefs.live && !state.tracking) return;
    state.pollTimer = setInterval(pollNow, RATES[state.prefs.rate] || RATES.turbo);
  }

  // Hold the watch open while either job still wants it, and not otherwise.
  function syncWatch() {
    if (state.prefs.live || state.tracking) {
      if (startWatch()) startDeadReckoning();
    } else {
      stopWatch();
    }
    syncPoll();
    renderLive();
  }

  function setLive(on) {
    state.prefs.live = on;
    savePrefs();
    syncWatch();
  }

  function renderLive() {
    var on = state.prefs.live;
    var btn = $('live-toggle');
    btn.classList.toggle('is-live', on && state.watchId != null);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Location updates automatically — tap to pause' : 'Updates paused — tap to resume';
    $('live-label').textContent = on ? 'Live' : 'Paused';
    renderSheetSummary();
  }

  function startTracking() {
    state.tracking = true;
    if (!startWatch()) { state.tracking = false; return; }
    state.trackStart = state.trackStart || Date.now();
    $('track-toggle').textContent = 'Stop tracking';
    $('track-toggle').classList.add('is-active');
    renderLive();
    saveTrip();
    toast('Recording trip');
  }

  function stopTracking() {
    state.tracking = false;
    $('track-toggle').textContent = 'Start tracking';
    $('track-toggle').classList.remove('is-active');
    // Live updates outlive the trip, so only drop the watch if nothing wants it.
    syncWatch();
    saveTrip();
  }

  /* A GPS that has just dropped to Wi-Fi or cell positioning reports a fix
   * that is both fresh and far worse. Taking it would throw the marker
   * hundreds of metres and poison the track, so hold the better fix — but
   * only briefly, or a stale reading would outlive its usefulness once
   * you've actually moved. */
  function isWorseFix(pos) {
    var current = state.position;
    if (!current) return false;
    var was = current.coords.accuracy;
    var now = pos.coords.accuracy;
    if (was == null || now == null) return false;
    var age = pos.timestamp - current.timestamp;
    if (!(now > was * 3 && now > 50 && age < 15000)) return false;
    // Only hold it if taking it would actually move the marker. A vaguer
    // reading of the same spot still deserves to refresh the accuracy
    // readout, otherwise the precision shown goes stale and misleads.
    var moved = distance(
      { lat: current.coords.latitude, lng: current.coords.longitude },
      { lat: pos.coords.latitude, lng: pos.coords.longitude }
    );
    return moved > was;
  }

  function precisionOf(accuracy) {
    if (accuracy == null) return { key: 'unknown', label: 'Accuracy unknown' };
    if (accuracy <= 20) return { key: 'precise', label: 'Precise' };
    if (accuracy <= 75) return { key: 'good', label: 'Good' };
    if (accuracy <= 500) return { key: 'approx', label: 'Approximate' };
    return { key: 'coarse', label: 'Coarse — network fix' };
  }

  // Only worth saying once, and only when the fix is bad enough to act on.
  function maybeAdviseOnPrecision(accuracy) {
    if (state.advisedOnPrecision || accuracy == null || accuracy <= 500) return;
    state.advisedOnPrecision = true;
    var ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    banner('This fix is ±' + formatDistance(accuracy) + ', which means it came from the network rather than GPS. ' +
      (ios ? 'Check Settings → Privacy → Location Services → your browser → Precise Location.'
           : 'Check your device location settings and allow precise location for this site.'), 'precision');
  }

  /* Nominatim is a free, shared public service, so this stays well inside
   * its usage policy on purpose: at most one lookup every 12s, and only
   * when we've actually moved far enough that the street has probably
   * changed — a sudden large jump (jump-to-coordinates, a teleporting fix)
   * bypasses the wait, since a 12s-stale street name right after that would
   * just be wrong rather than merely a little behind. */
  function maybeLookUpStreet(lat, lng) {
    var last = state.streetLookupPoint;
    var due = true;
    if (last) {
      var moved = distance(last, { lat: lat, lng: lng });
      var elapsed = Date.now() - state.streetLookupAt;
      due = moved > 300 || (moved > 30 && elapsed > 12000);
    }
    if (!due) return;
    state.streetLookupAt = Date.now();
    state.streetLookupPoint = { lat: lat, lng: lng };
    reverseGeocode(lat, lng);
  }

  function reverseGeocode(lat, lng) {
    var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' +
      encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng) + '&zoom=17&addressdetails=1';
    fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var a = data && data.address;
        // Nominatim's address fields vary by what's actually mapped there —
        // fall back through the closest things to "a street" it offers.
        var name = a && (a.road || a.pedestrian || a.footway || a.cycleway || a.path);
        state.streetName = name || null;
        renderStreet();
        renderSheetSummary();
      })
      .catch(function () { /* offline or rate-limited — coordinates remain the fallback */ });
  }

  function renderStreet() {
    var row = $('street-row');
    row.hidden = !state.streetName;
    if (state.streetName) $('street-name').textContent = state.streetName;
  }

  /* Weather doesn't need Nominatim's care — Open-Meteo has no key and a
   * generous free tier — but there's still no reason to ask again every
   * time a fix arrives: conditions don't meaningfully change minute to
   * minute, so refresh at most every 10 minutes, or immediately after
   * travelling far enough (20 km) that local weather might actually differ. */
  function maybeFetchWeather(lat, lng) {
    var last = state.weatherPoint;
    var due = true;
    if (last) {
      var moved = distance(last, { lat: lat, lng: lng });
      var elapsed = Date.now() - state.weatherAt;
      due = moved > 20000 || elapsed > 600000;
    }
    if (!due) return;
    state.weatherAt = Date.now();
    state.weatherPoint = { lat: lat, lng: lng };
    fetchWeather(lat, lng);
  }

  function fetchWeather(lat, lng) {
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(lat) +
      '&longitude=' + encodeURIComponent(lng) + '&current=temperature_2m,weather_code&timezone=auto';
    fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var cur = data && data.current;
        if (!cur || cur.temperature_2m == null) return;
        state.weather = { tempC: cur.temperature_2m, code: cur.weather_code };
        renderWeather();
      })
      .catch(function () { /* offline — the row just stays hidden */ });
  }

  function renderWeather() {
    var row = $('weather-row');
    if (!state.weather) { row.hidden = true; return; }
    var info = WEATHER_CODES[state.weather.code] || ['—', '🌡️'];
    var tempC = state.weather.tempC;
    var tempText = isMetric() ? Math.round(tempC) + '°C' : Math.round(tempC * 9 / 5 + 32) + '°F';
    $('weather-icon').textContent = info[1];
    $('weather-text').textContent = tempText + ' · ' + info[0];
    row.hidden = false;
  }

  function handlePosition(pos, recenter) {
    if (!recenter && isWorseFix(pos)) return;
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
    maybeLookUpStreet(point.lat, point.lng);
    maybeFetchWeather(point.lat, point.lng);

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
    saveTrip();
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
      (state.tracking ? ' · recording trip' : '');

    var quality = precisionOf(c.accuracy);
    $('precision').dataset.quality = quality.key;
    $('precision-text').textContent = c.accuracy != null
      ? quality.label + ' · ±' + formatDistance(c.accuracy)
      : quality.label;
    if (c.accuracy != null && c.accuracy <= 500) clearBanner('precision');
    maybeAdviseOnPrecision(c.accuracy);

    $('hud').hidden = !state.immersive;
    $('hud-coords').textContent = c.latitude.toFixed(5) + ', ' + c.longitude.toFixed(5);
    $('hud-meta').textContent = (c.accuracy != null ? '±' + formatDistance(c.accuracy) : '') +
      (c.speed != null && !isNaN(c.speed) ? ' · ' + formatSpeed(c.speed) : '');

    renderSheetSummary();
  }

  // The collapsed sheet's one line of text — coordinates until something
  // more useful (like a street name) is available, and never blank.
  function renderSheetSummary() {
    var dot = $('sheet-status-dot');
    var text = $('sheet-summary-text');
    if (!dot || !text) return;
    dot.classList.toggle('is-live', !!(state.prefs.live && state.watchId != null));
    if (!state.position) {
      text.textContent = state.locateBusy ? 'Finding you…' : 'Location unavailable';
      return;
    }
    var c = state.position.coords;
    text.textContent = state.streetName || (c.latitude.toFixed(4) + ', ' + c.longitude.toFixed(4));
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

  /* ------------------------------------------------------------- compass */

  /* Heading-up mode. Three complications, all handled here: iOS exposes a
   * ready-made compass heading and demands a permission gesture, other
   * browsers give an absolute alpha measured the other way round, and a
   * device held in landscape reports relative to the device rather than the
   * screen. */

  function headingFromEvent(e) {
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      return e.webkitCompassHeading;                 // iOS: degrees clockwise from north
    }
    if (typeof e.alpha === 'number' && !isNaN(e.alpha) && (e.absolute || e.type === 'deviceorientationabsolute')) {
      return (360 - e.alpha) % 360;                  // alpha runs anticlockwise
    }
    return null;
  }

  function screenAngle() {
    if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === 'number') {
      return window.screen.orientation.angle;
    }
    return typeof window.orientation === 'number' ? window.orientation : 0;
  }

  // Shortest signed way round from a to b, so smoothing across 359°→1° doesn't
  // spin the map the long way.
  function angleDelta(a, b) {
    return ((b - a + 540) % 360) - 180;
  }

  function onOrientation(e) {
    var raw = headingFromEvent(e);
    if (raw == null) return;
    state.compassSeen = true;

    var heading = (raw + screenAngle() + 360) % 360;
    state.heading = state.heading == null
      ? heading
      // Low-pass filter: raw compass output is far too jittery to drive a map.
      : (state.heading + angleDelta(state.heading, heading) * 0.25 + 360) % 360;

    // Only repaint on a change big enough to see.
    if (state.appliedHeading == null || Math.abs(angleDelta(state.appliedHeading, state.heading)) > 1.5) {
      state.appliedHeading = state.heading;
      map.setBearing(state.heading);
      renderCompass();
    }
  }

  function attachCompass() {
    var evt = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(evt, onOrientation);
    state.compassEvent = evt;

    // Nothing reports a heading on a desktop without a magnetometer; say so
    // rather than leaving a toggle that silently does nothing.
    setTimeout(function () {
      if (state.headingUp && !state.compassSeen) {
        toast('No compass on this device.');
        setHeadingUp(false);
      }
    }, 2500);
  }

  function detachCompass() {
    if (state.compassEvent) window.removeEventListener(state.compassEvent, onOrientation);
    state.compassEvent = null;
    state.heading = null;
    state.appliedHeading = null;
    state.compassSeen = false;
  }

  function setHeadingUp(on) {
    state.headingUp = on;
    state.prefs.headingUp = on;
    savePrefs();
    map.setRotationEnabled(on);

    if (on) {
      // iOS 13+ only hands over orientation after an explicit grant, and only
      // from a user gesture — which is why this lives on the button.
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(function (result) {
          if (result === 'granted') attachCompass();
          else { toast('Compass permission denied.'); setHeadingUp(false); }
        }).catch(function () { toast('Compass unavailable.'); setHeadingUp(false); });
      } else if (typeof DeviceOrientationEvent === 'undefined') {
        toast('This browser has no compass support.');
        state.headingUp = false;
        state.prefs.headingUp = false;
        map.setRotationEnabled(false);
      } else {
        attachCompass();
      }
    } else {
      detachCompass();
      map.setBearing(0);
    }
    renderCompass();
  }

  function renderCompass() {
    var btn = $('compass');
    btn.classList.toggle('is-active', !!state.headingUp);
    btn.setAttribute('aria-pressed', state.headingUp ? 'true' : 'false');
    btn.title = state.headingUp ? 'Heading up — tap for north up' : 'North up — tap to follow your heading';
    // The needle keeps pointing at true north as the map turns beneath it.
    $('compass-needle').style.transform = 'rotate(' + (-(map ? map.getBearing() : 0)) + 'deg)';
  }

  /* ---------------------------------------------------------- fullscreen */

  /* Two separate things, deliberately driven by one button: the Fullscreen
   * API (which iOS Safari doesn't offer at all) and an immersive layout that
   * hides the panel. The layout half always works, so the button still does
   * something useful where the API is missing. */

  function setImmersive(on) {
    state.immersive = on;
    document.body.classList.toggle('is-immersive', on);
    $('hud').hidden = !on || !state.position;
    var btn = $('fullscreen');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Exit full screen' : 'Full screen map';
    // The stage resized, so the map needs to refill it.
    if (map) map.render();
  }

  function toggleFullscreen() {
    var el = document.documentElement;
    var request = el.requestFullscreen || el.webkitRequestFullscreen;
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    var active = document.fullscreenElement || document.webkitFullscreenElement;

    if (!state.immersive) {
      setImmersive(true);
      if (request) {
        // Rejection is normal (denied, or unsupported on iOS) — the
        // immersive layout is already in place either way.
        var p = request.call(el);
        if (p && p.catch) p.catch(function () {});
      }
    } else {
      setImmersive(false);
      if (active && exit) {
        var q = exit.call(document);
        if (q && q.catch) q.catch(function () {});
      }
    }
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

  /* CARTO's Positron and Dark Matter, at @2x so the labels stay sharp on
   * dense screens. A native dark basemap beats inverting a light one: an
   * inverted map gets the ground right but turns every label into a
   * photographic negative. */
  var BASEMAP = {
    light: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
    dark: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'
  };

  function prefersDark() {
    var theme = state.prefs.theme;
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyTheme() {
    var theme = state.prefs.theme;
    document.documentElement.dataset.theme = theme === 'auto' ? '' : theme;
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    if (map) map.setTileUrl(prefersDark() ? BASEMAP.dark : BASEMAP.light);

    // Matches --bg exactly, so the browser/OS chrome blends with the page
    // rather than the OS scheme and the in-app override disagreeing.
    $('theme-color').setAttribute('content', prefersDark() ? '#0d1117' : '#f5f6f8');
  }

  function activateTab(name) {
    document.querySelectorAll('.tab').forEach(function (t) {
      var active = t.dataset.tab === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.toggle('is-active', p.dataset.panel === name);
    });
  }

  function setSheetExpanded(on) {
    state.sheetExpanded = on;
    state.prefs.sheetExpanded = on;
    savePrefs();
    $('sheet').dataset.state = on ? 'expanded' : 'collapsed';
    $('sheet-handle').setAttribute('aria-expanded', on ? 'true' : 'false');
    $('sheet-handle').setAttribute('aria-label', on ? 'Collapse details' : 'Expand details');
  }

  function wireUI() {
    // Recenter now doubles as "find me": one control, always a fresh fix,
    // rather than a separate always-visible pill for the same job.
    $('zoom-in').addEventListener('click', function () { map.zoomBy(1); });
    $('zoom-out').addEventListener('click', function () { map.zoomBy(-1); });
    $('recenter').addEventListener('click', locateOnce);

    $('sheet-handle').addEventListener('click', function () {
      setSheetExpanded(!state.sheetExpanded);
    });

    // Tapping the map while the sheet is open gets it out of the way, same
    // as Apple/Google Maps — but a drag is a pan, not a dismissal.
    map.on('click', function () {
      if (state.sheetExpanded) setSheetExpanded(false);
    });

    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        activateTab(tab.dataset.tab);
        state.prefs.activeTab = tab.dataset.tab;
        savePrefs();
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
      renderWeather();
    });

    $('rate-toggle').addEventListener('click', function () {
      var order = ['turbo', 'fast', 'normal', 'saver'];
      state.prefs.rate = order[(order.indexOf(state.prefs.rate) + 1) % order.length];
      this.textContent = rateLabel();
      savePrefs();
      syncPoll();
      if (state.prefs.live || state.tracking) pollNow();
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

    $('banner-close').addEventListener('click', function () {
      $('banner').hidden = true;
    });

    $('compass').addEventListener('click', function () {
      setHeadingUp(!state.headingUp);
    });

    // Rotating the phone changes what "up" means for the compass reading.
    if (window.screen && window.screen.orientation && window.screen.orientation.addEventListener) {
      window.screen.orientation.addEventListener('change', function () {
        state.heading = null;
        state.appliedHeading = null;
      });
    }

    $('fullscreen').addEventListener('click', toggleFullscreen);

    // Esc and the browser's own controls leave fullscreen without telling the
    // button, so follow the document rather than assuming our click did it.
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (evt) {
      document.addEventListener(evt, function () {
        var active = document.fullscreenElement || document.webkitFullscreenElement;
        if (!active && state.immersive) setImmersive(false);
      });
    });

    $('live-toggle').addEventListener('click', function () {
      if (state.tracking && state.prefs.live) {
        toast('Stop the trip recording first.');
        return;
      }
      setLive(!state.prefs.live);
    });

    $('track-toggle').addEventListener('click', function () {
      if (state.tracking) {
        stopTracking();
        toast(state.prefs.live ? 'Trip saved · still live' : 'Trip recording stopped');
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
      saveTrip();
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
      if (e.key === 'f') toggleFullscreen();
      if (e.key === 'Escape' && state.immersive) setImmersive(false);
      if (e.key === '+' || e.key === '=') map.zoomBy(1);
      if (e.key === '-') map.zoomBy(-1);
    });
  }

  function init() {
    loadStorage();
    applyTheme();

    var start = parseHash() || { lat: 20, lng: 0, zoom: 3 };
    start.tileUrl = prefersDark() ? BASEMAP.dark : BASEMAP.light;
    map = new MiniMap($('map'), start);

    // Follow the OS theme while the app is set to auto.
    if (window.matchMedia) {
      var dark = window.matchMedia('(prefers-color-scheme: dark)');
      var onSchemeChange = function () { if (state.prefs.theme === 'auto') applyTheme(); };
      if (dark.addEventListener) dark.addEventListener('change', onSchemeChange);
      else if (dark.addListener) dark.addListener(onSchemeChange);
    }

    $('coord-format').textContent = state.prefs.coordFormat;
    $('unit-toggle').textContent = state.prefs.units;
    $('theme-toggle').textContent = state.prefs.theme;
    $('rate-toggle').textContent = rateLabel();

    // Remembers where you left the sheet and which tab was open.
    activateTab(state.prefs.activeTab || 'now');
    setSheetExpanded(!!state.prefs.sheetExpanded);

    wireUI();
    renderLive();
    renderSheetSummary();
    renderCompass();
    // Heading-up needs a gesture on iOS, so a saved preference re-arms the
    // control rather than silently starting the compass.
    if (state.prefs.headingUp) toast('Tap the compass to follow your heading.');
    syncPlaceMarkers();
    renderPlaces();
    renderTrip();

    // A trip in progress (or just finished but not cleared) survives a
    // reload — restore its polyline and the recording button's own state;
    // syncWatch() below picks the watch back up if it was still recording.
    if (state.track.length) map.setTrack(state.track);
    if (state.tracking) {
      $('track-toggle').textContent = 'Stop tracking';
      $('track-toggle').classList.add('is-active');
    }

    if (!window.isSecureContext) {
      banner('Geolocation needs a secure context. Open this page over https:// or from http://localhost.', 'warn');
    }

    // Keep "fix from …" and the trip clock honest without extra fixes.
    setInterval(function () {
      if (state.position) renderNow();
      if (state.tracking) renderTrip();
    }, 1000);

    // Geolocation prompts don't need a prior click the way more sensitive
    // APIs do, so ask right away rather than waiting for a tap — locateOnce()
    // already handles "unsupported" and "insecure context" via its own banner.
    locateOnce();

    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' }).then(function (status) {
        status.addEventListener('change', function () {
          if (status.state === 'granted') syncWatch();
          else stopWatch();
        });
      }).catch(function () { /* Safari and friends: no permission-change tracking */ });
    }

    // A hidden tab can't show a live readout, so stop drawing on the GPS for
    // one. A trip in progress is different — that has to keep recording.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (!state.tracking) stopWatch();
      } else if (state.position) {
        // Only resume once we've had a fix — never spring a permission
        // prompt on someone just for switching back to the tab.
        syncWatch();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
