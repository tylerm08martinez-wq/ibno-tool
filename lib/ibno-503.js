'use strict';

// IBNO Coder: 503s, the bad-address flag (issue #699, spec #690 user stories
// 17 and 18, decision record #615, store shape #614).
//
// Dual-loadable with no build step:
// - Browser: window.Ibno503
// - Node: require('./lib/ibno-503')
//
// 503 is a DUMMY ROUTE, not a real van work area. Tyler types 503 into Goes
// To, the package shows 503 at re-inbound, and the team stages it on a
// separate pallet and fixes the address when they have slack (#615: "my team
// should be the ones doing those since they have high visibility and they are
// there for them"). The flag IS the existing Goes To box with 503 in it —
// there is no new disposition control, and no OPS2 code, ever.
//
// TWO SEPARATE THINGS LIVE IN HERE, and keeping them apart is the point:
//
//   1. THE FLAG, which is not a store at all. A row is filed 503 exactly when
//      its Goes To area reads 503, so membership of the 503s tab is DERIVED
//      from lib/actual-area.js rather than duplicated into a second set. That
//      is deliberate: a second store could disagree with the box, and the box
//      is what the sorter reads at re-inbound. It also means 503 state gets
//      the sort-day lifetime, the same-day re-drop survival and the F5
//      restore of the area store for free (#690 story 22), with no second
//      thing to expire.
//
//   2. THE LOG, which IS a store: every 503 assignment, auto-recorded with
//      zero extra keystrokes, so the tool can answer "did anyone actually fix
//      this address" on a LATER sort day. It is device-local and NEVER
//      SYNCED — it carries street addresses, which are PII, and ADR 0016's
//      Decision item 2 is the wall: syncing address data would be the first
//      time it left the device, the most irreversible failure class. It fails
//      ADR 0018's durability test in the cheap direction anyway, since it is
//      re-derivable from the session archives. Pruned at 30 days, the same
//      window Repeat History and the dated notes use.
//
// ─── THE REAPPEARANCE MATCH KEY: BUILDING LEVEL, NOT UNIT-EXACT ────────────
//
// Settled by Tyler on issue #699, 2026-08-19. DO NOT RE-LITIGATE.
//
//   - Label matching cannot work here at all. 503s are logged by ADDRESS, but
//     rows are keyed by label (tracking number) everywhere in this codebase,
//     and a re-shipped package arrives with a NEW tracking number.
//   - The question the signal answers is "did anyone actually fix this
//     address". An address reappearing at a different unit is still an
//     unfixed address, so a unit-exact key would miss the common case.
//   - The costs are asymmetric. The signal is a quiet count, so a false
//     positive costs a glance while a false negative costs the entire point
//     of the flag.
//
// NOTE THE DELIBERATE ASYMMETRY WITH DOCK FLEX. The unit-exact rule elsewhere
// in this feature governs Goes To AREA PROPAGATION, where handing a sorter the
// wrong area is a records-tier error, so it uses IbnoWorkLoop's unit-exact
// stop key. Reappearance detection is a different concern with different
// stakes. The two rules are MEANT to diverge; unifying them would break one of
// them whichever way it went.
//
// The key itself is lib/address-normalize.js's stripUnitTokens, which already
// exists as the repo's building-level key (house number through the street
// suffix, everything after it dropped). No second key was invented for this.
//
// Confidence on record: moderate (~70%). What would revise it: if the
// station's 503s turn out to be mostly unit-level errors where the building
// itself is fine.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Ibno503 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // The dummy route itself. One spelling, read by the tool and by every rule
  // below, so "is this a 503" can never be answered two ways.
  const AREA = '503';

  // 30 days, the same window Repeat History (IbnoRules.HISTORY_DAYS) and the
  // dated notes (SortDay.NOTE_DAYS) use, so "how far back this tool
  // remembers" is one number everywhere. Counted in SORT days.
  const LOG_DAYS = 30;

  function deps() {
    const SortDay = (root && root.SortDay) ||
      (typeof require === 'function' ? require('./sort-day') : null);
    const AddressNormalize = (root && root.AddressNormalize) ||
      (typeof require === 'function' ? require('./address-normalize') : null);
    if (!SortDay || !AddressNormalize) {
      throw new Error('Ibno503 dependencies unavailable (need SortDay and AddressNormalize)');
    }
    return { SortDay: SortDay, AddressNormalize: AddressNormalize };
  }

  function str(v) { return String(v == null ? '' : v).trim(); }

  // ─── THE FLAG ─────────────────────────────────────────────────────────────

  // is503(area) -> whether this Goes To value files the row. Folded the same
  // way lib/actual-area.js normalizes a typed area (trim + uppercase), so
  // " 503 " files the row exactly like "503" does. Nothing else matches: a
  // work area that merely CONTAINS 503 ("5030", "BELT 503") is a real area and
  // must keep behaving like one.
  function is503(area) {
    return str(area).toUpperCase() === AREA;
  }

  // filedRows(items, areaOf) -> the rows the 503s tab shows: the items of THIS
  // list whose Goes To area is 503, in the list's own order.
  //
  // Reading the loaded list rather than the store is the same scoping rule
  // lib/ibno-parked.js's parkedRows makes: the tab can never claim a package
  // the report in front of Tyler no longer carries.
  function filedRows(items, areaOf) {
    const read = typeof areaOf === 'function' ? areaOf : function () { return ''; };
    return (Array.isArray(items) ? items : []).filter(function (it) {
      return !!it && is503(read(it));
    });
  }

  function filedCount(items, areaOf) {
    return filedRows(items, areaOf).length;
  }

  // ─── THE BUILDING KEY ─────────────────────────────────────────────────────

  // buildingKey(address) -> the reappearance match key. See the header for why
  // this is BUILDING level and not unit-exact (Tyler, issue #699, 2026-08-19).
  function buildingKey(address) {
    return deps().AddressNormalize.stripUnitTokens(address);
  }

  // ─── THE LOG ──────────────────────────────────────────────────────────────
  //
  // Shape: { [buildingKey]: { address, day, lastDay, labels: [label, ...] } }
  //
  //   address  the address as it was typed on the report, kept for display
  //            only — the MATCH is always on the key, never on this string
  //   day      the sort day this address was FIRST flagged, which is what a
  //            reappearance is measured against
  //   lastDay  the sort day it was MOST RECENTLY flagged, which is what the
  //            30-day prune is measured against. The two are deliberately
  //            different numbers: `day` must never advance (see record) or the
  //            reappearance signal resets itself on every re-filing, but
  //            pruning on a never-advancing day retires the entry 30 days after
  //            it was FIRST seen — so an address flagged on day 0 and again on
  //            day 25 went quiet on day 31, six days after the last filing, on
  //            exactly the address that is still circulating. One field could
  //            not answer both questions.
  //   labels   the tracking numbers flagged at this address, so the log's
  //            grain is the address with a package count (#615: "the log's
  //            natural grain is the address with a package count"). Deduped;
  //            dock-flexed siblings share the stop and land here together.
  //
  // Every writer returns a NEW log, the lib/barcode-done.js convention.

  function restore(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return {}; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const SortDay = deps().SortDay;
    const out = {};
    Object.keys(parsed).forEach(function (k) {
      const key = str(k);
      const v = parsed[k];
      if (!key || !v || typeof v !== 'object' || Array.isArray(v)) return;
      const day = SortDay.parseInboundDate(v.day);
      // An entry with no readable day cannot answer "has it reappeared
      // SINCE", which is the only question the log exists to answer, and it
      // could never be pruned either. Dropped rather than kept as a
      // permanent unanswerable row.
      if (!day) return;
      const labels = [];
      const seen = Object.create(null);
      (Array.isArray(v.labels) ? v.labels : []).forEach(function (l) {
        const s = str(l);
        if (!s || seen[s]) return;
        seen[s] = true;
        labels.push(s);
      });
      // A payload written before lastDay existed carries only `day`, and that
      // is the truest thing known about it: the entry was flagged then and
      // there is no record of a later filing. Defaulting to `day` keeps such
      // an entry pruning exactly as it did before rather than becoming
      // immortal or vanishing.
      const lastDay = SortDay.parseInboundDate(v.lastDay) || day;
      out[key] = {
        address: str(v.address),
        day: day,
        lastDay: SortDay.isLaterSortDay(day, lastDay) ? day : lastDay,
        labels: labels,
      };
    });
    return out;
  }

  function serialize(log) {
    return restore(log);
  }

  // record(log, entry) -> the log with this 503 assignment in it.
  //
  // entry: { label, address, day }
  //
  // THE DAY DOES NOT MOVE FORWARD on a repeat. An entry's `day` is the sort
  // day the address was FIRST flagged, because that is what a reappearance is
  // measured against: rolling it forward every time the same address is
  // flagged again would make the entry permanently "quiet" — each new filing
  // would reset the clock the signal reads. An EARLIER day does win, since it
  // is a truer first-flagged date.
  //
  // An address with no readable building key, or a filing with no readable
  // sort day, records NOTHING. The refusal is the same one lib/sort-day.js
  // makes everywhere: a log entry that cannot be matched or pruned is worse
  // than no entry, because it is invisible and permanent.
  function record(log, entry) {
    const SortDay = deps().SortDay;
    const next = restore(log);
    const e = entry || {};
    const key = buildingKey(e.address);
    const day = SortDay.parseInboundDate(e.day);
    const label = str(e.label);
    if (!key || !day) return next;
    const prev = next[key];
    const labels = prev ? prev.labels.slice() : [];
    if (label && labels.indexOf(label) === -1) labels.push(label);
    next[key] = {
      address: str(e.address) || (prev ? prev.address : ''),
      day: prev && !SortDay.isLaterSortDay(day, prev.day) ? day : (prev ? prev.day : day),
      // The prune's clock, and the only one of the two that moves FORWARD.
      lastDay: prev && !SortDay.isLaterSortDay(day, prev.lastDay) ? prev.lastDay : day,
      labels: labels,
    };
    return next;
  }

  // unrecord(log, entry) -> the log with this package's filing taken back.
  //
  // Typing 503 is one keystroke away from typing 5030 or 503 into the wrong
  // row, and the correction is to retype the box. The log must follow that
  // correction or a typo becomes a 30-day "not fixed" signal about an address
  // nobody ever flagged. The ENTRY survives while any other package at the
  // building is still filed, because the entry is about the address and not
  // about one package; it is removed only when the last one leaves.
  function unrecord(log, entry) {
    const next = restore(log);
    const e = entry || {};
    const key = buildingKey(e.address);
    const label = str(e.label);
    const prev = next[key];
    if (!key || !prev) return next;
    const labels = prev.labels.filter(function (l) { return l !== label; });
    if (!labels.length) { delete next[key]; return next; }
    next[key] = { address: prev.address, day: prev.day, lastDay: prev.lastDay, labels: labels };
    return next;
  }

  // prune(log, day, days) -> entries whose LAST filing is within `days` SORT
  // days of `day`.
  //
  // Measured on lastDay and never on day. Pruning on the first-flagged day
  // retired an entry 30 days after it was first seen however recently it was
  // re-flagged, so the not-fixed signal went quiet on precisely the address
  // that kept coming back — the false negative this whole feature is built to
  // avoid. See the log's shape comment for why the two days are separate.
  //
  // `day` is supplied by the caller, which passes the loaded report's sort
  // day. NO AMBIENT CLOCK: the 1:30 AM sort straddles midnight on the device,
  // so a device-date prune would drop a day early or late at random (#695).
  // An unknown day prunes nothing — with no reference point, deleting an entry
  // would be arbitrary.
  function prune(log, day, days) {
    const SortDay = deps().SortDay;
    const next = restore(log);
    const now = dayNumber(SortDay, day);
    if (now == null) return next;
    const window = typeof days === 'number' && days >= 0 ? days : LOG_DAYS;
    Object.keys(next).forEach(function (key) {
      const d = dayNumber(SortDay, next[key].lastDay);
      if (d == null || now - d > window) delete next[key];
    });
    return next;
  }

  function dayNumber(SortDay, iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(SortDay.parseInboundDate(iso));
    if (!m) return null;
    return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
  }

  // ─── THE REAPPEARANCE SIGNAL ──────────────────────────────────────────────

  // reappeared(log, items, day) -> the logged addresses that are BACK:
  // [{ key, address, day, labels, packages }], one per address, in the log's
  // own insertion order.
  //
  // An entry has reappeared when BOTH hold:
  //
  //   the report on screen is from a STRICTLY LATER sort day than the day the
  //     address was flagged — a same-day re-drop is the same sort, and the
  //     packages Tyler flagged an hour ago are obviously still in it. Reading
  //     that as "not fixed" would light the signal on every single filing the
  //     moment it was made, which is the signal saying nothing at all; and
  //   some row in that report is at the same BUILDING (see the header).
  //
  // `packages` counts the rows in TODAY's report at that building, not the
  // labels stored on the entry: the stored labels are the packages that were
  // flagged, and the ones back today are a different set with different
  // tracking numbers. That count is the thing worth glancing at.
  //
  // Pure and computed live off the loaded report — nothing about "has it
  // reappeared" is persisted, so the answer can never go stale against the
  // report in front of him.
  function reappeared(log, items, day) {
    const SortDay = deps().SortDay;
    const entries = restore(log);
    const today = SortDay.parseInboundDate(day);
    if (!today) return [];
    const present = Object.create(null);
    (Array.isArray(items) ? items : []).forEach(function (it) {
      const key = buildingKey(it && it.address);
      if (!key) return;
      present[key] = (present[key] || 0) + 1;
    });
    const out = [];
    Object.keys(entries).forEach(function (key) {
      const e = entries[key];
      if (!SortDay.isLaterSortDay(today, e.day)) return;
      if (!present[key]) return;
      out.push({
        key: key,
        address: e.address,
        day: e.day,
        labels: e.labels.slice(),
        packages: present[key],
      });
    });
    return out;
  }

  function reappearedCount(log, items, day) {
    return reappeared(log, items, day).length;
  }

  // filedChipText(count) -> the counted trace for rows that LEFT the working
  // list into the 503s tab. Same register as the parked chip: nothing vanishes
  // without a number, and nothing reads "0" (#611).
  function filedChipText(count) {
    const n = Number(count) || 0;
    return n > 0 ? ('🚫 ' + n + ' filed 503') : '';
  }

  // chipText(count) -> the REAPPEARANCE signal, a separate quiet count (#615
  // point 3, #690 story 18). Deliberately its own chip rather than a second
  // meaning bolted onto the filed count: "filed today" and "flagged before and
  // still coming back" are different facts, and a chip that changed meaning
  // depending on which was nonzero would be unreadable.
  //
  // Empty at zero, and that emptiness IS the answer: quiet means presumed done.
  function chipText(count) {
    const n = Number(count) || 0;
    return n > 0 ? ('⚠ ' + n + ' not fixed') : '';
  }

  return {
    AREA: AREA,
    LOG_DAYS: LOG_DAYS,

    is503: is503,
    filedRows: filedRows,
    filedCount: filedCount,

    buildingKey: buildingKey,

    restore: restore,
    serialize: serialize,
    record: record,
    unrecord: unrecord,
    prune: prune,

    reappeared: reappeared,
    reappearedCount: reappearedCount,
    filedChipText: filedChipText,
    chipText: chipText,
  };
});
