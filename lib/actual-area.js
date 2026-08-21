'use strict';

// Actual work area — the belt/area a package REALLY goes to, as decided by the
// supervisor working the review list, and carried onto the barcode so the
// person walking the package doesn't have to come back and look it up.
//
// Dual-loadable with no build step:
// - Browser: window.ActualArea
// - Node: require('./lib/actual-area')
//
// WHY IT IS NOT THE REPORT'S WORK AREA: IB_WORK_AREA is what the package was
// scanned to — frequently the very thing that flagged it for review. The actual
// area is a human judgement laid on top. The two are shown side by side and
// never overwrite each other; nothing in this module reads or writes a package
// code, disposition, or category.
//
// ─── THE TWO ADDRESS KEYS ───────────────────────────────────────────────────
//
// This module deliberately keeps two different notions of "same address", and
// the difference is the whole safety story:
//
//   exactKey   — unit-preserving. "APT 2" and "APT 5" are DIFFERENT. This is
//                what PROPAGATION uses, so typing an area on one package can
//                never put a different apartment's package on the wrong belt.
//
//   clusterKey — building-level, unit stripped. "APT 2" and "APT 5" are the
//                SAME. This is what SORTING uses, so every package for one
//                building sits together in the list and can be worked in one
//                pass.
//
// Both fold formatting: "1234 N Main St" and "1234 NORTH MAIN STREET" match
// under either key, because both run through lib/address-normalize.js — the
// same canonicalization the Address Catcher joins addresses with, so the two
// tools can never disagree about what one address is.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ActualArea = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const AddressNormalize = (root && root.AddressNormalize) ||
      (typeof require === 'function' ? require('./address-normalize') : null);
    if (!AddressNormalize) {
      throw new Error('ActualArea dependencies unavailable (need AddressNormalize)');
    }
    return { AddressNormalize: AddressNormalize };
  }

  const MAX_LEN = 24;      // an area label, not a notes field
  const DEFAULT_DAYS = 30; // matches the Repeat History retention window

  // ─── VALUES ───────────────────────────────────────────────────────────────

  // normalizeArea(raw) -> the stored form of a typed work area: trimmed,
  // inner whitespace collapsed, uppercased, length-capped. Uppercasing means
  // "belt a" and "Belt A" are one value on the print sheet instead of two.
  function normalizeArea(raw) {
    return String(raw == null ? '' : raw)
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase()
      .slice(0, MAX_LEN);
  }

  // isMatchable(key) -> whether a normalized address is specific enough to say
  // two packages go to the SAME PLACE.
  //
  // Found by /verify against a real Inbound and Van Scans export (2026-07-08):
  // rows whose LABEL_ADDRESS1 is empty compose down to nothing but a ZIP —
  // " 85032" normalizes to "85032". Five such rows sat in one review list, and
  // without this guard they all matched each other, so a work area typed on one
  // would have auto-filled unrelated packages that merely share a ZIP code. A
  // ZIP is a region, not a destination; propagating across one is precisely the
  // wrong-belt error this feature must never make.
  //
  // The rule: a matchable address begins with a house number and has at least
  // one more token. "9782 E SOUTH BEND DR SCOTTSDALE AZ 85255" qualifies;
  // "85032" and a bare city do not. Anything unmatchable returns '', which
  // propagation skips entirely and cmpBlankLast sorts to the end.
  //
  // Deliberately conservative: an address form that does not lead with a number
  // (a PO box, a named campus) simply gets no clustering. Losing a convenience
  // is cheap; merging two different destinations is not.
  function isMatchable(key) {
    if (!key) return false;
    const tokens = key.split(' ').filter(Boolean);
    if (tokens.length < 2) return false;
    return /^\d/.test(tokens[0]);
  }

  // exactKey(address) -> unit-PRESERVING match key. Propagation key.
  function exactKey(address) {
    const key = deps().AddressNormalize.normalizeAddress(address);
    return isMatchable(key) ? key : '';
  }

  // clusterKey(address) -> building-level match key, unit markers and their
  // numbers removed. Sorting key.
  function clusterKey(address) {
    const AN = deps().AddressNormalize;
    const key = AN.normalizeAddress(AN.stripUnitTokens(address));
    return isMatchable(key) ? key : '';
  }

  // ─── STORE ────────────────────────────────────────────────────────────────
  //
  // Shape: { [trackingLabel]: { area: 'BELT 12', date: '2026-08-08', auto?: true, early?: true } }
  // The date is the day the area was entered, and exists only so prune() can
  // drop stale entries — it is never shown and never compared for correctness.
  //
  // `auto` is PROVENANCE: true means propagation wrote this value, false/absent
  // means a human typed it on this row. Without it "never overwrite" also
  // protects a value this feature wrote, so correcting a mistake leaves the
  // other package at that address on the old belt and printBarcodesFor puts two
  // different belts on two cards for one stop. An entry restored from an older
  // snapshot has no flag and is therefore treated as hand-typed: never sweep a
  // value we cannot prove this feature wrote.
  //
  // `early` is a THIRD provenance state (issue #634, decided with Tyler on
  // #622/#612): a value written by the Post Sort pre-assignment lane, ahead
  // of the slower full report. It pre-fills Goes To exactly like any other
  // value, but MUST NOT satisfy "scanned" — see isScanned() below. A boolean
  // `auto` cannot hold three states, so this is a second, independent optional
  // flag rather than widening `auto`; that keeps every pre-existing entry
  // (which never carries `early`) reading exactly as it always has — a
  // migration that runs by construction (this module's own read path) rather
  // than a separate pass that could be ordered after code that depends on it.
  // `early` and `auto` ARE both set together, on exactly one kind of entry: a
  // sibling that setEarly's propagation filled (2026-08-17). It is auto because
  // no one typed it on that row, and early because it is still unconfirmed, and
  // both facts are true at once. Every other writer sets at most one of them,
  // and restore() tolerates any combination from a hand-edited snapshot.

  function restore(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return {}; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    Object.keys(parsed).forEach(function (label) {
      const v = parsed[label];
      if (!v) return;
      // Tolerate a bare string from any earlier/hand-edited snapshot.
      const area = normalizeArea(typeof v === 'string' ? v : v.area);
      if (!area) return;
      const date = typeof v === 'object' && v.date ? String(v.date) : '';
      const entry = { area: area, date: date };
      // Only carry a flag when it is set, so a hand-typed entry keeps the
      // plain two-key shape it has always had on disk.
      if (typeof v === 'object' && v.auto) entry.auto = true;
      if (typeof v === 'object' && v.early) entry.early = true;
      out[String(label)] = entry;
    });
    return out;
  }

  function serialize(store) {
    return restore(store);
  }

  function get(store, label) {
    const e = store && store[String(label)];
    return e ? e.area : '';
  }

  // ─── WRITE + PROPAGATION ──────────────────────────────────────────────────

  // set(store, label, area, opts) -> { store, changed }
  //
  // Returns a NEW store (the caller persists it) plus `changed`: every label
  // whose value actually moved, so the tool repaints just those rows.
  //
  //   opts.items  [{ label, address }] — the rows currently in review. When
  //               present, the area also fills every OTHER row at the exact
  //               same address that is still BLANK.
  //   opts.today  'YYYY-MM-DD' stamp for prune(). Callers pass it in; this
  //               module never reads a clock.
  //
  // Two rules make propagation safe to leave switched on:
  //   1. A HAND-TYPED value on another row is never overwritten — the human who
  //      typed it wins. Rows this feature auto-filled carry `auto` and ARE
  //      updated, so a correction reaches the packages the mistake reached.
  //      Typing on a row always claims it as hand-typed, so a supervisor can
  //      pin one package's area and later corrections leave it alone. An
  //      `early` value (issue #634 — a Post Sort pre-assignment guess) is NOT
  //      hand-typed and must lose here too: it was never confirmed against a
  //      scan on this report, so a human typing the real value on a sibling
  //      overwrites it exactly like an auto value would. Fixed 2026-08-12
  //      (/code-review on #642): the guard used to read `!e.auto`, which
  //      treated an early entry as if a human had typed it — the unconfirmed
  //      guess silently survived a human's correction on the sibling that
  //      should have overwritten it.
  //   2. CLEARING a row (area '') erases that row and the values propagation
  //      wrote FROM it, and nothing else. Those values only existed because of
  //      the row being erased; leaving them is how a stale belt reaches a
  //      printed card. A typed value at the same address still survives. An
  //      `early` sibling is deliberately NOT swept here: setEarly() never
  //      propagates (it only ever answers for the exact label it was fed), so
  //      an early sibling's value was never "caused by" this row in the first
  //      place — there is nothing for this rule to be sweeping away. The only
  //      way an early sibling becomes eligible for this sweep is by first
  //      being promoted to `auto` via rule 1 above, at which point the
  //      existing `auto`-only check already covers it correctly.
  function set(store, label, area, opts) {
    const o = opts || {};
    const next = restore(store);
    const key = String(label);
    const value = normalizeArea(area);
    const stamp = o.today ? String(o.today) : '';
    const changed = [];

    // The OTHER rows at the exact same address (unit included). Empty when the
    // caller passed no review list, or when the address is too vague to match.
    function siblings() {
      const items = o.items;
      if (!items || !items.length) return [];
      const target = exactKey(addressOf(items, key));
      if (!target) return [];
      const out = [];
      items.forEach(function (item) {
        const l = item && String(item.label);
        if (!l || l === key) return;
        if (exactKey(item.address) !== target) return;
        out.push(l);
      });
      return out;
    }

    const before = get(next, key);

    if (!value) {
      if (before) { delete next[key]; changed.push(key); }
      siblings().forEach(function (l) {
        const e = next[l];
        if (!e || !e.auto) return;   // rule 1: a typed value is not ours to erase
        delete next[l];
        changed.push(l);
      });
      return { store: next, changed: changed };
    }

    if (before !== value) changed.push(key);
    // Written unconditionally: re-typing the value a row was auto-filled with
    // adopts it as hand-typed, which is how a supervisor pins one package.
    next[key] = { area: value, date: stamp };

    siblings().forEach(function (l) {
      const e = next[l];
      // rule 1: never overwrite a genuinely hand-typed value — but DO overwrite
      // both `auto` (propagated) and `early` (Post Sort guess, issue #634)
      // values, since neither was typed by a human.
      if (e && !e.auto && !e.early) return;
      // Already correct AND already confirmed — no needless repaint. An early
      // sibling whose guess happens to already match the typed value still
      // falls through: it must be promoted off `early` to `auto` so it stops
      // reading as an unconfirmed guess now that a human has confirmed it.
      if (e && e.area === value && !e.early) return;
      next[l] = { area: value, date: stamp, auto: true };
      changed.push(l);
    });

    return { store: next, changed: changed };
  }

  function addressOf(items, label) {
    for (let i = 0; i < items.length; i++) {
      if (items[i] && String(items[i].label) === label) return items[i].address;
    }
    return '';
  }

  // matchesFor(items, label) -> the OTHER labels at the exact same address.
  // Used to tell the human "this filled 3 other rows" rather than having rows
  // change silently underneath them.
  function matchesFor(items, label) {
    const list = items || [];
    const target = exactKey(addressOf(list, String(label)));
    if (!target) return [];
    return list
      .filter(function (i) { return i && String(i.label) !== String(label) && exactKey(i.address) === target; })
      .map(function (i) { return String(i.label); });
  }

  // ─── WORKING THROUGH A LIST ───────────────────────────────────────────────

  // isAuto(store, label) -> was this value written by propagation rather than
  // typed on this row? The tool tags those rows so a filled-in area that the
  // supervisor never typed is visible rather than surprising.
  function isAuto(store, label) {
    const e = store && store[String(label)];
    return !!(e && e.auto);
  }

  // isEarly(store, label) -> was this value written by the Post Sort
  // pre-assignment lane (issue #634), ahead of the full report? Distinct from
  // isAuto: an early value was never confirmed against a scan on the report
  // this tool actually runs, so it must never be mistaken for a worked row.
  function isEarly(store, label) {
    const e = store && store[String(label)];
    return !!(e && e.early);
  }

  // isAnswered(store, label) -> does this row carry a work area at all,
  // whatever wrote it? ADR 0022's **answered** state, and the question two
  // consumers ask: the Work-mode cursor (does this row still need FRO?) and the
  // progress bar's worked half (does it carry an area?).
  //
  // It is a SEPARATE reader rather than a widening of isScanned(), and that is
  // ADR 0022 invariant 7. Widening isScanned would make a dock-flexed sibling
  // count as scanned, and the bar would begin reporting a stop finished because
  // one of its packages was — invariant 1, and #612 decision 3 in Tyler's words:
  // "i scan each package individually."
  //
  // Why it had to exist (issues #740, #778): ADR 0021 gave the Post Sort report
  // the main slot, and every Post Sort area is written through setEarly, which
  // stamps `early: true`. isScanned is `area && !early`, so on a normal day it
  // can NEVER fire — the cursor stopped on every row Tyler had just answered and
  // the bar's worked numerator was structurally 0. Nobody changed either
  // consumer; the meaning moved underneath them.
  //
  // Provenance-blind on purpose. get() answers "what goes in the box" and is
  // also provenance-blind; this answers "is there an answer", and the two agree
  // by construction.
  function isAnswered(store, label) {
    const e = store && store[String(label)];
    return !!(e && e.area);
  }

  // isScanned(store, label) -> whether this package should count as WORKED for
  // stepWork, the Work-mode progress bar, and anything else that means "the
  // supervisor is done with this row" — as opposed to get(), which answers
  // "is there a value to show in the Goes To box" and is deliberately
  // provenance-blind so pre-filled areas still display.
  //
  // An early value fails this on purpose (issue #634): without the
  // distinction, pre-typing an area from the fresher-but-thinner Post Sort
  // report would make a package that turns out to be a QA-Intercept, an
  // Invalid HazMat, a Closure Portal, or a Hold to Match on the REAL report
  // filter itself off the working list unseen — the exact silent-disappearance
  // failure this provenance exists to prevent. A plain hand-typed or
  // propagated (auto) value — including every entry that predates this
  // feature and therefore carries no `early` flag at all — still counts,
  // unchanged from before this ticket.
  function isScanned(store, label) {
    const e = store && store[String(label)];
    return !!(e && e.area && !e.early);
  }

  // setEarly(store, label, area, opts) -> { store, changed }
  //
  // Writes a Post Sort pre-assignment value (issue #634), and — given opts.items
  // — spreads it across the same unit-exact stop, exactly as set() does.
  //
  // 2026-08-17: it did NOT spread until now, and that was #642's call: "the
  // pre-assignment pass only ever answers for the exact label it was fed, so
  // extending a guess across a cluster would be a second guess stacked on the
  // first." That reasoning treats an early value as a guess made BY the tool.
  // It is not one. Every value reaching this function came off the blur handler
  // of a box the supervisor typed into after an FRO lookup — the same act, from
  // the same source, as a Manual Review row, which has always spread. `early`
  // marks "not yet confirmed against a scan on the report this tool runs", which
  // is why isScanned() excludes it; it does not mark "guessed".
  //
  // What made the gap bite: #662 moved these rows INSIDE Needs Manual Review,
  // where they look identical to the rows that spread, and ADR 0021 gave a Post
  // Sort report the main slot outright. So on a Post Sort day every box the
  // supervisor types into is the one that does not spread, and typing a stop
  // once stopped covering the stop.
  //
  // THE HARD REQUIREMENT IS UNCHANGED and now governs siblings as well as the
  // typed row: an early write must never overwrite ANY value it did not itself
  // write — hand-typed, propagated (auto), or an already-scanned row from before
  // this feature existed. The only entry it may touch is one that is ALREADY
  // early (updating its own prior value, e.g. on a Post Sort re-drop) or one
  // that does not exist yet. Clearing (area '') follows the same rule on both.
  //
  // A sibling filled here is stamped `early` as well as `auto`: `auto` so the
  // "same addr" tag shows and an area the supervisor never typed is never
  // silent, `early` so isScanned() still reads it as unworked. That last part is
  // what makes this strictly safer than set()'s propagation — it fills the box
  // without marking the package done, so Work mode still stops on the row and
  // #621's "a typed value reads as scanned" cannot be reached through here.
  function setEarly(store, label, area, opts) {
    const o = opts || {};
    const next = restore(store);
    const key = String(label);
    const value = normalizeArea(area);
    const stamp = o.today ? String(o.today) : '';
    const before = next[key];
    const changed = [];
    const oursToTouch = (e) => !e || !!e.early;

    // The other rows at this exact address (unit included), or none when the
    // caller passed no list and no address is matchable.
    const siblings = o.items ? matchesFor(o.items, key) : [];

    if (!value) {
      if (oursToTouch(before) && before) { delete next[key]; changed.push(key); }
      siblings.forEach(function (l) {
        if (!next[l] || !oursToTouch(next[l])) return;
        delete next[l];
        changed.push(l);
      });
      return { store: next, changed: changed };
    }

    if (!oursToTouch(before)) return { store: next, changed: [] };
    if (!before || before.area !== value) {
      next[key] = { area: value, date: stamp, early: true };
      changed.push(key);
    }

    siblings.forEach(function (l) {
      const e = next[l];
      if (!oursToTouch(e)) return;               // never ours: hand-typed or confirmed-auto
      if (e && e.area === value && e.auto) return; // already says this, already tagged
      next[l] = { area: value, date: stamp, early: true, auto: true };
      changed.push(l);
    });

    return { store: next, changed: changed };
  }

  // nextNeedingArea(store, labels, from, dir) -> the index of the next package
  // in `labels` that still has no work area, walking in direction `dir`.
  //
  // Why this exists: propagation means one entry can answer several packages at
  // once. Stepping strictly to `from + dir` would park the cursor on a row that
  // is already filled in and make the supervisor press Enter through packages
  // they have effectively finished. Skipping them is the whole point of typing
  // an address once.
  //
  // Uses isAnswered(), the ADR 0022 **answered** state: an area is present,
  // provenance irrelevant. NOT isScanned().
  //
  // It read isScanned() until 2026-08-21 (#740). That was #634's deliberate
  // call while early rows were rare — an early value is "not yet confirmed
  // against a scan on the report this tool runs", so the real report's
  // classification still needed its say. ADR 0021 then gave the Post Sort
  // report the main slot, so EVERY box the supervisor types into on a normal
  // day writes through setEarly and is stamped early, and every row he answered
  // stayed "unanswered" to this loop. He pressed Enter through finished work.
  //
  // The #634 concern is still served, just not here: an early row whose area
  // the real report later contradicts surfaces by staying visible in the
  // working list and through the existing conflict signalling. It must not be
  // re-solved by parking the cursor on work he has already done.
  //
  // Returns the LAST index in that direction when everything ahead is answered,
  // so the caller lands somewhere real rather than off the end; returns `from`
  // unchanged when `labels` is empty or `from` is out of range.
  function nextNeedingArea(store, labels, from, dir) {
    const list = Array.isArray(labels) ? labels : [];
    const step = dir < 0 ? -1 : 1;
    const start = Number(from);
    if (!list.length || !isFinite(start)) return from;

    let last = start;
    for (let i = start + step; i >= 0 && i < list.length; i += step) {
      last = i;
      if (!isAnswered(store, list[i])) return i;
    }
    // Nothing unanswered ahead: stop at the far end rather than refusing to move,
    // so a supervisor revisiting a finished list can still walk it.
    return last;
  }

  // ─── RETENTION ────────────────────────────────────────────────────────────

  function dayNumber(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return null;
    return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
  }

  // prune(store, today, days) -> store without entries older than `days`.
  // An entry with no usable date is KEPT: a missing stamp is not evidence of
  // staleness, and dropping a supervisor's typed area is the worse error.
  function prune(store, today, days) {
    const limit = typeof days === 'number' && days >= 0 ? days : DEFAULT_DAYS;
    const now = dayNumber(today);
    const next = restore(store);
    if (now == null) return next;
    Object.keys(next).forEach(function (label) {
      const d = dayNumber(next[label].date);
      if (d != null && now - d > limit) delete next[label];
    });
    return next;
  }

  return {
    MAX_LEN: MAX_LEN,
    DEFAULT_DAYS: DEFAULT_DAYS,
    normalizeArea: normalizeArea,
    isMatchable: isMatchable,
    exactKey: exactKey,
    clusterKey: clusterKey,
    restore: restore,
    serialize: serialize,
    get: get,
    set: set,
    matchesFor: matchesFor,
    isAuto: isAuto,
    isEarly: isEarly,
    isAnswered: isAnswered,
    isScanned: isScanned,
    setEarly: setEarly,
    nextNeedingArea: nextNeedingArea,
    prune: prune,
  };
});
