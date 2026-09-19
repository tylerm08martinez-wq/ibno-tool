'use strict';

// WHICH SECTIONS AND BUCKETS THE SUPERVISOR HAS OPEN (issue #1040).
//
// The IBNO Coder opens as a stack of six collapsible sections. Tyler's ask is
// two sentences long and the two halves pull against each other:
//
//   "I want everything to start collapsed so it's easier to navigate."
//   "Even when I refresh it opens up full."
//
// The first says the DEFAULT is collapsed. The second says a refresh must not
// throw away the one section he had open when he hit F5 mid-sort. So the
// default is collapsed and the only thing that survives is what he OPENED
// HIMSELF — an explicit gesture, never an inferred one.
//
// THE STORE RECORDS OPEN THINGS ONLY, and that asymmetry is the whole design.
// Absence means collapsed, so a store that is empty, corrupt, hand-edited,
// half-written, or from another sort day all land on the SAME safe answer:
// everything closed, which is exactly the state the ticket asks a load for.
// A store recording `false` for closed would have a second way to be wrong
// (a stale `true` for a section that no longer exists reads as "open it"),
// and the failure would be silent.
//
// NO AMBIENT CLOCK, the same rule lib/sort-day.js states at length. The day
// this module compares against is the SORT day of the loaded report, handed in
// by the caller. The sort at 849 starts around 1:30 AM, so a device date
// changes in the middle of one shift's work: a view state stamped with
// `new Date()` would reset itself mid-sort, re-collapsing the section Tyler is
// working out of, which is the precise behaviour the ticket exists to remove.
//
// WHAT THIS MODULE DOES NOT DO: it does not touch a record store. Nothing here
// is evidence about a package — it is which boxes are open on a screen. That is
// why it may be dropped wholesale on any doubt (see restore below), a posture
// that would be indefensible for the area/scanned/filed stores and is the
// obviously right one here.
//
// Dual-loadable with no build step:
// - Browser: window.ViewCollapse
// - Node:    require('./lib/view-collapse')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ViewCollapse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // One key, one JSON blob. Deliberately not one key per section: a supervisor
  // clearing site data, or a future "reset my view" button, has one thing to
  // remove, and a partial write cannot leave three sections agreeing about a
  // day the fourth does not.
  const STORAGE_KEY = 'ibno_view_collapse';

  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

  function str(v) { return String(v == null ? '' : v).trim(); }

  // A well-SHAPED sort day, or ''. Shape only, matching what lib/sort-day.js's
  // parseInboundDate answers for an ISO cell — this module never needs to do
  // date arithmetic, only to ask "is this the same string as last time", so a
  // real calendar check would buy nothing and add a second place for the two
  // to disagree about what a day is.
  function day(v) {
    const s = str(v);
    return ISO_DAY.test(s) ? s : '';
  }

  function empty(forDay) {
    return { day: day(forDay), sections: {}, buckets: {} };
  }

  // keepsStateForDay(storedDay, currentDay) -> should the stored open state be
  // restored, or is this a new sort day that starts clean?
  //
  // Assume-and-flag (#1040): a SAME-DAY re-drop keeps what he had open, because
  // re-dropping the report is how this tool is used all shift long (#610) and
  // slamming every section shut on each drop would be a worse version of the
  // bug being fixed. A NEW sort day starts collapsed, because yesterday's
  // open sections are not a statement about today's work.
  //
  // An UNKNOWN day on either side answers false — start collapsed. That is the
  // deliberate asymmetry against lib/sort-day.js's stores, which keep an
  // entry they cannot date: there, discarding would destroy typed work; here,
  // the worst case is that Tyler clicks a header open again.
  function keepsStateForDay(storedDay, currentDay) {
    const a = day(storedDay);
    const b = day(currentDay);
    return !!a && !!b && a === b;
  }

  // restore(raw, forDay) -> the stored open state IF it belongs to this sort
  // day, otherwise an all-collapsed state stamped with the new day.
  //
  // Accepts a raw string straight out of localStorage or an already-parsed
  // object (ToolHelpers.createStorage JSON-decodes for its callers), so the
  // page can hand it whichever it has.
  //
  // TOTAL rather than throwing: every rejection path answers the all-collapsed
  // state, which is the ticket's default. There is no input to this function
  // that should make the page fail to open.
  function restore(raw, forDay) {
    const fresh = empty(forDay);
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return fresh; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fresh;
    if (!keepsStateForDay(parsed.day, fresh.day)) return fresh;
    return {
      day: fresh.day,
      sections: openMap(parsed.sections),
      buckets: openMap(parsed.buckets),
    };
  }

  // Only `true` survives. A stored `false`, `'false'`, `1`, `null` or an object
  // is dropped rather than coerced: the store's contract above is "open things
  // only", and the one coercion that would matter — a truthy non-true value
  // reading as open — is the one that re-opens a section Tyler closed.
  function openMap(src) {
    const out = {};
    if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
    Object.keys(src).forEach(function (k) {
      const key = str(k);
      if (key && src[k] === true) out[key] = true;
    });
    return out;
  }

  function serialize(state) {
    const s = state && typeof state === 'object' ? state : {};
    return { day: day(s.day), sections: openMap(s.sections), buckets: openMap(s.buckets) };
  }

  // Every writer returns a NEW state (the lib/sort-day.js day-store
  // convention), so a caller can persist the result and still hold what it had.
  function setFlag(state, group, key, open) {
    const next = serialize(state);
    const k = str(key);
    if (!k) return next;
    if (open) next[group][k] = true; else delete next[group][k];
    return next;
  }

  function isFlag(state, group, key) {
    const s = serialize(state);
    return s[group][str(key)] === true;
  }

  function isSectionOpen(state, id) { return isFlag(state, 'sections', id); }
  function setSectionOpen(state, id, open) { return setFlag(state, 'sections', id, open); }
  function isBucketOpen(state, key) { return isFlag(state, 'buckets', key); }
  function setBucketOpen(state, key, open) { return setFlag(state, 'buckets', key, open); }

  function openSections(state) { return Object.keys(serialize(state).sections); }
  function openBuckets(state) { return Object.keys(serialize(state).buckets); }

  // setAllSections(state, ids, open) -> the Collapse all / Expand all writer.
  //
  // Collapsing clears the WHOLE map rather than only the named ids: "Collapse
  // all" means the page is shut, and an id that was open but is not in the
  // list handed in (a section hidden on this report, say) would otherwise
  // spring back open on the next load that shows it.
  function setAllSections(state, ids, open) {
    const next = serialize(state);
    if (!open) { next.sections = {}; return next; }
    (Array.isArray(ids) ? ids : []).forEach(function (id) {
      const k = str(id);
      if (k) next.sections[k] = true;
    });
    return next;
  }

  // withDay(state, forDay) -> the state re-stamped for the sort day now on
  // screen, dropping everything if that is a different day.
  //
  // This is what a LOAD calls. It is `restore` re-expressed over a state
  // already in hand, so the "new day starts clean" decision lives in exactly
  // one place no matter which door the page comes through.
  function withDay(state, forDay) {
    return restore(serialize(state), forDay);
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    empty: empty,
    restore: restore,
    serialize: serialize,
    keepsStateForDay: keepsStateForDay,
    isSectionOpen: isSectionOpen,
    setSectionOpen: setSectionOpen,
    isBucketOpen: isBucketOpen,
    setBucketOpen: setBucketOpen,
    openSections: openSections,
    openBuckets: openBuckets,
    setAllSections: setAllSections,
    withDay: withDay,
  };
});
