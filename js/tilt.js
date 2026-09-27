// RUCUSO — RucusoTilt
//
// Loaded on the home page after js/app.js. 3D tilt for cards.
//
// Loaded as a plain script, not an ES module, to match how the rest of the site
// works: js/data.js exposes window.RucusoData, js/app.js reads it, and
// supabase/supabase-client.js exposes window.RucusoAPI. There is no bundler and
// no import map, so `export` would not resolve here.
//
// Written directly rather than pulled from a library. Vanilla-Tilt is a jQuery
// plugin and this site has no jQuery; the one behaviour wanted here is about
// thirty lines, and a dependency is a thing that can break independently of us.
//
// Design notes
//   * Every write is a CSS custom property, not a transform string. The browser
//     then owns the interpolation, so JS runs once per pointermove and the
//     compositor does the rest. That is what keeps this off the layout path.
//   * rAF-coalesced. pointermove can fire far more often than the display can
//     paint; without coalescing we would queue work for frames that never show.
//     Only the two numbers we need are kept, never the event object, because an
//     event reference held across a frame boundary is a retained object.
//   * Transform only — no width/height/top/left — so nothing reflows.
//   * Pointer devices only. A tilt driven by a finger fights with scrolling, so
//     on a coarse pointer this module does nothing at all.
//   * Honours prefers-reduced-motion, and unbinds rather than just zeroing, so
//     nothing is computed when someone has asked for less motion.
//
// Enhances only. If this file is absent, every card still works.
(function () {
  "use strict";

  var MAX_TILT = 7;   // degrees. Past ~8 a card reads as broken rather than alive.
  var LIFT = -5;      // px raised on hover.
  var SELECTOR = ".tilt[data-tilt]";

  var bound = false;
  var cards = [];
  var handlers = [];

  function reduced() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // A coarse pointer means touch. A finger dragging across a card is scrolling,
  // not aiming, and a tilt that tracks it feels like the page is broken.
  function coarse() {
    return window.matchMedia("(pointer: coarse)").matches;
  }

  // No-op, kept for the static page: index.html is served without a build step,
  // so a reader looking for the other init functions should find a consistent
  // shape. The real check is coarse() below.
  function init() {}

  function apply(card, px, py) {
    // rotateX follows the pointer vertically, negated, so pushing up tilts the
    // top of the card away — the way a real card pivots on its base.
    var x = (-py * MAX_TILT * 2).toFixed(2);
    var y = (px * MAX_TILT * 2).toFixed(2);
    card.style.setProperty("--tilt-x", x + "deg");
    card.style.setProperty("--tilt-y", y + "deg");
    card.style.setProperty("--tilt-glow-x", (px * 100 + 50).toFixed(1) + "%");
    card.style.setProperty("--tilt-glow-y", (py * 100 + 50).toFixed(1) + "%");
  }

  function onEnter(card) {
    card.style.setProperty("--tilt-lift", LIFT + "px");
  }

  function onLeave(card) {
    card.style.setProperty("--tilt-x", "0deg");
    card.style.setProperty("--tilt-y", "0deg");
    card.style.setProperty("--tilt-lift", "0px");
    // The highlight fades via the ::after opacity transition, so its position is
    // left alone rather than snapped back, which would look like a jump.
  }

  function teardown() {
    handlers.forEach(function (h) { h.card.removeEventListener(h.type, h.fn); });
    handlers = [];
    cards.forEach(function (card) {
      card.style.removeProperty("--tilt-x");
      card.style.removeProperty("--tilt-y");
      card.style.removeProperty("--tilt-lift");
      card.style.removeProperty("--tilt-glow-x");
      card.style.removeProperty("--tilt-glow-y");
    });
    cards = [];
    bound = false;
  }

  function bind(root) {
    if (coarse() || reduced()) return 0;

    var scope = root || document;
    var found = scope.querySelectorAll(SELECTOR);
    if (!found.length) return 0;

    // One pending pointer shared across all cards, so a fast sweep across a grid
    // costs one frame, not one frame per card.
    var pending = null;
    var queued = false;

    function flush() {
      queued = false;
      if (!pending) return;
      apply(pending.card, pending.px, pending.py);
      pending = null;
    }

    Array.prototype.forEach.call(found, function (card) {
      // getBoundingClientRect is read per event rather than cached on enter: the
      // page scrolls, and mobile browsers change the viewport height when their
      // chrome collapses, so a cached rect goes stale.
      var move = function (event) {
        if (event.pointerType === "touch") return;
        var rect = card.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        pending = {
          card: card,
          px: (event.clientX - rect.left) / rect.width - 0.5,
          py: (event.clientY - rect.top) / rect.height - 0.5,
        };
        if (!queued) {
          queued = true;
          requestAnimationFrame(flush);
        }
      };

      var enter = function () { onEnter(card); };
      var leave = function () { onLeave(card); };

      card.addEventListener("pointermove", move, { passive: true });
      card.addEventListener("pointerenter", enter, { passive: true });
      card.addEventListener("pointerleave", leave, { passive: true });

      handlers.push({ card: card, type: "pointermove", fn: move });
      handlers.push({ card: card, type: "pointerenter", fn: enter });
      handlers.push({ card: card, type: "pointerleave", fn: leave });
      cards.push(card);
    });

    bound = true;
    return cards.length;
  }

  // Someone can turn reduced motion on mid-session. Tear the listeners down
  // rather than leaving them writing properties nobody can see.
  var motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  var onMotionChange = function (event) {
    if (event.matches) teardown();
    else bind();
  };
  if (motionQuery.addEventListener) motionQuery.addEventListener("change", onMotionChange);
  else if (motionQuery.addListener) motionQuery.addListener(onMotionChange);

  window.RucusoTilt = { init: init, bind: bind, teardown: teardown, count: function () { return cards.length; } };
})();
