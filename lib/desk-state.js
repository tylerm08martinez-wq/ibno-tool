'use strict';

// THE 999 DESK STATE LANE — each device's Park and Work-area-assigned state,
// published READ-ONLY on a file of its own (issue #945, PRD #887, ADR-0023 as
// amended 2026-08-27).
//
// Dual-loadable with no build step:
// - Browser: window.DeskState
// - Node:    require('./lib/desk-state')
//
// ─── WHY THIS IS A SECOND LANE AND NOT A SECOND KEY ─────────────────────────
//
// Tyler's ask (2026-09-03): "I should be able to see what my admins have parked
// and 503'd so I'm not reworking their work, and audit it; and see their Work
// Area Assigned page so I know what's been assigned where."
//
// There were two existing channels and NEITHER could carry it:
//
//   lib/remote-areas.js is AREAS AND `by`, NOTHING ELSE, EVER (ADR-0023's
//   amendment says so twice). That rule is not about payload size — `applyTo`
//   WRITES what it carries into Tyler's own stores, so importing her filings
//   would silently REMOVE rows from his working list and importing her park
//   would violate "Park is never auto-cleared" (#730). Adding a key there also
//   makes it VERSION 2 and a mixed-build fleet stops reading each other.
//
//   lib/day-export.js already carries park and filed — at END OF SHIFT, merged
//   into Tyler's own stores with no author, so hers become indistinguishable
//   from his. Adding a store there is VERSION 4 (day-export.js:23-27).
//
// So: a NEW file, a NEW kind, its OWN VERSION 1. Neither existing envelope is
// bumped, and the whole of this lane is DISPLAY. Nothing here writes into a
// local store, and nothing on the answer path — `isSetAside`, `isAnswered`, the
// badges and chips, the progress denominator, lib/ibno-merged-view.js's
// predicates — may ever read the structure this module builds. That is the
// single property the DOM test exists to pin.
//
// ONE STATE IS NOW AN EXPLICIT EXCEPTION TO THAT LAST SENTENCE (#971 decision
// A3, and read the `filedBy` block below plus ADR 0022's amendment before
// touching it). The `filed` store — and ONLY the `filed` store, only through
// `filedBy()`, and only for a row the other desk BARCODED AND MARKED DONE on
// the loaded sort day — does reach the answer path: `isSetAside` counts it and
// the row auto-moves into the matching set-aside tab, credited to its author.
// That is deliberate: it is finished work, so a chip that still counted it
// would promise a row the working list will not produce. Everything else in
// this envelope stays pure display, `parked` above all — the park lane still
// may not reach `isSetAside`, and a local park OUTRANKS a remote marked-done
// (ibno-coder.html's `remoteAssignedRows` / `setAside503Predicate` say so).
// Nothing here writes into a local store even in the excepted state: the move
// is DERIVED live from this map, never merged into `filedStore` or ActualArea.
//
// AND #990 NARROWS THAT EXCEPTION AGAIN WITHOUT ADDING A SECOND ONE. Tyler,
// 2026-09-09, after seeing #971 shipped: "for the 503 and parked, I want it to
// still be in the needs manual review tab but has a little note that shows that
// it was parked or 503d, and who did it." So `filedBy` still reaches the answer
// path, but ONLY for a row whose area is not 503 — a 503 they marked done stays
// in Tyler's working list carrying a `503 · <name>` NOTE. And `parkedBy` below
// is a NEW reader of the `parked` store that is PURE DISPLAY: it feeds the
// `Parked · <name>` note and nothing else.
//
//   A NOTE IS DISPLAY. `isSetAside` IS NOT.
//
// A `parkedBy` lookup that feeds only a pill honours the contract in this
// header; one that reaches `isSetAside`, a badge, a lane filter or the progress
// denominator violates it, and a test pins that with a mutation shown RED.
//
// ─── ONE FILE PER WRITER, THE SAME WAY ──────────────────────────────────────
//
//   desk/<device-slug>.json
//
// Same reasoning as lib/remote-areas.js's areas/<slug>.json: each device owns
// exactly one path and overwrites only its own, so the concurrent-write class
// is removed rather than managed. THE SLUG IS RemoteAreas.deviceSlug, not a
// second copy of the fold — a device's identity must not be able to differ
// between its two files, and `deviceSlug('') -> ''` is the same off switch: an
// unnamed device has nothing to write to and publishes nothing.
//
// ─── PARK IS GATED ON THE FILE'S DAY, NOT THE ENTRY'S. FILED FAILS CLOSED ───
//
// The two stores have deliberately different lifetimes and this lane must not
// flatten them (ibno-parked.js and ibno-filed.js each say so in their headers):
//
//   PARK CARRIES ACROSS A SORT DAY (#730/#753). A park leaves only by an Unpark
//   or by the package falling out of a fresh report. Gating the read on each
//   ENTRY'S day would hide exactly the rows Tyler most needs to see — the ones
//   she deferred yesterday and nobody has answered since. A judgement call never
//   expires, so an entry crosses whatever day it carries, including none, and
//   `parkedDay()` shows the day it was made on so a carried park reads as
//   carried rather than as today's.
//
//   WHAT IS GATED IS THE PUBLISHING STORE'S OWN STAMP (#990 decision 2, Tyler
//   2026-09-09: "day gate it but show parked and the date"). A file whose park
//   store is stamped a DIFFERENT readable day from the loaded report carries
//   nothing: that is a desk which has not been near this sort, and the #990
//   browser verify caught one stamped 2026-01-02 drawing a live note against a
//   2026-08-13 report. An UNDATED park store still carries — see record()'s gate
//   for why this half stays open where `filed`'s does not. So `parked` is NO
//   LONGER carried unconditionally, and this paragraph is the contract.
//
//   FILED RESETS ON A NEW SORT DAY (#734 acceptance 7, ADR-0022 invariant 6).
//   "Yesterday's assignment is not evidence about today's package" and a
//   tracking number does repeat across days. So filed rows cross only when the
//   publishing store's stamp IS the loaded report's sort day, and an UNDATED
//   store fails CLOSED — a filing this lane cannot date is a filing it cannot
//   place, and showing it against today's list is the one way this read-only
//   surface could mislead a supervisor into skipping a real package.
//
// ─── AND IT NEVER RE-PUBLISHES ANOTHER DEVICE'S ROWS ────────────────────────
//
// Structural, not a rule that has to be remembered: `build` reads THIS device's
// stores, `record` writes only the in-memory map, and the two never meet. The
// map is also keyed by slug and a file authored by this device is skipped on
// read, so a device cannot echo itself either.
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DeskState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function req(name, path) {
    const v = (root && root[name]) ||
      (typeof require === 'function' ? require(path) : null);
    if (!v) throw new Error('DeskState dependencies unavailable (need ' + name + ')');
    return v;
  }
  function remoteAreasLib() { return req('RemoteAreas', './remote-areas'); }
  function parkedLib() { return req('IbnoParked', './ibno-parked'); }
  function filedLib() { return req('IbnoFiled', './ibno-filed'); }

  const KIND = 'ibno-desk-state';
  const VERSION = 1;
  const DIR = 'desk';

  // ─── IDENTITY ─────────────────────────────────────────────────────────────

  // Delegated on purpose — see the header. One device, one identity, two files.
  function deviceSlug(name) { return remoteAreasLib().deviceSlug(name); }

  function pathFor(name) {
    const slug = deviceSlug(name);
    return slug ? DIR + '/' + slug + '.json' : '';
  }

  function sameFile(a, b) {
    const pa = pathFor(a);
    const pb = pathFor(b);
    return !!pa && pa === pb;
  }

  // ─── SHAPES ───────────────────────────────────────────────────────────────

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function dayText(raw) {
    const s = String(raw == null ? '' : raw).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  }

  function emptyStore() { return { day: '', items: {} }; }

  // Each store goes through ITS OWN module's gate, the way lib/day-export.js
  // does it: an envelope can only ever carry entries the reading surface would
  // accept, so junk drops here rather than at the far end where it would have
  // to be explained. migrateEntries additionally backfills a per-label day from
  // the store's stamp, so a park published by an old device arrives already
  // resolved rather than inheriting the reader's day.
  function normalizeParked(store) {
    if (!isPlainObject(store)) return null;
    const s = parkedLib().migrateEntries(store);
    return isPlainObject(s) && isPlainObject(s.items) ? { day: dayText(s.day), items: s.items } : null;
  }

  function normalizeFiled(store) {
    if (!isPlainObject(store)) return null;
    const s = filedLib().normalizeEntries(store);
    return isPlainObject(s) && isPlainObject(s.items) ? { day: dayText(s.day), items: s.items } : null;
  }

  // ─── BUILD ────────────────────────────────────────────────────────────────

  // build({ day, by, updatedAt, parked, filed }) -> the envelope.
  //
  // SEVEN KEYS AND NO MORE, asserted exactly in tests/desk-state.test.js. Extra
  // keys on `input` are dropped rather than copied, on lib/remote-areas.js's
  // reasoning: a store must not be able to arrive here by habit, and adding one
  // is a deliberate act that bumps VERSION.
  //
  // NOTHING FROM THE ANSWER PATH TRAVELS. No areas, no scanned ticks, no codes,
  // no archive rows. Areas have their own lane and their own rules; this one is
  // the two SET-ASIDE stores and who set them aside.
  function build(input) {
    const i = input || {};
    return {
      kind: KIND,
      version: VERSION,
      day: dayText(i.day),
      by: String(i.by == null ? '' : i.by).trim(),
      updatedAt: String(i.updatedAt == null ? '' : i.updatedAt),
      parked: normalizeParked(i.parked) || emptyStore(),
      filed: normalizeFiled(i.filed) || emptyStore(),
    };
  }

  function stringify(env) { return JSON.stringify(env, null, 2) + '\n'; }

  // ─── PARSE ────────────────────────────────────────────────────────────────

  // parse(raw) -> { ok, envelope } | { ok: false, reason, error }.
  //
  // The four refusal reasons are lib/remote-areas.js's, verbatim in meaning,
  // because the caller's one sentence has the same job and only ONE of them
  // means "that device is ahead of this one":
  //
  //   'version' — a build this one cannot read. UPDATE THIS DEVICE.
  //   'json'    — truncated or corrupt bytes. Nothing to update; try again.
  //   'shape'   — not an object, or a store that is not a store.
  //               GithubJsonSync.fetchRemote swallows a JSON error of its own
  //               and hands back `[]`, which lands here.
  //   'kind'    — some other tool's file in the desk/ directory.
  //
  // A MALFORMED STORE IS 'shape', NOT A SILENT EMPTY. This is the one place
  // this module is stricter than remote-areas (which drops a single bad ROW and
  // keeps the file, and so does this one, inside the per-store gates above). A
  // `parked` that is not a day store cannot be told apart from a desk that has
  // parked nothing — and "nothing parked" is precisely the answer that makes
  // Tyler rework her row, which is the whole problem #887 exists to solve.
  function parse(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'json', error: 'not valid JSON' }; }
    }
    if (!isPlainObject(parsed)) return { ok: false, reason: 'shape', error: 'not an object' };
    if (parsed.kind !== KIND) {
      return { ok: false, reason: 'kind', error: 'wrong kind: expected ' + KIND + ', got ' + JSON.stringify(parsed.kind) };
    }
    if (parsed.version !== VERSION) {
      return { ok: false, reason: 'version', error: 'unsupported version ' + JSON.stringify(parsed.version) + ' (this build reads ' + VERSION + ')' };
    }
    const parked = parsed.parked === undefined || parsed.parked === null ? emptyStore() : normalizeParked(parsed.parked);
    if (!parked) return { ok: false, reason: 'shape', error: 'park decisions are the wrong shape' };
    const filed = parsed.filed === undefined || parsed.filed === null ? emptyStore() : normalizeFiled(parsed.filed);
    if (!filed) return { ok: false, reason: 'shape', error: 'barcoded rows are the wrong shape' };
    return {
      ok: true,
      envelope: {
        kind: KIND,
        version: VERSION,
        day: dayText(parsed.day),
        by: String(parsed.by == null ? '' : parsed.by).trim(),
        updatedAt: String(parsed.updatedAt == null ? '' : parsed.updatedAt),
        parked: parked,
        filed: filed,
      },
    };
  }

  // ─── THE READ SIDE: AN IN-MEMORY, READ-ONLY MAP ─────────────────────────────
  //
  // { '<slug>': { slug, by, day, updatedAt, parked: {label: entry},
  //               filed: {label: entry}, parkedCount, filedCount } }
  //
  // A PLAIN OBJECT THE PAGE HOLDS IN A VARIABLE, never persisted and never
  // merged. It is not a day store and deliberately does not look like one: the
  // #740 class (ADR-0022) is a consumer reading the wrong store because two
  // stores had the same shape, and the cheapest defence is for this one to be
  // shaped like nothing else on the page.

  function empty() { return {}; }

  // record(map, env, opts) -> a NEW map with this desk's entry replaced whole.
  //
  // A FILE IS THE WHOLE TRUTH ABOUT ITS AUTHOR, the same rule remote-areas
  // states: her park of an hour ago that her file no longer carries is a park
  // she has CLEARED, so the entry is replaced rather than merged into. Because
  // nothing here writes a local store, that costs nothing to get right.
  //
  // opts.day  — the LOADED REPORT'S sort day (never a device clock). Gates
  //             `filed` only; see the header.
  // opts.self — this device's name. Its own file is skipped: reading it back
  //             would show Tyler his own park under someone else's heading.
  function record(map, env, opts) {
    const o = opts || {};
    const next = Object.assign({}, isPlainObject(map) ? map : {});
    if (!isPlainObject(env)) return next;
    const by = String(env.by == null ? '' : env.by).trim();
    const slug = deviceSlug(by);
    // AN ANONYMOUS FILE HAS NO KEY. deviceSlug('') is the off switch on the
    // publish side, and the read side honours it rather than inventing a
    // heading: rows nobody can be attributed to are exactly what the #886 pill
    // and the `remote` flag exist to prevent being shown as somebody's work.
    if (!slug) return next;
    const self = String(o.self == null ? '' : o.self).trim();
    if (self && sameFile(by, self)) return next;

    const want = dayText(o.day);

    // THE PARK GATE (#990 decision 2, Tyler 2026-09-09: "day gate it but show
    // parked and the date"). It is the FILED GATE'S SHAPE, deliberately one
    // notch looser, and the difference is the whole point:
    //
    //   FOREIGN DAY  -> carries NOTHING. A desk file stamped 2026-01-02 read
    //                   against a 2026-08-13 report is a device that has not
    //                   been near this sort; the #990 browser verify caught it
    //                   drawing a live `Parked · Old Desk` note off a file
    //                   eight months old. That is the case this gate closes.
    //   UNDATED      -> still CARRIES. `filed` fails closed on an undated store
    //                   because a filing it cannot date is a filing it cannot
    //                   place. A park is the opposite: it is a judgement call
    //                   that never expires (#730/#753), so an unstamped park
    //                   store is the ordinary shape of a desk that has parked a
    //                   row and not loaded a report since, and refusing it would
    //                   hide exactly the rows Tyler needs. Pinned by
    //                   tests/ibno-desk-sync-dom.test.js — "her PARK crosses
    //                   with no sort day at all".
    //
    // Only the STORE'S stamp is read, never the entries': a park entry keeps
    // its OWN day so a park carried in from an earlier sort day still crosses
    // inside a current file, dated. parkedDay() below is what shows that date.
    const parkedItems = (env.parked && isPlainObject(env.parked.items)) ? env.parked.items : {};
    const havePark = env.parked ? dayText(env.parked.day) : '';
    const parkForeign = !!(havePark && want && havePark !== want);
    const parked = {};
    if (!parkForeign) {
      Object.keys(parkedItems).forEach(function (label) { parked[label] = parkedItems[label]; });
    }

    // THE FILED GATE, AND IT FAILS CLOSED. Both days must be readable AND
    // equal. An undated publishing store, an undated reader, or a foreign day
    // all carry nothing — see the header for why this store and not the other.
    const filed = {};
    const have = env.filed ? dayText(env.filed.day) : '';
    if (want && have && want === have && isPlainObject(env.filed.items)) {
      Object.keys(env.filed.items).forEach(function (label) { filed[label] = env.filed.items[label]; });
    }

    next[slug] = {
      slug: slug,
      by: by,
      day: dayText(env.day),
      // THE FILED STORE'S OWN DAY, kept because it is not the envelope's
      // (#968 review finding 6). The gate above required `have === want`, so
      // this is the LOADED REPORT'S sort day; env.day is whatever the
      // publishing device's page held, which can be a day older on a roll.
      // rowsFor's When column shows the day a row belongs to, and for a filing
      // that is this one. Empty whenever the gate carried nothing.
      filedDay: Object.keys(filed).length ? have : '',
      updatedAt: String(env.updatedAt == null ? '' : env.updatedAt),
      parked: parked,
      filed: filed,
      parkedCount: Object.keys(parked).length,
      filedCount: Object.keys(filed).length,
    };
    return next;
  }

  // counts(map) -> { desks, parked, filed }. The tracer's one visible claim:
  // "one parked row and one filed row from the cage PC arrived and are held".
  function counts(map) {
    const m = isPlainObject(map) ? map : {};
    const keys = Object.keys(m);
    let parked = 0, filed = 0;
    keys.forEach(function (k) {
      parked += Object.keys((m[k] && m[k].parked) || {}).length;
      filed += Object.keys((m[k] && m[k].filed) || {}).length;
    });
    return { desks: keys.length, parked: parked, filed: filed };
  }

  // desks(map) -> the entries, slug-sorted, so a caller (and the follow-up
  // view, #949) has one stable order rather than object insertion order.
  function desks(map) {
    const m = isPlainObject(map) ? map : {};
    return Object.keys(m).sort().map(function (k) { return m[k]; });
  }

  // ─── ROW SHAPING FOR THE VIEW (#949) ──────────────────────────────────────
  //
  // STILL DISPLAY, STILL NOTHING ELSE. These three helpers exist so the read-
  // only "Other desk" pane has one testable place to ask "what did this desk
  // set aside, and is what I am looking at current" — instead of the page
  // walking the map by hand and inventing a second answer per surface. They
  // add NO key to the envelope: VERSION stays 1 and build()'s seven keys are
  // untouched (tests/desk-state.test.js pins both).
  //
  // Nothing here reads a LOCAL store, and nothing on the answer path may read
  // what they return. The page joins the label to an address and an area from
  // the report on screen; that join happens there because the report is the
  // page's, not this module's.

  // KIND NAMES, not the store names. 'parked' and 'assigned' are what the two
  // set-aside tabs are CALLED on screen, and the view groups by them, so the
  // shaping speaks the surface's vocabulary rather than the file's. Deliberate:
  // a reader of the pane must never have to know that "Work area assigned" is
  // the `filed` store.
  const KIND_PARKED = 'parked';
  const KIND_ASSIGNED = 'assigned';

  // rowsFor(desk) -> [{ kind, label, day, source }], parks first then filings,
  // each label-sorted so a repaint cannot reorder a pane nobody changed.
  //
  // A FILED ENTRY HAS NO DAY OF ITS OWN and lib/ibno-filed.js deliberately does
  // not give it one, so it inherits the FILED STORE'S day (`filedDay`, which
  // record() gated to the loaded report's sort day), falling back to the
  // envelope's day for a map entry recorded before that key existed. Not the
  // envelope's day outright: the two differ on a roll, and the When column
  // would then date her filing to the day her page last stamped its envelope.
  // A parked entry keeps its own day,
  // which may be older than the desk's (#753: a park carries across a roll),
  // and that is exactly the fact the "when" column exists to show.
  function rowsFor(desk) {
    const d = isPlainObject(desk) ? desk : {};
    const deskDay = dayText(d.day);
    const out = [];
    const walk = function (store, kind, fallbackDay) {
      const items = isPlainObject(store) ? store : {};
      Object.keys(items).sort().forEach(function (label) {
        const e = isPlainObject(items[label]) ? items[label] : {};
        out.push({
          kind: kind,
          label: String(label),
          day: dayText(e.day) || fallbackDay,
          source: String(e.source == null ? '' : e.source),
        });
      });
    };
    walk(d.parked, KIND_PARKED, '');
    walk(d.filed, KIND_ASSIGNED, dayText(d.filedDay) || deskDay);
    return out;
  }

  // ─── THE REMOTE-FILED LOOKUP (#971) ───────────────────────────────────────
  //
  // ONE QUESTION, ASKED BY LABEL: "did some OTHER desk generate the barcode and
  // press marked-as-done on this package, for the sort day I have loaded?"
  //
  // A LOOKUP HELPER, NOT A NEW STORE AND NOT A NEW ENVELOPE KEY. VERSION stays
  // 1 and build()'s seven keys are untouched — this reads the same map record()
  // already built, which is why it can be added at all under #971's scope lock.
  //
  // IT IS THE FIRST READER OF THIS MODULE THAT IS NOT PURE DISPLAY, and that is
  // a deliberate, recorded reversal for exactly one state (issue #971, decision
  // A3; ADR 0022's amendment names the predicate). Everything else this module
  // feeds is still the read-only pane. The caller — ibno-coder.html's
  // isRemoteFiled — is the only consumer, and ADR 0022 records which question
  // it answers so no second consumer can quietly borrow it for another.
  //
  // THE DAY GATE IS ASKED TWICE, ON PURPOSE. record() already refused to carry
  // a `filed` store whose day was not the loaded report's, and `filedDay` is
  // the stamp it kept. Passing `day` here asks the same question again at READ
  // time, so a map recorded before a sort-day roll cannot answer "yes" against
  // the new day while the next poll is still 30 seconds away. Filings reset on
  // a new sort day (#734 acceptance 7, ADR 0022 invariant 6) and a stale yes
  // would take a package out of Tyler's working list on a day nobody worked it.
  // An omitted `day` skips the second gate and leans on record()'s alone, which
  // is what a caller with no loaded report legitimately has.
  //
  // MATCHED BY LABEL AND NOTHING ELSE (#971 A1): a tracking number is the key
  // every lane in this codebase joins on, and the two devices are looking at
  // the same report.
  function deskCarriesFiled(desk, day) {
    if (!isPlainObject(desk)) return false;
    if (!isPlainObject(desk.filed)) return false;
    const want = dayText(day);
    if (want && dayText(desk.filedDay) !== want) return false;
    return true;
  }

  // filedBy(map, label, day) -> the NAME of the desk that marked this label
  // done, or ''. Slug-sorted so two desks claiming one label resolve the same
  // way on every render — a pill that changed name between repaints would be
  // the surface disagreeing with itself about who did the work.
  function filedBy(map, label, day) {
    const l = String(label == null ? '' : label).trim();
    if (!l) return '';
    const m = isPlainObject(map) ? map : {};
    const slugs = Object.keys(m).sort();
    for (let i = 0; i < slugs.length; i++) {
      const desk = m[slugs[i]];
      if (!deskCarriesFiled(desk, day)) continue;
      if (Object.prototype.hasOwnProperty.call(desk.filed, l)) {
        return String(desk.by == null ? '' : desk.by).trim();
      }
    }
    return '';
  }

  // ─── THE REMOTE-PARK LOOKUP (#990) ────────────────────────────────────────
  //
  // ONE QUESTION, ASKED BY LABEL: "has some OTHER desk parked this package?"
  //
  // IT IS PURE DISPLAY AND IT MUST STAY THAT WAY. `filedBy` above is the ONE
  // documented exception to this module's "nothing reaches the answer path"
  // rule (#971 decision A3). THIS IS NOT A SECOND EXCEPTION. Its only sanctioned
  // consumer is ibno-coder.html's `Parked · <name>` note on a Needs Manual
  // Review row — a LABEL ON SCREEN, nothing more. Tyler, 2026-09-09: "I want it
  // to still be in the needs manual review tab but has a little note that shows
  // that it was parked or 503d, and who did it."
  //
  //   A NOTE IS DISPLAY. `isSetAside` IS NOT.
  //
  // So a caller may paint what this returns and may not branch a lifecycle on
  // it: not `isSetAside`, not a badge, not the progress denominator, not a lane
  // filter, not a set-aside tab. Their park is THEIR judgement about THEIR
  // list; Tyler's row stays his to work (#990 decision A1), and Park on this
  // device stays Tyler's own and is never auto-cleared (#730).
  // tests/ibno-remote-503-park-note-dom.test.js pins that with a mutation:
  // wiring this read into `isSetAside` must go RED.
  //
  // NOT DAY-GATED AT READ TIME, and that is the same deliberate asymmetry the
  // header records: a park carries across a sort day (#753) and a judgement
  // call never expires, so gating THIS read on the loaded day would hide
  // exactly the rows Tyler most needs to see. `filedBy` asks its gate twice
  // because a filing resets on a new sort day (#734 acceptance 7, ADR 0022
  // invariant 6). Flattening the two is the mistake the header forbids.
  //
  // A STALE FILE IS ALREADY GONE BY HERE (#990 decision 2). record()'s park gate
  // refused to carry a park store stamped a foreign day, so what this walks is
  // a current file — including the older parks inside it, which is the case the
  // gate is deliberately shaped to keep. parkedDay() dates them.
  //
  // MATCHED BY LABEL AND NOTHING ELSE, and slug-sorted, for filedBy's reasons.
  function parkedBy(map, label) {
    const l = String(label == null ? '' : label).trim();
    if (!l) return '';
    const m = isPlainObject(map) ? map : {};
    const slugs = Object.keys(m).sort();
    for (let i = 0; i < slugs.length; i++) {
      const desk = m[slugs[i]];
      if (!isPlainObject(desk) || !isPlainObject(desk.parked)) continue;
      if (Object.prototype.hasOwnProperty.call(desk.parked, l)) {
        return String(desk.by == null ? '' : desk.by).trim();
      }
    }
    return '';
  }

  // parkedDay(map, label) -> the sort day the OTHER desk's park was MADE on, or
  // ''. parkedBy's twin, walked in the same slug-sorted order so the two always
  // describe the SAME park — a note reading one desk's name and another desk's
  // date would be the surface disagreeing with itself.
  //
  // THE PARK'S OWN DAY, not the file's. lib/ibno-parked.js gives every entry a
  // { source, day } and backfills `day` from the store's stamp on migrate, so
  // this is the day the judgement was made, which is what #990 decision 2 asks
  // the note to show: a park carried in from an earlier sort day inside a
  // CURRENT file is exactly the row Tyler wants to see dated. An entry with no
  // readable day returns '' and the note simply carries no date rather than
  // inventing one.
  //
  // STILL PURE DISPLAY, on the same terms as parkedBy above: a caller may paint
  // this and may not branch a lifecycle on it.
  function parkedDay(map, label) {
    const l = String(label == null ? '' : label).trim();
    if (!l) return '';
    const m = isPlainObject(map) ? map : {};
    const slugs = Object.keys(m).sort();
    for (let i = 0; i < slugs.length; i++) {
      const desk = m[slugs[i]];
      if (!isPlainObject(desk) || !isPlainObject(desk.parked)) continue;
      if (Object.prototype.hasOwnProperty.call(desk.parked, l)) {
        const e = desk.parked[l];
        return dayText(isPlainObject(e) ? e.day : '');
      }
    }
    return '';
  }

  // parkedLabels(map) -> every label any other desk has parked, sorted and
  // deduped. filedLabels' twin and used for the same job: a CHANGE KEY, so the
  // working lanes are repainted when the note set moves and not on every poll
  // tick. It answers a REPAINT question, never a lifecycle one.
  function parkedLabels(map) {
    const m = isPlainObject(map) ? map : {};
    const seen = Object.create(null);
    Object.keys(m).sort().forEach(function (slug) {
      const desk = m[slug];
      if (!isPlainObject(desk) || !isPlainObject(desk.parked)) return;
      Object.keys(desk.parked).forEach(function (l) { seen[l] = true; });
    });
    return Object.keys(seen).sort();
  }

  // filedLabels(map, day) -> every label any other desk has marked done, sorted
  // and deduped. The caller uses it as a CHANGE KEY: a repaint of the working
  // lanes is only owed when this set moves, and comparing a joined string is
  // cheaper and more honest than repainting the list on every poll tick.
  function filedLabels(map, day) {
    const m = isPlainObject(map) ? map : {};
    const seen = Object.create(null);
    Object.keys(m).sort().forEach(function (slug) {
      const desk = m[slug];
      if (!deskCarriesFiled(desk, day)) return;
      Object.keys(desk.filed).forEach(function (l) { seen[l] = true; });
    });
    return Object.keys(seen).sort();
  }

  // freshness(desk, opts) -> { at, ageMs, state, minutes }.
  //
  // THE ANSWER TO "PARKED NOTHING" vs "LANE IS BROKEN" (#949, carried from the
  // #967 review). deskStatePublish's failures are swallowed on the PUBLISHING
  // device — no pill, no banner, nothing observable from here — so on Tyler's
  // screen a desk whose publish has been failing all morning renders exactly
  // like a desk that has genuinely set nothing aside. An empty pane with no
  // freshness signal is the dangerous answer: it is the one that makes him
  // rework her row, which is the whole problem #887 exists to solve.
  //
  // Three states, and 'never' is NOT folded into 'stale':
  //   'never' — no readable updatedAt at all. Nothing is known about this
  //             desk's currency, which is different from knowing it is old.
  //   'stale' — older than opts.quietAfterMs (default 30 minutes, the same
  //             threshold lib/desk-health.js's quiet alarm uses, read from the
  //             caller so the two can never be tuned apart by accident).
  //   'fresh' — heard from inside the window.
  //
  // THE CLOCK IS THE CALLER'S. opts.now is an ISO stamp or a number; there is
  // no `new Date()` in here, so a test drives this by value rather than by
  // sleeping, and the page hands it the same clock every other stamp reads.
  function freshness(desk, opts) {
    const o = opts || {};
    const d = isPlainObject(desk) ? desk : {};
    const at = String(d.updatedAt == null ? '' : d.updatedAt).trim();
    const limit = typeof o.quietAfterMs === 'number' && o.quietAfterMs >= 0
      ? o.quietAfterMs : 30 * 60 * 1000;
    const stamp = at ? Date.parse(at) : NaN;
    if (!at || isNaN(stamp)) return { at: '', ageMs: null, state: 'never', minutes: null };
    const nowRaw = o.now == null ? Date.now() : o.now;
    const nowMs = typeof nowRaw === 'number' ? nowRaw : Date.parse(String(nowRaw));
    if (isNaN(nowMs)) return { at: at, ageMs: null, state: 'never', minutes: null };
    const ageMs = Math.max(0, nowMs - stamp);
    return {
      at: at,
      ageMs: ageMs,
      state: ageMs >= limit ? 'stale' : 'fresh',
      minutes: Math.max(1, Math.round(ageMs / 60000)),
    };
  }

  // absentDesks(map, roster) -> [{ by, updatedAt }] for every author the AREAS
  // lane has heard from today that has published NO state file at all.
  //
  // THE SECOND HALF OF THE SAME QUESTION, and the sharper half. A desk whose
  // areas are arriving is demonstrably alive and credentialed, so if its
  // desk/<slug>.json is missing the state lane specifically is broken — not the
  // network, not the token, not her shift. That is a distinction Tyler can act
  // on ("her park is not reaching me"), and it is invisible from the state
  // lane alone, which can only ever report the absence of a file.
  //
  // `roster` is lib/desk-health.js's `desks` map ({ author -> ISO updatedAt }),
  // passed in rather than imported: this module must not grow a dependency on
  // the health module to answer a display question.
  function absentDesks(map, roster) {
    const m = isPlainObject(map) ? map : {};
    const r = isPlainObject(roster) ? roster : {};
    const known = {};
    Object.keys(m).forEach(function (k) {
      const by = String((m[k] && m[k].by) || '').trim();
      if (by) known[deviceSlug(by)] = true;
    });
    return Object.keys(r).sort().filter(function (by) {
      const slug = deviceSlug(by);
      return !!slug && !known[slug];
    }).map(function (by) {
      return { by: by, updatedAt: String(r[by] == null ? '' : r[by]) };
    });
  }

  return {
    KIND: KIND,
    KIND_PARKED: KIND_PARKED,
    KIND_ASSIGNED: KIND_ASSIGNED,
    VERSION: VERSION,
    DIR: DIR,
    deviceSlug: deviceSlug,
    pathFor: pathFor,
    build: build,
    stringify: stringify,
    parse: parse,
    empty: empty,
    record: record,
    counts: counts,
    desks: desks,
    rowsFor: rowsFor,
    filedBy: filedBy,
    filedLabels: filedLabels,
    parkedBy: parkedBy,
    parkedDay: parkedDay,
    parkedLabels: parkedLabels,
    freshness: freshness,
    absentDesks: absentDesks,
  };
});
