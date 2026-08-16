'use strict';

// IBNO Coder column layout model (issue #701, spec #690 stories 29/30,
// born-in-lib mandate 3 of #614).
//
// Dual-loadable with no build step:
// - Browser: window.IbnoColumnLayout
// - Node: require('./lib/ibno-column-layout')
//
// This module is the whole answer to "which columns are on screen, in what
// order, and how wide". It is a PURE state model: no DOM, no localStorage, no
// globals, and every mutator returns a NEW layout rather than editing the one it
// was handed. ibno-coder.html owns the pixels and the storage; it owns the
// rules.
//
// ─── THE THREE CLOCKS, AND WHY THIS ONE NEVER TICKS ─────────────────────────
//
// IBNO Coder now keeps state on three different clocks, and this module is the
// slowest of them. Getting it wrong is not a cosmetic bug — it is Tyler
// re-arranging his table at 1:30 AM:
//
//   filters .......... TRANSIENT. Reset on every load and every fresh pull, so a
//                      stale slice can never hide rows on a new report (#690
//                      story 2). lib/ibno-merged-view.js.
//   Goes To / parked / SORT DAY. Alive for the report's own sort day, keyed on
//   503s / sheet ticks INBOUND_DATE so the 1:30 AM sort does not reset at
//                      midnight (#621). lib/sort-day.js.
//   column layout .... INDEFINITE. Survives loads, fresh report drops and new
//                      sort days. There is deliberately NO clock in this file:
//                      nothing here reads a date, and nothing here should ever
//                      learn how to. If a future edit wants to expire a layout,
//                      that is a spec change, not a refactor.
//
// ─── THE SPEC, AND THE THREE ROLES ──────────────────────────────────────────
//
// The page hands in a `spec`: the table's columns in MARKUP order, each
// { key, label, role? }. The role decides what may happen to a column:
//
//   'lead'   Structural and pinned to the front. The row-select checkbox: it is
//            not a column of data, it is the handle for every bulk action, and a
//            supervisor who drags it into the middle of the row has broken
//            select-all for no gain.
//   'data'   (the default) Movable and, unless locked below, hidable. These are
//            the columns story 29 is about.
//   'trail'  Structural and pinned to the end. The Resolve / action cell, which
//            holds the code select and the Apply and Park buttons.
//
// Only 'data' columns live in `layout.order`; lead and trail are re-derived from
// the spec on every render (columnsFor). That is what makes reordering
// impossible to get wrong: there is no index arithmetic that could walk a data
// column past a structural one, because they are not in the same list.
//
// ─── WHY CODE AND GOES TO CANNOT BE HIDDEN ──────────────────────────────────
//
// They are the two columns Tyler WRITES to. Goes To is where the area he looked
// up in FRO goes; Code is where the OPS2 code goes. Every other column on the
// row is something he reads. Hiding a column he reads costs him a glance; hiding
// a column he writes to costs him the workflow, with no visible cause — the row
// simply stops accepting the thing it exists to accept.
//
// Round 6 of the prototype (#613) shipped this lock as popover UI only, and the
// probe caught that the underlying function would still hide them. So the lock
// lives HERE, at the model, and every path in and out of the model goes through
// it: setHidden, toggleHidden, and deserialize (a hand-edited or stale store is
// just another caller).

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IbnoColumnLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ─── THE ONE WIDTH CEILING ────────────────────────────────────────────────
  //
  // Acceptance criterion, stated as one constant on purpose: the edge-pull and
  // the panel are two UIs over ONE rule. lib/data-table.js deliberately has no
  // ceiling (its cells ellipsize, so a wide column is how you read a long value
  // in full). These tables do the opposite — nothing truncates by default, the
  // full value already wraps — so an unbounded width buys nothing and costs the
  // rest of the row: one runaway drag on Recipient / Address and Goes To is off
  // the right edge of the screen with no hint of where it went.
  //
  // MIN matches data-table's, because a column narrower than its own resize
  // handle cannot be grabbed back.
  const MIN_WIDTH = 60;
  const MAX_WIDTH = 600;

  // The two columns Tyler writes to. See the header comment.
  const LOCKED_KEYS = ['code', 'goesto'];

  // Service Provider (the ISP from lib/zip-isp-belt.js, stamped per row). Tyler
  // sorts by it and groups his walk by it, but he does not READ it mid-row, so
  // it defaults to the far end of the data band (#613 round 6, his first
  // message on columns). A default, not a lock: he can drag it anywhere.
  const PROVIDER_KEY = 'isp';

  function str(v) { return String(v == null ? '' : v); }

  function specList(spec) {
    return Array.isArray(spec) ? spec.filter(function (c) { return c && c.key; }) : [];
  }

  function roleOf(col) {
    const r = str(col && col.role);
    return (r === 'lead' || r === 'trail') ? r : 'data';
  }

  function specFor(spec, key) {
    const k = str(key);
    return specList(spec).filter(function (c) { return c.key === k; })[0] || null;
  }

  function dataKeys(spec) {
    return specList(spec)
      .filter(function (c) { return roleOf(c) === 'data'; })
      .map(function (c) { return c.key; });
  }

  // isLocked(key) -> may this column never be hidden?
  function isLocked(key) {
    return LOCKED_KEYS.indexOf(str(key)) !== -1;
  }

  // isMovable(spec, key) -> is this column part of the reorderable band?
  function isMovable(spec, key) {
    const col = specFor(spec, key);
    return !!col && roleOf(col) === 'data';
  }

  // ─── DEFAULTS ─────────────────────────────────────────────────────────────

  // defaultOrder(spec) -> the data keys in markup order, with Provider pulled to
  // the end. Absent a provider column the markup order is the default outright.
  function defaultOrder(spec) {
    const keys = dataKeys(spec);
    const i = keys.indexOf(PROVIDER_KEY);
    if (i === -1) return keys;
    return keys.slice(0, i).concat(keys.slice(i + 1)).concat([PROVIDER_KEY]);
  }

  // createLayout(spec) -> a fresh layout.
  //
  //   order   the data keys, in render order
  //   widths  key -> pinned px. EMPTY by default, which is what "nothing
  //           truncates by default" means at the model: an unpinned column is
  //           auto-width and its cell wraps rather than clipping.
  //   hidden  key -> true. Empty by default; every column starts on screen.
  function createLayout(spec) {
    return { order: defaultOrder(spec), widths: {}, hidden: {} };
  }

  // reset(spec) -> createLayout. Named separately because "Reset columns" is a
  // button Tyler presses, and a call site reading `reset` says why it ran.
  function reset(spec) {
    return createLayout(spec);
  }

  function cloneLayout(layout) {
    const l = layout || {};
    return {
      order: Array.isArray(l.order) ? l.order.slice() : [],
      widths: Object.assign({}, l.widths),
      hidden: Object.assign({}, l.hidden),
    };
  }

  // ─── REORDER ──────────────────────────────────────────────────────────────

  // moveTo(layout, key, index) -> a new layout with `key` at `index` in the data
  // band. Out-of-range indexes CLAMP rather than drop the column: the drag path
  // computes the index from a pointer position, and a pointer past the last
  // header is a perfectly ordinary way to say "put it at the end".
  function moveTo(layout, key, index) {
    const next = cloneLayout(layout);
    const k = str(key);
    const from = next.order.indexOf(k);
    if (from === -1) return next;
    let to = Math.round(Number(index));
    if (!isFinite(to)) return next;
    if (to < 0) to = 0;
    if (to > next.order.length - 1) to = next.order.length - 1;
    if (to === from) return next;
    next.order.splice(from, 1);
    next.order.splice(to, 0, k);
    return next;
  }

  // moveBy(layout, key, delta) -> the panel's up/down arrows. No wrap-around:
  // a column at the end that jumped to the front on one more click of the same
  // button would read as a lost column, not as a move.
  function moveBy(layout, key, delta) {
    const from = cloneLayout(layout).order.indexOf(str(key));
    if (from === -1) return cloneLayout(layout);
    const d = Math.round(Number(delta)) || 0;
    const to = from + d;
    if (to < 0 || to > (layout && layout.order ? layout.order.length - 1 : -1)) return cloneLayout(layout);
    return moveTo(layout, key, to);
  }

  // ─── WIDTH ────────────────────────────────────────────────────────────────

  // clampWidth(px) -> a whole-pixel width inside the ceiling, or null for auto.
  //
  // THE seam both resize paths call. A drag hands it an absolute pixel measured
  // from the pointer; the panel hands it the current width plus or minus a
  // nudge. Neither knows the ceiling, and neither should.
  //
  // A NUMBER is always a width, and is clamped into the band at both ends. That
  // includes zero, a negative and an infinity, none of which a caller types on
  // purpose: they arrive from arithmetic (startWidth + dx on a drag that crossed
  // the header, or the panel's minus button walked down). Answering "auto" to
  // those would make a hard pull left un-pin the column and jump it back to full
  // width, which reads as the drag being dropped.
  //
  // "No width" is said by passing null, undefined, '', a boolean or something
  // that coerces to NaN — or, more clearly, by calling clearWidth. Note the
  // exact boundary, because it is narrower than "non-numeric": a value that
  // COERCES to a number is a number here, so `[]` and '  ' become 0 and land on
  // the floor rather than on auto. No caller passes either; the rule is stated
  // so a future one is not surprised.
  function clampWidth(px) {
    if (px === null || px === undefined || px === '' || typeof px === 'boolean') return null;
    const n = Number(px);
    if (Number.isNaN(n)) return null;
    if (n === Infinity) return MAX_WIDTH;
    if (n === -Infinity) return MIN_WIDTH;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(n)));
  }

  // widthOf(layout, key) -> the pinned px, or null when the column is auto.
  function widthOf(layout, key) {
    const w = layout && layout.widths ? layout.widths[str(key)] : null;
    return (typeof w === 'number' && w > 0) ? w : null;
  }

  // setWidth(layout, key, px) -> a new layout with the column pinned, clamped.
  // A px that clamps to null clears the pin instead of storing a zero.
  function setWidth(layout, key, px) {
    const next = cloneLayout(layout);
    const k = str(key);
    // Widths are only meaningful for columns this layout actually orders. Lead
    // and trail cells are structural and sized by the markup, and a key the
    // spec does not have is a caller bug that must not grow the store.
    if (next.order.indexOf(k) === -1) return next;
    const w = clampWidth(px);
    if (w === null) delete next.widths[k];
    else next.widths[k] = w;
    return next;
  }

  function clearWidth(layout, key) {
    const next = cloneLayout(layout);
    delete next.widths[str(key)];
    return next;
  }

  // ─── HIDE ─────────────────────────────────────────────────────────────────

  function isHidden(layout, key) {
    const k = str(key);
    if (isLocked(k)) return false;
    return !!(layout && layout.hidden && layout.hidden[k]);
  }

  // setHidden(layout, key, on) -> a new layout. Locked columns are refused HERE,
  // at the model, so no caller can hide Code or Goes To by any route.
  //
  // Also refused: any key outside the reorderable band. The structural lead and
  // trail cells are not hidable (a table with no select checkbox has no bulk
  // actions and no visible cause), and a key the spec does not have at all is a
  // caller bug. Both used to be ACCEPTED and stored, which inflated hiddenCount
  // — the button could read "· 1 hidden" with every column on screen.
  function setHidden(layout, key, on) {
    const next = cloneLayout(layout);
    const k = str(key);
    if (isLocked(k) || next.order.indexOf(k) === -1) return next;
    if (on) next.hidden[k] = true;
    else delete next.hidden[k];
    return next;
  }

  function toggleHidden(layout, key) {
    return setHidden(layout, key, !isHidden(layout, key));
  }

  // hiddenCount(layout) -> the number the Columns button prints ("· 2 hidden").
  // Hidden columns must leave a counted trace: the findability rule (#611) says
  // nothing vanishes without a number.
  function hiddenCount(layout) {
    const h = (layout && layout.hidden) || {};
    const order = (layout && Array.isArray(layout.order)) ? layout.order : [];
    // Counted over the BAND, so the number on the button can only ever be the
    // number of columns actually missing from the table.
    return Object.keys(h).filter(function (k) {
      return h[k] && !isLocked(k) && order.indexOf(k) !== -1;
    }).length;
  }

  // ─── RENDER VIEW ──────────────────────────────────────────────────────────

  // columnsFor(spec, layout) -> every spec column, in render order, each with
  // its resolved layout state. Lead columns first (markup order), then the data
  // band in the layout's order, then trail columns (markup order).
  //
  // The invariant this function keeps, and that the tests pin: every spec column
  // appears exactly once, whatever the layout says. A layout can hide a column
  // or move it; it can never make one disappear from the table, because the
  // header and the rows are painted from THIS list and a missing entry would be
  // a missing cell in a row whose colspan still counts it.
  function columnsFor(spec, layout) {
    const cols = specList(spec);
    const order = (layout && Array.isArray(layout.order)) ? layout.order : defaultOrder(spec);
    const lead = cols.filter(function (c) { return roleOf(c) === 'lead'; });
    const trail = cols.filter(function (c) { return roleOf(c) === 'trail'; });
    const band = dataKeys(spec);
    const seen = Object.create(null);
    const ordered = [];
    order.forEach(function (k) {
      if (band.indexOf(k) === -1 || seen[k]) return;
      seen[k] = true;
      ordered.push(specFor(spec, k));
    });
    band.forEach(function (k) {
      if (seen[k]) return;
      seen[k] = true;
      ordered.push(specFor(spec, k));
    });
    return lead.concat(ordered, trail).map(function (c) {
      const role = roleOf(c);
      return {
        key: c.key,
        label: str(c.label),
        role: role,
        movable: role === 'data',
        locked: isLocked(c.key),
        hidden: role === 'data' && isHidden(layout, c.key),
        width: role === 'data' ? widthOf(layout, c.key) : null,
      };
    });
  }

  // visibleColumns(spec, layout) -> what is actually on screen.
  function visibleColumns(spec, layout) {
    return columnsFor(spec, layout).filter(function (c) { return !c.hidden; });
  }

  // ─── STORAGE (shape only; the page owns localStorage) ─────────────────────

  function serialize(layout) {
    const l = cloneLayout(layout);
    return { order: l.order, widths: l.widths, hidden: l.hidden };
  }

  // deserialize(raw, spec) -> a layout that is always usable.
  //
  // Written defensively because this is the ONLY path by which a layout Tyler
  // saved weeks ago meets a table whose columns have since changed. Every branch
  // fails toward a working table rather than toward his stored preference:
  //
  //   - junk, or no stored value at all      -> the default layout
  //   - a stored key the spec dropped        -> ignored
  //   - a spec key the store never saw       -> appended in default order, so a
  //                                             newly added column is visible
  //                                             rather than mysteriously absent
  //   - a width past the ceiling, or junk    -> clamped, or dropped to auto
  //   - a hidden Code or Goes To             -> refused; the lock outranks the store
  function deserialize(raw, spec) {
    const layout = createLayout(spec);
    if (!raw || typeof raw !== 'object') return layout;

    const band = dataKeys(spec);
    if (Array.isArray(raw.order)) {
      const seen = Object.create(null);
      const kept = [];
      raw.order.forEach(function (k) {
        const key = str(k);
        if (band.indexOf(key) === -1 || seen[key]) return;
        seen[key] = true;
        kept.push(key);
      });
      defaultOrder(spec).forEach(function (k) {
        if (!seen[k]) { seen[k] = true; kept.push(k); }
      });
      layout.order = kept;
    }

    if (raw.widths && typeof raw.widths === 'object') {
      Object.keys(raw.widths).forEach(function (k) {
        if (band.indexOf(k) === -1) return;
        const w = clampWidth(raw.widths[k]);
        if (w !== null) layout.widths[k] = w;
      });
    }

    if (raw.hidden && typeof raw.hidden === 'object') {
      Object.keys(raw.hidden).forEach(function (k) {
        if (band.indexOf(k) === -1 || isLocked(k) || !raw.hidden[k]) return;
        layout.hidden[k] = true;
      });
    }

    return layout;
  }

  return {
    MIN_WIDTH: MIN_WIDTH,
    MAX_WIDTH: MAX_WIDTH,
    LOCKED_KEYS: LOCKED_KEYS,
    PROVIDER_KEY: PROVIDER_KEY,
    createLayout: createLayout,
    reset: reset,
    defaultOrder: defaultOrder,
    isLocked: isLocked,
    isMovable: isMovable,
    moveTo: moveTo,
    moveBy: moveBy,
    clampWidth: clampWidth,
    widthOf: widthOf,
    setWidth: setWidth,
    clearWidth: clearWidth,
    isHidden: isHidden,
    setHidden: setHidden,
    toggleHidden: toggleHidden,
    hiddenCount: hiddenCount,
    columnsFor: columnsFor,
    visibleColumns: visibleColumns,
    serialize: serialize,
    deserialize: deserialize,
  };
});
