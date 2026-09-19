'use strict';

// GETTING AROUND A LONG PAGE (issue #1041).
//
// Tyler, 2026-09-17: *"I need a way to quickly get back to the top of the page.
// Or if there's any other things we can do, because if I open up Ready to Enter
// and sometimes I have a lot and I have to scroll a lot."*
//
// Ready to Enter can be several hundred rows. Two controls answer that, and
// both of them were shaped by measurement rather than by taste — the prototype
// (PR #1056, prototypes/2026-09-17-page-nav/) built five variants in real
// Chrome and measured the geometry, and two of its numbers overturned the
// obvious design:
//
//   THE FLOATING "Top" BUTTON GOES BOTTOM-LEFT, NOT BOTTOM-RIGHT. At the
//   obvious corner it covered the last visible row's To Station button by
//   1,383 px² — breaking the ticket's own "nothing covers a row's action cell"
//   rule — and sat squarely on lib/theme.js's floating toggle (1,280 px², gap
//   0), which every tool mounts bottom-right. Bottom-left measured 0 and 0,
//   because the action cell is right-aligned on every row, so the left corner
//   is the one place a row has no controls. It is `position: fixed` rather than
//   sticky: at 390 the page is 639px wide, and a sticky control scrolls off
//   sideways with everything else.
//
//   THE JUMP STRIP CONDENSES UNDER 640px. At 1280 the strip costs 3px of
//   header. At 390 the full strip wraps and costs +82px, putting the whole
//   sticky stack at 495px — 58.7% of the viewport — which is #874 repeating
//   (a sticky stack eating the phone).
//
// ONE CONSTANT FOR THE AIR AND THE MARKER. A jump leaves JUMP_AIR of air under
// the sticky header, and the "where am I" marker asks whether a section has
// passed a line JUMP_AIR (plus a few px of tolerance) below that header. The
// prototype ran these as two numbers for one round and the strip highlighted
// the PREVIOUS section after every jump — the target had arrived 8px short of
// the line. They are one number here and tests/page-nav.test.js round-trips
// jumpTargetY through currentSectionId so they cannot drift apart again.
//
// WHAT THIS MODULE IS NOT: it does not touch a record store, and it holds no
// state. It is arithmetic and predicates over numbers the DOM hands in, so the
// page can be re-measured at any moment without anything to invalidate. The
// pixels themselves (does the button overlap an action cell, how tall is the
// sticky stack) are not knowable in jsdom and are left to the real-Chrome
// verify; what IS knowable — which chips exist, which key navigates, where a
// jump lands — is pinned here and in tests/ibno-page-nav-dom.test.js.
//
// Dual-loadable with no build step:
// - Browser: window.PageNav
// - Node:    require('./lib/page-nav')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PageNav = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Air left under the sticky header by a jump, AND the offset of the line the
  // marker measures against. One number, for the reason above.
  const JUMP_AIR = 12;

  // Slack on the marker line only. A jump lands a section exactly at
  // headerBottom + JUMP_AIR, and sub-pixel layout means "exactly" is worth a
  // few pixels of grace in the direction of "yes, it arrived".
  const MARK_TOLERANCE = 4;

  // Slack on "the page is at its bottom". Sub-pixel document heights and a
  // browser that stops a smooth scroll a fraction short are both common, and
  // neither means the supervisor is somewhere other than the bottom.
  const BOTTOM_TOLERANCE = 2;

  // How far down the page the Top button waits before appearing. The button is
  // useless while the top is on screen and it is a floating object, so it stays
  // out of the way until scrolling has actually cost something.
  const TOP_THRESHOLD = 600;

  // The phone breakpoint, matching the one ibno-coder.html already uses for the
  // grouped toolbar. At or below this the strip condenses.
  //
  // THE CONDENSING ITSELF IS CSS, not this module — `@media (max-width: 640px)`
  // in ibno-coder.html is what drops the chips' counts and moves the Top button
  // to its 12px inset. So this number does not drive the page; it PINS it.
  // tests/page-nav.test.js reads the page and asserts the media query is built
  // from this constant, which is what stops the two drifting apart (PR #1061
  // review, finding 3). isCondensed() is the predicate that reading gives a
  // name to.
  const CONDENSE_MAX_WIDTH = 640;

  // The long section titles, as they read in a strip that has to fit beside the
  // rest of the header. Keyed by the CLEANED h2 text (icon and chevron gone).
  const SHORT_LABELS = {
    'Ready to Enter': 'Ready',
    'Needs Manual Review': 'Manual',
    'Manually Resolved': 'Resolved',
    'Repeat Packages': 'Repeat',
    'Other work areas': 'Other areas',
    'Set aside': 'Set aside',
  };

  function str(v) { return String(v == null ? '' : v).trim(); }

  function num(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  // showsTopButton(scrollY) -> is the page far enough down to offer the button?
  //
  // Strictly greater, so a page that settles back at exactly 0 answers false.
  // "It hides at the top" is one of the ticket's conditions and a >= would make
  // a 0-threshold build of this silently keep it on screen.
  function showsTopButton(scrollY) {
    return num(scrollY) > TOP_THRESHOLD;
  }

  // isTypingTarget(el) -> is this element one the supervisor is typing into?
  //
  // Tag-based, matching the two global keydown handlers ibno-coder.html already
  // runs (the C/B copy-mode keys and Work mode's own). The cases that matter
  // are the per-row code inputs and Work mode's Goes To box, both plain
  // <input>: Home and End inside them move the CARET, and a page-nav handler
  // that hijacked them would make the tool unable to edit the middle of a typed
  // area — the single worst outcome available to this feature, because it
  // happens mid-sort and looks like a broken keyboard.
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = str(el.tagName).toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return !!el.isContentEditable;
  }

  // navActionFor(event) -> 'top' | 'bottom' | ''
  //
  // '' means "not ours": the page must not preventDefault, and every other
  // handler on the document sees the key untouched. A modified Home/End is
  // always the browser's — Ctrl+Home is the OS-level "go to the top" and
  // stealing it would replace a working shortcut with a lookalike.
  function navActionFor(event) {
    if (!event) return '';
    if (event.metaKey || event.ctrlKey || event.altKey) return '';
    if (isTypingTarget(event.target)) return '';
    if (event.key === 'Home') return 'top';
    if (event.key === 'End') return 'bottom';
    return '';
  }

  // jumpTargetY(sectionTop, scrollY, headerHeight) -> the absolute page offset
  // a jump should scroll to, given the section's CURRENT viewport-relative top.
  //
  // Clamped at 0: the first section sits a few px below the top of the page, so
  // an unclamped jump to it would ask for a negative offset and land at 0
  // anyway on some engines and nowhere on others.
  function jumpTargetY(sectionTop, scrollY, headerHeight) {
    const y = num(sectionTop) + num(scrollY) - num(headerHeight) - JUMP_AIR;
    return y > 0 ? y : 0;
  }

  // markerLine(headerBottom) -> the viewport y a section's top must have passed
  // for the strip to call it the current one.
  function markerLine(headerBottom) {
    return num(headerBottom) + JUMP_AIR + MARK_TOLERANCE;
  }

  // atPageBottom(scrollY, viewportHeight, documentHeight) -> is the page as far
  // down as it goes?
  //
  // The last section cannot always reach the marker line: a jump to it is
  // clamped at the document end, so on a short final section the page stops
  // with that section's top still BELOW the line and the marker stays on the
  // one above it. The verify measured exactly that — a click on the Set aside
  // chip left Repeat highlighted at 1280 and Other areas at 390. Being at the
  // bottom is the one case where "which section am I in" has an answer that
  // does not come from the line: the last one.
  //
  // Requires the page to actually scroll. A document shorter than the viewport
  // is at its own bottom by arithmetic while every section is on screen at
  // once, and there the first section is the honest answer, not the last.
  function atPageBottom(scrollY, viewportHeight, documentHeight) {
    const doc = num(documentHeight);
    const view = num(viewportHeight);
    if (doc <= view) return false;
    return num(scrollY) + view >= doc - BOTTOM_TOLERANCE;
  }

  // currentSectionId(sections, headerBottom, atBottom) -> which chip is
  // highlighted.
  //
  // `sections` is [{ id, top }] in page order, tops viewport-relative. The
  // answer is the LAST section whose top has passed the line; at the top of the
  // page nothing has, so the first section is current rather than none — the
  // strip should never read as "you are nowhere". At the very bottom the last
  // section is current whether or not it reached the line (see atPageBottom).
  function currentSectionId(sections, headerBottom, atBottom) {
    const list = Array.isArray(sections) ? sections.filter((s) => s && str(s.id)) : [];
    if (!list.length) return '';
    if (atBottom) return str(list[list.length - 1].id);
    const line = markerLine(headerBottom);
    let cur = list[0];
    list.forEach((s) => { if (num(s.top) <= line) cur = s; });
    return str(cur.id);
  }

  // stripLabel(rawTitle) -> the chip's text.
  //
  // The h2 carries a leading chevron span and an emoji icon, neither of which
  // reads as anything in a 12px chip, so everything before the first letter or
  // digit is dropped. An unmapped title falls through cleaned rather than
  // blank: a new section should show up in the strip under its own name, not
  // as an empty chip nobody can click on purpose.
  function stripLabel(rawTitle) {
    const cleaned = str(rawTitle).replace(/^[^A-Za-z0-9]+/, '').trim();
    return SHORT_LABELS[cleaned] || cleaned;
  }

  // stripEntries(sections) -> [{ id, label, count }] for the chips to render.
  //
  // `sections` is [{ id, title, count, hidden }]. Hidden sections are skipped —
  // a chip that jumps to a `display: none` section is a dead control, and the
  // two counted lines (Other work areas, Set aside) are hidden on most reports.
  function stripEntries(sections) {
    const list = Array.isArray(sections) ? sections : [];
    const out = [];
    list.forEach(function (s) {
      if (!s || s.hidden) return;
      const id = str(s.id);
      if (!id) return;
      out.push({ id: id, label: stripLabel(s.title), count: str(s.count) });
    });
    return out;
  }

  // isCondensed(viewportWidth) -> should the strip use its narrow form?
  function isCondensed(viewportWidth) {
    return num(viewportWidth) <= CONDENSE_MAX_WIDTH;
  }

  return {
    JUMP_AIR: JUMP_AIR,
    MARK_TOLERANCE: MARK_TOLERANCE,
    BOTTOM_TOLERANCE: BOTTOM_TOLERANCE,
    TOP_THRESHOLD: TOP_THRESHOLD,
    CONDENSE_MAX_WIDTH: CONDENSE_MAX_WIDTH,
    SHORT_LABELS: SHORT_LABELS,
    showsTopButton: showsTopButton,
    isTypingTarget: isTypingTarget,
    navActionFor: navActionFor,
    jumpTargetY: jumpTargetY,
    markerLine: markerLine,
    atPageBottom: atPageBottom,
    currentSectionId: currentSectionId,
    stripLabel: stripLabel,
    stripEntries: stripEntries,
    isCondensed: isCondensed,
  };
});
