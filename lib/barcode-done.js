'use strict';

// Which printed barcode cards have actually been worked (Tyler, 2026-08-14:
// "check off on the new page with the bar codes on it and mark which ones
// I've done").
//
// The barcode sheet is the last surface before a package is physically moved,
// and it is worked a card at a time over several minutes. Before this there
// was nothing anywhere recording which of them were finished — Tyler either
// held it in his head or ticked the paper, and a re-print or a phone refresh
// lost it. This is the store behind the tick.
//
// SHAPE: a plain object, { [trackingNumber]: true }. Only DONE labels are
// present — an absent key means not done, so the store never grows entries for
// the far larger population of untouched rows and needs no migration when the
// lane's contents change.
//
// DELIBERATELY NOT part of lib/actual-area.js, though both are per-label state
// keyed off the same tracking numbers. actual-area records a DECISION about
// the package (where it goes) that feeds coding and printing; this records
// PROGRESS through a physical task. Merging them would put a
// records-tier value and a scratch checklist behind one key, where clearing
// the checklist could take a real routing decision with it.
//
// Dual-loadable with no build step:
// - Browser: window.BarcodeDone
// - Node:    require('./lib/barcode-done')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.BarcodeDone = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function str(v) { return String(v == null ? '' : v).trim(); }

  function normalize(store) {
    return (store && typeof store === 'object' && !Array.isArray(store)) ? store : {};
  }

  // isDone(store, label) -> boolean. Absent key = not done.
  function isDone(store, label) {
    const s = normalize(store);
    const l = str(label);
    if (!l) return false;
    return s[l] === true;
  }

  // setDone(store, label, done) -> a NEW store object. Never mutates the one
  // passed in, so a caller can persist the result and keep the previous value
  // for comparison. Setting false DELETES the key rather than storing false,
  // which keeps "only done labels are present" true and stops the object
  // growing a tombstone per untick.
  function setDone(store, label, done) {
    const s = normalize(store);
    const l = str(label);
    if (!l) return Object.assign({}, s);
    const out = Object.assign({}, s);
    if (done) out[l] = true; else delete out[l];
    return out;
  }

  function toggle(store, label) {
    return setDone(store, label, !isDone(store, label));
  }

  // countDone(store, labels) -> how many of THESE labels are done. Scoped to a
  // caller-supplied list rather than counting the whole store: the store
  // outlives any one sheet or report, so a bare Object.keys().length would
  // report yesterday's ticks against today's lane. De-duplicates, because a
  // tracking number can appear more than once in a report.
  function countDone(store, labels) {
    const s = normalize(store);
    const seen = new Set();
    (Array.isArray(labels) ? labels : []).forEach(function (l) {
      const k = str(l);
      if (k && s[k] === true) seen.add(k);
    });
    return seen.size;
  }

  // prune(store, labels) -> the store with only the given labels kept. Used
  // when a fresh report is dropped, so the tick list cannot accumulate every
  // tracking number Tyler has ever worked. Passing an empty list clears it.
  function prune(store, labels) {
    const s = normalize(store);
    const keep = new Set((Array.isArray(labels) ? labels : []).map(str).filter(Boolean));
    const out = {};
    Object.keys(s).forEach(function (k) {
      if (keep.has(k) && s[k] === true) out[k] = true;
    });
    return out;
  }

  return {
    isDone: isDone,
    setDone: setDone,
    toggle: toggle,
    countDone: countDone,
    prune: prune,
  };
});
