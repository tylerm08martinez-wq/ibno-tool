'use strict';

// IBNO Coder merged-section view model (issue #696, spec #690, born-in-lib
// mandate 1 of #614).
//
// Dual-loadable with no build step:
// - Browser: window.IbnoMergedView
// - Node: require('./lib/ibno-merged-view')
//
// This module is the whole answer to "what is on screen and what does each chip
// say", for the two merged sections that replace the service-split ones:
//
//   Needs Manual Review ... the working list, sliced by chips
//   Ready to Enter ....... the auto-coded list, sliced by the same chip model
//   Other work areas ..... the counted remainder, quiet at the page bottom
//
// It is BORN here rather than written inline and extracted later (#614 list B),
// because the old per-section filter functions died with the old sections and
// every rule below is a rule the spec froze.
//
// ─── WHAT IS INJECTED, AND WHY ──────────────────────────────────────────────
//
// Nothing in here reads a global. The page hands in a context of small readers
// so the rules stay pure and Node-testable:
//
//   isExpress(item) ............ the service split, IbnoRules.isExpress
//   bucketOf(item) ............. the need-based bucket, ReviewPlan.bucketOf
//   isWorkAreaFlagged(ibWork) .. Tyler's configured areas, IbnoRules
//   clusterKey(address) ........ building-level stop key, ActualArea
//   streetOf(item) ............. number and name only, the FRO paste text
//   ispOf(item) ................ service provider for the zip, or ''
//   stateOf(item) .............. the row's state, or ''
//   isSetAside(item) ........... parked or filed 503, so counts exclude it
//
// Every reader is optional and degrades to a safe default, EXCEPT that a
// missing reader can only ever make a chip count smaller, never route a row
// into the wrong section: the population rule below leans on isWorkAreaFlagged
// alone among them, and a row with no flagged answer still reaches the working
// list through its blank area or its QA category.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IbnoMergedView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ─── SECTION AND AXIS VOCABULARY ──────────────────────────────────────────
  //
  // Two merged sections, each owning its OWN filter state. A Ground chip on the
  // work list must never silently filter Ready to Enter (round 18 of the
  // prototype found that exact defect).
  const SECTIONS = ['manual', 'ready'];

  // The service axis. Two chips, and they are the ONLY place service names a
  // slice: buckets below are keyed on what a row NEEDS, never on its service
  // (#616 cured that disease at lane level, and the merge must not reintroduce
  // it one level down).
  const LANE_KEYS = ['express', 'ground'];

  // The need axis, in render order. Keys only. The HEADINGS stay in the tool,
  // because they are screen vocabulary and this module must not need to know
  // what the screen says (the same split lib/ibno-review-plan.js already makes).
  const BUCKET_KEYS = ['area', 'zip', 'other'];

  // The three standalone chips. Each is a flag rather than a value list,
  // because each is a single predicate over the row rather than a facet.
  const FLAG_KEYS = ['oob', 'multi', 'noaddr'];

  // ─── WORK AREA AND CATEGORY VOCABULARY ────────────────────────────────────

  // The work areas that carry no usable answer: blank, or the 999 dummy that
  // the report writes when it cannot resolve one. Both mean "a person has to
  // decide this", which is exactly what the working list is for.
  const NO_AREA_VALUES = ['', '999'];

  // The category a row carries when the ONLY reason it needs review is that the
  // report assigned it a work area. Rows in this category on somebody else's
  // area are not Tyler's to work, and are what Other work areas exists to hold.
  const AREA_ASSIGNED_CATEGORY = 'On File - WA Assigned';

  // A row whose category names a SERVICE rather than a problem. On a 2.0
  // station these are the bulk of the express review population, and routing
  // them by the express label alone is what buried the eight rows Tyler
  // actually works under 281 he does not (ADR 0021).
  const SERVICE_CATEGORY_RE = /^express\b/i;

  function str(v) { return String(v == null ? '' : v).trim(); }

  function areaOf(item) { return str(item && item.ibWork); }

  function hasNoUsableArea(item) {
    return NO_AREA_VALUES.indexOf(areaOf(item)) !== -1;
  }

  // isQaCategory(category) -> does this row need review for a REASON, rather
  // than for its work area or its service?
  //
  // Stated as "anything that is not the two known non-reasons" rather than as a
  // list of QA categories, deliberately. The QA category list grows (#616 added
  // two, and the report's PLA_LOOKUP vocabulary is not ours), and a
  // list-of-known-problems rule fails CLOSED on a category nobody has seen yet:
  // the new problem quietly lands in Other work areas at the page bottom. This
  // rule fails OPEN, into the list Tyler is looking at.
  function isQaCategory(category) {
    const c = str(category);
    if (!c) return false;
    if (c === AREA_ASSIGNED_CATEGORY) return false;
    if (SERVICE_CATEGORY_RE.test(c)) return false;
    return true;
  }

  // ─── THE POPULATION RULE ──────────────────────────────────────────────────
  //
  // The working list holds only flagged areas, QA categories, and blank or 999
  // areas. Everything else goes behind the quiet counted Other work areas line
  // (spec #690, user story 19).
  //
  // Note what this does to the #616 case, which is the whole reason that gate
  // exists: an EXPRESS QA-Intercept on an unflagged work area passes on its
  // CATEGORY, so it lands in Needs Manual Review rather than in the demoted
  // remainder. The demotion and the #616 fix are the same rule read twice.
  function inWorkingPopulation(item, ctx) {
    const c = ctx || {};
    const flagged = typeof c.isWorkAreaFlagged === 'function'
      ? !!c.isWorkAreaFlagged(areaOf(item))
      : false;
    if (flagged) return true;
    if (hasNoUsableArea(item)) return true;
    return isQaCategory(item && item.category);
  }

  // partition(items, ctx) -> { working, other }, in the input's own order.
  // ONE walk, so a row can never be counted in both or dropped by neither.
  function partition(items, ctx) {
    const working = [];
    const other = [];
    (Array.isArray(items) ? items : []).forEach(function (it) {
      (inWorkingPopulation(it, ctx) ? working : other).push(it);
    });
    return { working: working, other: other };
  }

  // ─── COUNTED POPULATION ───────────────────────────────────────────────────
  //
  // Counts are ALWAYS computed over the working list with parked and 503 rows
  // excluded (#696). A row Tyler set aside cannot appear in the list, so a chip
  // that counts it promises rows the list will not produce. That shipped once
  // as "Multi-stop says 4, shows 2" (prototype round 26).
  function countedRows(items, ctx) {
    const c = ctx || {};
    const setAside = typeof c.isSetAside === 'function' ? c.isSetAside : function () { return false; };
    return (Array.isArray(items) ? items : []).filter(function (it) { return !setAside(it); });
  }

  function laneKeyOf(item, ctx) {
    const c = ctx || {};
    const express = typeof c.isExpress === 'function' ? !!c.isExpress(item) : !!(item && item.express);
    return express ? 'express' : 'ground';
  }

  function bucketKeyOf(item, ctx) {
    const c = ctx || {};
    const b = typeof c.bucketOf === 'function' ? str(c.bucketOf(item)) : '';
    return BUCKET_KEYS.indexOf(b) !== -1 ? b : 'other';
  }

  // ─── SAME-STOP CLUSTERS ───────────────────────────────────────────────────
  //
  // Cluster sizes are recomputed PER RENDER over the counted rows, never cached
  // across a data change: a pair with one member parked is no longer a pair,
  // and a stale size is the Multi-stop chip lying about what it will show.
  function clusterKeyOf(item, ctx) {
    const c = ctx || {};
    if (typeof c.clusterKey !== 'function') return '';
    return str(c.clusterKey((item && item.address) || ''));
  }

  function clusterIndex(rows, ctx) {
    const sizes = {};
    (Array.isArray(rows) ? rows : []).forEach(function (it) {
      const k = clusterKeyOf(it, ctx);
      if (!k) return;
      sizes[k] = (sizes[k] || 0) + 1;
    });
    return sizes;
  }

  function clusterSizeOf(item, index, ctx) {
    const k = clusterKeyOf(item, ctx);
    if (!k) return 1;
    return (index && index[k]) || 1;
  }

  // ─── THE THREE FLAG PREDICATES ────────────────────────────────────────────

  // Out of area: the zip is not in the CSP breakdown (no provider), or the row
  // is not an Arizona address. Both are easy knock-outs rather than lookups.
  function isOutOfArea(item, ctx) {
    const c = ctx || {};
    const isp = typeof c.ispOf === 'function' ? str(c.ispOf(item)) : str(item && item.isp);
    if (!isp) return true;
    const state = typeof c.stateOf === 'function' ? str(c.stateOf(item)) : str(item && item.state);
    return !!state && state.toUpperCase() !== 'AZ';
  }

  // A row has an address only when its street carries a NUMBER and a NAME. A
  // blank or zip-only street is the FTrack-later population, and must never
  // read as an address just because it is a non-empty string.
  function hasAddress(item, ctx) {
    const c = ctx || {};
    const street = typeof c.streetOf === 'function' ? str(c.streetOf(item)) : '';
    return /^\d+\s+\S/.test(street);
  }

  // ─── FILTER STATE ─────────────────────────────────────────────────────────
  //
  // TRANSIENT by design (#613 round 11, Tyler reversed the sticky-filters
  // decision and it stays reversed): the page resets to this on every load and
  // every fresh pull. `lastSlice` is the All chip's memory and lives only for
  // the session.
  function defaultFilter() {
    return { lanes: [], buckets: [], oob: false, multi: false, noaddr: false, lastSlice: null };
  }

  function defaultFilters() {
    const out = {};
    SECTIONS.forEach(function (s) { out[s] = defaultFilter(); });
    return out;
  }

  function filterActive(filter) {
    const f = filter || {};
    return !!((f.lanes && f.lanes.length) || (f.buckets && f.buckets.length) || f.oob || f.multi || f.noaddr);
  }

  function sliceOf(filter) {
    const f = filter || {};
    return {
      lanes: (f.lanes || []).slice(),
      buckets: (f.buckets || []).slice(),
      oob: !!f.oob,
      multi: !!f.multi,
      noaddr: !!f.noaddr,
    };
  }

  function applySlice(filter, slice) {
    const f = filter || defaultFilter();
    const s = slice || {};
    f.lanes = (s.lanes || []).slice();
    f.buckets = (s.buckets || []).slice();
    f.oob = !!s.oob;
    f.multi = !!s.multi;
    f.noaddr = !!s.noaddr;
    return f;
  }

  function toggleIn(list, value) {
    const out = (list || []).slice();
    const i = out.indexOf(value);
    if (i >= 0) out.splice(i, 1); else out.push(value);
    return out;
  }

  // Any deliberate chip click clears lastSlice: the All chip's memory is "the
  // slice you were on when you pressed A", and a slice built after pressing A
  // is a new slice, not a return to the old one.
  function toggleLane(filter, laneKey) {
    const f = filter || defaultFilter();
    f.lanes = toggleIn(f.lanes, laneKey);
    f.lastSlice = null;
    return f;
  }

  function toggleBucket(filter, bucketKey) {
    const f = filter || defaultFilter();
    f.buckets = toggleIn(f.buckets, bucketKey);
    f.lastSlice = null;
    return f;
  }

  function toggleFlag(filter, flagKey) {
    const f = filter || defaultFilter();
    if (FLAG_KEYS.indexOf(flagKey) === -1) return f;
    f[flagKey] = !f[flagKey];
    f.lastSlice = null;
    return f;
  }

  // toggleAll(filter) -> the All chip, shortcut `A`. One key flips between
  // EVERYTHING and the last slice, within a session:
  //
  //   a filter is active .... remember it, then clear -> showing everything
  //   nothing active, memory . restore it -> back to the slice
  //   nothing active, no mem  no-op, and it says so
  //
  // Returns { filter, action } so the caller can toast the right words without
  // re-deriving which branch ran.
  function toggleAll(filter) {
    const f = filter || defaultFilter();
    if (filterActive(f)) {
      f.lastSlice = sliceOf(f);
      applySlice(f, defaultFilter());
      return { filter: f, action: 'showing-all' };
    }
    if (f.lastSlice) {
      applySlice(f, f.lastSlice);
      return { filter: f, action: 'slice-restored' };
    }
    return { filter: f, action: 'noop' };
  }

  // ─── THE ONE ROW PREDICATE ────────────────────────────────────────────────
  //
  // Every axis is AND across axes and OR within an axis: picking Express and
  // Ground shows both, picking Express and the zip bucket shows express zip
  // rows. `index` is the cluster index for the SAME population the counts were
  // taken over, so the Multi-stop chip and the rows it produces agree.
  function passes(item, filter, ctx, index) {
    const f = filter || {};
    if (f.lanes && f.lanes.length && f.lanes.indexOf(laneKeyOf(item, ctx)) === -1) return false;
    if (f.buckets && f.buckets.length && f.buckets.indexOf(bucketKeyOf(item, ctx)) === -1) return false;
    if (f.oob && !isOutOfArea(item, ctx)) return false;
    if (f.multi && clusterSizeOf(item, index, ctx) < 2) return false;
    if (f.noaddr && !hasAddress(item, ctx)) return false;
    return true;
  }

  // ─── CHIP COUNTS ──────────────────────────────────────────────────────────
  //
  // Every chip carries a LIVE count, over the counted population rather than
  // over what is currently visible: the point of a count on a chip you have not
  // picked is to say what you are not looking at.
  function chipCounts(items, ctx) {
    const rows = countedRows(items, ctx);
    const index = clusterIndex(rows, ctx);
    const lanes = {};
    LANE_KEYS.forEach(function (k) { lanes[k] = 0; });
    const buckets = {};
    BUCKET_KEYS.forEach(function (k) { buckets[k] = 0; });
    let oob = 0, multi = 0, noaddr = 0;
    rows.forEach(function (it) {
      lanes[laneKeyOf(it, ctx)]++;
      buckets[bucketKeyOf(it, ctx)]++;
      if (isOutOfArea(it, ctx)) oob++;
      if (clusterSizeOf(it, index, ctx) > 1) multi++;
      if (!hasAddress(it, ctx)) noaddr++;
    });
    return {
      all: rows.length,
      lanes: lanes,
      buckets: buckets,
      oob: oob,
      multi: multi,
      noaddr: noaddr,
      clusterIndex: index,
    };
  }

  // view(items, filter, ctx) -> everything one section's render needs, from one
  // walk of one population: the counted total, the chip counts, the cluster
  // index those counts were taken over, the rows that pass, and the note.
  function view(items, filter, ctx) {
    const counts = chipCounts(items, ctx);
    const rows = countedRows(items, ctx);
    const visible = rows.filter(function (it) { return passes(it, filter, ctx, counts.clusterIndex); });
    return {
      counts: counts,
      total: rows.length,
      rows: visible,
      shown: visible.length,
      active: filterActive(filter),
      note: filterActive(filter) ? showingText(visible.length, rows.length) : '',
    };
  }

  // "showing X of Y" whenever a filter is active. Filtered-out rows are always
  // announced before Tyler can fail to find them (spec #690, user story 6).
  function showingText(shown, total) {
    return 'showing ' + shown + ' of ' + total;
  }

  return {
    SECTIONS: SECTIONS,
    LANE_KEYS: LANE_KEYS,
    BUCKET_KEYS: BUCKET_KEYS,
    FLAG_KEYS: FLAG_KEYS,
    NO_AREA_VALUES: NO_AREA_VALUES,
    AREA_ASSIGNED_CATEGORY: AREA_ASSIGNED_CATEGORY,
    isQaCategory: isQaCategory,
    hasNoUsableArea: hasNoUsableArea,
    inWorkingPopulation: inWorkingPopulation,
    partition: partition,
    countedRows: countedRows,
    laneKeyOf: laneKeyOf,
    bucketKeyOf: bucketKeyOf,
    clusterKeyOf: clusterKeyOf,
    clusterIndex: clusterIndex,
    clusterSizeOf: clusterSizeOf,
    isOutOfArea: isOutOfArea,
    hasAddress: hasAddress,
    defaultFilter: defaultFilter,
    defaultFilters: defaultFilters,
    filterActive: filterActive,
    sliceOf: sliceOf,
    toggleLane: toggleLane,
    toggleBucket: toggleBucket,
    toggleFlag: toggleFlag,
    toggleAll: toggleAll,
    passes: passes,
    chipCounts: chipCounts,
    view: view,
    showingText: showingText,
  };
});
