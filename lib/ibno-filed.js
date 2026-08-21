'use strict';

// IBNO Coder: the BARCODED state and the "✅ Work area assigned" tab (issue
// #734, spec #690, map #608). Rides the Set aside tab group built by #698.
//
// Dual-loadable with no build step:
// - Browser: window.IbnoFiled
// - Node: require('./lib/ibno-filed')
//
// WHAT THIS STORE MEANS, and it is the one thing to get right here: a label in
// this store is BARCODED — a card was generated for it AND Tyler confirmed on
// the panel that he actually assigned it. That is ADR 0022's fourth lifecycle
// state, and it is stored INDEPENDENTLY of every other one:
//
//   answered .. lib/actual-area.js. A row can be answered and not barcoded.
//   barcoded .. THIS store.
//   scanned ... lib/barcode-done.js. A row can be barcoded and NOT scanned.
//
// ADR 0022 INVARIANT 2, BARCODED NEVER IMPLIES SCANNED, is why this file exists
// at all rather than a flag on barcodeDoneStore. #697 made scanned deliberately
// per-row because Tyler scans every package individually ("i scan each package
// individually", #612 decision 3), so a dock-flexed sibling must not read as
// scanned. Filing is a BATCH act on one confirmation — a decluttering move, not
// a scan. Fold the two together and a filed batch of forty reads as forty
// scans, and the progress bar lies about work nobody did. Nothing in this
// module may ever read or write lib/barcode-done.js, and nothing in it may be
// handed to a scanned reader.
//
// GENERATION ALONE NEVER FILES A ROW. The writer is the confirm panel, never
// printBarcodesFor: a sheet can be reprinted or abandoned, and a silently
// hidden package is the failure the whole ticket exists to prevent. Unchecking
// a row on the panel, or dismissing it, writes nothing at all.
//
// SHAPE: a lib/sort-day.js DAY STORE ({ day, items }), the same shape the
// parked set and the resolved barcodes ride. Each value is a FILING ENTRY:
//
//   source  WHICH REPORT the filing was made from: 'main', 'post-sort', or
//           'unknown' when the tool could not name one. It exists for exactly
//           one reason, the same one #754 added it to the parked set for: a
//           PARTIAL report (Post Sort, which under ADR 0021 holds the main
//           slot) may prune only the filings IT is entitled to speak about.
//
// NO PER-LABEL DAY, and that is a decision rather than an omission. The parked
// set carries one (#753) because a park CARRIES ACROSS a sort-day roll and has
// to be shown as carried. Filed state does not carry: it resets on a new sort
// day (#734 acceptance criterion 7), so a filed entry is always from the day
// the store is stamped with and a per-label day could only ever repeat the
// stamp. A field that can hold only one value answers no question.
//
// THE LIFETIME, which is DELIBERATELY NOT THE PARKED SET'S:
//
//   survives a same-day re-drop and an F5 ....... yes, it is a day store
//   resets on a NEW sort day .................... YES, unlike Park (#730)
//   drops a label a fresh report no longer has .. yes, without residue
//
// Park is Tyler's own deferral with no other record anywhere, so #730 froze it
// against every automatic clear. Filing is a statement about a batch of paper
// that was printed and walked TODAY. Yesterday's assignment is not evidence
// about today's package (ADR 0022 invariant 6), and a tracking number does
// repeat across days, so carrying a filing forward would hide today's package
// behind yesterday's card. This store is therefore on the STRICTER rule, the
// same one lib/barcode-store.js's resolved barcodes ride.
//
// A FILED ROW IS NOT A FROZEN ROW, and the tool half of this ticket depends on
// it: Tyler still needs to code a 33 on a filed row, so the tab keeps the
// quick-code pills, the free code entry with Apply, the checkbox and the
// per-tab copy/barcode controls. Nothing here writes a code, a disposition or
// a resolution, and nothing that reaches OPS2 may ever be added to this store.
//
// This module owns the RULES. The tool owns the DOM wiring, and nothing here
// reads a global, a clock, or storage directly.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IbnoFiled = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const SortDay = (root && root.SortDay) ||
      (typeof require === 'function' ? require('./sort-day') : null);
    if (!SortDay) {
      throw new Error('IbnoFiled dependencies unavailable (need SortDay)');
    }
    return { SortDay: SortDay };
  }

  function str(v) { return String(v == null ? '' : v).trim(); }

  // SOURCE_UNKNOWN is the SAFE value, exactly as it is in lib/ibno-parked.js:
  // every path that cannot name a report answers it, and a partial report never
  // prunes it, because "I do not know where this came from" can never be
  // grounds for deleting a filing.
  const SOURCE_MAIN = 'main';
  const SOURCE_POST_SORT = 'post-sort';
  const SOURCE_UNKNOWN = 'unknown';

  function normalizeSource(v) {
    const s = str(v);
    return (s === SOURCE_MAIN || s === SOURCE_POST_SORT) ? s : SOURCE_UNKNOWN;
  }

  // normalizeEntry(value) -> the { source } an entry means, for ANY value a
  // real store can hold: an object written by this module, the bare `true` a
  // hand-edited or half-migrated payload can carry, or something else entirely.
  // It NEVER answers null for a value that is PRESENT — the key being present
  // is what "filed" means, and no reader here may un-file a row by failing to
  // understand its value.
  function normalizeEntry(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { source: normalizeSource(value.source) };
    }
    return { source: SOURCE_UNKNOWN };
  }

  // normalizeEntries(store) -> the store with every value in the { source }
  // shape. Deletes nothing, adds nothing: every key in, every key out.
  //
  // IDEMPOTENT, so a second pass (pruneToReport runs one defensively) can never
  // change an entry it already normalized.
  //
  // ORDER: this must run BEFORE anything that re-stamps or drops the store's
  // items. It is the lib/ibno-parked.js migrateEntries rule applied to a store
  // whose entries carry no day — and the ordering matters MORE here, not less,
  // because syncSortDay DROPS the items on a roll: a normalize placed after it
  // would be normalizing an empty object on exactly the load that mattered. A
  // guard evaluated after the thing it guards is a dead guard, and a green
  // suite cannot see it (#478 seenIds, #564 KB schema-before-detect).
  function normalizeEntries(store) {
    const s = deps().SortDay.serializeDayStore(store);
    const items = {};
    Object.keys(s.items).forEach(function (k) { items[k] = normalizeEntry(s.items[k]); });
    return { day: s.day, items: items };
  }

  function filedEntry(store, label) {
    if (!isFiled(store, label)) return null;
    return normalizeEntry(deps().SortDay.dayStoreGet(store, label));
  }

  // file(store, label, opts) / unfile(store, label) -> a NEW day store, the
  // lib/barcode-done.js convention: the caller persists the result and can
  // still hold the previous value for comparison.
  function file(store, label, opts) {
    const o = opts || {};
    return deps().SortDay.dayStoreSet(store, label, { source: normalizeSource(o.source) });
  }

  // fileMany(store, labels, opts) -> file a whole confirmed batch in one write.
  // opts.sourceOf(label), when given, names the report EACH label came off, so
  // a batch spanning both reports files each row with its own provenance rather
  // than one guess for all of them. Falls back to opts.source.
  //
  // Deduplicates: a tracking number can be carried by both reports at once, and
  // one package is one filing.
  function fileMany(store, labels, opts) {
    const o = opts || {};
    let next = deps().SortDay.serializeDayStore(store);
    const seen = Object.create(null);
    (Array.isArray(labels) ? labels : []).forEach(function (raw) {
      const label = str(raw);
      if (!label || seen[label]) return;
      seen[label] = true;
      const source = typeof o.sourceOf === 'function' ? o.sourceOf(label) : o.source;
      next = file(next, label, { source: source });
    });
    return next;
  }

  function unfile(store, label) {
    return deps().SortDay.dayStoreDelete(store, label);
  }

  function isFiled(store, label) {
    return !!str(label) && deps().SortDay.dayStoreHas(store, label);
  }

  // filedRows(items, store) -> the rows the tab shows: the items of THIS list
  // whose label is filed, in the list's own order. Reading the LIST rather than
  // the store is what keeps the tab from claiming a package the report in front
  // of Tyler no longer carries — the same scoping lib/ibno-parked.js's
  // parkedRows and lib/barcode-done.js's countDone make, for the same reason.
  function filedRows(items, store) {
    const list = Array.isArray(items) ? items : [];
    return list.filter(function (it) { return it && isFiled(store, it.label); });
  }

  function filedCount(items, store) {
    return filedRows(items, store).length;
  }

  // pruneToReport(store, items) -> the store with only the labels the fresh
  // MAIN report still carries, so a filed package that stopped appearing drops
  // off WITHOUT RESIDUE (#734 acceptance criterion 8): the label itself leaves
  // the store rather than lingering to resurrect the filing if the tracking
  // number ever reappears.
  function pruneToReport(store, items) {
    const list = Array.isArray(items) ? items : [];
    return deps().SortDay.dayStorePruneTo(normalizeEntries(store),
      list.map(function (it) { return it && it.label; }));
  }

  // prunePostSortToReport(store, items) -> the PARTIAL report's prune, the
  // lib/ibno-parked.js prunePostSortToReport rule applied to filings (#754).
  //
  // The Post Sort report is one filtered slice, and under ADR 0021 it takes the
  // main slot by resetting the main report first, so the loaded population is
  // that slice ALONE. It may therefore say a package is gone only about the
  // filings IT produced:
  //
  //   source 'post-sort', label carried by the fresh slice ..... kept
  //   source 'post-sort', label NOT carried by the fresh slice . DROPPED
  //   source 'main' or 'unknown' ............................... always kept
  function prunePostSortToReport(store, items) {
    const s = normalizeEntries(store);
    const keep = Object.create(null);
    (Array.isArray(items) ? items : []).forEach(function (it) {
      const label = it && str(it.label);
      if (label) keep[label] = true;
    });
    const out = { day: s.day, items: {} };
    Object.keys(s.items).forEach(function (k) {
      const entry = s.items[k];
      if (entry.source !== SOURCE_POST_SORT || keep[k]) out.items[k] = entry;
    });
    return out;
  }

  // syncSortDay(store, day) -> the store for a freshly loaded report.
  //
  // THIS IS WHERE FILED STATE DIFFERS FROM PARK, and the difference is the
  // feature. Park never clears on a roll (#730); filing does.
  //
  //   day unreadable ......................... change NOTHING. The same refusal
  //     the clock itself makes: a report we cannot date is not evidence that
  //     anything expired, and wiping a shift's filings on an unparsable .xlsx
  //     is the destruction this whole family of stores is careful about.
  //   day LATER than the stamp (or unstamped) . a NEW SORT DAY: drop the items,
  //     re-stamp. Yesterday's assignment is not evidence about today's package,
  //     and a tracking number repeats across days.
  //   day SAME as the stamp ................... a same-day re-drop, Tyler's
  //     constant loop: keep everything, stamp unchanged.
  //   day EARLIER than the stamp .............. the SAME SHIFT — the clock
  //     reached the stamp through the Post Sort report and this load is the
  //     earlier-dated main pull it ran alongside (the 1:30 AM mixed-date shift,
  //     lib/ibno-parked.js states it in full). Keep the items; NEVER roll the
  //     stamp backward, the clock is monotonic.
  //
  // NORMALIZE FIRST, ALWAYS. On the keep paths the normalized entries are what
  // is returned; putting it after the roll would leave it normalizing whatever
  // survived instead of what was there.
  function syncSortDay(store, day) {
    const SortDay = deps().SortDay;
    const s = normalizeEntries(store);
    const d = SortDay.parseInboundDate(day);
    if (!d) return s;
    if (SortDay.isLaterSortDay(d, s.day)) return { day: d, items: {} };
    return s;
  }

  // chipText(count) -> the always-visible-while-nonzero count, the same quiet
  // register the parked and 503 chips keep (#612 decision 8, #611). Empty at
  // zero: a chip reading "0 assigned" is volume without information.
  function chipText(count) {
    const n = Number(count) || 0;
    return n > 0 ? ('✅ ' + n + ' assigned') : '';
  }

  // confirmBatch(cards) -> the rows the confirm panel offers, one per package,
  // EVERY ONE PRE-CHECKED (#734 acceptance criterion 1).
  //
  // Fed the cards that ACTUALLY reached the paper, never the rows that were
  // selected: #667's gating refuses an early row with no resolved barcode or a
  // lookup conflict, and offering "mark as done" for a package no card was
  // printed for would file a row against a sheet that does not mention it.
  //
  // Deduped by label, first occurrence winning, because a tracking number can
  // be carried by both reports at once and one package is one line on the
  // panel.
  function confirmBatch(cards) {
    const out = [];
    const seen = Object.create(null);
    (Array.isArray(cards) ? cards : []).forEach(function (c) {
      const label = str(c && (c.label != null ? c.label : c));
      if (!label || seen[label]) return;
      seen[label] = true;
      out.push({
        label: label,
        area: str(c && c.area),
        address: str(c && c.address),
        source: normalizeSource(c && c.source),
        checked: true,
      });
    });
    return out;
  }

  // confirmActionText(n) -> the panel's live count. Named here rather than in
  // the tool so the panel's promise and the write under it are one statement.
  function confirmActionText(n) {
    const count = Number(n) || 0;
    return 'Mark ' + count + ' as done';
  }

  return {
    SOURCE_MAIN: SOURCE_MAIN,
    SOURCE_POST_SORT: SOURCE_POST_SORT,
    SOURCE_UNKNOWN: SOURCE_UNKNOWN,

    file: file,
    fileMany: fileMany,
    unfile: unfile,
    isFiled: isFiled,
    filedEntry: filedEntry,
    normalizeEntries: normalizeEntries,
    filedRows: filedRows,
    filedCount: filedCount,
    pruneToReport: pruneToReport,
    prunePostSortToReport: prunePostSortToReport,
    syncSortDay: syncSortDay,
    chipText: chipText,
    confirmBatch: confirmBatch,
    confirmActionText: confirmActionText,
  };
});
