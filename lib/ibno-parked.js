'use strict';

// IBNO Coder: Park and the Parked tab (issue #698, spec #690 user story 16,
// decision record #612 as amended by #613 rounds 19-20).
//
// Dual-loadable with no build step:
// - Browser: window.IbnoParked
// - Node: require('./lib/ibno-parked')
//
// Park is the DEFER state for rows Tyler cannot answer yet, typically the
// no-address 999s he will look up in FTrack later. Parking moves the row out
// of the working list into the Parked tab in the Set aside group at the page
// bottom. It is the answer to what used to be a resolve-and-undo round trip
// to fake a park, and its rules are the ones #612 froze:
//
//   PARK WRITES NO RECORD. No archive entry, no resolution, no code, nothing
//   that reaches OPS2. The store below is the ONLY thing a park writes.
//
//   PARK NEVER KEEPS A PACKAGE ALIVE. Parked state has effect only while the
//   package is still present in the freshly loaded report. Handled on the
//   dock by someone else means it is simply not in the new report, and the
//   park is moot: the label is pruned, gone without residue, never
//   resurrected if the tracking number reappears.
//
//   PARK LIVES UNTIL THE PACKAGE DOES NOT. The store is a lib/sort-day.js DAY
//   STORE, stamped with the report's own INBOUND_DATE and never the device
//   clock (the 1:30 AM sort straddles midnight). But the stamp is a KEY, not
//   an expiry: a park survives a same-day re-drop, an F5, and a new sort day,
//   and leaves only by Tyler's own Unpark or by the prune above, when a fresh
//   report no longer carries the package (#730, 2026-08-19). It used to reset
//   on a new sort day, on both paths; see the four-line rule below.
//
//   PARK IS NOT PROGRESS. A parked row never satisfies scanned and never
//   counts on the progress bar as done. It writes no Goes To area, so the
//   worked/scanned readers never see it; the tool additionally drops parked
//   labels from the progress population itself, so the bar's total is the
//   list that still needs him.
//
// The store shape is the generic day store ({ day, items }). Each value is a
// PARK ENTRY, { source, day }, and nothing more (#753/#754):
//
//   source  WHICH REPORT the park was made from: 'main', 'post-sort', or
//           'unknown' when the tool could not name one (a migrated entry from
//           before this shape, or a park made with no report identity in
//           hand). It exists so a PARTIAL report may prune only the parks it
//           is entitled to speak about; see prunePostSortToReport.
//   day     the sort day the park was MADE on, so a park carried in from an
//           earlier sort day can be shown as carried rather than deleted
//           (#753). Per-label, unlike the store's own stamp, which follows the
//           clock forward on every load and therefore cannot answer this.
//
// It stays this thin on the same records-tier argument lib/barcode-done.js
// makes: a scratch deferral and a routing decision must not share a shape a
// records path could read. NEITHER FIELD IS A CODE, A DISPOSITION, A CATEGORY
// OR A RESOLUTION, and nothing that reaches OPS2 may ever be added here.
//
// The value used to be the boolean true. Those entries still exist on real
// devices and migrate through migrateEntries below, which must run BEFORE the
// store's stamp is rolled forward — read its own note for why.
//
// This module owns the RULES. The tool owns the DOM wiring, and nothing in
// here reads a global, a clock, or storage directly (the day-store mechanics
// delegate to lib/sort-day.js, the one home of "is this the same sort day").

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IbnoParked = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const SortDay = (root && root.SortDay) ||
      (typeof require === 'function' ? require('./sort-day') : null);
    if (!SortDay) {
      throw new Error('IbnoParked dependencies unavailable (need SortDay)');
    }
    return { SortDay: SortDay };
  }

  function str(v) { return String(v == null ? '' : v).trim(); }

  // ─── PARK ENTRY: SOURCE AND DAY (#753, #754) ──────────────────────────────
  //
  // SOURCE_UNKNOWN is the SAFE value, and every path that cannot name a report
  // answers it rather than guessing. It is never pruned by a partial report,
  // because "I do not know where this park came from" can never be grounds for
  // deleting deferred work the supervisor has no other record of.
  const SOURCE_MAIN = 'main';
  const SOURCE_POST_SORT = 'post-sort';
  const SOURCE_UNKNOWN = 'unknown';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function normalizeSource(v) {
    const s = str(v);
    return (s === SOURCE_MAIN || s === SOURCE_POST_SORT) ? s : SOURCE_UNKNOWN;
  }

  // normalizeEntry(value) -> the { source, day } an entry means, for ANY value
  // a real store can hold: the boolean true this store wrote before #753/#754,
  // an object written since, or a hand-edited payload holding something else
  // entirely. It NEVER answers null for a value that is present, because the
  // key being present is what "parked" means and no reader of this module may
  // delete a park by failing to understand its value.
  function normalizeEntry(value) {
    const SortDay = deps().SortDay;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { source: normalizeSource(value.source), day: SortDay.parseInboundDate(value.day) };
    }
    return { source: SOURCE_UNKNOWN, day: '' };
  }

  // migrateEntries(store) -> the store with every value in the { source, day }
  // shape, days backfilled from the STORE'S OWN STAMP.
  //
  // ORDER IS THE WHOLE MIGRATION, and this is the note to read before moving
  // this call: it must run BEFORE the store's stamp is rolled forward by
  // followClock. The store's stamp is the last sort day a report dated it, so
  // for an entry that carries no day of its own it is the only evidence there
  // is about when the park was made. Roll the stamp first and every carried
  // park inherits TODAY, reads as "parked this shift", and #753's whole signal
  // is silently inverted — a dead migration a green suite cannot see, because
  // nothing about the result is malformed, only wrong.
  //
  // IDEMPOTENT: an entry that already carries a day keeps it, so a second pass
  // (pruneToReport runs one defensively) can never re-date a park.
  //
  // Deletes nothing and adds nothing. Every key in, every key out.
  function migrateEntries(store) {
    const SortDay = deps().SortDay;
    const s = SortDay.serializeDayStore(store);
    const stamp = s.day;
    const items = {};
    Object.keys(s.items).forEach(function (k) {
      const e = normalizeEntry(s.items[k]);
      items[k] = { source: e.source, day: e.day || stamp };
    });
    return { day: s.day, items: items };
  }

  // parkEntry(store, label) -> { source, day } for a parked label, or null
  // when the label is not parked at all.
  function parkEntry(store, label) {
    if (!isParked(store, label)) return null;
    return normalizeEntry(deps().SortDay.dayStoreGet(store, label));
  }

  // park(store, label, opts) / unpark(store, label) -> a NEW day store, the
  // lib/barcode-done.js convention: the caller persists the result and can
  // still hold the previous value. opts.source names the report the park was
  // made from and opts.day the sort day it was made on; both default to "not
  // known", which is the safe answer everywhere (see SOURCE_UNKNOWN above).
  function park(store, label, opts) {
    const o = opts || {};
    return deps().SortDay.dayStoreSet(store, label, {
      source: normalizeSource(o.source),
      day: deps().SortDay.parseInboundDate(o.day),
    });
  }

  function unpark(store, label) {
    return deps().SortDay.dayStoreDelete(store, label);
  }

  function isParked(store, label) {
    return !!str(label) && deps().SortDay.dayStoreHas(store, label);
  }

  // parkedRows(items, store) -> the rows the Parked tab shows: the items of
  // THIS list whose label is parked, in the list's own order. Reading the
  // list rather than the store is the "park never keeps a package alive"
  // rule applied to the render: a parked label the report no longer carries
  // has no row to show, whatever the store says.
  function parkedRows(items, store) {
    const list = Array.isArray(items) ? items : [];
    return list.filter(function (it) { return it && isParked(store, it.label); });
  }

  // parkedCount(items, store) -> the visible parked count. Scoped to the
  // loaded list so the count never claims a package that is not on the page
  // (the same scoping lib/barcode-done.js's countDone makes, and for the
  // same reason: the store can briefly outlive the report that fed it).
  function parkedCount(items, store) {
    return parkedRows(items, store).length;
  }

  // pruneToReport(store, items) -> the store with only the labels the fresh
  // report still carries. Called on every load, so a parked package that
  // stopped appearing drops off WITHOUT RESIDUE: the label itself leaves the
  // store rather than lingering to resurrect the park if the tracking number
  // ever reappears on a later pull.
  function pruneToReport(store, items) {
    const list = Array.isArray(items) ? items : [];
    return deps().SortDay.dayStorePruneTo(migrateEntries(store),
      list.map(function (it) { return it && it.label; }));
  }

  // prunePostSortToReport(store, items) -> the PARTIAL report's prune (#754).
  //
  // The Post Sort report is one filtered slice of the sort, and under ADR 0021
  // it takes the main slot by resetting the main report first, so the loaded
  // population is that slice ALONE. It is therefore entitled to say a package
  // is gone only about the parks IT produced. A park made from a main pull, or
  // one whose source is not known, is outside what this report can speak about
  // and is KEPT whatever the slice contains — deleting those is the data-loss
  // bug this function exists to not commit, because the deferred FTrack work
  // Park holds has no other record anywhere.
  //
  //   source 'post-sort', label carried by the fresh slice ..... kept
  //   source 'post-sort', label NOT carried by the fresh slice . DROPPED, the
  //     fourth line of the rule below: someone on the dock got it to the right
  //     area, so it falls off
  //   source 'main' or 'unknown' ............................... always kept
  function prunePostSortToReport(store, items) {
    const s = migrateEntries(store);
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

  // carriedParkNote(store, label, day) -> the "parked on an earlier sort day"
  // signal for one row (#753), or null when there is nothing to say.
  //
  // Null in three cases, and each is a refusal to claim something:
  //   not parked ................. nothing to describe
  //   the park's day is unknown .. a migrated entry whose store had never been
  //     dated. It is NOT called carried and NOT called fresh; claiming either
  //     from no evidence is the failure #753's acceptance criterion 2 names
  //   the park's day is not EARLIER than the day being worked .. parked this
  //     shift, or a same-day re-drop. The comparison is SortDay.isLaterSortDay,
  //     the one comparison this tool makes about sort days, and it is STRICT:
  //     a park made today is not carried.
  //
  // This says nothing about deleting anything. #753's whole point is that a
  // carried park is SHOWN, and leaves only by Unpark or by the prune above.
  function carriedParkNote(store, label, day) {
    const SortDay = deps().SortDay;
    const entry = parkEntry(store, label);
    if (!entry || !entry.day) return null;
    const today = SortDay.parseInboundDate(day);
    if (!today || !SortDay.isLaterSortDay(today, entry.day)) return null;
    return {
      day: entry.day,
      text: 'parked ' + shortSortDay(entry.day),
      title: 'Parked on ' + shortSortDay(entry.day) + ', an earlier sort day. It carried across the ' +
        'day boundary rather than being thrown away. Unpark it if it no longer needs you.',
    };
  }

  // shortSortDay('2026-08-12') -> 'Aug 12'. String arithmetic on a day that is
  // already in hand: no Date, no device clock, nothing this module is not
  // allowed to read.
  function shortSortDay(day) {
    const iso = deps().SortDay.parseInboundDate(day);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return '';
    return MONTHS[Number(m[2]) - 1] + ' ' + String(Number(m[3]));
  }

  // loadedItems(lists) -> the rows of EVERY list the page currently holds,
  // deduped by label with the FIRST occurrence winning, so the Parked tab and
  // the prune can be read off one population (#728 review findings 1 and 2).
  //
  // Under ADR 0021 the Post Sort report HOLDS THE MAIN SLOT: loading it runs a
  // full resetApp() first, so the main report's items are empty for the whole
  // Post Sort interlude. A tab rendered off the main list alone therefore went
  // to zero the moment that report landed — the count vanished, the group and
  // the header chip hid themselves, and a parked package with an early row was
  // on screen NOWHERE with no reachable Unpark, while the store still held the
  // label. Reading both lists is what keeps "the parked count is always visible
  // while nonzero" (#612 decision 8) true on both report paths.
  //
  // Deduped because the same label can be carried by both lists at once (a row
  // parked from the main pull that also has an early Post Sort row): the tab
  // must show it once, and the count must count it once.
  function loadedItems(lists) {
    const out = [];
    const seen = Object.create(null);
    (Array.isArray(lists) ? lists : []).forEach(function (list) {
      (Array.isArray(list) ? list : []).forEach(function (it) {
        const label = it && str(it.label);
        if (!label || seen[label]) return;
        seen[label] = true;
        out.push(it);
      });
    });
    return out;
  }

  // ─── WHEN A PARK MAY BE CLEARED: THE RULE, IN FOUR LINES ──────────────────
  //
  // Governs BOTH entry points below. Read all four lines before changing
  // either. Tyler, 2026-08-19, closing #730: "i would like park to not be
  // cleared. i have to manually clear each one", and "i want if to fall off of
  // park if the fresh report drops it. so if someone on the dock actually
  // figures it out and get it to the right area then it should fall off."
  //
  //   NEVER clear on a sort-day roll.
  //   NEVER clear on a page refresh.
  //   NEVER clear on a re-drop that still carries the package.
  //   DO clear when the freshly loaded report no longer carries the package.
  //
  // The first three belong to followClock, which is why it has no reset branch
  // on EITHER path. The fourth is pruneToReport (and reconcileParked in the
  // tool). It is NOT "parks are never cleared": ripping the prune out to
  // satisfy a blanket reading of the first three would break #698's "gone
  // without residue" rule and leave parks on packages someone already got to
  // the right area.
  //
  // THE PRINCIPLE UNDERNEATH, which is what to reason from if a new case turns
  // up: a report's DATE is evidence about the report. Only a report's CONTENTS
  // are evidence about a package. Clearing a park is a claim about a package,
  // so it may be made from the contents and never from the date. Unparking is
  // real work Tyler does row by row, and anything that empties the set on his
  // behalf destroys it.
  //
  // ─── THE MIXED-DATE SHIFT (#698 review finding 1) ─────────────────────────
  //
  // Why the STAMP still needs care even though the items no longer move with
  // it. The 1:30 AM sort works YESTERDAY's main pull (dated Y) alongside
  // TODAY's Post Sort report (dated T > Y), and the monotonic clock moves Y to
  // T when the Post Sort report lands. The comparison in followClock is the one
  // lib/sort-day.js makes everywhere, isLaterSortDay: only a STRICTLY LATER day
  // re-stamps. Read against the store's own stamp that gives:
  //
  //   stamp earlier than the incoming day ... a later report: re-stamp
  //   stamp same as the incoming day ........ a same-day re-drop: unchanged
  //   stamp later than the incoming day ..... the SAME SHIFT: the clock
  //     reached the stamp through the Post Sort report, and this load is the
  //     earlier-dated main pull it ran alongside. Never roll the stamp
  //     backward (the clock is monotonic; the stamp follows it).
  //
  // Every one of those three keeps the items. The stamp is a key, not a verdict.

  // followClock(store, day) -> the store re-stamped for a freshly loaded
  // report, ITEMS ALWAYS INTACT. Both entry points below are this function:
  // neither the main-report path nor the Post Sort path may empty the parked
  // set, because NO REPORT'S DATE IS EVIDENCE ABOUT A PACKAGE. Only the
  // report's CONTENTS are, and reading the contents is pruneToReport's job.
  //
  // The stamp still moves, and only ever forward, because it is what the day
  // store is keyed on and the clock in lib/sort-day.js is monotonic.
  function followClock(store, day) {
    const SortDay = deps().SortDay;
    // MIGRATE FIRST, ALWAYS, and never below the re-stamp. An entry with no day
    // of its own takes the store's CURRENT stamp here, which is the day a
    // report last dated this store; the lines below then move that stamp
    // forward. Reverse the two and every carried park is re-dated to the day
    // being loaded and reads as parked this shift (#753 AC2). See
    // migrateEntries for the full argument.
    const s = migrateEntries(store);
    const d = SortDay.parseInboundDate(day);
    // An undateable report changes nothing, the same refusal the clock makes.
    if (!d) return s;
    // A LATER day re-stamps. This also covers the UNSTAMPED store (#728 review
    // finding 3): isLaterSortDay(d, '') is true by design, an unknown `than`
    // being earlier than any readable day, so a store that has never met a
    // dateable report is simply dated by this load rather than treated as one
    // from an earlier day.
    if (SortDay.isLaterSortDay(d, s.day)) return { day: d, items: s.items };
    // Same day (a re-drop), or a stamp LATER than the incoming day (the same
    // shift's earlier-dated pull). Keep, stamp intact, never rolled backward.
    return s;
  }

  // syncMainReport(store, day) -> the parked store for a MAIN report load (a
  // fresh drop, a merge, or the session restore on F5).
  //
  // It used to reset the whole set on a genuinely new sort day, on the reading
  // that the main report IS the sort day's own statement of itself. Tyler
  // removed that (2026-08-19, #730): a new date is a statement about the
  // REPORT, never about whether a package he set aside is still sitting there.
  // The wipe also ran BEFORE the prune and bypassed it, so it dropped parks
  // without ever asking whether the fresh report still carried those packages —
  // which is precisely the question that decides it.
  //
  // What replaces it is already wired and is strictly better informed: the
  // main-report path calls reconcileParked() -> pruneToReport() in
  // renderResults(), AFTER this runs, against the freshly loaded rows. So a
  // park whose package is gone from the new report still drops, by evidence
  // rather than by the calendar, and a park whose package is still on the
  // report survives the day boundary — still live work, still set aside.
  function syncMainReport(store, day) {
    return followClock(store, day);
  }

  // carryAcrossRoll(store, day) -> the parked store for a POST SORT load. The
  // store follows the clock forward, items ALWAYS intact. It delegates to the
  // same followClock as syncMainReport since #730, structurally and not merely
  // by having the same shape, so the two cannot drift apart. It keeps its own
  // name because the two call sites are different acts and the tool reads
  // better saying which one it is.
  //
  // The four-line rule above governs this path too. The prune behind it is the
  // PROVENANCE-AWARE one, prunePostSortToReport (#754), never pruneToReport:
  // the Post Sort report is a partial population, so it may drop only the parks
  // it produced itself. A main-pull park and a park of unknown source leave on
  // this path only by Tyler's own Unpark, until a main report loads and prunes.
  //
  // Why this is worth having at all rather than waiting for the main report:
  // Post Sort is the daily driver (ADR 0021, and Tyler's own loop, 2026-08-19),
  // so most days no main report is loaded until the end of the sort, if ever.
  // Without it the fourth line of the rule never fires on a normal day, and a
  // park the dock already resolved sits stale through the whole shift.
  //
  // #730 asked for the opposite — reset the set when a Post Sort report from a
  // genuinely NEW day lands, matching the main-report path — and this function
  // briefly did that, gated on session provenance (an opts.shiftMainDay naming
  // the live main-report drop of the page session, since a mid-shift roll and a
  // new sort day are otherwise DATA-IDENTICAL here: both read as a stamp of Y
  // and an incoming report dated T > Y). That mechanism is gone. It could not
  // separate the two cases without also dropping parks across an F5, and every
  // wipe it performed was work Tyler had not asked to lose.
  //
  // The residual #730 concern is real and is answered the other way round: a
  // park carried in from an earlier sort day is made VISIBLE so he can see it
  // and unpark it himself, never deleted for him. That is carriedParkNote and
  // the per-label day stamp it reads (#753).
  //
  // WHAT STILL LEAVES THE SET, both untouched by this and neither one the tool
  // discarding live work:
  //   unpark(), the supervisor's own hand; and
  //   pruneToReport(), the fourth line of the rule above — the "gone without
  //     residue" prune (#698, #613 round 19), which drops a label the freshly
  //     loaded MAIN report no longer carries. Tyler's reason for it, in his own
  //     words: someone on the dock figured the package out and got it to the
  //     right area, so it should fall off. It keeps every label the loaded
  //     population does carry, so it can never delete a park that is still
  //     holding a row.
  function carryAcrossRoll(store, day) {
    return followClock(store, day);
  }

  // chipText(count) -> the always-visible-while-nonzero count (#612 decision
  // 8). Empty at zero: a control that reads "0 parked" is volume without
  // information (the findability rule, #611), so the chip is absent instead.
  function chipText(count) {
    const n = Number(count) || 0;
    return n > 0 ? ('⏳ ' + n + ' parked') : '';
  }

  return {
    SOURCE_MAIN: SOURCE_MAIN,
    SOURCE_POST_SORT: SOURCE_POST_SORT,
    SOURCE_UNKNOWN: SOURCE_UNKNOWN,

    park: park,
    unpark: unpark,
    isParked: isParked,
    parkEntry: parkEntry,
    migrateEntries: migrateEntries,
    carriedParkNote: carriedParkNote,
    shortSortDay: shortSortDay,
    parkedRows: parkedRows,
    parkedCount: parkedCount,
    pruneToReport: pruneToReport,
    prunePostSortToReport: prunePostSortToReport,
    loadedItems: loadedItems,
    syncMainReport: syncMainReport,
    carryAcrossRoll: carryAcrossRoll,
    chipText: chipText,
  };
});
