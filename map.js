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

    /* A second, optional raster layer painted over the basemap — used for
     * the railway overlay in train mode. Kept as its own tile cache rather
     * than folded into the basemap's, so toggling it on and off doesn't
     * disturb any basemap tile that's already loaded. */
    this.overlayTileLayer = document.createElement('div');
    this.overlayTileLayer.className = 'mm-tiles mm-tiles-overlay';
    this.overlayTiles = Object.create(null);
    this.overlayTileUrl = options.overlayTileUrl || null;

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

    /* Everything that belongs to the world goes inside a rotator, so a
     * heading-up map is one transform rather than a re-projection. It is
     * inset by `_pad` past every edge, because a rotated square has to be
     * bigger than its viewport or the corners come up empty. */
    this.rotator = document.createElement('div');
    this.rotator.className = 'mm-rotator';
    this.rotator.appendChild(this.tileLayer);
    this.rotator.appendChild(this.overlayTileLayer);
    this.rotator.appendChild(this.overlay);
    this.rotator.appendChild(this.markerLayer);
    this.el.appendChild(this.rotator);

    this.bearing = 0;
    this.rotationEnabled = false;
    this._pad = 0;

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

  /* The rotator is transformed by rotate(-bearing), so a CSS transform maps a
   * plane point p to M(-bearing)·p. Going the other way — screen to plane, for
   * clicks, drags and zoom anchors — means applying M(+bearing). */
  MiniMap.prototype._screenToPlane = function (x, y) {
    if (!this.bearing) return { x: x, y: y };
    var s = this.size();
    var cx = s.w / 2, cy = s.h / 2;
    var v = this._rotateVector(x - cx, y - cy);
    return { x: cx + v.x, y: cy + v.y };
  };

  MiniMap.prototype._rotateVector = function (dx, dy) {
    if (!this.bearing) return { x: dx, y: dy };
    var r = this.bearing * Math.PI / 180;
    var cos = Math.cos(r), sin = Math.sin(r);
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  };

  MiniMap.prototype.pointToLatLng = function (x, y) {
    var p = this._screenToPlane(x, y);
    var o = this._origin();
    return unproject(o.x + p.x, o.y + p.y, this.zoom);
  };

  /* Rotation ---------------------------------------------------------- */

  // Half the difference between the viewport's diagonal and its shorter side:
  // the most any corner can swing outside the box at any angle.
  MiniMap.prototype._padFor = function (s) {
    if (!this.rotationEnabled) return 0;
    return Math.ceil((Math.hypot(s.w, s.h) - Math.min(s.w, s.h)) / 2) + TILE;
  };

  MiniMap.prototype.setRotationEnabled = function (on) {
    if (this.rotationEnabled === on) return this;
    this.rotationEnabled = on;
    if (!on) this.bearing = 0;
    this.render();
    return this;
  };

  MiniMap.prototype.setBearing = function (deg) {
    this.bearing = ((deg % 360) + 360) % 360;
    this.rotator.style.transform = 'rotate(' + (-this.bearing) + 'deg)';
    // Markers would otherwise ride the rotation and end up upside down.
    this._placeMarkers();
    return this;
  };

  MiniMap.prototype.getBearing = function () { return this.bearing; };

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
    // Dragging should follow the finger, not the map's underlying axes.
    var d = this._rotateVector(dx, dy);
    var c = project(this.center.lat, this.center.lng, this.zoom);
    var next = unproject(c.x + d.x, c.y + d.y, this.zoom);
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
    var pad = this._pad;
    var upright = self.bearing ? ' rotate(' + self.bearing + 'deg)' : '';
    Object.keys(this.markers).forEach(function (id) {
      var m = self.markers[id];
      var p = self.latLngToPoint(m.lat, m.lng);
      m.el.style.transform = 'translate(' + (p.x + pad) + 'px,' + (p.y + pad) + 'px)' + upright;
    });
  };

  MiniMap.prototype._drawOverlay = function () {
    var size = this.size();
    var pad = this._pad;
    var s = { w: size.w + pad * 2, h: size.h + pad * 2 };
    this.overlay.setAttribute('width', s.w);
    this.overlay.setAttribute('height', s.h);
    this.overlay.setAttribute('viewBox', '0 0 ' + s.w + ' ' + s.h);

    if (this._accuracy) {
      var c = this.latLngToPoint(this._accuracy.lat, this._accuracy.lng);
      var r = this._accuracy.meters / metersPerPixel(this._accuracy.lat, this.zoom);
      this.accuracyCircle.setAttribute('cx', c.x + pad);
      this.accuracyCircle.setAttribute('cy', c.y + pad);
      // Below a few pixels the circle reads as noise around the marker.
      this.accuracyCircle.setAttribute('r', r > 4 ? Math.min(r, s.w + s.h) : 0);
    } else {
      this.accuracyCircle.setAttribute('r', '0');
    }

    if (this.track.length > 1) {
      var d = '';
      for (var i = 0; i < this.track.length; i++) {
        var p = this.latLngToPoint(this.track[i].lat, this.track[i].lng);
        d += (i === 0 ? 'M' : 'L') + (p.x + pad).toFixed(1) + ' ' + (p.y + pad).toFixed(1);
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

  // Null clears the overlay entirely (and drops its tiles); anything else
  // swaps it, same drop-and-reload contract as the basemap above.
  MiniMap.prototype.setOverlayTileUrl = function (url) {
    if (url === this.overlayTileUrl) return this;
    this.overlayTileUrl = url || null;
    for (var key in this.overlayTiles) {
      this.overlayTiles[key].remove();
      delete this.overlayTiles[key];
    }
    this.render();
    return this;
  };

  function fillTemplate(template, z, x, y) {
    return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  }

  MiniMap.prototype._tileUrl = function (z, x, y) {
    return fillTemplate(this.tileUrl, z, x, y);
  };

  MiniMap.prototype.render = function () {
    var s = this.size();
    if (!s.w || !s.h) return;

    var pad = this._padFor(s);
    this._pad = pad;
    this.rotator.style.inset = (-pad) + 'px';
    this.rotator.style.transform = 'rotate(' + (-this.bearing) + 'deg)';

    // Tiles are laid out against the rotator's box, which starts `pad` above
    // and left of the viewport.
    var o = this._origin();
    o = { x: o.x - pad, y: o.y - pad };
    var w = s.w + pad * 2;
    var h = s.h + pad * 2;

    var z = this.zoom;
    var n = Math.pow(2, z);
    var minX = Math.floor(o.x / TILE);
    var maxX = Math.floor((o.x + w) / TILE);
    var minY = clamp(Math.floor(o.y / TILE), 0, n - 1);
    var maxY = clamp(Math.floor((o.y + h) / TILE), 0, n - 1);

    var box = { z: z, n: n, o: o, minX: minX, maxX: maxX, minY: minY, maxY: maxY };
    this._renderTileLayer(this.tileLayer, this.tiles, this.tileUrl, box);
    this._renderTileLayer(this.overlayTileLayer, this.overlayTiles, this.overlayTileUrl, box);

    this._placeMarkers();
    this._drawOverlay();
  };

  /* One loop, two layers: the basemap and the optional overlay differ only
   * in which cache and URL template they draw from, so they share this
   * rather than keeping two copies of the same tiling arithmetic in step. */
  MiniMap.prototype._renderTileLayer = function (layerEl, cache, template, box) {
    var key;
    if (!template) {
      for (key in cache) {
        cache[key].remove();
        delete cache[key];
      }
      return;
    }

    var wanted = Object.create(null);

    for (var x = box.minX; x <= box.maxX; x++) {
      for (var y = box.minY; y <= box.maxY; y++) {
        // Wrap horizontally so panning past the antimeridian keeps working.
        var tx = ((x % box.n) + box.n) % box.n;
        var k = box.z + '/' + tx + '/' + y + '@' + x;
        wanted[k] = true;

        var tile = cache[k];
        if (!tile) {
          tile = document.createElement('img');
          tile.className = 'mm-tile';
          tile.alt = '';
          tile.decoding = 'async';
          tile.loading = 'eager';
          tile.src = fillTemplate(template, box.z, tx, y);
          tile.addEventListener('load', function () { this.classList.add('is-loaded'); });
          tile.addEventListener('error', function () { this.classList.add('is-error'); });
          layerEl.appendChild(tile);
          cache[k] = tile;
        }
        tile.style.transform = 'translate(' + (x * TILE - box.o.x) + 'px,' + (y * TILE - box.o.y) + 'px)';
      }
    }

    for (key in cache) {
      if (!wanted[key]) {
        cache[key].remove();
        delete cache[key];
      }
    }
  };

  MiniMap.metersPerPixel = metersPerPixel;
  MiniMap.MIN_ZOOM = MIN_ZOOM;
  MiniMap.MAX_ZOOM = MAX_ZOOM;

  global.MiniMap = MiniMap;
})(window);
