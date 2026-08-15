'use strict';

// IBNO Coder sort model — the key functions and the comparator behind every
// sortable table in ibno-coder.html.
//
// Dual-loadable with no build step:
// - Browser: window.IbnoSort
// - Node: require('./lib/ibno-sort')
//
// Extracted from ibno-coder.html by issue #692, behavior-preserving. It lived
// inline where no unit test could reach it, while the ordering it produces is
// FROZEN behavior (#611): the redesign in spec #690 rebuilds the DOM around
// this comparator and must not move a single row.
//
// ─── WHAT IS INJECTED, AND WHY ──────────────────────────────────────────────
//
// The inline version read four page globals: `sortState`, `defaultSorts`, and
// the field accessors zipOf / ispOf / streetOf / actualAreaOf (each of which
// reaches into a lib, the loaded ZIP list, or the typed-area store). Those stay
// in the page, where their state lives; this module takes them as a context so
// the comparator itself is pure.
//
// `sortState` may be an object OR a getter function. The tool REASSIGNS its
// sortState wholesale on reset (`sortState = JSON.parse(...)`), so a comparator
// that captured the object once would sort by a state the page no longer has.
// The tool passes a getter for that reason.
//
// ─── THE CLUSTER-RUN GUARANTEE ──────────────────────────────────────────────
//
// The Service Provider, Street and Goes To sorts all tiebreak on the
// BUILDING-level address key, so every package for one stop lands in a
// contiguous run instead of being scattered by tracking number. That run is
// what makes the list dock-flexable: the destination is decided once for the
// stop rather than re-decided per package. The cluster key drops unit numbers
// (lib/actual-area.js clusterKey), so APT 2 and APT 5 sit together here —
// sorting groups a building, while PROPAGATION of a typed area still refuses to
// cross a unit. Anything reordering these keys breaks dock flex.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IbnoSort = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ─── DATE AND CLOCK KEYS ──────────────────────────────────────────────────
  //
  // The tool accepts TWO Inbound and Van Scans exports whose INBOUND_DATE
  // differs: one ISO (2026-08-14), one US (8/14/2026, sometimes 8/14/26). Both
  // collapse onto the same comparable integer, or a sort by time would split
  // one day's report into two blocks. Anything unreadable is 0, which sorts
  // first ascending rather than throwing.
  function parseDateKey(raw) {
    const s = String(raw || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      let y = Number(m[3]);
      if (y < 100) y += 2000;
      return y * 10000 + Number(m[1]) * 100 + Number(m[2]);
    }
    return 0;
  }

  function parseClockKey(raw) {
    const s = String(raw || '').trim().toUpperCase();
    const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/);
    if (!m) return 0;
    let h = Number(m[1]);
    const min = Number(m[2]);
    const sec = Number(m[3] || 0);
    if (m[4] === 'PM' && h < 12) h += 12;
    if (m[4] === 'AM' && h === 12) h = 0;
    return h * 3600 + min * 60 + sec;
  }

  function itemTimeKey(item) {
    return parseDateKey(item && item.inboundDate) * 100000 + parseClockKey(item && item.ibScanTime);
  }

  function latestRepeatDateKey(entry) {
    return Math.max.apply(null, ((entry && entry.inboundDates) || []).map(parseDateKey).concat([0]));
  }

  // ─── FIELD KEYS ───────────────────────────────────────────────────────────

  function addressKey(item) {
    return String((item && item.address) || '').trim().toLowerCase();
  }

  function firmKey(item) {
    return String((item && item.firm) || '').trim().toLowerCase();
  }

  // clusterKeyOf(item, clusterKey) -> the building-level address key two
  // packages share when they are the same stop. Canonicalized through the
  // injected clusterKey (lib/actual-area.js, itself on lib/address-normalize.js),
  // so "1234 N Main St" and "1234 NORTH MAIN STREET APT 5" cluster together
  // despite having no string in common. Blank for a row with no usable address,
  // which cmpBlankLast then sorts to the end rather than to the front.
  function clusterKeyOf(item, clusterKey) {
    if (typeof clusterKey !== 'function') return '';
    return clusterKey((item && item.address) || '');
  }

  function cmpText(a, b) {
    return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
  }

  // Text compare that always ranks a blank after a non-blank, so "no ZIP on this
  // row" and "no ISP for this ZIP" never sort as if they were an empty string.
  function cmpBlankLast(a, b) {
    const x = String(a || ''), y = String(b || '');
    if (!x && !y) return 0;
    if (!x) return 1;
    if (!y) return -1;
    return cmpText(x, y);
  }

  // waSortKey(item) -> numeric work-area for sorting; blank/non-numeric sort last.
  function waSortKey(item) {
    const n = parseInt(String((item && item.ibWork) || '').trim(), 10);
    return isNaN(n) ? Number.POSITIVE_INFINITY : n;
  }

  // ─── THE COMPARATOR ───────────────────────────────────────────────────────

  const BLANK = function () { return ''; };

  // The sort state a table falls back to when it is named in neither the page's
  // sortState nor its defaultSorts (#707). resolveState used to return undefined
  // there and compare then read `.key` off it and threw. No sort key matches, so
  // every comparison drops through to the label tiebreak: an unknown table comes
  // out label-ascending, which is exactly what an unrecognized sort KEY already
  // does. Ascending on purpose, so a table the page has not registered yet can
  // never come out silently reversed. Frozen so no caller can mutate it.
  const FALLBACK_SORT = Object.freeze({ key: '', dir: 'asc' });

  function resolveState(ctx, table) {
    const raw = ctx && ctx.sortState;
    const state = typeof raw === 'function' ? raw() : raw;
    const st = (state && state[table]) || (ctx && ctx.defaultSorts && ctx.defaultSorts[table]);
    return st || FALLBACK_SORT;
  }

  // resolveAccessors(ctx) -> the five injected field readers, each already
  // checked once, plus the cluster closure built once. compare() used to run
  // these five typeof checks and allocate a fresh cluster closure on EVERY
  // comparison, which an n log n sort pays for on every row pair; createComparator
  // now does this once at construction. A missing accessor still degrades to a
  // blank reader here, because compare() takes a raw context; createComparator
  // refuses one outright before it ever gets this far.
  function resolveAccessors(ctx) {
    const c = ctx || {};
    const clusterKey = c.clusterKey;
    return {
      zipOf: typeof c.zipOf === 'function' ? c.zipOf : BLANK,
      ispOf: typeof c.ispOf === 'function' ? c.ispOf : BLANK,
      streetOf: typeof c.streetOf === 'function' ? c.streetOf : BLANK,
      actualAreaOf: typeof c.actualAreaOf === 'function' ? c.actualAreaOf : BLANK,
      cluster: function (item) { return clusterKeyOf(item, clusterKey); },
    };
  }

  // compare(a, b, table, ctx) -> the inline compareBySort, with the page's sort
  // state and field accessors handed in rather than read off the window. It
  // resolves the accessors per call; a hot sort should go through
  // createComparator, which resolves them once.
  function compare(a, b, table, ctx) {
    return compareWith(a, b, table, ctx || {}, resolveAccessors(ctx));
  }

  // compareWith(a, b, table, ctx, fields) -> the comparison itself, with the
  // accessors already resolved. `ctx` is still read per call, because the sort
  // state behind it is re-read every comparison on purpose (the page reassigns
  // sortState wholesale on reset).
  function compareWith(a, b, table, ctx, fields) {
    const st = resolveState(ctx, table);
    const zipOf = fields.zipOf;
    const ispOf = fields.ispOf;
    const streetOf = fields.streetOf;
    const actualAreaOf = fields.actualAreaOf;
    const cluster = fields.cluster;
    let n = 0;
    if (st.key === 'report') n = ((a && a._ord) || 0) - ((b && b._ord) || 0);
    else if (st.key === 'resolve') n = ((a && a._resolvedOrd) || 0) - ((b && b._resolvedOrd) || 0);
    else if (st.key === 'time') n = itemTimeKey(a) - itemTimeKey(b);
    else if (st.key === 'address') n = cmpText(addressKey(a), addressKey(b)) || cmpText(firmKey(a), firmKey(b)) || cmpText(a && a.label, b && b.label);
    else if (st.key === 'category') n = cmpText(a && a.category, b && b.category) || cmpText(a && a.label, b && b.label);
    else if (st.key === 'reason') n = cmpText(a && a.reason, b && b.reason) || cmpText(a && a.label, b && b.label);
    else if (st.key === 'wa') n = (waSortKey(a) - waSortKey(b)) || cmpText(String((a && a.ibWork) || ''), String((b && b.ibWork) || '')) || cmpText(a && a.label, b && b.label);
    // ZIP sorts as text, not as a number: it is an identifier, and a leading zero
    // is part of it. Rows with no ZIP sort after every real ZIP ascending (and so
    // lead descending) instead of sorting as if they were '00000'.
    else if (st.key === 'zip') n = cmpBlankLast(zipOf(a), zipOf(b)) || cmpText(a && a.label, b && b.label);
    // Service provider groups the list by who runs the zip; unknown zips sort last.
    //
    // Within one provider the tiebreak is the BUILDING-level address key, so every
    // package for one address lands in a contiguous run instead of being scattered
    // by tracking number. That is what makes the list dock-flexable: decide the
    // destination once for the run rather than re-deciding it per package. The
    // cluster key drops unit numbers (lib/actual-area.js), so APT 2 and APT 5 sit
    // together here — sorting groups a building, while PROPAGATION of a typed area
    // still refuses to cross a unit. ZIP remains the tiebreak below the address so
    // ordering is stable for rows with no usable address.
    else if (st.key === 'isp') n = cmpBlankLast(ispOf(a), ispOf(b)) || cmpBlankLast(cluster(a), cluster(b)) || cmpBlankLast(zipOf(a), zipOf(b)) || cmpText(a && a.label, b && b.label);
    // Street: the copy-paste text itself. Rows with no street (an empty
    // LABEL_ADDRESS1 composes down to a bare ZIP) sort last ascending, so the
    // packages you can actually paste are the head of the list. The building-level
    // key is the tiebreak so one address stays a contiguous run, same as ISP.
    else if (st.key === 'street') n = cmpBlankLast(streetOf(a), streetOf(b)) || cmpBlankLast(cluster(a), cluster(b)) || cmpText(a && a.label, b && b.label);
    // Goes To: the typed actual work area. Blank rows sort last ascending, so the
    // not-yet-decided packages are the tail of the list, not the head.
    else if (st.key === 'goesto') n = cmpBlankLast(actualAreaOf(a), actualAreaOf(b)) || cmpBlankLast(cluster(a), cluster(b)) || cmpText(a && a.label, b && b.label);
    else if (st.key === 'code') n = cmpText(String((a && a.code) || ''), String((b && b.code) || '')) || cmpText(a && a.label, b && b.label);
    else if (st.key === 'count') n = ((a && a.timesSeen) || 0) - ((b && b.timesSeen) || 0);
    else if (st.key === 'date') n = latestRepeatDateKey(a || {}) - latestRepeatDateKey(b || {});
    if (n === 0) n = cmpText(a && a.label, b && b.label);
    return st.dir === 'desc' ? -n : n;
  }

  // createComparator(ctx) -> (a, b, table) => number, bound to one context.
  // This is the shape the page uses, so every `.sort()` call site reads the same
  // as it did inline.
  //
  // It REFUSES an incomplete context, loudly, at construction time. Every
  // accessor below feeds a tiebreak, and a missing one degrades in silence: drop
  // `clusterKey` and the isp/street/goesto sorts quietly lose the building-level
  // tiebreak, scattering the packages for one stop across the list. That is the
  // frozen dock-flex behavior (#611) this module exists to protect, and a green
  // suite would not notice. #690 rebuilds the DOM around this call, so a renamed
  // or dropped ctx key has to be a crash on load, not a worse sort at 1:30 AM.
  const REQUIRED = ['zipOf', 'ispOf', 'streetOf', 'actualAreaOf', 'clusterKey'];

  // The accessors are resolved ONCE here, so the returned comparator carries the
  // five field readers it was built with rather than re-reading them off the
  // context on every comparison. The sort STATE is still read per comparison,
  // through the getter, because the page reassigns it on reset. A page that
  // swaps an accessor after construction has to rebuild the comparator; nothing
  // in the tool does, and the alternative is paying the check on every row pair.
  function createComparator(ctx) {
    const missing = REQUIRED.filter((k) => typeof (ctx && ctx[k]) !== 'function');
    if (missing.length) throw new Error('IbnoSort.createComparator: missing required accessor(s): ' + missing.join(', '));
    const fields = resolveAccessors(ctx);
    return function (a, b, table) { return compareWith(a, b, table, ctx, fields); };
  }

  return {
    parseDateKey: parseDateKey,
    parseClockKey: parseClockKey,
    itemTimeKey: itemTimeKey,
    latestRepeatDateKey: latestRepeatDateKey,
    addressKey: addressKey,
    firmKey: firmKey,
    clusterKeyOf: clusterKeyOf,
    cmpText: cmpText,
    cmpBlankLast: cmpBlankLast,
    waSortKey: waSortKey,
    compare: compare,
    createComparator: createComparator,
  };
});
