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

  // US state/territory codes, used ONLY to recognize a trailing city/state/ZIP
  // tail so it can be set aside before asking "is there a street name here?".
  // Never used to fold or compare addresses.
  const STATE_CODES = {
    AL: 1, AK: 1, AZ: 1, AR: 1, CA: 1, CO: 1, CT: 1, DE: 1, FL: 1, GA: 1,
    HI: 1, ID: 1, IL: 1, IN: 1, IA: 1, KS: 1, KY: 1, LA: 1, ME: 1, MD: 1,
    MA: 1, MI: 1, MN: 1, MS: 1, MO: 1, MT: 1, NE: 1, NV: 1, NH: 1, NJ: 1,
    NM: 1, NY: 1, NC: 1, ND: 1, OH: 1, OK: 1, OR: 1, PA: 1, RI: 1, SC: 1,
    SD: 1, TN: 1, TX: 1, UT: 1, VT: 1, VA: 1, WA: 1, WV: 1, WI: 1, WY: 1,
    DC: 1, PR: 1, VI: 1, GU: 1, AS: 1, MP: 1,
  };

  // Directional tokens as lib/address-normalize.js canonicalizes them. A
  // directional POINTS at a street, it does not NAME one: "12 N PHOENIX AZ
  // 85013" is no more a stop than "12 PHOENIX AZ 85013".
  const DIRECTIONAL_TOKENS = {
    N: 1, S: 1, E: 1, W: 1, NE: 1, NW: 1, SE: 1, SW: 1,
  };

  // hasStreetName(tokens) -> is there a street NAME between the leading house
  // number and the trailing city/state/ZIP tail? (Issue #721.)
  //
  // ONLY EVER ASKED OF A FULL COMPOSED ADDRESS. It reasons about a tail, so a
  // string that has already had its tail cut off (stripUnitTokens' output) is
  // not a legal input — see clusterKey below for what happens when it is.
  //
  // The tail is peeled off the END, in the order a composed address carries it
  // (LABEL_ADDRESS1 + LABEL_CITY + LABEL_STATE + POSTAL_CODE):
  //   1. a trailing 5-digit ZIP, if present (ZIP+4 is already folded to 5),
  //   2. then a trailing state code, if present (real exports omit it),
  //   3. then ONE more token as the minimum city — a city is at least one word.
  // Whatever survives must contain a token that could be a street name: not a
  // bare number (that is a house or unit number) and not a bare directional.
  //
  // KNOWN LIMIT (deliberate, see the PR for #721): a city of two or more words
  // — CAVE CREEK, SUN CITY WEST — leaves its first word standing in for a
  // street name, so a unit-only address in such a city can still read as a
  // stop. Closing that gap needs a city gazetteer, which would be a new table
  // to keep current and would misfire on street names that contain a city name.
  // Peeling more than one token instead would reject REAL suffix-less streets
  // ("6905 W MONTE LINDO GLENDALE AZ 85310"), about 3% of a real export — a
  // worse trade: this module would rather lose a match than invent one, but
  // losing 3% of real stops to catch a rarer junk shape is not that trade.
  function hasStreetName(tokens) {
    let end = tokens.length; // exclusive
    if (end > 1 && /^\d{5}$/.test(tokens[end - 1])) end--;      // ZIP
    if (end > 1 && STATE_CODES[tokens[end - 1]]) end--;         // state
    if (end > 1) end--;                                         // minimum city
    for (let i = 1; i < end; i++) {
      const t = tokens[i];
      if (/^\d+$/.test(t)) continue;          // a number names no street
      if (DIRECTIONAL_TOKENS[t]) continue;    // nor does a bare directional
      return true;
    }
    return false;
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
  // The rule: a matchable address is a NUMBER AND A NAME — it begins with a
  // house number, has at least one more token, and names a street.
  // "9782 E SOUTH BEND DR SCOTTSDALE AZ 85255" qualifies; "85032" and a bare
  // city do not. Anything unmatchable returns '', which propagation skips
  // entirely and cmpBlankLast sorts to the end.
  //
  // The NAME half was documented but not enforced until issue #721. Found by
  // the independent review of PR #720: normalizeAddress drops a unit marker
  // WORD and keeps its number, so "APT 12 PHOENIX AZ 85013" — an address with
  // a unit and no street at all — normalized to "12 PHOENIX AZ 85013", led
  // with a digit, carried more tokens, and read as a real physical stop. Two
  // unrelated APT 12 rows in one ZIP then shared an exactKey: the sheet banded
  // them as one stop and dock flex propagated a typed area between two
  // packages that do not share a stop. Same wrong-belt shape as the ZIP case
  // above, one level down. hasStreetName() below is the enforcement.
  //
  // Deliberately conservative: an address form that does not lead with a number
  // (a PO box, a named campus) simply gets no clustering. Losing a convenience
  // is cheap; merging two different destinations is not.
  function isMatchable(key) {
    if (!key) return false;
    const tokens = String(key).split(' ').filter(Boolean);
    if (tokens.length < 2) return false;
    if (!/^\d/.test(tokens[0])) return false;
    return hasStreetName(tokens);
  }

  // exactKey(address) -> unit-PRESERVING match key. Propagation key.
  function exactKey(address) {
    const key = deps().AddressNormalize.normalizeAddress(address);
    return isMatchable(key) ? key : '';
  }

  // clusterKey(address) -> building-level match key, unit markers and their
  // numbers removed. Sorting key.
  //
  // MATCHABILITY IS DECIDED FROM THE FULL ADDRESS, NOT THE STRIPPED ONE.
  // "Is this a real stop?" and "what is this building's key?" are two
  // different questions, and only the first one may be asked of a complete
  // address. stripUnitTokens truncates at the last street suffix and discards
  // city/state/ZIP outright, so its output has no tail for hasStreetName to
  // peel — and peeling one anyway ate real street names: "4210 E HUNTER CT"
  // lost CT to the state-code table (Connecticut), then HUNTER — the actual
  // street name — to the minimum-city rule, leaving a bare directional and no
  // stop. Measured on 8 real exports, that cost 830 real rows their band
  // (CT 624, LOOP 84, LN 66, HWY 29, ...) while dock flex, which rides
  // exactKey, saw nothing wrong. Found by the independent review of this PR
  // (#833, round 1); the first cut of #721 had this bug and every existing
  // test still passed.
  function clusterKey(address) {
    const AN = deps().AddressNormalize;
    if (!isMatchable(AN.normalizeAddress(address))) return '';
    return AN.normalizeAddress(AN.stripUnitTokens(address));
  }

  // ─── STORE ────────────────────────────────────────────────────────────────
  //
  // Shape: { [trackingLabel]: { area: 'BELT 12', date: '2026-08-08', typed?: true, auto?: true, early?: true, by?: 'Cage PC' } }
  //
  // `typed` is PROVENANCE, and it is the POSITIVE half of the pair below
  // (issue #722). It means a human typed this area on this row. Before #722 the
  // same fact was inferred from the ABSENCE of both `auto` and `early`, and
  // that inference is what made ibno-coder.html's areaProvenanceOf end in a
  // `return 'typed'` catch-all: every value that reached this store, however it
  // got here, was labelled hand-typed and printed on a barcode card in 30px
  // type. IbnoBarcodeSheet.cardArea's allowlist could not fail closed against
  // anything, because nothing could ever fail it. Naming the good case is what
  // makes the bad case nameable.
  //
  // It follows `early`'s and `by`'s precedent: a further independent optional
  // field, never a widening of an existing one.
  //
  // IT HAS EXACTLY TWO WRITERS, AND THEY DO NOT MEAN THE SAME THING.
  //   set()               a human typed this area on this row. The keystroke.
  //   adoptLegacyTyped()  this entry was already in the store, carrying no
  //                       provenance, when the migration boundary ran. That is
  //                       evidence it PREDATES the marker, not evidence of a
  //                       keystroke — see that function for the trade.
  // Nothing else writes it: propagation writes `auto`, the Post Sort lane writes
  // `early`, reflow writes `auto`. A reader must not treat `typed` as proof a
  // person touched that row; it is proof the value is ACCOUNTED FOR, which is
  // the question the barcode card asks. A future writer that
  // puts a report-supplied, suggested or carried area into this store writes
  // none of them, and its entry therefore reads as an UNKNOWN provenance and
  // dashes, which is the whole point.
  //
  // MIGRATION IS THE SHARP EDGE, and it is adoptLegacyTyped() below rather than
  // a stamp in restore(). Every entry written before #722 carries no marker at
  // all, so a bare `''` default would dash a real supervisor's typed areas on
  // upgrade. See that function for the decision and its cost.
  //
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
  //
  // `by` is ATTRIBUTION, not provenance (issue #793, PRD #790, ADR-0023 item
  // 5): the free-text name of the DEVICE that wrote this area. Under the 999
  // Desk an Admin works the Flagged Work Area rows on the cage PC while Tyler
  // works the same list from the other end, so "who typed this" stopped being
  // implicit the moment there were two of them, and a repeated wrong-belt
  // pattern is uncoachable when nobody can say whose it was.
  //
  // It follows `early`'s precedent exactly — a THIRD independent optional
  // field, added beside the other two rather than widening either. That is what
  // keeps every pre-existing entry (which carries no `by` at all) reading
  // exactly as it always has, migrating by construction through this read path.
  //
  // TWO RULES, AND BOTH ARE LOAD-BEARING:
  //
  //   OPTIONAL, ALWAYS. An absent `by` is legal and means "written before this
  //   device was named". An unnamed device answers rows exactly as it did
  //   before this field existed, and rows answered before naming stay valid and
  //   are never retro-stamped. Attribution is an improvement, never a gate.
  //
  //   INDEPENDENT OF `auto` AND `early` (ADR-0022). `by` answers WHO, the other
  //   two answer HOW, and no consumer may infer either from the other. Nothing
  //   in this module's overwrite safety reads `by`: a name neither protects a
  //   row from a correction nor exposes one to it. All eight combinations are
  //   legal and each survives this gate on its own terms.
  //
  // Unlike an area it is NOT upper-cased — it is a person's name, and folding
  // case would print MARISOL back at review. It is trimmed and length-capped,
  // because it is a name and not a notes field.

  // The cap is deliberately generous for a name and far short of a sentence.
  // The page's input carries the same maxlength so a typed name is never
  // silently shorter on disk than in the box, and
  // tests/actual-area-by-attribution.test.js pins all three readings of 40
  // against each other — a comment is not a drift guard in this repo.
  const MAX_BY_LEN = 40;

  // SLICE, THEN TRIM — the order is load-bearing, and getting it backwards
  // splits one person into two authors.
  //
  // Trimming first lets the cut land ON a space, so set() stamps a 40-char name
  // ending in a space while restore() trims that same name to 39 on the very
  // next reload. Two distinct strings, one person, in the store #794's export
  // and merge key on — exactly the collision the cap exists to prevent. Found
  // by the independent review of this PR (#852).
  function normalizeBy(raw) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_BY_LEN).trim();
  }

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
      // `typed` (#722) is CARRIED but never INVENTED here. See the field's own
      // section in the store header above, and adoptLegacyTyped() for why the
      // migration is a named step rather than a stamp in this read path.
      if (typeof v === 'object' && v.typed) entry.typed = true;
      // Same "only when set" rule: an unnamed device's entry keeps the exact
      // shape it has always had on disk, with no `by` key at all.
      const by = typeof v === 'object' ? normalizeBy(v.by) : '';
      if (by) entry.by = by;
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
  //   opts.by     this device's free-text name (#793), stamped on the typed row
  //               AND on every sibling this write fills — the device really did
  //               assign those packages, the supervisor just typed the stop
  //               once. Optional: omit it and nothing is recorded, which is an
  //               unnamed device working exactly as it always has.
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
    const by = normalizeBy(o.by);
    const changed = [];

    // entryFor(extra) -> a fresh entry carrying this write's attribution, if any.
    // Kept as one helper so the typed row and its siblings cannot drift apart on
    // whether they record the author.
    function entryFor(extra) {
      const e = Object.assign({ area: value, date: stamp }, extra || {});
      if (by) e.by = by;
      return e;
    }

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
    //
    // `typed: true` is the POSITIVE provenance marker (#722). This line is the
    // only place in this function where a human's own keystrokes land — the
    // siblings below are `auto` and stay that way. It is one of the marker's
    // TWO writers; adoptLegacyTyped is the other, and the store header above
    // says what each of them actually proves.
    next[key] = entryFor({ typed: true });

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
      next[l] = entryFor({ auto: true });
      changed.push(l);
    });

    return { store: next, changed: changed };
  }

  // reflow(store, opts) -> { store, changed }
  //
  // DOCK FLEX ON A SAME-DAY UPDATED REPORT (issue #739). The load-time half of
  // what set()/setEarly() do at type time.
  //
  //   opts.items  [{ label, address }] — the rows the page has just built from
  //               the report it has just loaded.
  //   opts.today  the LOADED REPORT's sort day (lib/sort-day.js), never the
  //               device clock. This module still reads no clock.
  //   opts.early  true when the loaded report is the POST SORT report, so every
  //               write is stamped `early: true` whatever the source says. See
  //               rule 4 below; the default (absent) INHERITS from the source,
  //               which is the main report's behaviour and is unchanged.
  //
  // WHY IT HAS TO EXIST: propagation fires when a value is typed, and spreads
  // only across the item list that existed at that moment. Tyler re-drops an
  // updated report several times a shift (#610, job 1), so packages for a stop
  // he already answered ARRIVE afterwards and land blank. He then re-answers a
  // stop he has already worked, which is the FRO lookup dock flex exists to
  // spend once.
  //
  // It only ever ADDS. It writes nothing onto a label that already carries an
  // area, removes nothing, and rolls nothing — the sort-day roll belongs to
  // SortDay.rollToSortDay and pruning to the loaded report belongs to the
  // page's reconcile paths. A function that only fills blanks cannot lose a
  // supervisor's typed work however it is called, and it is called on every
  // load.
  //
  // THE FIVE RULES IT KEEPS, each one an ADR 0022 invariant:
  //
  //   1. UNIT-EXACT (invariant 3). Matching rides exactKey, so APT 171 never
  //      answers for APT 328. Both keys still require a house number and a
  //      street name (invariant 4), so a bare ZIP matches nothing.
  //   2. SAME SORT DAY ONLY (invariant 6, #695/#702). A source entry must be
  //      stamped with the day being loaded. On a new sort day Tyler re-runs FRO,
  //      so yesterday's answer is a dated note and never a value. An entry with
  //      no usable stamp cannot prove it belongs to today and is not a source
  //      either — failing closed costs a convenience, failing open routes a
  //      package off a stale answer.
  //   3. NEVER OVERWRITE. Any label already carrying an area is skipped, typed
  //      or auto. This is deliberately stricter than set()'s rule 1, which does
  //      update its own `auto` values: set() knows a human just typed the
  //      correction it is spreading, and this function knows only that two
  //      answers exist for one stop. Choosing between them at load time, with
  //      nobody watching, is not a choice worth making silently.
  //   4. SAME PROVENANCE AS A TYPE-TIME SIBLING (invariants 1 and 5). Every
  //      write is `auto`, so the "same addr" tag shows and an area the
  //      supervisor never typed is never silent. `early` follows the LANE, and
  //      the rule is "whatever this lane's type-time propagation would have
  //      written":
  //
  //        opts.early absent (MAIN report) .... INHERITED from the source, which
  //          is what set()'s propagation does — an area typed on a main row
  //          spreads as a main value, one carried in early spreads as early.
  //        opts.early true (POST SORT report) . ALWAYS `early: true`, which is
  //          what setEarly()'s propagation does: it stamps `early: true`
  //          unconditionally, never inheriting.
  //
  //      THE ASYMMETRY IS NOT A WART, AND UNDOING IT SILENTLY BREAKS TYPING
  //      (#827). setEarly may only touch an entry that is absent or already
  //      `early` (its oursToTouch gate — the #642 hard requirement). A Post Sort
  //      load that inherited a MAIN-typed area onto its blank rows would leave
  //      them `{ auto: true }` with no `early`, and the supervisor's own blur on
  //      that very box would then be REFUSED, silently, by that gate. Stamping
  //      the lane's own provenance is what keeps the load-time re-apply and the
  //      type-time propagation writing the same shape, which is the whole
  //      premise of them sharing a pool.
  //
  //      `early` is also simply TRUE of these rows in its own terms: it means
  //      "not yet confirmed against a scan on the report this tool runs", and
  //      no row of the Post Sort report has been. isScanned() therefore still
  //      reads every one of them as unworked, so nothing here can make a
  //      package count as scanned, hide a row, or print on a card unworked.
  //   5. DETERMINISTIC when one stop has two answers. A hand-typed source beats
  //      one propagation wrote; ties break to the first occurrence in `items`,
  //      the report's own order. Without this the arriving row's area would
  //      depend on object key order.
  //   6. THE SOURCE MUST NAME A PROVENANCE (#722, added by #865's review).
  //      An entry carrying none is one nobody can account for, and this function
  //      is a PRINTING path in disguise: every copy it writes is stamped `auto`,
  //      which IbnoBarcodeSheet.cardArea prints. Without this gate the barcode
  //      card's guard holds on the injected row and fails on its siblings —
  //      card 1 a dash, card 2 the report's own 999, at the same stop, on the
  //      same sheet. That is ADR 0022 invariant 5 ("nothing propagated may ...
  //      print on a card unworked") and it is the ticket defeated one row over.
  //
  //      It is deliberately a gate on CANDIDACY, not a new tie-break. Rule 5's
  //      `held.auto && !e.auto` reads as "prefer a non-auto answer", and before
  //      this gate that phrase preferred an UNACCOUNTABLE entry over a real
  //      propagated one — the absence-inference this ticket removed, still
  //      deciding which area a stop gets. Removing such entries from the pool
  //      fixes that at the root and leaves rule 5's typed-vs-early semantics
  //      exactly as they were.
  //
  //      A legacy markerless entry is NOT lost to this: adoptLegacyTyped runs at
  //      the store load, before any report is dropped, so by the time reflow
  //      sees it it is `typed`.
  function reflow(store, opts) {
    const o = opts || {};
    const next = restore(store);
    const day = o.today ? String(o.today) : '';
    const items = o.items;
    const laneIsEarly = !!o.early;   // rule 4: the POST SORT lane stamps its own
    const changed = [];
    if (!day || !items || !items.length) return { store: next, changed: changed };

    const sources = Object.create(null);  // exactKey -> the entry that answers for that stop
    const blanks = [];                    // [{ label, key }] rows with no area of their own

    items.forEach(function (item) {
      const label = item && item.label != null ? String(item.label) : '';
      if (!label) return;
      const key = exactKey(item && item.address);
      if (!key) return;                   // rule 1: not specific enough to be a stop
      const e = next[label];
      if (!e || !e.area) { blanks.push({ label: label, key: key }); return; }
      if (String(e.date || '') !== day) return;   // rule 2
      if (!hasKnownProvenance(e)) return;         // rule 6
      const held = sources[key];
      // rule 5: first occurrence wins, unless a hand-typed answer turns up later
      if (!held || (held.auto && !e.auto)) sources[key] = e;
    });

    blanks.forEach(function (b) {
      const src = sources[b.key];
      if (!src) return;
      const entry = { area: src.area, date: day, auto: true };   // rule 4
      if (laneIsEarly || src.early) entry.early = true;
      // Attribution (#793) travels with the value it is spreading, for the same
      // reason the type-time paths stamp their siblings: this is the load-time
      // HALF of that same act, so a row filled here and a row filled at type
      // time must not disagree about who assigned the stop. reflow itself never
      // invents a name — with an unattributed source there is nothing to carry.
      if (src.by) entry.by = src.by;
      next[b.label] = entry;
      changed.push(b.label);
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

  // hasKnownProvenance(entry) -> can anything account for how this value got
  // into the store? (#722)
  //
  // True for exactly the three flags this module writes, and it is the ENTRY
  // form of the same question areaProvenanceOf asks by label. It exists because
  // the card guard is not the only place an unaccountable area can reach paper:
  // reflow (below) spreads a stored value across a stop and stamps the copies
  // `auto`, which IS on IbnoBarcodeSheet's printable allowlist. So an entry that
  // correctly dashes on its own card would print on every dock-flex sibling at
  // the same stop — the ticket's own guard walked around, one row over. Found
  // by the independent review of PR #865, reproduced on two rows at one address.
  function hasKnownProvenance(e) {
    return !!(e && (e.typed || e.auto || e.early));
  }

  // isTyped(store, label) -> did a human type this area on a MANUAL REVIEW row?
  // (#722)
  //
  // THE LANE IS PART OF THE QUESTION, and leaving it out undercounts real human
  // input. A hand-typed POST SORT row is every bit as typed, but it commits
  // through setEarly and carries `early` alone — so this answers FALSE for it,
  // deliberately and correctly, because `early` is the provenance that row has.
  // ADR 0022's table is the authority on all four combinations. A consumer that
  // wants "did a person decide this" reads the whole provenance, not this one
  // predicate; the card's allowlist is the model, since it names all three.
  //
  // The POSITIVE reader for the positive marker. It is deliberately NOT
  // `!isAuto && !isEarly`: that expression is the inference #722 removed, and
  // it answers "true" for an entry nobody can account for — which on the
  // barcode sheet means printing a work area a package handler then walks.
  //
  // A markerless entry answers FALSE here, and that is the point. It is a real
  // possibility on exactly two paths, both handled by adoptLegacyTyped() at
  // their boundary: a store written before this ticket, and a Day Export
  // arriving from a device that has not been updated yet.
  function isTyped(store, label) {
    const e = store && store[String(label)];
    return !!(e && e.typed);
  }

  // adoptLegacyTyped(store) -> a NEW store in which every entry that carries an
  // area and NO provenance at all is adopted as `typed: true`. (#722)
  //
  // THE MIGRATION, and the decision it encodes: a markerless entry is treated
  // as hand-typed, because on the day this ships that is what every one of them
  // is. The alternative — dashing them — would silently blank a real
  // supervisor's already-answered rows on the upgrade, on a records-tier
  // surface, for a defect that is latent rather than live. Losing an answer he
  // already paid an FRO lookup for is the worse error, and it is the error he
  // would not be told about.
  //
  // ITS COST, STATED: this function cannot tell a pre-#722 typed area from a
  // report area some future writer dropped into the store before this call.
  // That is why it is a NAMED STEP AT A BOUNDARY and not a stamp inside
  // restore(). restore() runs inside set(), setEarly(), reflow(), prune() and
  // every Day Export build/parse/merge, so migrating there would re-launder any
  // markerless entry — at any time, from any writer — straight back into "a
  // human typed this", rebuilding the catch-all this ticket removed one level
  // down. Callers apply this exactly where LEGACY data crosses into the tool:
  // the load of the persisted store, and the import of a Day Export. Everything
  // written after that point carries its own provenance and needs no adoption.
  //
  // It is idempotent, mutates nothing, and adds no key to an entry that already
  // names a provenance.
  function adoptLegacyTyped(store) {
    const next = restore(store);
    Object.keys(next).forEach(function (label) {
      const e = next[label];
      if (!e || !e.area) return;
      if (e.typed || e.auto || e.early) return;
      e.typed = true;
    });
    return next;
  }

  // isEarly(store, label) -> was this value written by the Post Sort
  // pre-assignment lane (issue #634), ahead of the full report? Distinct from
  // isAuto: an early value was never confirmed against a scan on the report
  // this tool actually runs, so it must never be mistaken for a worked row.
  function isEarly(store, label) {
    const e = store && store[String(label)];
    return !!(e && e.early);
  }

  // ─── WHO ANSWERED THIS ROW (issue #886) ─────────────────────────────────
  //
  // byOf(store, label) -> the free-text name (#793/#852) of whoever wrote this
  // row's area, or '' when the entry has none. An absent `by` is ALWAYS legal:
  // every area written before attribution existed has none, and those rows must
  // keep rendering exactly as they did.
  //
  // WHICH PREDICATE ANSWERS WHICH QUESTION (ADR 0022). Neither reader below is
  // one. They answer "who typed this", which NO existing consumer asks:
  // isAnswered, isScanned, isAuto, isEarly, nextNeedingArea and the progress
  // bar's worked half all read `area` and the provenance flags, and none of
  // them gains a read of `by` here. This is a render-only fact — #740 is what
  // happens when a store quietly starts answering a question nobody asked it.
  function byOf(store, label) {
    const e = store && store[String(label)];
    return (e && normalizeBy(e.by)) || '';
  }

  // otherBy(store, label, self) -> the author's name when this row was answered
  // by SOMEONE ELSE, or '' when it was this device, when there is no author, or
  // when this device is unnamed.
  //
  // WHY THE COMPARISON LIVES HERE and not in the page: it decides whether a row
  // reads as "already handled by someone else", which is the whole point of the
  // pill, so it gets a test rather than a glance at a template string.
  //
  // CASE- AND SPACING-INSENSITIVE, and both sides go through normalizeBy first.
  // The name is typed by hand, once per Windows profile, and "marisol" on one
  // device is the same human as "Marisol" on the other. Comparing raw would put
  // a "someone else did this" pill on the user's OWN rows after a re-type with
  // different capitalisation, which is precisely the noise story 2 forbids.
  //
  // AN UNNAMED DEVICE SHOWS NO PILL. With self === '' every attributed row in
  // the store would otherwise read as foreign, so a user who never opened
  // Settings would see a pill on every row including their own. Silence is the
  // safe default: the pill claims "not you", and an unnamed device cannot know.
  function otherBy(store, label, self) {
    const by = byOf(store, label);
    if (!by) return '';
    const me = normalizeBy(typeof self === 'string' ? self : '');
    if (!me) return '';
    return by.toLowerCase() === me.toLowerCase() ? '' : by;
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
    // Attribution (#793) rides here exactly as it does on set(): stamped on the
    // typed row and on the siblings this write fills, absent when the device
    // has no name. It is not consulted by oursToTouch below — whose name is on
    // an entry has no bearing on whether this lane may overwrite it.
    const by = normalizeBy(o.by);
    const before = next[key];
    const changed = [];
    const oursToTouch = (e) => !e || !!e.early;
    function entryFor(extra) {
      const e = Object.assign({ area: value, date: stamp }, extra || {});
      if (by) e.by = by;
      return e;
    }

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
    // RE-TYPING THE SAME VALUE DOES NOT RE-STAMP THE AUTHOR, and that differs
    // from set(), which rewrites the entry unconditionally and so moves `by` to
    // whoever last typed. Named here because #886 made the difference VISIBLE:
    // on the Post Sort lane, Tyler re-typing Marisol's 275 to confirm he agrees
    // leaves her pill in place, while the identical keystrokes on the main lane
    // would clear it.
    //
    // KEPT DELIBERATELY (review of PR #909). `by` records who DECIDED this
    // stop's belt, and agreeing with a decision is not making it — she still
    // decided it. Re-stamping on agreement would also quietly erase the one
    // signal that says a row came from the other desk, which is the whole point
    // of the pill. Typing a DIFFERENT value is a real change of mind and does
    // re-stamp, via the branch below.
    //
    // Pinned by tests/ibno-by-tag-dom.test.js so it stays a decision.
    if (!before || before.area !== value) {
      next[key] = entryFor({ early: true });
      changed.push(key);
    }

    siblings.forEach(function (l) {
      const e = next[l];
      if (!oursToTouch(e)) return;               // never ours: hand-typed or confirmed-auto
      if (e && e.area === value && e.auto) return; // already says this, already tagged
      next[l] = entryFor({ early: true, auto: true });
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
  // THAT IS A COMPENSATING CONTROL, AND IT HAS A TEST (#785).
  // tests/ibno-early-visibility-dom.test.js is it. The skip below is deliberate,
  // and the visibility channel is the ONLY thing left standing between it and a
  // carried early area passing unreviewed on a main-report day — so that channel
  // is pinned rather than assumed. The channel is goesToCell()'s `.early-tag`,
  // rendered off isEarly() beside the Goes To box, and it is what survives the
  // report swap: handleFile calls clearPostSortLane(), so the early lane and its
  // `.early-category-chip` / `.early-code-chip` are gone by the time this matters.
  // Before weakening isEarly(), goesToCell(), or that tag, read the test and
  // ADR 0022's consequences section — do NOT answer it by putting isScanned()
  // back here, which is ADR 0022 invariant 7 and resurrects #778.
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
    reflow: reflow,
    matchesFor: matchesFor,
    isAuto: isAuto,
    isTyped: isTyped,
    adoptLegacyTyped: adoptLegacyTyped,
    isEarly: isEarly,
    byOf: byOf,
    otherBy: otherBy,
    isAnswered: isAnswered,
    isScanned: isScanned,
    setEarly: setEarly,
    nextNeedingArea: nextNeedingArea,
    prune: prune,
  };
});
