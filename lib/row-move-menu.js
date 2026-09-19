'use strict';

// IBNO Coder: WHERE the row-move menu is painted (issue #1037, the "Move to…"
// item #997 listed). Pure geometry and nothing else — no DOM, no store, no
// writer.
//
// Dual-loadable with no build step:
// - Browser: window.RowMoveMenu
// - Node: require('./lib/row-move-menu')
//
// WHY THIS IS A MODULE AND NOT FOUR LINES INSIDE THE CLICK HANDLER.
//
// The prototype for #1037 (prototypes/2026-09-17-row-move-menu, PR #1056)
// measured the failure this function exists to prevent, in real Chrome, with a
// menu open on the LAST row of a 60-row list:
//
//   variant A, 1280x900 — 147px of a 195px menu below the fold, 75.3% of it
//                         off-screen, and elementFromPoint() at the centre of
//                         the last item returned something outside the menu:
//                         the last move was UNCLICKABLE.
//   variant A,  390x844 — 116px below the fold, 59.4% off-screen, same result.
//   with the upward flip — 0px lost at both widths, last item clickable.
//
// The last row of a lane is exactly the row a supervisor reaches at the end of
// a pass, so "it only breaks at the bottom" is not a mitigation. The decision
// therefore lives where a unit test with a FAKE viewport can pin it, rather
// than only where a browser can see it.
//
// THE CALLER STILL OWNS `position: fixed` ON `<body>`. This function answers
// "where", not "inside what". The same prototype measured a menu positioned
// inside the row's own cell under a wrapper with `overflow: hidden` losing
// 38,267px² — 80.3% of itself — with its last item unclickable again, so the
// menu is parented to <body>. No number this module returns can rescue a menu
// that is clipped by an ancestor.
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RowMoveMenu = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // The gap between the caret and the menu, and the minimum breathing room
  // between the menu and any viewport edge. Exported so the stylesheet and the
  // test read the same numbers this function does.
  const GAP = 4;
  const MARGIN = 8;

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : (fallback || 0);
  }

  function clamp(v, lo, hi) {
    if (hi < lo) return lo;
    return Math.min(Math.max(v, lo), hi);
  }

  // place({ caret, menu, viewport }) -> { direction, top, left, maxHeight }
  //
  //   caret     { top, bottom, left, right } — a DOMRect, or anything shaped
  //             like one. Viewport coordinates, which is what
  //             getBoundingClientRect() already gives and what `position:
  //             fixed` already consumes, so the caller converts nothing.
  //   menu      { width, height } — measured AFTER the menu is in the document
  //             and BEFORE it is positioned. A height of 0 means it has not
  //             been measured, and the answer would be "everything fits".
  //   viewport  { width, height }
  //
  // `direction` is the answer the prototype's numbers are about, and it is
  // returned separately from `top` so a test can assert the DECISION without
  // re-deriving it from a pixel value, and so the menu can carry it as a data
  // attribute for the browser /verify to read.
  function place(opts) {
    const o = opts || {};
    const caret = o.caret || {};
    const menu = o.menu || {};
    const viewport = o.viewport || {};

    const gap = num(o.gap, GAP);
    const margin = num(o.margin, MARGIN);

    const cTop = num(caret.top, 0);
    const cBottom = num(caret.bottom, cTop);
    const cRight = num(caret.right, num(caret.left, 0));

    const mW = Math.max(0, num(menu.width, 0));
    const mH = Math.max(0, num(menu.height, 0));

    const vW = Math.max(0, num(viewport.width, 0));
    const vH = Math.max(0, num(viewport.height, 0));

    const need = mH + gap;
    const roomBelow = vH - cBottom - margin;
    const roomAbove = cTop - margin;

    // THE FLIP RULE. Down is the default because a menu that drops from its
    // own control is what a person expects; up is taken the moment down would
    // cross the viewport bottom, which is the measured failure above.
    //
    // THE THIRD CASE IS REAL AND IS NOT "flip and hope": on a short viewport
    // neither side fits, and flipping upward into even less room would be a
    // worse menu for the same click. There, the roomier side wins and the
    // clamp + maxHeight below make the menu scroll inside itself instead of
    // hanging off an edge. A tie stays down, so the default is never lost to
    // a rounding accident.
    let direction;
    if (roomBelow >= need) direction = 'down';
    else if (roomAbove >= need) direction = 'up';
    else direction = roomAbove > roomBelow ? 'up' : 'down';

    const rawTop = direction === 'up' ? (cTop - gap - mH) : (cBottom + gap);
    const top = clamp(rawTop, margin, Math.max(margin, vH - margin - mH));

    // RIGHT-ALIGNED TO THE CARET, then pulled back inside the right edge, then
    // never pushed past the left one. The order matters: at 390 the action
    // cell is `white-space: nowrap` and runs past the viewport, so the caret's
    // own right edge can be off-screen and the first expression alone would
    // paint the menu where nobody can reach it.
    const rawLeft = cRight - mW;
    const left = clamp(rawLeft, margin, Math.max(margin, vW - margin - mW));

    // What the menu may grow to before it has to scroll itself. Always the
    // full usable height rather than the chosen side's room, because clamping
    // has already moved the menu off the caret in the only case where the two
    // differ, and a menu that is shorter than it needs to be for a reason the
    // supervisor cannot see is its own defect.
    const maxHeight = Math.max(0, vH - (2 * margin));

    return { direction: direction, top: top, left: left, maxHeight: maxHeight };
  }

  // flipDirection(...) -> just the decision, for the callers and tests that
  // only ever ask which way it went.
  function flipDirection(opts) { return place(opts).direction; }

  return {
    GAP: GAP,
    MARGIN: MARGIN,
    place: place,
    flipDirection: flipDirection,
  };
});
