'use strict';

// WORK AREA DISAGREEMENTS — the record of what was shown and what was settled
// (issue #796, PRD #790, ADR-0023 item 4, ADR-0022 for `by`).
//
// ─── WHAT THIS IS NOT ───────────────────────────────────────────────────────
//
// It is NOT the detector. lib/day-export.js's `merge` already finds a
// disagreement, already keeps the LOCAL value, and already returns a
// `conflicts` array carrying both answers and the incoming author. #794 built
// that seam deliberately and #795 left it alone; this module does not rebuild
// it, does not re-derive it, and does not change one rule of it.
//
// It is the OTHER half: a small persistent record answering one question the
// merge cannot, because the merge has no memory —
//
//     HAS A HUMAN ALREADY LOOKED AT THIS EXACT DISAGREEMENT?
//
// Without it, re-dropping the Admin's file — which Tyler does whenever an email
// arrives twice, and which the whole design promises is harmless — would put
// the same settled question back on his screen every time, and a surface that
// cries wolf is a surface he stops reading. Rare and visible is the goal;
// common and hidden is the failure, and "common and visible" gets there too.
//
// ─── THE ONE PROPERTY THAT MATTERS: NOTHING HERE UN-RESOLVES ────────────────
//
// This is the one place in the 999 Desk design where a silent merge could put a
// package on the wrong belt, so the record of "a human looked at this" is
// records-tier, not a UI convenience. Three consequences, each pinned by a test
// in tests/area-conflicts.test.js:
//
//   1. `record` NEVER flips a resolved entry back to open. A settled key is
//      counted as suppressed and the store comes back untouched.
//   2. NOTHING EXPIRES. There is no retention window, no prune and no cap, and
//      that is deliberate rather than an omission: a retention window IS a
//      silent un-resolve, just on a timer, and it would fire on exactly the
//      case the record exists for (a file re-sent weeks later). Conflicts are
//      rare by construction — the two work from opposite ends of an ISP-sorted
//      list — so the store is a handful of ~120-byte rows, not a data set.
//   3. Resolved survives serialize/restore, because a reload is a round trip
//      and a resolution that does not survive one was never a resolution.
//
// ─── THE KEY IS THE WHOLE DISAGREEMENT, NOT THE PACKAGE ─────────────────────
//
// Keying by tracking number alone would be the dangerous shortcut: Tyler
// settles "mine BELT 3 / theirs BELT 46", and a later file saying BELT 12 for
// that same package would then arrive pre-settled and never be seen. So the key
// is (package, my answer, their answer). A genuinely NEW disagreement about a
// package is a new key and surfaces; the one already looked at does not.
//
// The three parts are joined through JSON.stringify rather than a delimiter,
// because a typed area is free text (uppercased, 24 chars, nothing else) and
// any delimiter it could contain is a way to forge another record's key.
//
// ─── WHY THE COMPARISON ADDS NO NORMALISATION ───────────────────────────────
//
// Stored areas are ALREADY normalised by lib/actual-area.js — trimmed, inner
// whitespace collapsed, uppercased, length-capped — which is exactly why "belt
// 46" and "BELT 46" are not a disagreement. A second normalisation here would
// be a second answer to a settled question and the two would drift; the test
// asserts the folding holds through ActualArea rather than re-implementing it.
//
// Dual-loadable with no build step:
// - Browser: window.AreaConflicts
// - Node:    require('./lib/area-conflicts')

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AreaConflicts = api;
}(typeof self !== 'undefined' ? self : this, function () {

  function text(raw) {
    return String(raw == null ? '' : raw);
  }

  // ─── THE PREDICATE ────────────────────────────────────────────────────────
  //
  // isConflict(localArea, incomingArea) -> is this a genuine disagreement?
  //
  // Both sides must have SAID something, and they must have said different
  // things. That is the whole of it, and it is the same rule lib/day-export.js
  // reaches by construction: merge only ever compares two entries that both
  // exist, and an entry with no area is not stored at all.
  //
  // The three non-conflicts fall out of it rather than being special-cased:
  //   - the same area typed by both        -> equal strings
  //   - one answered, the other not        -> one side empty
  //   - differing only by formatting       -> equal strings, already normalised
  function isConflict(localArea, incomingArea) {
    const a = text(localArea);
    const b = text(incomingArea);
    if (!a || !b) return false;
    return a !== b;
  }

  // keyOf(c) -> the stable identity of ONE disagreement: which package, my
  // answer, their answer. Not the authors: a disagreement Tyler has settled
  // stays settled if the Admin renames her device.
  function keyOf(c) {
    const v = c || {};
    return JSON.stringify([text(v.label), text(v.local), text(v.incoming)]);
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const label = text(raw.label).trim();
    const local = text(raw.local);
    const incoming = text(raw.incoming);
    if (!label) return null;
    if (!isConflict(local, incoming)) return null;
    return {
      label: label,
      local: local,
      localBy: text(raw.localBy),
      incoming: incoming,
      by: text(raw.by),
      day: text(raw.day),
      resolved: !!raw.resolved,
    };
  }

  // restore(raw) -> the live store, from a JSON string, a plain object, or
  // nothing at all. Tolerant in the same shape every other store here is: an
  // unreadable or hand-edited entry is DROPPED rather than thrown over, because
  // this store is read at boot and a throw there takes the whole tool down.
  //
  // Note which direction the tolerance runs on `resolved`: any truthy value
  // reads as settled. Over-resolving hides one row a human already chose to
  // look at; UN-resolving is the failure this module exists to prevent.
  function restore(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return {}; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    Object.keys(parsed).forEach(function (key) {
      const entry = normalizeEntry(parsed[key]);
      if (entry) out[key] = entry;
    });
    return out;
  }

  // serialize(store) -> the plain object to persist. Defined through restore
  // for the same reason lib/actual-area.js defines its own that way: one gate
  // for entry shape, so a field cannot be preserved on one path and dropped on
  // the other.
  function serialize(store) {
    return restore(store);
  }

  // record(store, conflicts, opts) -> { store, opened, held, suppressed }
  //
  //   conflicts   merge's `conflicts` array, each entry optionally enriched by
  //               the caller with `localBy` — merge reports the INCOMING author
  //               only, because the local one is already in the caller's hand
  //               (and #795's rule that the envelope's `by` is a display
  //               fallback for an entry without its own is preserved: merge has
  //               already applied it by the time this sees the entry).
  //   opts.day    the sort day the import happened on, carried for display.
  //
  //   opened      keys shown for the FIRST time. This is the number that
  //               decides whether the surface appears at all.
  //   held        keys already open and still open — not new, not hidden.
  //   suppressed  keys a human already settled. Counted, never re-opened.
  //
  // Returns a NEW store; the one handed in is never mutated, matching every
  // other store module here.
  function record(store, conflicts, opts) {
    const next = restore(store);
    const day = text((opts || {}).day);
    const out = { store: next, opened: [], held: 0, suppressed: 0 };
    (Array.isArray(conflicts) ? conflicts : []).forEach(function (c) {
      const entry = normalizeEntry({
        label: (c || {}).label,
        local: (c || {}).local,
        localBy: (c || {}).localBy,
        incoming: (c || {}).incoming,
        by: (c || {}).by,
        day: day,
        resolved: false,
      });
      // A non-disagreement handed in by a future caller that stopped filtering
      // is refused here rather than recorded. The record is of disagreements.
      if (!entry) return;
      const key = keyOf(entry);
      const held = next[key];
      if (held) {
        if (held.resolved) out.suppressed++;
        else out.held++;
        return;
      }
      next[key] = entry;
      out.opened.push(key);
    });
    return out;
  }

  // open(store) -> the disagreements still waiting on a human, each carrying
  // its own key so a click can name exactly what it settled. Sorted by package
  // then key, so the surface reads the same way twice running.
  function open(store) {
    const s = restore(store);
    return Object.keys(s)
      .filter(function (k) { return !s[k].resolved; })
      .sort(function (a, b) {
        const la = s[a].label, lb = s[b].label;
        if (la !== lb) return la < lb ? -1 : 1;
        return a < b ? -1 : (a > b ? 1 : 0);
      })
      .map(function (k) { return Object.assign({ key: k }, s[k]); });
  }

  function openCount(store) {
    return open(store).length;
  }

  function isResolved(store, key) {
    const s = restore(store);
    return !!(s[key] && s[key].resolved);
  }

  // resolve(store, key) -> the store with that one disagreement settled.
  //
  // A key with no record INVENTS NOTHING. A stale click — a second browser tab,
  // a re-render mid-click — must not be able to write a settled record for a
  // disagreement this device never showed, because that record would then
  // suppress the real one when it does arrive.
  function resolve(store, key) {
    const next = restore(store);
    if (!next[key]) return next;
    next[key] = Object.assign({}, next[key], { resolved: true });
    return next;
  }

  return {
    isConflict: isConflict,
    keyOf: keyOf,
    restore: restore,
    serialize: serialize,
    record: record,
    open: open,
    openCount: openCount,
    isResolved: isResolved,
    resolve: resolve,
  };
}));
