// RUCUSO — RucusoMap
//
// Loaded on the home page after js/app.js. The "Tupo yetu" section: an
// interactive Leaflet map pinned to the RUCU main campus in Iringa.
//
// Leaflet from a CDN, not Google Maps: no API key to manage, no billing, and the
// OpenStreetMap tile layer needs no account at all. Google Maps embed would also
// have to be an iframe (so no custom marker, no dark-mode-aware tiles), and a
// key in front-end code is a key that ends up in a screenshot.
//
// Coordinates: -7.7760, 35.6963. That is 7°46'34"S 35°41'47"E, the main campus
// in Iringa Municipality. Sourced from Wikipedia's coordinate for Ruaha Catholic
// University, which Wikidata and 50bestmuseums both corroborate. It is NOT
// read from anywhere at runtime, and it is a campus centroid, not the front gate
// — which is why the popup also links to directions rather than implying the pin
// is a doorway.
//
// Degrades honestly. If the CDN is blocked — which is a real possibility on
// campus networks — the section shows the address, the coordinates and a working
// "Open in maps" link rather than an empty grey box. An interactive map that
// does not load is worse than no map, because the visitor does not know whether
// it is broken or whether they are looking in the wrong place.
(function () {
  "use strict";

  // Main campus, Iringa, Tanzania.
  var CAMPUS = { lat: -7.7760, lng: 35.6963 };

  var LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
  var LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
  // Pin images are relative to the leaflet CSS, so the URL is pinned explicitly
  // rather than letting Leaflet guess from the stylesheet's location.
  var TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
  var TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

  // The pin, as an inline SVG so it needs no extra request and inherits the
  // brand colours from the CSS rather than baking them into a file.
  var PIN_SVG =
    '<svg class="rucu-pin" viewBox="0 0 34 44" aria-hidden="true">' +
    '<path class="rucu-pin__body" d="M17 43C17 43 32 25.4 32 14.4A15 15 0 0 0 2 14.4C2 25.4 17 43 17 43Z"/>' +
    '<circle class="rucu-pin__core" cx="17" cy="14" r="5.4"/>' +
    "</svg>";

  // The popup carries one outbound link, to Google Maps directions. An earlier
  // version also offered a "Uongozi" link to rucuso.online/leader/ — that path
  // does not exist (leader/ only has dashboard/ and login/), so it was a 404.
  // There is nothing to link leadership to from here, so it is simply not
  // offered rather than pointed somewhere that breaks.
  var directionsUrl = "https://www.google.com/maps/dir/?api=1&destination=" +
    CAMPUS.lat + "," + CAMPUS.lng;

  var map = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-rucusomap="' + src + '"]');
      if (existing) {
        if (existing.dataset.loaded === "true") { resolve(); return; }
        existing.addEventListener("load", function () { resolve(); });
        existing.addEventListener("error", reject);
        return;
      }
      var el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.dataset.rucusomap = src;
      el.addEventListener("load", function () {
        el.dataset.loaded = "true";
        resolve();
      });
      el.addEventListener("error", function () { reject(new Error("leaflet js failed: " + src)); });
      document.head.appendChild(el);
    });
  }

  function loadStyle(href) {
    if (document.querySelector('link[data-rucusomap="' + href + '"]')) return;
    var el = document.createElement("link");
    el.rel = "stylesheet";
    el.href = href;
    el.dataset.rucusomap = href;
    document.head.appendChild(el);
  }

  function popupHtml() {
    return (
      '<div class="rucu-popup">' +
      '<p class="rucu-popup__kicker">RUCUSO Headquarters</p>' +
      '<p class="rucu-popup__title">Ruaha Catholic University (RUCU)</p>' +
      '<p class="rucu-popup__meta">Iringa, Tanzania<br>' +
      "7&deg;46&prime;34&Prime;S 35&deg;41&prime;47&Prime;E</p>" +
      '<div class="rucu-popup__actions">' +
      '<a href="' + directionsUrl + '" target="_blank" rel="noopener noreferrer">Fungua kwenye Google Maps</a>' +
      "</div>" +
      "</div>"
    );
  }

  function popupIcon() {
    return L.divIcon({
      html: PIN_SVG,
      className: "rucu-pinwrap",
      iconSize: [34, 44],
      // The tip of the pin is the point on the map; without this anchor the pin
      // floats half its height above the location.
      iconAnchor: [17, 44],
      popupAnchor: [0, -44],
    });
  }

  function build(host) {
    loadStyle(LEAFLET_CSS);

    return loadScript(LEAFLET_JS).then(function () {
      if (typeof L === "undefined") throw new Error("leaflet loaded but L is missing");

      map = L.map(host, {
        center: [CAMPUS.lat, CAMPUS.lng],
        zoom: 16,
        scrollWheelZoom: false, // so scrolling the page over the map does not zoom it
        zoomControl: true,
      });

      // CartoDB's light basemap reads much closer to the site's cream and navy
      // than the standard OSM style, and it is still OpenStreetMap data — so the
      // attribution requirement is unchanged either way.
      //
      // Only one layer is on the map at a time. An earlier version added both
      // this and the standard tiles, which fetched every tile twice for a
      // visually identical result; on a metered or congested campus connection
      // that is real data spent for nothing.
      var primary = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        attribution: TILE_ATTR,
        subdomains: "abcd",
        maxZoom: 20,
      });

      // Real fallback, on a real failure: if a tile will not load, drop this
      // layer and put the standard OSM tiles in its place. Checked before
      // painting rather than after, so a broken primary is never briefly
      // visible.
      var fellBack = false;
      primary.on("tileerror", function () {
        if (fellBack) return;
        fellBack = true;
        map.removeLayer(primary);
        L.tileLayer(TILE_URL, {
          attribution: TILE_ATTR,
          maxZoom: 19,
          crossOrigin: true,
        }).addTo(map);
        host.classList.add("is-fallback-tiles");
      });

      primary.addTo(map);

      L.marker([CAMPUS.lat, CAMPUS.lng], { icon: popupIcon(), title: "RUCUSO Headquarters — RUCU, Iringa" })
        .addTo(map)
        .bindPopup(popupHtml(), { maxWidth: 280, closeButton: true })
        .openPopup();

      // A wide frame with a pinned height can end up with grey bands when Leaflet
      // initialises before the container has its final size.
      setTimeout(function () { if (map) map.invalidateSize(); }, 120);

      host.classList.add("is-ready");
      return map;
    });
  }

  function init() {
    var host = document.getElementById("mapHost");
    if (!host || map) return;

    build(host).catch(function (error) {
      // The frame keeps the address, the coordinates and the "Open in maps"
      // buttons, so a student on a blocked network is not stuck. The only thing
      // that has to change is the caption: leaving "Ramani inapakia" on screen
      // after loading has definitively failed would tell the visitor the page is
      // still working when it is not.
      var note = host.querySelector("[data-map-note]");
      if (note) note.textContent = "Ramani hazikuweza kupakiwa. Tumia viungo hapa chini.";
      console.warn("RUCUSO map unavailable:", error.message);
      host.classList.add("is-fallback");
    });
  }

  // Only build the map once the section is close to the viewport.
  //
  // The map lives inside #view-verify, which is display:none until the student
  // navigates there. A hidden element has no box, so an IntersectionObserver on
  // it reports "not intersecting" — and whether it re-fires when the ancestor
  // becomes visible is browser-dependent. Relying on that alone meant the map
  // sometimes never appeared, which is the worst possible failure for the one
  // thing on this screen that a student is looking for.
  //
  // So the observer is only an optimisation, and app.js also calls ensure()
  // from go() when the verify view is opened. Whichever happens first wins, and
  // build() is idempotent via the `map` guard.
  var observer = null;

  function observeWhenNear() {
    var host = document.getElementById("mapHost");
    if (!host || observer) return;
    if (!("IntersectionObserver" in window)) return; // ensure() will handle it

    observer = new IntersectionObserver(function (entries) {
      if (!entries.some(function (e) { return e.isIntersecting; })) return;
      observer.disconnect();
      observer = null;
      init();
    }, { rootMargin: "300px" });
    observer.observe(host);
  }

  // Called by app.js when the verify view is shown. Safe to call repeatedly.
  function ensure() {
    var host = document.getElementById("mapHost");
    if (!host) return;
    if (map) {
      // Already built, but the frame may have been laid out at a different size
      // while hidden, so the tile grid and centre need recomputing.
      if (map.invalidateSize) setTimeout(function () { map.invalidateSize(); }, 0);
      return;
    }
    observeWhenNear();
    init();
  }

  window.RucusoMap = { init: init, ensure: ensure, CAMPUS: CAMPUS, get instance() { return map; } };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observeWhenNear);
  } else {
    observeWhenNear();
  }
})();
