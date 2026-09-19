'use strict';

// THE STATION DAY-STORE (#999, spec #996).
//
// #998 gave the Station tab a pane that reads the drop in front of Tyler and
// nothing else: a re-drop rebuilt it from the report, and the moment a package
// stopped appearing it simply vanished. That is the wrong shape for these rows.
// A station package is not IBNO work that resolves itself on the dock — it sits
// in the cage until the Cage A Admin walks it to the office and scans it
// delivered, which can be the next sort day or the one after. So the pane needs
// a MEMORY: what came in, what is still out, and how long it has been sitting.
//
// WHAT THIS MODULE IS. A keyed store, modeled field for field on the Parked
// store (lib/ibno-parked.js) and riding the same { day, items } shape from
// lib/sort-day.js, holding the CARRIED ROW PROJECTION for every station package
// the tool has seen and not yet seen delivered:
//
//   label .......... the tracking number, the key
//   firm ........... the recipient cell
//   addr2 .......... where a vision-updated stray declares itself
//   status ......... STATUS_CODES1, as printed; what makes a row `coded`
//   inboundDate .... the report's own INBOUND_DATE, ISO
//   inboundDateRaw . the same column as printed, which is what the cell shows
//   express ........ EXPRESS_TRACK exactly as the report printed it, and the
//                    ONLY field here that exists for a CHIP rather than a cell
//                    (#1035). The pane draws the STORE's entry and not the
//                    report row, so a carried-over package — the row with no
//                    report row behind it, which is precisely the one being
//                    chased in FTrack — could not otherwise answer
//                    IbnoRules.isExpress and lost its eOps link. Carried as the
//                    printed string rather than a boolean because isExpress
//                    matches the positive value and reads 'true' as GROUND.
//                    Still nothing a record can read: it is a service, not a
//                    code, a disposition or an area.
//   provenance ..... which REPORT last described this package — 'early' for the
//   scanBarcode      Post Sort report, absent for the full-detail pull — and the
//                    scannable barcode that report resolved for it. The pair
//                    exists for the tracking cell's COPY, and for nothing else
//                    (#1035 review). Both are needed together, because between
//                    them they are the whole of what copyOptsFor/copyValueFor
//                    ask of a row: an early row with a barcode must copy the
//                    BARCODE in barcode mode, and an early row without one must
//                    copy NOTHING rather than a PKG_LABEL_XREF-shaped value
//                    that does not scan (#746, #750). Without them here the
//                    Station tab would answer that question differently from
//                    the Parked row and the 503 row for the same package, which
//                    is the per-surface divergence copyOptsFor exists to end.
//                    Still nothing a record can read: `provenance` names the
//                    report, never a code, a disposition or an area, and no
//                    reader outside the tracking cell asks either of them.
//   firstSeenDay ... the sort day this tool first saw the package, which is the
//                    age fallback when the report carried no inbound date
//   deliveredDay ... the sort day it was inferred delivered, or absent
//
// HOW DELIVERED IS DECIDED, and it is DERIVED ON EVERY DROP rather than being a
// flag a human sets:
//
//   POST SORT DAYS have no delivered column at all. The Admin's 13/14/05
//   delivery scan is what takes a package OFF the report, so a station row that
//   was in the previous drop and is gone from this one is delivered today.
//   Absence is the whole signal, and it is the only one available.
//
//   THE FULL-DETAIL "Inbound and Van Scans" REPORT carries the scans, so a row
//   whose LATEST scan is 13, 14 or 05 reads delivered regardless of presence.
//   That is confirmation on the days that report is loaded, not a second rule.
//
// A REAPPEARING PACKAGE IS OPEN AGAIN. ingestDrop clears deliveredDay for any
// row the fresh drop carries, because the report saying "still here" outranks
// an inference drawn from it not saying so yesterday. That is also the hook
// #1002's `still-open` override rides: an override is the one thing that may
// beat the inference, and it is deliberately NOT in this module (it belongs to
// the general override store, spec #996) — `ingestDrop` takes an `isHeldOpen`
// predicate so the two can be composed without this store learning about kinds.
//
// ABSENCE ONLY EVER SPEAKS ABOUT THE POPULATION IT CAN SEE. `ingestDrop` with
// `{ absenceMeansDelivered: false }` adds and refreshes rows and applies the
// scan rule but marks nothing delivered — the answer for the main pull, which
// is a DIFFERENT population from the Post Sort slice (ADR 0021) and is not
// entitled to say a package the slice held is gone. And an EMPTY drop marks
// nothing delivered on either path: "the report parsed to nothing" and "every
// station package was delivered" are the same bytes, and only one of them may
// clear the pane.
//
// THE ROLL PRUNES DELIVERED AND KEEPS OPEN. That is the inverse of every other
// day store here and it is the point of the feature: an open station package is
// carried work that must survive the day boundary with its age visible, while a
// delivered one has already said everything it has to say (spec #996 story 23).
//
// NOTHING IN HERE IS A RECORD. No code, no disposition, no resolution, nothing
// that reaches OPS2 — the same fence lib/ibno-parked.js keeps, for the same
// reason. `status` is carried as the report PRINTED it and is never written.
//
// Dual-loadable with no build step:
// - Browser: window.StationStore
// - Node:    require('./lib/station-store')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.StationStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const SortDay = (root && root.SortDay) ||
      (typeof require === 'function' ? require('./sort-day') : null);
    if (!SortDay) throw new Error('StationStore dependencies unavailable (need SortDay)');
    return { SortDay: SortDay };
  }

  function str(v) { return String(v == null ? '' : v).trim(); }

  const VERSION = 1;

  // THE DELIVERY SCANS (spec #996 story 20). 13 and 14 are the delivery scans
  // the Admin puts on a package handed over at the office; 05 is the third one
  // Tyler named. Compared on the ZERO-PADDED two-character form, because the
  // report prints '05' and a hand-built fixture or an .xlsx read can produce
  // '5'; both are the same scan and neither may read as a code.
  const DELIVERED_SCAN_CODES = ['13', '14', '05'];

  function pad2(code) {
    const s = str(code);
    return /^\d$/.test(s) ? '0' + s : s;
  }

  // scanTokens(status) -> the STATUS_CODES1 list, in report order. The column
  // is '||'-separated (lib/address-match.js reads the same column the same
  // way), and the LAST token is the latest scan.
  function scanTokens(status) {
    return str(status).split('||').map(str).filter(Boolean);
  }

  function latestScan(status) {
    const t = scanTokens(status);
    return t.length ? pad2(t[t.length - 1]) : '';
  }

  // isDeliveredScan(status) -> does this row's LATEST scan say delivered?
  //
  // THE LATEST ONE, never "contains". A package that was delivered, refused and
  // came back carries a delivery scan somewhere in its history and is sitting in
  // the cage right now; reading the whole list would file it delivered and take
  // it off the Admin's list.
  function isDeliveredScan(status) {
    return DELIVERED_SCAN_CODES.indexOf(latestScan(status)) !== -1;
  }

  // isCodedStatus(status) -> a NON-DELIVERY status code, which is what `coded`
  // means on this pane (spec #996 story 21): a 999 or a damage code, visible
  // with its number without the row re-muddying Needs Review. A delivery scan
  // is not a code; a blank column is not a code.
  function isCodedStatus(status) {
    return !!latestScan(status) && !isDeliveredScan(status);
  }

  // ─── THE ROW PROJECTION ───────────────────────────────────────────────────
  //
  // The whitelist, and every field is here because a rendered cell, a count or
  // the age pill reads it. Widening it is a deliberate act with a failing test
  // attached (tests/station-store.test.js pins the list), never a quiet
  // Object.assign that starts carrying whatever a later ticket hangs off an
  // item. Deliberately absent: any area, any code the TOOL applied, any
  // disposition — see the module note.
  const ROW_FIELDS = ['label', 'firm', 'addr2', 'status', 'inboundDate', 'inboundDateRaw',
    'express', 'provenance', 'scanBarcode'];

  // pickRow(item) -> the projected fields that actually have a value. A blank
  // field stays ABSENT rather than becoming '': no reader here distinguishes
  // "never had one" from "had an empty one", so the smaller payload is free
  // (the same call lib/ibno-parked.js's pickParkedRow makes).
  function pickRow(item) {
    const src = (item && typeof item === 'object' && !Array.isArray(item)) ? item : {};
    const out = {};
    ROW_FIELDS.forEach(function (f) {
      const v = str(src[f]);
      if (v) out[f] = v;
    });
    return out;
  }

  function empty(day) {
    return { v: VERSION, day: deps().SortDay.parseInboundDate(day), items: {} };
  }

  // restore(raw) -> the stored state, NOT day-gated.
  //
  // Every other store in this tool restores through SortDay.restoreDayStore,
  // which throws the items away when the stamp is not today. This one must not:
  // an open station package outliving its sort day is the feature, and gating
  // the restore would empty the pane on exactly the morning the age pill exists
  // to make visible. The day roll is an explicit act (see roll below), never a
  // side effect of reading.
  function restore(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return empty(''); }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty('');
    const items = parsed.items;
    const out = empty(parsed.day);
    if (!items || typeof items !== 'object' || Array.isArray(items)) return out;
    Object.keys(items).forEach(function (k) {
      const key = str(k);
      const v = items[k];
      if (!key || !v || typeof v !== 'object' || Array.isArray(v)) return;
      out.items[key] = normalizeEntry(v, key);
    });
    return out;
  }

  function normalizeEntry(value, key) {
    const SortDay = deps().SortDay;
    const src = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    const entry = pickRow(Object.assign({}, src, { label: str(src.label) || str(key) }));
    const firstSeen = SortDay.parseInboundDate(src.firstSeenDay);
    const delivered = SortDay.parseInboundDate(src.deliveredDay);
    if (firstSeen) entry.firstSeenDay = firstSeen;
    if (delivered) entry.deliveredDay = delivered;
    return entry;
  }

  function serialize(store) {
    const s = (store && typeof store === 'object' && !Array.isArray(store)) ? store : {};
    const out = empty(s.day);
    const items = (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) ? s.items : {};
    Object.keys(items).forEach(function (k) {
      const key = str(k);
      if (key) out.items[key] = normalizeEntry(items[k], key);
    });
    return out;
  }

  function entries(store) { return serialize(store).items; }
  function get(store, label) { return entries(store)[str(label)] || null; }
  function has(store, label) { return !!get(store, label); }
  function labels(store) { return Object.keys(entries(store)); }

  // ─── INGEST ───────────────────────────────────────────────────────────────
  //
  // ingestDrop(store, opts) -> a NEW store (the lib/barcode-done.js convention:
  // the caller persists the result and can still hold the previous value).
  //
  //   rows ..................... the station-matched rows THIS drop carries
  //   day ...................... the report's own sort day, never a clock
  //   absenceMeansDelivered .... true only on the Post Sort path
  //   reportCarriedRows ........ how many rows the REPORT carried in total, the
  //                              non-vacuity signal (see below). Defaults to
  //                              rows.length.
  //   isHeldOpen(label) ........ an optional veto, for #1002's `still-open`
  //                              override. Defaults to "nothing is held open".
  //
  // The order is the rule: present rows are refreshed and un-delivered FIRST,
  // then absence is read against what is left. Reversing it would let a row be
  // marked delivered and refreshed open in the same pass, which is two answers.
  function ingestDrop(store, opts) {
    const SortDay = deps().SortDay;
    const o = opts || {};
    const day = SortDay.parseInboundDate(o.day);
    const rows = Array.isArray(o.rows) ? o.rows : [];
    const held = typeof o.isHeldOpen === 'function' ? o.isHeldOpen : function () { return false; };
    const next = serialize(store);
    // An unreadable day is "change nothing": every write below stamps a day,
    // and a wrong sort day would age a package by an arbitrary number of days
    // or file it delivered on a day that never happened.
    if (!day) return next;
    next.day = day;

    const present = Object.create(null);
    rows.forEach(function (item) {
      const label = str(item && item.label);
      if (!label) return;
      present[label] = true;
      const prev = next.items[label] || {};
      const entry = pickRow(Object.assign({}, item, { label: label }));
      // FIRST SEEN NEVER MOVES. It is the age fallback for a package whose
      // report carried no inbound date, so letting a re-drop re-stamp it would
      // reset a three-day-old package to today every time Tyler re-drops.
      entry.firstSeenDay = str(prev.firstSeenDay) || day;
      // WHAT PRESENCE MEANS IS A PROPERTY OF THE PATH, NOT OF THE ROW (PR #1008
      // review finding 1). pickRow rebuilds the entry from the drop and carries
      // no deliveredDay, so without this the mere sight of a row clears the
      // mark — right on one path and wrong on the other:
      //
      //   POST SORT (absenceMeansDelivered) .. the delivery scan is what REMOVES
      //     a package from this report, so a row that is here is here. Presence
      //     outranks yesterday's inference and the mark is cleared.
      //   THE MAIN PULL ................. the full-detail report carries
      //     already-scanned rows — that is the entire reason the caller reads it
      //     off the raw rows rather than the manual list. Presence there is not
      //     evidence of open, so it may not clear a mark the Post Sort made.
      //     Measured on the real 2026-08-13 export, it did: {delivered:3,
      //     needing:3} became {delivered:0, needing:6} at the end-of-day load,
      //     putting three packages the Admin had already walked to the office
      //     back on his list with no click and no warning.
      //
      // On the main path the STATUS column is the only thing entitled to speak:
      // 13/14/05 delivers, any other readable code says the latest scan was not
      // a delivery and clears, and a BLANK column says nothing at all and leaves
      // whatever the Post Sort concluded exactly where it was.
      if (isDeliveredScan(entry.status)) entry.deliveredDay = day;
      else if (!o.absenceMeansDelivered && !str(entry.status) && str(prev.deliveredDay)) {
        entry.deliveredDay = str(prev.deliveredDay);
      }
      next.items[label] = entry;
    });

    if (!o.absenceMeansDelivered) return next;
    // AN EMPTY DROP MARKS NOTHING, and the non-vacuity signal is the size of the
    // REPORT, not of `rows`.
    //
    // This is the difference between the two sentences "the file failed to parse
    // and I am holding nothing" and "the report is here and carries no station
    // packages" — which are the SAME `rows.length === 0` and have opposite
    // answers. The second is the ordinary end of a station package's life (the
    // Admin walked all six to the office) and must deliver them; the first is a
    // broken load and must touch nothing.
    //
    // `reportCarriedRows` defaults to rows.length so a caller that cannot say
    // gets the cautious reading rather than a silent one.
    const carried = typeof o.reportCarriedRows === 'number' ? o.reportCarriedRows : rows.length;
    if (!carried) return next;

    Object.keys(next.items).forEach(function (label) {
      if (present[label]) return;
      const entry = next.items[label];
      if (str(entry.deliveredDay)) return;   // already delivered; do not re-date
      if (held(label)) return;               // #1002's override beats the rule
      next.items[label] = Object.assign({}, entry, { deliveredDay: day });
    });
    return next;
  }

  // undeliver(store, label) / remove(store, label) -> a NEW store. The Undo and
  // the "Not ours" move (#1001/#1002) are the callers; the store offers the two
  // edits so those tickets add no shape of their own.
  function undeliver(store, label) {
    const next = serialize(store);
    const entry = next.items[str(label)];
    if (!entry) return next;
    const copy = Object.assign({}, entry);
    delete copy.deliveredDay;
    next.items[str(label)] = copy;
    return next;
  }

  function remove(store, label) {
    const next = serialize(store);
    delete next.items[str(label)];
    return next;
  }

  // ─── THE ROLL ─────────────────────────────────────────────────────────────
  //
  // roll(store, day) -> delivered rows pruned, open rows kept, stamp moved.
  //
  // ONLY EVER FORWARD, on SortDay.isLaterSortDay — the same monotonic clock the
  // whole tool reads. At 1:30 AM the main pull available is often YESTERDAY's
  // report worked alongside today's Post Sort; a roll on any change of day
  // would prune the delivered rows of the shift actually being worked, twice a
  // night. An unreadable day changes nothing at all.
  function roll(store, day) {
    const SortDay = deps().SortDay;
    const next = serialize(store);
    const to = SortDay.parseInboundDate(day);
    if (!to) return next;
    if (!SortDay.isLaterSortDay(to, next.day)) return next;
    const out = empty(to);
    Object.keys(next.items).forEach(function (label) {
      const entry = next.items[label];
      if (str(entry.deliveredDay)) return;   // said everything it had to say
      out.items[label] = entry;
    });
    return out;
  }

  // ─── READING THE STORE ────────────────────────────────────────────────────

  function isDelivered(entry) { return !!(entry && str(entry.deliveredDay)); }
  function isCoded(entry) { return !!entry && !isDelivered(entry) && isCodedStatus(entry.status); }
  function isOpen(entry) { return !!entry && !isDelivered(entry) && !isCoded(entry); }

  // rowState(entry) -> 'delivered' | 'coded' | 'open'. One function answers it,
  // so the badge, the header line and the row mark cannot disagree about what a
  // row is (ADR 0022's rule: one predicate per question).
  function rowState(entry) {
    if (isDelivered(entry)) return 'delivered';
    if (isCoded(entry)) return 'coded';
    return 'open';
  }

  // counts(rows) -> { total, delivered, needing, coded, open }, over the rows
  // the pane is DRAWING. Read off the drawn rows and never off the raw store,
  // so the number on the badge can never claim a row that is not under it — the
  // property #696 named and every tab in this strip keeps.
  //
  //   total   = open + delivered + coded
  //   needing = open + coded          (spec #996: the badge)
  function counts(rows) {
    const list = Array.isArray(rows) ? rows : [];
    let open = 0, delivered = 0, coded = 0;
    list.forEach(function (entry) {
      const state = rowState(entry);
      if (state === 'delivered') delivered++;
      else if (state === 'coded') coded++;
      else open++;
    });
    return {
      total: open + delivered + coded,
      delivered: delivered,
      needing: open + coded,
      coded: coded,
      open: open,
    };
  }

  // ─── AGE ──────────────────────────────────────────────────────────────────
  //
  // ageDays(entry, day) -> how many days this package has been sitting, or null
  // when there is nothing to claim.
  //
  // SINCE THE INBOUND DATE (the ticket's own words), falling back to the day
  // this tool first saw it when the report carried none — the same fallback
  // order the "Came in" cell uses, and it is marked as a fallback there.
  // Negative is impossible-looking data (an inbound date in the future), and it
  // answers null rather than a negative number of days.
  function ageDays(entry, day) {
    const SortDay = deps().SortDay;
    const e = entry || {};
    const from = SortDay.parseInboundDate(e.inboundDate) ||
                 SortDay.parseInboundDate(e.inboundDateRaw) ||
                 SortDay.parseInboundDate(e.firstSeenDay);
    const to = SortDay.parseInboundDate(day);
    if (!from || !to) return null;
    const days = dayNumber(to) - dayNumber(from);
    return days >= 0 ? days : null;
  }

  function dayNumber(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return null;
    return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
  }

  // isCarried(entry, day) -> was this package first seen on an EARLIER sort day?
  //
  // Strict, like IbnoParked.carriedParkNote: a package first seen today is not
  // carried, whatever its inbound date says. An entry with no firstSeenDay
  // claims nothing.
  function isCarried(entry, day) {
    const SortDay = deps().SortDay;
    const seen = SortDay.parseInboundDate(entry && entry.firstSeenDay);
    if (!seen) return false;
    return SortDay.isLaterSortDay(day, seen);
  }

  // ageNote(entry, day) -> the age pill for a CARRIED row, or null.
  //
  // Null on a row first seen today: an age pill on every row is not a signal,
  // and the "Came in" cell already says the date. The wording is the same
  // singular/plural care lib/sort-day.js's noteLine takes — "1 days" reads as a
  // bug and undermines the rest of the row.
  function ageNote(entry, day) {
    if (!isCarried(entry, day)) return null;
    const days = ageDays(entry, day);
    if (days == null || days < 1) return null;
    return {
      days: days,
      text: days + (days === 1 ? ' day' : ' days'),
      title: 'This station package came in ' + days + (days === 1 ? ' day' : ' days') +
        ' ago and is still here. It carried across the sort-day boundary rather than ' +
        'being thrown away.',
    };
  }

  return {
    VERSION: VERSION,
    ROW_FIELDS: ROW_FIELDS,
    DELIVERED_SCAN_CODES: DELIVERED_SCAN_CODES,

    latestScan: latestScan,
    isDeliveredScan: isDeliveredScan,
    isCodedStatus: isCodedStatus,

    empty: empty,
    restore: restore,
    serialize: serialize,
    entries: entries,
    get: get,
    has: has,
    labels: labels,
    pickRow: pickRow,

    ingestDrop: ingestDrop,
    undeliver: undeliver,
    remove: remove,
    roll: roll,

    isDelivered: isDelivered,
    isCoded: isCoded,
    isOpen: isOpen,
    rowState: rowState,
    counts: counts,

    ageDays: ageDays,
    isCarried: isCarried,
    ageNote: ageNote,
  };
});
