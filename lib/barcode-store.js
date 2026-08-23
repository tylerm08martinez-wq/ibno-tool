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
// two, and only one key is ever set:
//
//   { barcode: '11952...' }  resolved by the LOOKUP tier
//   { conflict: true }       the lookup file held two disagreeing barcodes
//
// ISSUE #757 — ONLY ONE OF #666's TWO TERMINAL STATES IS STORED, AND WHICH ONE
// IS THE WHOLE DECISION (Tyler, 2026-08-22, option 1 of three). They look alike
// on the lane and they answer completely different questions:
//
//   conflict — a TERMINAL ANSWER. Two disagreeing barcodes for one tracking
//              number, real and reproducible (2 of 56 on a fresh pull). Nobody
//              knows which is right; only a human settles it. Re-asking the
//              lookup is pure noise, and NOT re-asking is the point of #741. So
//              it PERSISTS for the sort day, like a resolved barcode.
//   asked    — a TIMING ARTIFACT, not an answer at all. The Track IDs to Full
//              Barcode extract is a POINT-IN-TIME pull, and Tyler re-drops the
//              Post Sort report constantly through the shift to get fresh
//              inbound scans. A package whose barcode was simply not in the
//              extract YET at 2 AM comes back "asked and empty" once; the next
//              pull answers it. So it is NOT stored, and a re-drop retries the
//              row — exactly the pre-#741 behaviour.
//
// Persisting `asked` was the #741 review's flagged ambiguity, and the reason it
// had to be settled rather than left implicit is HOW it fails: silently. There
// is no unpark-style manual clear, so a 503 with a work area assigned — which
// needs its barcode generated — would simply never be asked for again, and that
// is invisible until the packages are already gone.
//
// #666 IS NOT WEAKENED. Its job is to terminate the lookup loop WITHIN one
// loaded report, and `barcodeAsked` on the lane item still does that in full:
// selectBarcodeBatch skips the row, the batch index advances instead of
// stalling, and the lane still reaches "Nothing to copy". What changes is only
// the store's MEMORY of that state across a rebuild of the lane. The lane is
// the loop's scope; the sort day is not.
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
// labels on every load (SortDay.dayStorePruneTo) and reset on a genuinely new
// sort day — rollOnNewSortDay below, which since #756 is ONE-DIRECTIONAL and no
// longer the plain SortDay.restoreDayStore. ADR 0022: "areas, ticks, filing and
// barcodes (#741) all persist for the sort day on INBOUND_DATE, prune to the
// loaded report's labels, and roll on a new day."
//
// Dual-loadable with no build step:
// - Browser: window.BarcodeStore
// - Node:    require('./lib/barcode-store')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.BarcodeStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // The same lazy dependency lookup lib/ibno-parked.js uses, and for the same
  // reason: the day rule below is lib/sort-day.js's, not this module's, and
  // restating "is this the same sort day" here is how the two drift apart.
  // Resolved at CALL time so a browser script-tag order that loads this file
  // first is still fine.
  function deps() {
    const SortDay = (root && root.SortDay) ||
      (typeof require === 'function' ? require('./sort-day') : null);
    if (!SortDay) throw new Error('BarcodeStore dependencies unavailable (need SortDay)');
    return { SortDay: SortDay };
  }

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
    // A bare `barcodeAsked` (asked, no conflict, no barcode) is NOT stored —
    // see the #757 block in the header. It is the timing artifact of when the
    // point-in-time extract ran, and the store is the one thing that would turn
    // it into a sort-day-long verdict on a package.
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
  //
  // IT ALSO PURGES ANY ENTRY THAT IS NEITHER SHAPE (#757 review). A legacy
  // `{ asked: true }` written by the #741 build is already INERT on read —
  // applyStored ignores it — but "inert" is not "gone": dayStorePruneTo keeps
  // it whenever its label is in the loaded report, which for an asked row is
  // every load. It would then sit in the payload until the sort day rolled.
  //
  // That is not merely untidy. capEntries evicts the OLDEST keys at
  // MAX_ENTRIES, so on a large pull (the biggest on record is 2,868 rows) dead
  // asked entries can displace REAL resolved barcodes at the cap — the one
  // thing this store exists to keep. Purging on the write path is where it
  // belongs, because that is the path every caller re-persists through, so the
  // junk clears on the next drop rather than on the next sort day.
  function isStorableEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    if (str(entry.barcode)) return true;
    return entry.conflict === true;
  }

  function mergeEntries(prev, next) {
    const out = {};
    const a = normalizeEntries(prev);
    const b = normalizeEntries(next);
    Object.keys(a).forEach(function (k) { if (isStorableEntry(a[k])) out[k] = a[k]; });
    Object.keys(b).forEach(function (k) { if (isStorableEntry(b[k])) out[k] = b[k]; });
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
      // #757 MIGRATION: a legacy `{ asked: true }` entry, written by the
      // #741 build that persisted both terminal states. entryFor no longer
      // produces one, but a real device can be holding a store full of them at
      // the moment this build lands, mid-sort. It falls through to the
      // no-op below on purpose — the row is left with no barcode state at all,
      // which is "never asked", which is what puts it back in the next batch.
      // IGNORING it here rather than only stopping the writes is what keeps the
      // fix from taking a whole extra sort day to take effect.
      //
      // Ignored on READ, dropped on WRITE: mergeEntries purges it, so it does
      // not linger in the payload competing for MAX_ENTRIES. Both halves are
      // needed — this one makes the next drop correct, that one makes it clean.
      return Object.assign({}, it);
    });
  }

  // ─── THE DAY ROLL, ONE-DIRECTIONAL (issue #756, Tyler's decision 2026-08-22)
  //
  // rollOnNewSortDay(raw, day) -> the day store this report's load should leave
  // behind. Pure; `raw` may be the live store, a serialized one, or the RAW
  // JSON string of the boot seed straight off localStorage.
  //
  //   incoming day unreadable ..... change NOTHING — items and stamp both, and
  //     that holds even for an UNSTAMPED store. The same refusal the clock
  //     itself makes: a report whose dates will not parse is not evidence about
  //     anything, least of all grounds for discarding a shift's lookups.
  //   incoming day LATER than the stamp .... RESET, empty and re-stamped. This
  //     is a genuinely new sort day, and it is #755's tradeoff, unchanged and
  //     deliberate — see below.
  //   incoming day the SAME as the stamp ... KEEP. A same-day re-drop or an F5,
  //     which is the whole of #741.
  //   stamp LATER than the incoming day .... KEEP, stamp intact, never rolled
  //     backward. THIS IS THE #756 FIX.
  //
  // WHY THE LAST LINE IS A FIX AND NOT A LOOSENING. Until this ticket the page
  // rolled this store with a plain SortDay.restoreDayStore, which drops the
  // entries whenever the stamp is not EXACTLY the day being loaded — in BOTH
  // directions. Only the forward direction was ever argued for. The reverse one
  // is Tyler's real 1:30 AM loop: a mid-shift refresh leaves the clock at '',
  // he drops YESTERDAY's main pull first (the only one that exists at that
  // hour), the clock moves '' -> yesterday, and a store stamped TODAY is wiped
  // and immediately re-persisted empty. Today's Post Sort re-drop then restores
  // nothing and the whole day's Track IDs to Full Barcode lookup is re-run,
  // mid-sort. lib/sort-day.js's isLaterSortDay goes out of its way to call that
  // earlier-dated pull the SAME SHIFT — wiping the shift's work against a
  // report the clock rule says is not a new day is incoherent.
  //
  // This is deliberately IbnoParked.carryAcrossRoll's rule minus its last
  // clause. The parked set never resets at all (#730), because a park is a
  // decision with no other source. A barcode is re-derivable from a lookup the
  // tool re-copies on its own, so the forward reset stays: yesterday's barcodes
  // must never show against today's lane, and a tracking number repeats across
  // days (ADR 0022 invariant 6).
  //
  // AN UNSTAMPED STORE RESETS, and that falls out of isLaterSortDay(d, '')
  // being true by design rather than by accident: nothing dates those entries,
  // so nothing can claim them for today.
  //
  // DAY SEMANTICS ONLY — it purges no entry and normalizes no value. The write
  // path owns that (mergeEntries, #757/#842), which is the path every caller
  // re-persists through, so a legacy entry carried across here leaves on the
  // very next drop rather than riding the carry.
  function rollOnNewSortDay(raw, day) {
    const SortDay = deps().SortDay;
    const d = SortDay.parseInboundDate(day);
    const stamp = SortDay.parseInboundDate(stampOf(raw));
    // AN UNDATEABLE REPORT CHANGES NOTHING, and that has to include an
    // UNSTAMPED store (#846 review finding C). restoreDayStore alone would
    // empty one here — its rule is "an unknown current day restores nothing" —
    // which is the wrong reading on this path: the store is not being restored
    // FOR a day, it is being left alone because no day was named. Nothing is
    // leaked by keeping it, since the next readable day resets an unstamped
    // store outright on the line below.
    if (!d) return stamp ? SortDay.restoreDayStore(raw, stamp) : keepUnstamped(raw);
    // Genuinely later, INCLUDING an unstamped store: isLaterSortDay(d, '') is
    // true by design, so a payload nothing can date is never claimed for today.
    if (SortDay.isLaterSortDay(d, stamp)) return SortDay.emptyDayStore(d);
    // Same day, or a stamp LATER than the incoming day. Restoring against the
    // store's OWN stamp is what "keep, stamp intact" means, and it reuses
    // restoreDayStore's key sanitizing rather than repeating it. `stamp` is
    // always readable here — an empty one took the reset branch above.
    return SortDay.restoreDayStore(raw, stamp);
  }

  // keepUnstamped(raw) -> the payload's items under an empty stamp, keys
  // sanitized the way restoreDayStore sanitizes them. Reached only when BOTH
  // the store and the incoming report are undateable.
  function keepUnstamped(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return { day: '', items: {} }; }
    }
    const items = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed.items : null;
    const out = {};
    if (items && typeof items === 'object' && !Array.isArray(items)) {
      Object.keys(items).forEach(function (k) { if (str(k)) out[str(k)] = items[k]; });
    }
    return { day: '', items: out };
  }

  // stampOf(raw) -> the `day` a stored payload claims, for any shape a real
  // device can hand back: the live store, a serialized copy, the raw JSON
  // string off localStorage, or junk.
  function stampOf(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return ''; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    return parsed.day;
  }

  return {
    MAX_ENTRIES: MAX_ENTRIES,
    rollOnNewSortDay: rollOnNewSortDay,
    entryFor: entryFor,
    collect: collect,
    mergeEntries: mergeEntries,
    capEntries: capEntries,
    applyStored: applyStored,
  };
});
