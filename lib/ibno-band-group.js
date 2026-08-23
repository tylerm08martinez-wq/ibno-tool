'use strict';

// ZIP / ISP BANDS over the IBNO Coder working list (issue #737, spec #690,
// map #608).
//
// Dual-loadable with no build step:
// - Browser: window.IbnoBandGroup
// - Node: require('./lib/ibno-band-group')
//
// Tyler's case, 2026-08-19 (same origin as #736): a bundle of packages heading
// to the same place but not to the same street, checked one at a time. #736
// gave him shift-click. This gives him the band: sort by ZIP or by Service
// Provider, and every run of packages going to one place gets a header with a
// count and one control that selects the whole run.
//
// ─── WHAT THIS MODULE DOES *NOT* DO ─────────────────────────────────────────
//
// It never derives, predicts, pre-fills or suggests a WORK AREA. That was the
// original ask and #737 rejects it on the evidence already in the repo:
// lib/zip-isp-belt.js's own header records the #438 grill outcome — the belt is
// humble orientation text, never a verdict, because table-versus-report
// disagreement is routine, and the table is ZIP-granular while a work area is
// finer. A derived area would be a guess presented as fact on a 3 AM sort.
// ZIP is real data on the report; a band clusters on it and infers nothing.
// Any future proposal to auto-fill a work area reopens #438's grill first.
//
// ─── WHY BANDS ARE CONTIGUOUS RUNS AND NEVER A REGROUP ──────────────────────
//
// Spec #690 user story 10 freezes the Service Provider sort and the
// street/address sort that groups same-stop packages: dock flex depends on
// same-stop rows being ADJACENT so a whole stop can be knocked out together.
// A new grouping mode must not perturb the existing ones.
//
// So bands are built as CONTIGUOUS RUNS of the already-sorted list, not by
// bucketing rows under a key. `bands(items, ...)` concatenated back together is
// `items`, element for element, in the same order — that is a mechanical
// property, pinned by a test, and it is what makes it impossible for this
// module to move a row. Grouping here is a matter of where the HEADERS go, and
// of nothing else.
//
// The consequence, stated rather than hidden: a key that appears in two
// non-adjacent runs yields TWO bands. Under the 'zip' and 'isp' sorts that
// cannot happen — the comparator keys on exactly that field first, so equal
// keys are always adjacent — and under any other sort a split band is the
// honest picture of a list that is not in that order.
//
// ─── HOW MANY STOPS IS A BAND? (#837) ───────────────────────────────────────
//
// A band is NOT one stop, and was never claimed to be. #737 shipped the band
// header with a label and a package count and ONE control that selects the
// whole run, and that control is what made the silence expensive: selecting 41
// packages that share only a carrier and typing one area is a one-click act,
// and nothing on screen said how many stops that covers. A work area is finer
// than a ZIP (the #438 grill, again), so a band can span several of them.
//
// Measured on the real 2026-08-12 Post Sort export, main working lane, 281
// rendered rows, through the tool itself:
//   ZIP sort — 36 bands: 29 covering more than one distinct stop, 6 covering
//              exactly one, 1 with nothing addressable in it at all. Largest
//              band 35 rows;
//   ISP sort — 13 bands, ALL 13 covering more than one stop, largest 41 rows.
//
// That 29/6/1 breakdown is the number every comment in this repo should quote.
// #837's own text says 30, counted before the label separated "at least N" from
// "exactly N"; 8 further ZIP bands read "N+" because something in them has no
// usable address.
//
// Tyler's decision on #837 (2026-08-22) was option B-flavoured: leave the sort
// alone — spec #690 user story 10 froze the zip sort's label tiebreak and
// changing it would move frozen ordering for no measured gain — and make the
// HEADER say what is inside it. So each band carries `stops`, and the header
// reads "85023  12  5 stops". The reading error needs one number, not a resort.
//
// The unit of "one stop" is the BUILDING key the sort clustering and dock flex
// already ride (lib/ibno-work-loop.js buildingOf -> ActualArea.clusterKey),
// injected rather than re-derived, so this header cannot come to mean something
// the rest of the tool disagrees with. A row with no matchable physical address
// has no stop at all (ADR 0022 invariant 4: a bare ZIP is a region, not a
// destination); those rows are counted separately in `noStop` and the label
// says "5+ stops" rather than pretending to a total it cannot know. A band in
// which nothing is addressable claims no number at all.
//
// ─── THE UNKNOWN BAND ───────────────────────────────────────────────────────
//
// A row whose ZIP is absent from lib/zip-isp-belt.js's table has no ISP, and a
// row can carry no readable ZIP at all. Neither is dropped and neither is
// guessed: both land in an explicit band that says so. The sort already puts
// them last ascending (IbnoSort.cmpBlankLast), so the unknown band falls at the
// tail without this module reordering anything.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IbnoBandGroup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // The sort keys that also band. Both are keys IbnoSort already understands
  // (#692 extracted them; they have shipped in the sort dropdown since), which
  // is what "ZIP and ISP join the existing sort model" means: no second control
  // and no second ordering — choosing the sort IS choosing the grouping.
  const BAND_MODES = ['zip', 'isp'];

  // The label a band with no key wears, per mode. Written out rather than left
  // blank because "no ZIP on this row" and "this ZIP is not in the station
  // list" must never read as an empty heading over real packages.
  const UNKNOWN_LABEL = {
    zip: 'No ZIP on these rows',
    isp: 'Unknown Service Provider',
  };

  // The hover text on an unknown band, saying which of the two reasons applies
  // — a row with no readable ZIP, or a ZIP the station list does not carry.
  // One band holds both, because the sort holds them together too (they share a
  // blank key) and splitting them would put two headings at the tail of the
  // list for one idea.
  const UNKNOWN_TITLE = {
    zip: 'These rows carry no readable ZIP. Nothing is guessed for them.',
    isp: 'Either the row carries no readable ZIP, or its ZIP is not in the ' +
         'station zip list. Nothing is guessed for them.',
  };

  // What the stop badge says when NOTHING in the band has a matchable address.
  // A dash, not a zero: "0 stops" over real packages reads as a claim that they
  // are going nowhere, when the truth is that the report gave no address to
  // cluster on. #837's decision comment: "'-' is fine, a wrong number is not."
  const NO_STOP_LABEL = '— stops';

  function isBandMode(key) {
    return BAND_MODES.indexOf(String(key || '')) !== -1;
  }

  // keyOf(item, mode, fields) -> the band key, '' when unknown.
  function keyOf(item, mode, fields) {
    if (mode === 'zip') return String(fields.zipOf(item) || '').trim();
    if (mode === 'isp') return String(fields.ispOf(item) || '').trim();
    return '';
  }

  function labelFor(key, mode) {
    return key ? key : (UNKNOWN_LABEL[mode] || 'Unknown');
  }

  function titleFor(key, mode) {
    return key ? '' : (UNKNOWN_TITLE[mode] || '');
  }

  // stopsLabel({ stops, noStop }) -> the text the band header's stop badge wears.
  //
  //   { stops: 5, noStop: 0 } -> '5 stops'     every row placed, exact
  //   { stops: 1, noStop: 0 } -> '1 stop'      singular
  //   { stops: 0, noStop: 0 } -> '0 stops'     nothing counted at all
  //   { stops: 5, noStop: 2 } -> '5+ stops'    at least five; two rows unplaceable
  //   { stops: 0, noStop: 3 } -> '— stops'     nothing to count, so no number
  //
  // Lives here rather than in the page so the header written at render time and
  // the one rewritten after a resolve cannot word the same fact two ways.
  function stopsLabel(band) {
    if (!band) return NO_STOP_LABEL;
    const stops = Math.max(0, Number((band && band.stops) || 0));
    const noStop = Math.max(0, Number((band && band.noStop) || 0));
    if (!stops) return noStop ? NO_STOP_LABEL : '0 stops';
    return stops + (noStop ? '+' : '') + (stops === 1 && !noStop ? ' stop' : ' stops');
  }

  // stopsTitle({ stops, noStop }) -> the hover text that EXPLAINS the badge.
  //
  // The '+' and the '—' are the two states a supervisor cannot decode from the
  // glyph alone, and they are not rare: on the real 2026-08-12 export 8 ZIP
  // bands read 'N+' and 1 reads '—', and in the flagged lane 4 of 7 bands read
  // '—'. A static tooltip would leave exactly the ambiguous cases unexplained,
  // so the text is state-dependent and names the rows that caused it.
  function stopsTitle(band) {
    const stops = Math.max(0, Number((band && band.stops) || 0));
    const noStop = Math.max(0, Number((band && band.noStop) || 0));
    const rows = noStop === 1 ? '1 row carries' : noStop + ' rows carry';
    if (!stops && noStop) {
      return 'No stop count: ' + rows + ' no usable street address, so there is ' +
        'nothing here to count. Nothing is guessed.';
    }
    if (noStop) {
      return 'At least ' + stops + ' distinct ' + (stops === 1 ? 'stop' : 'stops') +
        ' — ' + rows + ' no usable street address and could be anywhere, so the ' +
        'true total is higher than ' + stops + '. Nothing is guessed.';
    }
    return stops + ' distinct ' + (stops === 1 ? 'stop' : 'stops') +
      ' in this band. A band is a run of packages that share a ZIP or a carrier, ' +
      'not one stop.';
  }

  // bandsOf(items, mode, fields) -> [{ key, label, title, unknown, count, stops, noStop, items }]
  //
  // NOTE on `fields`: this raw entry point still degrades a missing clusterKey
  // to a blank reader (resolveFields), which makes every band read '— stops'.
  // Only createBander REFUSES that, and createBander is what the tool uses. A
  // direct bandsOf caller owes itself the same three accessors.
  //
  // `fields` is { zipOf, ispOf }. Contiguous runs, input order preserved. An
  // unrecognized mode answers ONE band holding the whole list with a null key,
  // so a caller that forgets to check isBandMode renders the list it already
  // had rather than an empty table.
  function bandsOf(items, mode, fields) {
    const list = Array.isArray(items) ? items : [];
    const f = resolveFields(fields);
    if (!isBandMode(mode)) {
      // stops/noStop are null, not 0: the question was never ASKED. Nothing
      // renders a header for a keyless band, and clustering a whole unbanded
      // list on every render would be address normalization nobody reads.
      return list.length ? [{ key: null, label: '', title: '', unknown: false, count: list.length, stops: null, noStop: null, items: list.slice() }] : [];
    }
    const out = [];
    let current = null;
    // The distinct building keys seen in the band being built. Kept beside the
    // band rather than on it so the band's own shape stays exactly the fields a
    // caller may render (a test pins that list, because "a band has nowhere to
    // put a work area" is an assertion this module owes #737).
    let seen = null;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const key = keyOf(item, mode, f);
      if (!current || current.key !== key) {
        current = {
          key: key,
          label: labelFor(key, mode),
          title: titleFor(key, mode),
          unknown: !key,
          count: 0,
          stops: 0,
          noStop: 0,
          items: [],
        };
        seen = Object.create(null);
        out.push(current);
      }
      current.items.push(item);
      current.count++;
      // The injected clusterKey takes an ADDRESS, exactly as IbnoSort's does —
      // same function, same argument, so the two cannot drift into two ideas of
      // one building.
      const stop = String(f.clusterKey((item && item.address) || '') || '');
      if (!stop) current.noStop++;
      else if (!seen[stop]) { seen[stop] = true; current.stops++; }
    }
    return out;
  }

  const BLANK = function () { return ''; };

  function resolveFields(fields) {
    const f = fields || {};
    return {
      zipOf: typeof f.zipOf === 'function' ? f.zipOf : BLANK,
      ispOf: typeof f.ispOf === 'function' ? f.ispOf : BLANK,
      clusterKey: typeof f.clusterKey === 'function' ? f.clusterKey : BLANK,
    };
  }

  // createBander(ctx) -> (items, mode) => bands, bound to one context.
  //
  // REFUSES an incomplete context loudly, at construction, for the same reason
  // IbnoSort.createComparator does: a missing accessor degrades in SILENCE —
  // every key reads blank, every row falls into the unknown band, and the
  // supervisor is shown one heading over the whole list that says his packages
  // have no ZIP. A green suite would not notice. On a 3 AM sort that has to be
  // a crash on load, not a quietly wrong grouping.
  const REQUIRED = ['zipOf', 'ispOf', 'clusterKey'];

  function createBander(ctx) {
    const missing = REQUIRED.filter((k) => typeof (ctx && ctx[k]) !== 'function');
    if (missing.length) {
      throw new Error('IbnoBandGroup.createBander: missing required accessor(s): ' + missing.join(', '));
    }
    const fields = resolveFields(ctx);
    return function (items, mode) { return bandsOf(items, mode, fields); };
  }

  return {
    BAND_MODES: BAND_MODES,
    UNKNOWN_LABEL: UNKNOWN_LABEL,
    UNKNOWN_TITLE: UNKNOWN_TITLE,
    NO_STOP_LABEL: NO_STOP_LABEL,
    stopsLabel: stopsLabel,
    stopsTitle: stopsTitle,
    isBandMode: isBandMode,
    bandsOf: bandsOf,
    createBander: createBander,
  };
});
