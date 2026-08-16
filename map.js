/* MiniMap — a small dependency-free slippy map over OpenStreetMap tiles.
 *
 * Covers what this app needs and nothing more: pan, integer zoom, markers,
 * an accuracy circle, and a track polyline. Web Mercator throughout, with
 * tiles at 256px so world size is 256 * 2^zoom pixels.
 */
(function (global) {
  'use strict';

  var TILE = 256;
  var MIN_ZOOM = 2;
  var MAX_ZOOM = 19;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // Latitude beyond this can't be represented in Web Mercator.
  function clampLat(lat) { return clamp(lat, -85.05112878, 85.05112878); }

  function worldSize(zoom) { return TILE * Math.pow(2, zoom); }

  function project(lat, lng, zoom) {
    var size = worldSize(zoom);
    var s = Math.sin(clampLat(lat) * Math.PI / 180);
    return {
      x: size * (lng / 360 + 0.5),
      y: size * (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI))
    };
  }

  function unproject(x, y, zoom) {
    var size = worldSize(zoom);
    var n = Math.PI * (1 - 2 * y / size);
    return {
      lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
      lng: 360 * (x / size - 0.5)
    };
  }

  // Ground resolution in metres per screen pixel at a given latitude/zoom.
  function metersPerPixel(lat, zoom) {
    return 156543.03392804097 * Math.cos(clampLat(lat) * Math.PI / 180) / Math.pow(2, zoom);
  }

  function MiniMap(container, options) {
    options = options || {};
    this.el = container;
    this.el.classList.add('minimap');
    this.center = { lat: options.lat != null ? options.lat : 20, lng: options.lng != null ? options.lng : 0 };
    this.zoom = clamp(options.zoom != null ? options.zoom : 3, MIN_ZOOM, MAX_ZOOM);
    this.tileUrl = options.tileUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    this.markers = Object.create(null);
    this.listeners = { move: [], click: [] };
    this.tiles = Object.create(null);
    this.track = [];

    this.tileLayer = document.createElement('div');
    this.tileLayer.className = 'mm-tiles';

    this.overlay = document.createElementNS(SVG_NS, 'svg');
    this.overlay.setAttribute('class', 'mm-overlay');

    // Two paths for one line: a casing underneath keeps the track legible
    // wherever it crosses something the same colour as itself.
    this.trackCasing = document.createElementNS(SVG_NS, 'path');
    this.trackCasing.setAttribute('class', 'mm-track-casing');
    this.trackCasing.setAttribute('fill', 'none');
    this.overlay.appendChild(this.trackCasing);

    this.trackPath = document.createElementNS(SVG_NS, 'path');
    this.trackPath.setAttribute('class', 'mm-track');
    this.trackPath.setAttribute('fill', 'none');
    this.overlay.appendChild(this.trackPath);

    this.accuracyCircle = document.createElementNS(SVG_NS, 'circle');
    this.accuracyCircle.setAttribute('class', 'mm-accuracy');
    this.accuracyCircle.setAttribute('r', '0');
    this.overlay.appendChild(this.accuracyCircle);

    this.markerLayer = document.createElement('div');
    this.markerLayer.className = 'mm-markers';

    this.el.appendChild(this.tileLayer);
    this.el.appendChild(this.overlay);
    this.el.appendChild(this.markerLayer);

    this._bindPointer();
    this._bindWheel();

    var self = this;
    this._onResize = function () { self.render(); };
    global.addEventListener('resize', this._onResize);
    if (global.ResizeObserver) {
      this._ro = new ResizeObserver(function () { self.render(); });
      this._ro.observe(this.el);
    }

    this.render();
  }

  MiniMap.prototype.size = function () {
    return { w: this.el.clientWidth, h: this.el.clientHeight };
  };

  // Top-left corner of the viewport in world pixel coordinates.
  MiniMap.prototype._origin = function () {
    var c = project(this.center.lat, this.center.lng, this.zoom);
    var s = this.size();
    return { x: c.x - s.w / 2, y: c.y - s.h / 2 };
  };

  MiniMap.prototype.latLngToPoint = function (lat, lng) {
    var p = project(lat, lng, this.zoom);
    var o = this._origin();
    return { x: p.x - o.x, y: p.y - o.y };
  };

  MiniMap.prototype.pointToLatLng = function (x, y) {
    var o = this._origin();
    return unproject(o.x + x, o.y + y, this.zoom);
  };

  MiniMap.prototype.on = function (event, fn) {
    if (this.listeners[event]) this.listeners[event].push(fn);
    return this;
  };

  MiniMap.prototype._emit = function (event, payload) {
    var fns = this.listeners[event] || [];
    for (var i = 0; i < fns.length; i++) fns[i](payload);
  };

  MiniMap.prototype.setView = function (lat, lng, zoom) {
    this.center = { lat: clampLat(lat), lng: lng };
    if (zoom != null) this.zoom = clamp(Math.round(zoom), MIN_ZOOM, MAX_ZOOM);
    this.render();
    this._emit('move', this.getView());
    return this;
  };

  MiniMap.prototype.getView = function () {
    return { lat: this.center.lat, lng: this.center.lng, zoom: this.zoom };
  };

  MiniMap.prototype.zoomBy = function (delta, anchor) {
    var next = clamp(this.zoom + delta, MIN_ZOOM, MAX_ZOOM);
    if (next === this.zoom) return this;
    if (anchor) {
      // Keep the geographic point under `anchor` pinned to the same pixel.
      var before = this.pointToLatLng(anchor.x, anchor.y);
      this.zoom = next;
      var after = this.pointToLatLng(anchor.x, anchor.y);
      this.center = {
        lat: clampLat(this.center.lat + (before.lat - after.lat)),
        lng: this.center.lng + (before.lng - after.lng)
      };
    } else {
      this.zoom = next;
    }
    this.render();
    this._emit('move', this.getView());
    return this;
  };

  MiniMap.prototype._bindPointer = function () {
    var self = this;
    var dragging = false;
    var moved = 0;
    var last = null;
    var pointers = Object.create(null);
    var pinchStart = null;

    function pointerCount() { return Object.keys(pointers).length; }

    this.el.addEventListener('pointerdown', function (e) {
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (pointerCount() === 1) {
        dragging = true;
        moved = 0;
        last = { x: e.clientX, y: e.clientY };
        self.el.setPointerCapture(e.pointerId);
        self.el.classList.add('is-dragging');
      } else if (pointerCount() === 2) {
        dragging = false;
        pinchStart = self._pinchDistance(pointers);
      }
    });

    this.el.addEventListener('pointermove', function (e) {
      if (!pointers[e.pointerId]) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };

      if (pointerCount() === 2 && pinchStart) {
        var dist = self._pinchDistance(pointers);
        var ratio = dist / pinchStart;
        if (ratio > 1.8 || ratio < 0.55) {
          var rect = self.el.getBoundingClientRect();
          var ids = Object.keys(pointers);
          var mid = {
            x: (pointers[ids[0]].x + pointers[ids[1]].x) / 2 - rect.left,
            y: (pointers[ids[0]].y + pointers[ids[1]].y) / 2 - rect.top
          };
          self.zoomBy(ratio > 1 ? 1 : -1, mid);
          pinchStart = dist;
        }
        return;
      }

      if (!dragging || !last) return;
      var dx = e.clientX - last.x;
      var dy = e.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      last = { x: e.clientX, y: e.clientY };
      self.panByPixels(-dx, -dy);
    });

    function release(e) {
      delete pointers[e.pointerId];
      if (pointerCount() < 2) pinchStart = null;
      if (pointerCount() === 0) {
        if (dragging && moved < 5) {
          var rect = self.el.getBoundingClientRect();
          self._emit('click', self.pointToLatLng(e.clientX - rect.left, e.clientY - rect.top));
        }
        dragging = false;
        last = null;
        self.el.classList.remove('is-dragging');
      }
    }

    this.el.addEventListener('pointerup', release);
    this.el.addEventListener('pointercancel', release);
  };

  MiniMap.prototype._pinchDistance = function (pointers) {
    var ids = Object.keys(pointers);
    if (ids.length < 2) return 0;
    var a = pointers[ids[0]], b = pointers[ids[1]];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  MiniMap.prototype._bindWheel = function () {
    var self = this;
    var cooldown = 0;
    this.el.addEventListener('wheel', function (e) {
      e.preventDefault();
      var now = Date.now();
      if (now - cooldown < 120) return;
      cooldown = now;
      var rect = self.el.getBoundingClientRect();
      self.zoomBy(e.deltaY < 0 ? 1 : -1, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    }, { passive: false });
  };

  MiniMap.prototype.panByPixels = function (dx, dy) {
    var c = project(this.center.lat, this.center.lng, this.zoom);
    var next = unproject(c.x + dx, c.y + dy, this.zoom);
    this.center = { lat: clampLat(next.lat), lng: next.lng };
    this.render();
    this._emit('move', this.getView());
    return this;
  };

  MiniMap.prototype.setMarker = function (id, lat, lng, className, label) {
    var marker = this.markers[id];
    if (!marker) {
      var el = document.createElement('div');
      el.className = 'mm-marker ' + (className || '');
      if (label) el.title = label;
      this.markerLayer.appendChild(el);
      marker = this.markers[id] = { el: el };
    }
    marker.lat = lat;
    marker.lng = lng;
    if (label) marker.el.title = label;
    this._placeMarkers();
    return marker.el;
  };

  MiniMap.prototype.removeMarker = function (id) {
    var marker = this.markers[id];
    if (!marker) return;
    marker.el.remove();
    delete this.markers[id];
  };

  MiniMap.prototype.clearMarkers = function (prefix) {
    var self = this;
    Object.keys(this.markers).forEach(function (id) {
      if (!prefix || id.indexOf(prefix) === 0) self.removeMarker(id);
    });
  };

  MiniMap.prototype.setAccuracy = function (lat, lng, meters) {
    this._accuracy = (meters > 0) ? { lat: lat, lng: lng, meters: meters } : null;
    this._drawOverlay();
    return this;
  };

  MiniMap.prototype.setTrack = function (points) {
    this.track = points || [];
    this._drawOverlay();
    return this;
  };

  MiniMap.prototype._placeMarkers = function () {
    var self = this;
    Object.keys(this.markers).forEach(function (id) {
      var m = self.markers[id];
      var p = self.latLngToPoint(m.lat, m.lng);
      m.el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
    });
  };

  MiniMap.prototype._drawOverlay = function () {
    var s = this.size();
    this.overlay.setAttribute('width', s.w);
    this.overlay.setAttribute('height', s.h);
    this.overlay.setAttribute('viewBox', '0 0 ' + s.w + ' ' + s.h);

    if (this._accuracy) {
      var c = this.latLngToPoint(this._accuracy.lat, this._accuracy.lng);
      var r = this._accuracy.meters / metersPerPixel(this._accuracy.lat, this.zoom);
      this.accuracyCircle.setAttribute('cx', c.x);
      this.accuracyCircle.setAttribute('cy', c.y);
      // Below a few pixels the circle reads as noise around the marker.
      this.accuracyCircle.setAttribute('r', r > 4 ? Math.min(r, s.w + s.h) : 0);
    } else {
      this.accuracyCircle.setAttribute('r', '0');
    }

    if (this.track.length > 1) {
      var d = '';
      for (var i = 0; i < this.track.length; i++) {
        var p = this.latLngToPoint(this.track[i].lat, this.track[i].lng);
        d += (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
      }
      this.trackPath.setAttribute('d', d);
      this.trackCasing.setAttribute('d', d);
    } else {
      this.trackPath.setAttribute('d', '');
      this.trackCasing.setAttribute('d', '');
    }
  };

  // Swapping basemaps (light <-> dark) drops every cached tile, since the old
  // images are still correct for their coordinates but wrong for the style.
  MiniMap.prototype.setTileUrl = function (url) {
    if (url === this.tileUrl) return this;
    this.tileUrl = url;
    for (var key in this.tiles) {
      this.tiles[key].remove();
      delete this.tiles[key];
    }
    this.render();
    return this;
  };

  MiniMap.prototype._tileUrl = function (z, x, y) {
    return this.tileUrl
      .replace('{z}', z)
      .replace('{x}', x)
      .replace('{y}', y);
  };

  MiniMap.prototype.render = function () {
    var s = this.size();
    if (!s.w || !s.h) return;

    var o = this._origin();
    var z = this.zoom;
    var n = Math.pow(2, z);
    var minX = Math.floor(o.x / TILE);
    var maxX = Math.floor((o.x + s.w) / TILE);
    var minY = clamp(Math.floor(o.y / TILE), 0, n - 1);
    var maxY = clamp(Math.floor((o.y + s.h) / TILE), 0, n - 1);

    var wanted = Object.create(null);

    for (var x = minX; x <= maxX; x++) {
      for (var y = minY; y <= maxY; y++) {
        // Wrap horizontally so panning past the antimeridian keeps working.
        var tx = ((x % n) + n) % n;
        var key = z + '/' + tx + '/' + y + '@' + x;
        wanted[key] = true;

        var tile = this.tiles[key];
        if (!tile) {
          tile = document.createElement('img');
          tile.className = 'mm-tile';
          tile.alt = '';
          tile.decoding = 'async';
          tile.loading = 'eager';
          tile.src = this._tileUrl(z, tx, y);
          tile.addEventListener('load', function () { this.classList.add('is-loaded'); });
          tile.addEventListener('error', function () { this.classList.add('is-error'); });
          this.tileLayer.appendChild(tile);
          this.tiles[key] = tile;
        }
        tile.style.transform = 'translate(' + (x * TILE - o.x) + 'px,' + (y * TILE - o.y) + 'px)';
      }
    }

    for (var key2 in this.tiles) {
      if (!wanted[key2]) {
        this.tiles[key2].remove();
        delete this.tiles[key2];
      }
    }

    this._placeMarkers();
    this._drawOverlay();
  };

  MiniMap.metersPerPixel = metersPerPixel;
  MiniMap.MIN_ZOOM = MIN_ZOOM;
  MiniMap.MAX_ZOOM = MAX_ZOOM;

  global.MiniMap = MiniMap;
})(window);
