'use strict';

// RESOLVED BARCODES THAT SURVIVE A RE-DROP (issue #741, spec #690, ADR 0021/0022).
//
// Tyler re-drops the Post Sort report MANY times a shift — it is how he gets
// fresh inbound scans, so it is the normal motion, not an edge case. Until this
// module, every barcode joined by every Track IDs to Full Barcode batch earlier
// in the shift was thrown away by that drop: `ingestPostSortRecords` rebuilds
// the lane from the incoming records with buildPostSortLane, and the barcodes
// only ever lived on the in-memory items. So he re-ran the lookup for packages
// he had already looked up, over and over, all shift. For the 503 bad
// addresses in particular ("I have to do the barcode for all of those ones that
// are work area assigned, so they actually go where they need to go") every
// lost barcode is work redone.
//
// This is NOT the #635 bug (batch 2 eating batch 1 WITHIN one loaded report).
// That fix holds and is untouched. This is the same loss one level up, across a
// report reload, and the answer is a store rather than a parse-scoping change.
//
// SHAPE: `{ [trackingNumber]: entry }`, exactly the per-label keying
// lib/barcode-done.js and lib/actual-area.js already use. An entry is one of
// three, and only one key is ever set:
//
//   { barcode: '11952...' }  resolved by the LOOKUP tier
//   { conflict: true }       the lookup file held two disagreeing barcodes
//   { asked: true }          a batch investigated it and came back empty (#666)
//
// The two terminal states are stored alongside the resolved ones deliberately.
// They are what stops an unanswerable row riding in every copy batch forever
// (#666), and losing them on a re-drop is indistinguishable from "never asked",
// which is the state that puts the row straight back in the next batch.
//
// A 'main'-sourced barcode is NEVER collected. It comes off the main report's
// own SCAN_BARCODE column, so the report that supplied it re-supplies it on
// every join (`mainReportBarcodeMap`), and persisting it would let a stale main
// answer outlive the report it came from. Tier 1 has its own source of truth;
// this store is the lookup tier's memory only.
//
// ARBITRATION IS NOT BYPASSED. applyStored writes the same fields
// applyBarcodeLookup writes, with barcodeSource 'lookup', and the page calls it
// BEFORE applyBarcodeLookup(items, null, mainReportBarcodeMap()). So a label
// with a main-report SCAN_BARCODE still ends up on the main report's answer
// (tier 3, #649): a restored value is arbitrated exactly like a freshly parsed
// one, never silently preferred because it was there first. The call order is
// the guarantee — see ingestPostSortRecords in ibno-coder.html, where it is
// spelled out again at the call site, because a guard that runs after the thing
// it guards is a dead guard and a green suite will not catch it.
//
// LIFECYCLE is the sort-day clock (#695) and NOT this module's business: the
// entries ride a lib/sort-day.js DAY STORE, pruned to the loaded report's
// labels on every load (SortDay.dayStorePruneTo) and reset on a new sort day
// (SortDay.restoreDayStore). ADR 0022: "areas, ticks, filing and barcodes
// (#741) all persist for the sort day on INBOUND_DATE, prune to the loaded
// report's labels, and roll on a new day."
//
// Dual-loadable with no build step:
// - Browser: window.BarcodeStore
// - Node:    require('./lib/barcode-store')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.BarcodeStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // A HARD CEILING ON WHAT THIS STORE MAY COST, on top of the per-load prune.
  //
  // The prune is the real bound: entries are cut to the loaded report's labels
  // on every ingest, so the store can never exceed one report. But the prune
  // runs on the LOAD path, and this cap runs on the WRITE path, which is the
  // one a stuck or unusual state could ride. The real 2026-08-12 pull is 289
  // rows; the largest pull on record is 2,868. 4,000 entries at roughly 60
  // bytes each is about 240 KB against a ~5 MB origin quota — comfortably
  // inside it, and the localStorage history here is real (auto-memory: a full
  // quota presents as "a refresh re-inputs the CSV", not as "storage full").
  //
  // Overflow drops the OLDEST entries, because insertion order here is the
  // order labels were resolved and the oldest are the likeliest to have already
  // been walked to the dock.
  const MAX_ENTRIES = 4000;

  function str(v) { return String(v == null ? '' : v).trim(); }

  function normalizeEntries(entries) {
    return (entries && typeof entries === 'object' && !Array.isArray(entries)) ? entries : {};
  }

  // entryFor(item) -> the entry to persist for one lane item, or null when the
  // item carries nothing worth remembering.
  //
  // Order matters: a resolved barcode is checked FIRST, so a row whose conflict
  // a later batch (or tier 1) answered is stored as answered, never as the
  // conflict it used to be. That mirrors applyBarcodeLookup, which clears
  // barcodeConflict the moment any tier resolves the label.
  function entryFor(item) {
    const it = item || {};
    const barcode = str(it.barcode);
    if (barcode) {
      // Tier 1 only. See the header: the main report re-supplies its own.
      if (str(it.barcodeSource) === 'main') return null;
      return { barcode: barcode };
    }
    if (it.barcodeConflict) return { conflict: true };
    if (it.barcodeAsked) return { asked: true };
    return null;
  }

  // collect(items) -> `{ [label]: entry }` for every lane item worth
  // remembering. Pure; items are never mutated.
  //
  // Later items win on a duplicated label, matching the lane's own
  // last-write-wins reading of a repeated tracking number.
  function collect(items) {
    const list = Array.isArray(items) ? items : [];
    const out = {};
    list.forEach(function (it) {
      const label = str(it && it.label);
      if (!label) return;
      const entry = entryFor(it);
      if (entry) out[label] = entry;
    });
    return out;
  }

  // mergeEntries(prev, next) -> a NEW entries object, `next` winning per label.
  // Never mutates either argument (the lib/barcode-done.js convention), so a
  // caller can persist the result and still hold the previous value.
  //
  // MERGE, NOT REPLACE, for the same reason applyBarcodeLookup merges: Tyler
  // works this lookup in small targeted batches through a shift, so a write
  // that only knows about the current batch must never erase an earlier one.
  function mergeEntries(prev, next) {
    const out = {};
    const a = normalizeEntries(prev);
    const b = normalizeEntries(next);
    Object.keys(a).forEach(function (k) { out[k] = a[k]; });
    Object.keys(b).forEach(function (k) { out[k] = b[k]; });
    return out;
  }

  // capEntries(entries, max) -> at most `max` entries, oldest keys dropped.
  function capEntries(entries, max) {
    const e = normalizeEntries(entries);
    const limit = (typeof max === 'number' && max >= 0) ? max : MAX_ENTRIES;
    const keys = Object.keys(e);
    const out = {};
    const kept = keys.length <= limit ? keys : keys.slice(keys.length - limit);
    kept.forEach(function (k) { out[k] = e[k]; });
    return out;
  }

  // applyStored(items, entries) -> a NEW array of items carrying the stored
  // barcode state. Never mutates `items`.
  //
  // A row that ALREADY has barcode state of its own is left completely alone.
  // On the ingest path that never happens (buildPostSortLane has just made the
  // rows and none of them carry a barcode field at all), but the rule is what
  // keeps this function safe to call anywhere: the store is the OLDEST evidence
  // in the room, so it may fill a gap and may never overwrite.
  //
  // The restored fields are exactly applyBarcodeLookup's four, with
  // barcodeSource 'lookup', so everything downstream — #649 arbitration, #666's
  // terminal state, barcodePrintDecision's gating, selectBarcodeBatch's
  // skipping — reads a restored row and a freshly looked-up row identically.
  function applyStored(items, entries) {
    const list = Array.isArray(items) ? items : [];
    const e = normalizeEntries(entries);
    return list.map(function (it) {
      const label = str(it && it.label);
      const entry = label ? e[label] : null;
      if (!entry || typeof entry !== 'object') return Object.assign({}, it);
      // Already answered or already asked on this load — the store says nothing
      // newer than what is in hand.
      if (str(it && it.barcode) || (it && (it.barcodeConflict || it.barcodeAsked))) {
        return Object.assign({}, it);
      }
      const barcode = str(entry.barcode);
      if (barcode) {
        return Object.assign({}, it, {
          barcode: barcode,
          barcodeConflict: false,
          barcodeSource: 'lookup',
          barcodeAsked: false,
        });
      }
      if (entry.conflict) {
        return Object.assign({}, it, {
          barcode: '',
          barcodeConflict: true,
          barcodeSource: '',
          barcodeAsked: true,
        });
      }
      if (entry.asked) {
        return Object.assign({}, it, {
          barcode: '',
          barcodeConflict: false,
          barcodeSource: '',
          barcodeAsked: true,
        });
      }
      return Object.assign({}, it);
    });
  }

  return {
    MAX_ENTRIES: MAX_ENTRIES,
    entryFor: entryFor,
    collect: collect,
    mergeEntries: mergeEntries,
    capEntries: capEntries,
    applyStored: applyStored,
  };
});
