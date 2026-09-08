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
// ─── PARK IS NOT SORT-DAY FILTERED ON READ. FILED IS, AND FAILS CLOSED ──────
//
// The two stores have deliberately different lifetimes and this lane must not
// flatten them (ibno-parked.js and ibno-filed.js each say so in their headers):
//
//   PARK CARRIES ACROSS A SORT DAY (#730/#753). A park leaves only by an Unpark
//   or by the package falling out of a fresh report. Gating the read on the day
//   would hide exactly the rows Tyler most needs to see — the ones she deferred
//   yesterday and nobody has answered since. A judgement call never expires, so
//   it crosses whatever day it carries, including none.
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

    const parkedItems = (env.parked && isPlainObject(env.parked.items)) ? env.parked.items : {};
    const parked = {};
    Object.keys(parkedItems).forEach(function (label) { parked[label] = parkedItems[label]; });

    // THE FILED GATE, AND IT FAILS CLOSED. Both days must be readable AND
    // equal. An undated publishing store, an undated reader, or a foreign day
    // all carry nothing — see the header for why this store and not the other.
    const filed = {};
    const want = dayText(o.day);
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
    freshness: freshness,
    absentDesks: absentDesks,
  };
});
