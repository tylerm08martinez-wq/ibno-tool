'use strict';

// IBNO Coder: "new since the last drop" (issue #735, spec #690, map #608).
//
// THE PROBLEM, and it is a consequence of a design decision that is CORRECT.
// Tyler re-drops an updated Inbound and Van Scans report several times a shift.
// Typed Goes To areas survive that re-drop BY DESIGN (#695) — reset-on-fresh-
// drop is on spec #690's "rejections on record, do not re-propose" list — so a
// fresh drop presents rows he already worked and rows that only just arrived as
// one undifferentiated pile. #733/#734 solve the DONE half by filing worked
// rows out of the working list. This module is the other half: what ARRIVED.
//
// ─── THE DEFINITION ────────────────────────────────────────────────────────
//
//   A row is NEW when it is present on THIS drop and was absent from the
//   PREVIOUS DROP of this sort day.
//
// Everything else here follows from that one sentence, and each clause of it is
// load-bearing:
//
// "PREVIOUS DROP" — not "not seen yet today". The marker is per-drop and the
//   next drop recomputes against the drop before it (#735, in as many words).
//   The two designs are indistinguishable until a label LEAVES and COMES BACK:
//   on the report at 02:00, gone at 03:00, back at 04:00 is NEW at 04:00,
//   because it arrived since the report Tyler was last looking at, and that is
//   the question he is asking the screen. A cumulative ever-seen set answers it
//   wrong and looks identical on every other case, so `prev` below holds ONE
//   drop's labels and is REPLACED, never unioned.
//
// "OF THIS SORT DAY" — the INBOUND_DATE clock in lib/sort-day.js, NEVER the
//   device's. The sort at 849 starts around 1:30 AM, so a device-date stamp
//   changes in the middle of the shift being worked. Same reason #695 exists;
//   the full argument lives at the top of lib/sort-day.js and is not repeated.
//
// "PRESENT ON THIS DROP" — a drop is a REPORT LOAD, not a render. The tool
//   calls recordDrop from its snapshot pipeline (applySnapshot), so a session
//   restore on F5, a Re-run rules, or any repaint leaves the classification
//   exactly as the last real drop left it. That is spec #690's three-way
//   persistence split, and it puts this module on BOTH sides of it: the chip's
//   on/off state is a filter and resets on load like every other filter, while
//   the new/old classification is DATA and lives for the sort day.
//
// ─── THE EDGES, ALL FOUR NAMED ─────────────────────────────────────────────
//
//   FIRST DROP OF A SORT DAY .... nothing is new. There is no predecessor, and
//     marking an entire first report new is volume, not information (#735).
//     The drop is still RECORDED, so the second drop has something to diff.
//   AFTER AN F5 ................. unchanged. Restore rebuilds `prev` and
//     `fresh` from storage; no drop is recorded, so the marks Tyler was looking
//     at before the refresh are the marks he sees after it.
//   A NEW SORT DAY .............. clean. The roll drops the predecessor, so the
//     first drop of the new day is a first drop again and marks nothing. A
//     tracking number DOES repeat across days, and yesterday's report is not
//     evidence about today's package (ADR 0022 invariant 6).
//   AN UNDATEABLE REPORT ........ no clock, so no classification and no
//     recorded drop. `fresh` clears (nothing is claimed) and `prev` is left
//     INTACT for the next dateable drop. Never a guess: this marker sits beside
//     a Goes To box whose value routes a physical package, and a wrong "new" on
//     a row he already worked sends him back to FRO for an answer he has.
//
// ─── WHAT THIS MODULE IS NOT ───────────────────────────────────────────────
//
// It is NOT a row lifecycle state. ADR 0022's four states (unanswered,
// answered, barcoded, scanned) describe what Tyler has DONE to a package; this
// describes when the REPORT started carrying it. Nothing here may be read to
// answer any question in that ADR's consumer table, and nothing here reads
// lib/actual-area.js, lib/ibno-filed.js or lib/barcode-done.js — a row can be
// new and answered, new and filed, or old and untouched, in any combination.
//
// It also never NARROWS a population. newCount counts the rows it is HANDED,
// so the tool hands it the same counted population every other chip counts
// (parked, 503 and filed already excluded, #696/#698/#699/#734) and this chip
// can never promise rows the list will not produce. Keeping the narrowing in
// the caller is deliberate: ADR 0022's closing note is that a consumer which
// narrows a population feeding a ratio has to ask invariant 2 as well, and the
// cheapest way not to get that wrong is not to own a population at all.
//
// Dual-loadable with no build step:
// - Browser: window.IbnoNewSince
// - Node:    require('./lib/ibno-new-since')
//
// This module owns the RULES. The tool owns the DOM wiring and storage I/O, and
// nothing here reads a global, a clock, or localStorage.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IbnoNewSince = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const SortDay = (root && root.SortDay) ||
      (typeof require === 'function' ? require('./sort-day') : null);
    if (!SortDay) {
      throw new Error('IbnoNewSince dependencies unavailable (need SortDay)');
    }
    return { SortDay: SortDay };
  }

  function str(v) { return String(v == null ? '' : v).trim(); }

  // A plain label set: { label: 1 }. Not an Array, because every read of it is
  // a membership test and every write is a dedupe, and not a Set, because this
  // shape goes through JSON.stringify into localStorage as-is.
  function labelSet(items) {
    const out = Object.create(null);
    (Array.isArray(items) ? items : []).forEach(function (it) {
      const label = str(it && typeof it === 'object' ? it.label : it);
      if (label) out[label] = 1;
    });
    return out;
  }

  function isPlainMap(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  // ─── WHICH REPORT A DROP CAME FROM (#827) ─────────────────────────────────
  //
  // THE DEFECT THIS EXISTS FOR, and it is the one thing to understand before
  // touching anything below. Until #827 the ONLY recorder was applySnapshot, so
  // every drop this module ever saw was a MAIN-report drop and `prev` was
  // main-population by construction. #827 wired the Post Sort load path in too
  // — the report Tyler actually re-drops (ADR 0021 gives it the main slot) —
  // and a single `prev` with no notion of WHICH report it held then became a
  // cross-report diff.
  //
  // The two populations differ by orders of magnitude: the Post Sort pull is
  // one station-wide filtered slice (289 rows on the 2026-08-12 export) while
  // the main Inbound and Van Scans report is the whole building (2,868 to
  // 30,343). Diff one against the other and essentially the ENTIRE main report
  // is badged "arrived since the last drop", which is #735's own forbidden
  // failure — and because `fresh` is sort-day data, the wrong marks then stand
  // for the rest of the shift.
  //
  // THE MIXED CASE IS ROUTINE, NOT HYPOTHETICAL. ADR 0021 §2: a Post Sort load
  // resets and ingests, a main load calls clearPostSortLane(), and "whichever
  // arrives last owns the page" — one at a time, but freely alternating within
  // one sort day. #732 is open precisely about the "Post Sort interlude"
  // between two main pulls, and #756's 1:30 AM scenario has a main pull worked
  // alongside a Post Sort report dated the next day.
  //
  // THE FIX IS ONE PREDECESSOR PER REPORT KIND, not "seed whenever the kind
  // changes". Seeding on every switch would be safe but would throw the signal
  // away on exactly Tyler's loop: main -> Post Sort -> main marks nothing on
  // that third drop, when what he wants to know is what arrived since the
  // PREVIOUS MAIN pull. `prev` therefore stays what it always was — the
  // predecessor of the report kind being loaded — and the other kinds'
  // predecessors wait in `stashed` until their own report comes back.
  //
  // The vocabulary is lib/report-detect.js's, deliberately: that module already
  // names these dialects for the one drop zone, and a second spelling of "which
  // report is this" is the #733 class waiting to happen.
  const KIND_MAIN = 'main';
  const KIND_POST_SORT = 'post-sort';

  // normalizeKind(v) -> a usable kind, defaulting to MAIN.
  //
  // THE DEFAULT IS THE MIGRATION. A payload written before #827 carries no
  // `kind` at all, and every drop that could have written one was a main-report
  // drop, so reading a legacy state as main is not a guess — it is exactly what
  // that `prev` holds. A stored shift's marks therefore survive the upgrade
  // instead of being reseeded.
  function normalizeKind(v) {
    const k = str(v);
    return k || KIND_MAIN;
  }

  // stashedOf(v) -> the OTHER kinds' predecessors, { kind: labelSet }. A kind
  // absent from this map has no predecessor, which recordDrop treats as a seed
  // — the same meaning `prev === null` carries for the loaded kind.
  function stashedOf(v) {
    const out = Object.create(null);
    if (!isPlainMap(v)) return out;
    Object.keys(v).forEach(function (k) {
      const kind = str(k);
      if (!kind || !isPlainMap(v[k])) return;
      out[kind] = normalizeSet(v[k]);
    });
    return out;
  }

  function normalizeSet(v) {
    const out = Object.create(null);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    Object.keys(v).forEach(function (k) {
      const label = str(k);
      if (label && v[k]) out[label] = 1;
    });
    return out;
  }

  // emptyState() -> the day-zero shape.
  //
  //   day ..... the sort day this state belongs to (lib/sort-day.js's clock)
  //   kind .... WHICH REPORT the last drop was (#827), in
  //             lib/report-detect.js's vocabulary. It names what `prev` holds.
  //   prev .... the label set of the PREVIOUS drop OF THAT KIND, the thing the
  //             next drop of that kind diffs against. Replaced whole on every
  //             drop, never unioned. NULL means "there is no predecessor"; an
  //             OBJECT means there is one, and it may legitimately be EMPTY.
  //   stashed . the OTHER kinds' predecessors, { kind: labelSet }, waiting for
  //             their own report to come back (#827). recordDrop swaps one out
  //             of here into `prev` when the loaded kind changes, so `prev`
  //             always means the same thing it did before this field existed.
  //   fresh ... the label set the LAST drop classified as new. This is the
  //             answer isNew() gives, and it is what persists for the sort day.
  //             ONE map, not one per kind, and deliberately: ADR 0021 loads one
  //             report at a time, so exactly one classification is ever on
  //             screen, and keeping a per-kind fresh would let the marks
  //             disagree with the rows under them.
  //
  // `prev: null` VERSUS `prev: {}` IS A REAL DISTINCTION, not defensive
  // typing, and collapsing the two is a live defect. This code first asked
  // "is prev empty?" to detect "no predecessor" — which silently reseeds after
  // a drop that carried NO ROWS. A report can reach the tool empty (a pull
  // taken before the sort produced anything, a mangled export that parses to a
  // header and nothing else), and it is a real drop: the next report's rows all
  // genuinely arrived since it. Read as "no predecessor", that next drop marks
  // NOTHING and Tyler loses the one signal this whole ticket exists to give
  // him, on the one drop where every row is new. Suppression is the failure
  // mode that matters here — a missed package beats an over-flagged one.
  //
  // Deliberately NOT a lib/sort-day.js day store. That shape is one keyed map
  // stamped with a day, and this state carries TWO maps that roll together;
  // bending it into a day store would mean two stores that could roll apart,
  // which is the one thing that must not happen here.
  function emptyState() {
    return {
      day: '', kind: KIND_MAIN, prev: null,
      stashed: Object.create(null), fresh: Object.create(null),
    };
  }

  // restore(raw) -> a usable state from anything a real localStorage payload
  // can hold: this module's own shape, a half-written one, junk, or nothing.
  // Never throws, and never INVENTS a classification — anything it cannot read
  // becomes "nothing is new", which is the safe answer (the failure mode of a
  // wrong `new` is Tyler re-doing an FRO lookup he already did).
  // A `prev` that is not a readable map restores as NULL, not as an empty one:
  // "I cannot tell what the last drop carried" is the no-predecessor case, and
  // seeding is the safe answer to it (the alternative diffs the next report
  // against nothing and marks every row new).
  function restore(raw) {
    const o = isPlainMap(raw) ? raw : {};
    return {
      day: deps().SortDay.parseInboundDate(o.day),
      // A legacy payload has no `kind`; normalizeKind reads it as MAIN, which
      // is what its `prev` genuinely holds. See normalizeKind.
      kind: normalizeKind(o.kind),
      prev: isPlainMap(o.prev) ? normalizeSet(o.prev) : null,
      stashed: stashedOf(o.stashed),
      fresh: normalizeSet(o.fresh),
    };
  }

  // freshOf(state) -> the classification map, WITHOUT walking `prev`.
  //
  // THE HOT PATH, and why this is not just `restore(state).fresh`. `prev` holds
  // the whole report — thousands of labels — and restore() normalizes BOTH maps
  // on every call. isNew runs once per row inside chipCounts, again inside
  // passes, again inside newSinceTagHtml, and renderMergedChips re-runs on
  // every chip click. Routing the per-row readers through restore made each of
  // those a full walk of the report, so a single render was quadratic in the
  // report's size for no gain: none of them look at `prev` at all.
  //
  // Normalizing only when the map is not already one keeps the tool's own
  // restored state on the O(1) path while a hand-built or half-written object
  // still reads correctly.
  function freshOf(state) {
    const f = state && state.fresh;
    return isPlainMap(f) ? f : normalizeSet(f);
  }

  // serialize(state) -> a plain JSON-safe object, with Object.create(null) maps
  // flattened to ordinary ones so JSON.stringify and structural equality both
  // behave.
  function serialize(state) {
    const s = restore(state);
    const stashed = {};
    Object.keys(s.stashed).forEach(function (k) { stashed[k] = Object.assign({}, s.stashed[k]); });
    return {
      day: s.day,
      kind: s.kind,
      // null survives the round trip through JSON, so "no predecessor" is still
      // "no predecessor" after a refresh rather than an empty drop.
      prev: s.prev === null ? null : Object.assign({}, s.prev),
      stashed: stashed,
      fresh: Object.assign({}, s.fresh),
    };
  }

  // recordDrop(state, items, day, kind) -> the state AFTER a report load.
  //
  // `kind` is WHICH REPORT this drop was (#827), in lib/report-detect.js's
  // vocabulary. Omitted means MAIN, which is what every drop was before that
  // ticket and what a legacy stored state holds.
  //
  // Pure: returns a new object and mutates nothing, so the tool can hold the
  // previous state while it decides whether to persist.
  //
  // THE THREE BRANCHES, in the order they are tested:
  //
  //   1. No usable sort day -> record NOTHING. `fresh` clears (this drop makes
  //      no claim) and `prev`, `kind` and `stashed` are ALL preserved, so the
  //      next dateable drop still has the predecessor it needs. An undated or
  //      mangled export must not be able to erase the diff for the whole shift,
  //      and it must not be able to move which report `prev` belongs to either.
  //   2. First drop of a sort day, or a LATER sort day than the one stored ->
  //      seed. `prev` becomes this report, `fresh` is empty, and `stashed`
  //      empties too: on a new sort day nothing carries over, whichever report
  //      it came from. Nothing is marked new, and the next drop of that day
  //      diffs against this one.
  //   3. Same day (or an EARLIER-dated re-pull, see below) -> diff, against the
  //      predecessor OF THIS KIND. A kind whose report has not been dropped yet
  //      today has no predecessor and seeds, exactly as the first drop does.
  //
  // THE KIND SWAP HAPPENS FIRST, ABOVE ALL THREE. Before anything else a drop
  // of a different kind than the stored one puts the current `prev` away in
  // `stashed` under its own kind and pulls this kind's predecessor out. Every
  // branch below then reads `prev` meaning exactly what it always meant — the
  // previous drop of the report now being loaded — so the three branches did
  // not change at all. See the KIND block above for why a cross-report diff
  // badges an entire main report as new.
  //
  // AN EARLIER-DATED RE-DROP IS BRANCH 3, NOT BRANCH 2, and that is the same
  // call lib/actual-area.js's reflow gate makes: the shift's clock only ever
  // moves forward, so a stale re-pull mid-shift is still a drop of the shift
  // being worked. It diffs normally and leaves `state.day` on the later day, so
  // it cannot roll the shift backwards and re-open a day that has closed.
  function recordDrop(state, items, day, kind) {
    const SortDay = deps().SortDay;
    const s = restore(state);
    const d = SortDay.parseInboundDate(day);
    const k = normalizeKind(kind);

    if (!d) {
      return {
        day: s.day, kind: s.kind, prev: s.prev,
        stashed: s.stashed, fresh: Object.create(null),
      };
    }

    const incoming = labelSet(items);

    // THE KIND SWAP. `prev` and `stashed` below are this drop's own view: the
    // predecessor of the kind being loaded, and everyone else's put away. When
    // the kind has not changed both are simply the stored ones, so a
    // single-report shift takes the identical path it always did.
    let prev = s.prev;
    let stashed = s.stashed;
    if (k !== s.kind) {
      stashed = Object.assign(Object.create(null), s.stashed);
      // The outgoing kind's predecessor goes away only if it HAS one. A `prev`
      // of null is the absence of a predecessor, and stashing it as an empty
      // map would turn it into an empty DROP — the distinction emptyState
      // spends a paragraph on, arriving here by a different door.
      if (s.prev !== null) stashed[s.kind] = s.prev;
      else delete stashed[s.kind];
      prev = Object.prototype.hasOwnProperty.call(stashed, k) ? stashed[k] : null;
      delete stashed[k];
    }

    // NO PREDECESSOR IS A SEED, NEVER A DIFF, and `prev === null` is the whole
    // of that test. `!s.day` alone would not do it: the tool also calls
    // syncSortDay on a roll, which sets the new day and drops the predecessor,
    // and diffing against a missing one marks EVERY row new — exactly the "do
    // not mark an entire first report as new" failure #735 forbids, landing on
    // the first drop of every new sort day.
    //
    // THE TEST IS `=== null`, NEVER "is prev empty". An EMPTY predecessor is a
    // real drop that carried no rows, and the next report's rows all genuinely
    // arrived since it. See emptyState for why collapsing the two suppresses
    // the signal on the one drop where every row is new.
    const rolled = !s.day || SortDay.isLaterSortDay(d, s.day);
    if (rolled) {
      // A new sort day drops EVERY kind's predecessor, not just the loaded
      // one's: yesterday's main pull cannot answer "what arrived since the last
      // drop" about today any more than yesterday's Post Sort pull can.
      return {
        day: d, kind: k, prev: incoming,
        stashed: Object.create(null), fresh: Object.create(null),
      };
    }
    if (prev === null) {
      return { day: s.day, kind: k, prev: incoming, stashed: stashed, fresh: Object.create(null) };
    }

    const fresh = Object.create(null);
    Object.keys(incoming).forEach(function (label) {
      if (!prev[label]) fresh[label] = 1;
    });
    return { day: s.day, kind: k, prev: incoming, stashed: stashed, fresh: fresh };
  }

  // syncSortDay(state, day) -> the state a load should start from when a report
  // announces its sort day BEFORE anything renders, mirroring
  // IbnoFiled.syncSortDay. A later day wipes the classification so yesterday's
  // marks never flash on today's rows; the same day, or no readable day, leaves
  // it alone. recordDrop makes the same call for itself, so this is for the
  // restore path, not a precondition of recording a drop.
  function syncSortDay(state, day) {
    const SortDay = deps().SortDay;
    const s = restore(state);
    const d = SortDay.parseInboundDate(day);
    if (!d) return s;
    // prev: null, not {} — the roll leaves NO predecessor, and recordDrop's
    // seed branch keys on exactly that. `stashed` empties for the same reason
    // recordDrop's roll branch empties it: no kind's yesterday answers today.
    // `kind` is carried rather than reset — with no predecessor anywhere it
    // changes nothing, and inventing one here would be a claim about a report
    // that has not been dropped.
    if (SortDay.isLaterSortDay(d, s.day)) {
      return {
        day: d, kind: s.kind, prev: null,
        stashed: Object.create(null), fresh: Object.create(null),
      };
    }
    return s;
  }

  // isNew(state, label) -> the row marker's predicate, and the chip filter's.
  // One definition for both, on purpose: #733's own bug was a count and an
  // action reading two spellings of one question (see ADR 0022 and /code-review
  // on #642 finding 8), and a marker that disagrees with the chip that counts
  // it is the same defect wearing different clothes.
  //
  // Reads freshOf, never restore: this is the per-row hot path and `prev` holds
  // the whole report. See freshOf.
  function isNew(state, label) {
    const l = str(label);
    if (!l) return false;
    return !!freshOf(state)[l];
  }

  // newLabels(state) -> every label the last drop classified as new. Sorted for
  // a stable answer; nothing here depends on report order.
  function newLabels(state) {
    return Object.keys(freshOf(state)).sort();
  }

  // newCount(state, items) -> the chip's LIVE count, over the rows it is
  // HANDED. See the header: the caller passes the counted population, so
  // parked (#698), filed 503 (#699) and barcoded-and-filed (#734) rows are
  // already gone and this chip counts under the same rule as every other one.
  function newCount(state, items) {
    const fresh = freshOf(state);
    let n = 0;
    const seen = Object.create(null);
    (Array.isArray(items) ? items : []).forEach(function (it) {
      const label = str(it && typeof it === 'object' ? it.label : it);
      if (!label || seen[label]) return;
      seen[label] = 1;
      if (fresh[label]) n++;
    });
    return n;
  }

  // chipText(count) -> the chip's words, empty at zero. Absent entirely at zero
  // is the #696 chip convention: a chip reading "New (0)" is volume without
  // information, and #735 asks for it by name.
  function chipText(count) {
    const n = Number(count) || 0;
    return n > 0 ? (CHIP_LABEL + ' (' + n + ')') : '';
  }

  // The chip's LABEL alone, for the tool's chip renderer, which prints the
  // count in its own <span class="n"> the way every other merged chip does.
  // chipText is the same words as one string, for anywhere that needs them
  // together. Both read this constant, so the chip cannot be renamed in one
  // place and not the other.
  const CHIP_LABEL = '✨ New';

  // The row marker's words and its tooltip, named here rather than in the tool
  // so the badge and the predicate under it are one statement.
  const MARKER_TEXT = 'new';
  const MARKER_TITLE = 'Arrived since the previous report drop of this sort day';

  return {
    CHIP_LABEL: CHIP_LABEL,
    MARKER_TEXT: MARKER_TEXT,
    MARKER_TITLE: MARKER_TITLE,
    // #827: named here so the two call sites in ibno-coder.html cannot spell
    // "which report is this" two different ways. Same vocabulary as
    // lib/report-detect.js.
    KIND_MAIN: KIND_MAIN,
    KIND_POST_SORT: KIND_POST_SORT,

    emptyState: emptyState,
    restore: restore,
    serialize: serialize,
    recordDrop: recordDrop,
    syncSortDay: syncSortDay,
    isNew: isNew,
    newLabels: newLabels,
    newCount: newCount,
    chipText: chipText,
  };
});
