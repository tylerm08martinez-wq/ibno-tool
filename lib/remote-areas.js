'use strict';

// THE 999 DESK LIVE LOOP — the wire format (issue #913, PRD #887).
//
// Under the 999 Desk an Admin works the Flagged Work Area list on the cage PC
// and Tyler works the same list on his own device. ADR-0023 originally settled
// this with no shared state at all: two copies, an ISP split, and one Day
// Export at end of shift. #887 REVERSED that — the coordination is now LIVE
// during the sort, and the Day Export stays on as the archive record (it is the
// only thing carrying `filed` and `park` into Tyler's archive) rather than as
// the channel. See ADR-0023's amendment for the four decisions and why.
//
// This module is the whole wire format: build, parse, the sort-day gate, which
// of this device's areas are ours to publish, and the apply step. Pure — no
// DOM, no network, and NO CLOCK: every date is passed in, because the day is
// the loaded report's day and lib/sort-day.js owns that question. Nothing here
// may grow a second opinion about what day it is.
//
// Dual-loadable with no build step:
// - Browser: window.RemoteAreas
// - Node:    require('./lib/remote-areas')
//
// ─── ONE FILE PER WRITER ────────────────────────────────────────────────────
//
//   areas/<device-slug>.json
//
// Never a shared file. That removes the concurrent-write class outright instead
// of managing it: each device owns exactly one path and overwrites only its
// own, so two people typing at once cannot race, and no merge rule has to be
// right under contention. The reader fetches every OTHER file in the directory.
//
// ─── WHAT TRAVELS, AND WHAT NEVER DOES ──────────────────────────────────────
//
// AREAS AND `by`. Nothing else, ever. `filed` and `park` stay off this loop
// under any circumstance (#887, and it matters MORE under "apply" than it would
// under "display"): importing the other desk's filings would silently REMOVE
// rows from Tyler's working list — packages hidden from him with no signal —
// and `park` is a human judgement frozen against automatic clears by #730. Both
// keep travelling in the Day Export, whose merge rules were written for a
// daily, human-reviewed import. `build` drops every other key on the floor and
// a test asserts its exact key set, so adding one is a deliberate act.
//
// ─── THE SORT-DAY GATE ──────────────────────────────────────────────────────
//
// A file whose `day` is not the loaded report's day is ignored ENTIRELY, on the
// same terms as lib/day-export.js. A stale publish — a device left open
// overnight, a file nobody cleaned up — must not reach into today's list.
//
// ─── A FILE IS THE WHOLE TRUTH ABOUT ITS AUTHOR ─────────────────────────────
//
// applyTo reads a same-day file as the COMPLETE statement of what that desk has
// answered today, not as a list of additions. A label the file no longer
// mentions is a label its author has CLEARED, and it clears here too. Without
// that, correction-by-deletion — the most ordinary correction there is — never
// crosses, and the withdrawn value stands all shift wearing her name on the
// #886 pill. A publisher may only withdraw its OWN rows, and an anonymous file
// may add but never delete; applyTo's own comment carries the reasoning.
//
// ─── AND A CLEAR ON THIS DEVICE IS THE SAME CORRECTION, GOING THE OTHER WAY ──
//
// The mirror of that rule is the CLEAR TOMBSTONE (see its own section below).
// Tyler clearing HER area used to survive exactly one render: the entry was
// deleted, her file still listed the label, and the next pull re-applied it
// with her pill on it. A separate, sort-day-stamped store records that a human
// here rejected that value, and applyTo consults it before writing.
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RemoteAreas = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function areaLib() {
    const ActualArea = (root && root.ActualArea) ||
      (typeof require === 'function' ? require('./actual-area') : null);
    if (!ActualArea) throw new Error('RemoteAreas dependencies unavailable (need ActualArea)');
    return ActualArea;
  }

  const KIND = 'ibno-remote-areas';
  const VERSION = 1;
  const DIR = 'areas';
  const MAX_SLUG = 40;

  // ─── THE FILE ONE WRITER OWNS ─────────────────────────────────────────────

  // deviceSlug(name) -> a filename-safe fold of the device's person name, or ''
  // when the device is unnamed or the name folds to nothing.
  //
  // AN UNNAMED DEVICE HAS NO FILE, AND THAT IS THE OFF SWITCH. Publishing
  // anonymously would put areas in the repo that no reader can attribute, and
  // #886 already makes the pill inert without a name — so the row would arrive
  // as an area from nobody, indistinguishable from work done here. Returning ''
  // means pathFor() returns '' and the caller has nothing to write to.
  function deviceSlug(name) {
    return String(name == null ? '' : name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_SLUG)
      .replace(/-+$/g, '');
  }

  function pathFor(name) {
    const slug = deviceSlug(name);
    return slug ? DIR + '/' + slug + '.json' : '';
  }

  // ─── BUILD ────────────────────────────────────────────────────────────────

  function dayText(raw) {
    const s = String(raw == null ? '' : raw).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  }

  function normalizeAreas(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const ActualArea = areaLib();
    Object.keys(raw).forEach(function (label) {
      const v = raw[label];
      if (!v || typeof v !== 'object' || Array.isArray(v)) return;
      const area = ActualArea.normalizeArea(v.area);
      if (!area) return;
      const entry = { area: area };
      const at = v.at == null ? '' : String(v.at);
      if (at) entry.at = at;
      out[String(label)] = entry;
    });
    return out;
  }

  // build(input) -> the envelope, carrying areas and `by` and NOTHING else.
  // Extra keys on `input` are dropped rather than copied; the key set is
  // asserted in tests/remote-areas.test.js so a new store cannot arrive here by
  // habit.
  function build(input) {
    const i = input || {};
    return {
      kind: KIND,
      version: VERSION,
      day: dayText(i.day),
      by: String(i.by == null ? '' : i.by).trim(),
      updatedAt: String(i.updatedAt == null ? '' : i.updatedAt),
      areas: normalizeAreas(i.areas),
    };
  }

  function stringify(env) { return JSON.stringify(env, null, 2) + '\n'; }

  // ─── PARSE ────────────────────────────────────────────────────────────────

  // parse(raw) -> { ok, envelope } or { ok: false, reason, error }.
  //
  // Refuses an unknown VERSION out loud rather than importing what it
  // recognizes. That is lib/day-export.js's rule and the reason the field
  // exists: a parser that tolerates an unknown version imports half a file and
  // says nothing, which is a silent partial import.
  //
  // A single unusable ROW is a different matter and is dropped, keeping the
  // rest — one corrupt entry should not cost the desk its whole file.
  //
  // `reason` NAMES WHICH OF THE FOUR REFUSALS THIS IS, and it is not decoration
  // (#918 round-two review finding 5). The caller has one sentence to spend on
  // the pill, and only ONE of these four means "that device is ahead of this
  // one":
  //
  //   'version' — a build this one cannot read. UPDATE THIS DEVICE.
  //   'json'    — truncated or corrupt bytes. Nothing to update; try again.
  //   'shape'   — not an object at all. GithubJsonSync.fetchRemote swallows a
  //               JSON error of its own and hands back `[]`, which lands here,
  //               so this is the shape a half-written file really arrives in.
  //   'kind'    — some other tool's file in the areas/ directory.
  //
  // Folding all four into "the other desk is publishing a newer format" told
  // Tyler to update a device that was perfectly current, which is a diagnosis
  // he would act on and could never make come true.
  function parse(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'json', error: 'not valid JSON' }; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'shape', error: 'not an object' };
    }
    if (parsed.kind !== KIND) {
      return { ok: false, reason: 'kind', error: 'wrong kind: expected ' + KIND + ', got ' + JSON.stringify(parsed.kind) };
    }
    if (parsed.version !== VERSION) {
      return { ok: false, reason: 'version', error: 'unsupported version ' + JSON.stringify(parsed.version) + ' (this build reads ' + VERSION + ')' };
    }
    return {
      ok: true,
      envelope: {
        kind: KIND,
        version: VERSION,
        day: dayText(parsed.day),
        by: String(parsed.by == null ? '' : parsed.by).trim(),
        updatedAt: String(parsed.updatedAt == null ? '' : parsed.updatedAt),
        areas: normalizeAreas(parsed.areas),
      },
    };
  }

  // ─── THE SORT-DAY GATE ────────────────────────────────────────────────────

  // areasForDay(env, day) -> the envelope's areas, or {} when it is not this
  // sort day's file. `day` is the LOADED REPORT'S day, never a device clock.
  function areasForDay(env, day) {
    if (!isForDay(env, day)) return {};
    return (env && env.areas) || {};
  }

  // isForDay(env, day) -> is this envelope THIS sort day's file at all?
  //
  // Split out from areasForDay because the two answers are different and
  // applyTo needs both: areasForDay returns {} for "wrong day" AND for "right
  // day, she has cleared everything", and the withdrawal pass below must act on
  // the second while doing absolutely nothing on the first. Collapsing them is
  // how a file left open overnight would delete today's applied areas.
  function isForDay(env, day) {
    const want = dayText(day);
    const have = env && dayText(env.day);
    return !!(want && have && want === have);
  }

  // ─── WHAT THIS DEVICE PUBLISHES ───────────────────────────────────────────

  // localAreas(store, opts) -> the areas payload for THIS device's file: every
  // area written here for the given sort day.
  //
  // A REMOTE ENTRY IS EXCLUDED, and that is the loop's stop condition. Without
  // it each device republishes the other's answers as its own: the archive can
  // no longer say who decided a stop, an area the other desk CORRECTED is
  // immortal because the stale copy keeps being re-offered back to them, and
  // two devices ping-pong one row forever. A device publishes its own work and
  // only its own work.
  function localAreas(store, opts) {
    const o = opts || {};
    const ActualArea = areaLib();
    const day = dayText(o.day);
    const src = ActualArea.restore(store);
    const out = {};
    Object.keys(src).forEach(function (label) {
      const e = src[label];
      if (!e || !e.area) return;
      if (e.remote) return;                    // never re-publish the other desk
      // NOT THIS SORT DAY'S WORK — and an UNDATED entry fails this too, which
      // is the whole point of the second half (review finding 4). The old test
      // was `day && e.date && e.date !== day`, so an entry with `date: ''`
      // always shipped. Undated entries are deliberately IMMORTAL on this
      // device: canPersistArea's header says rollToSortDay keeps them, because
      // a missing stamp is not evidence of staleness. Publishing one hands the
      // other desk an entry with no day at all, and their setRemote stamps it
      // with THEIR loaded report's day — laundering a stale pre-#621 area into
      // a fresh, today-dated routing answer on a machine that cannot see how
      // old it is. An area whose day this device cannot state does not travel.
      if (day && e.date !== day) return;
      const entry = { area: e.area };
      if (e.date) entry.at = e.date;
      out[label] = entry;
    });
    return out;
  }

  // ─── THE CLEAR TOMBSTONE ──────────────────────────────────────────────────
  //
  // TYLER CLEARING HER AREA IS A CORRECTION, AND WITHOUT THIS IT IS THE ONE
  // CORRECTION THAT CANNOT STICK (#918 round-two review finding 2).
  //
  // Round one built the mirror of this: an area SHE clears withdraws from his
  // device (see applyTo below). The reverse was unguarded. He sees her remote
  // 200, judges it wrong for that stop, and clears the box. ActualArea.set with
  // an empty value DELETES the entry outright — which is right, that row needs
  // FRO again — but it leaves nothing behind saying a human here rejected that
  // answer. Her file still lists the label, so the very next pull finds no
  // local entry, setRemote's `oursToTouch` treats the label as free, and 200
  // lands again wearing her pill. Every pull. All shift.
  //
  // So "Tyler's keystroke always wins" held only for a keystroke that produced
  // a VALUE (set() writes that unconditionally and setRemote will not touch
  // it). A keystroke that produced a blank won for exactly one render.
  //
  // THE TOMBSTONE IS A SEPARATE STORE, deliberately not an area entry carrying
  // an empty `area`. ActualArea.restore drops every entry without a usable
  // area, by design and on every load, save, set, reflow, prune and Day Export
  // merge — so an area-less entry would either be destroyed on the spot or
  // force that guard open for every consumer of the area store at once, which
  // is the #740 class ADR-0022 exists to prevent. This store answers one
  // question, is read by one function, and cannot be mistaken for an answer.
  //
  //   { "<label>": { area: '200', by: 'Marisol', date: '2026-08-27' } }
  //
  // IT IS SORT-DAY STAMPED AND ROLLED, on the same terms as everything else on
  // this loop: a rejection is evidence about today's stop, not a standing
  // judgement, and a tombstone that outlived its day would refuse an area on a
  // sort it knows nothing about. rollCleared drops every entry not stamped with
  // the day being loaded.
  //
  // IT IS MATCHED ON THE VALUE, NOT THE AUTHOR (assumption, flagged in the PR).
  // What Tyler rejected is "200 for this stop", and that judgement does not
  // become wrong because a second desk publishes the same number. A GENUINELY
  // NEW value from her — 998 where he cleared 200 — applies normally, which is
  // what makes this a tombstone rather than a mute button.

  function areaText(raw) {
    return areaLib().normalizeArea(raw);
  }

  function restoreCleared(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return {}; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    Object.keys(parsed).forEach(function (label) {
      const v = parsed[label];
      if (!v || typeof v !== 'object' || Array.isArray(v)) return;
      const area = areaText(v.area);
      const date = dayText(v.date);
      if (!area || !date) return;            // a tombstone with no day is not one
      const entry = { area: area, date: date };
      const by = String(v.by == null ? '' : v.by).trim();
      if (by) entry.by = by;
      out[String(label)] = entry;
    });
    return out;
  }

  function serializeCleared(store) { return restoreCleared(store); }

  // recordClear(cleared, label, prevEntry, opts) -> the next tombstone store.
  //
  // Called from the ONE commit path that can clear a Goes To box, with the
  // entry that was there BEFORE the write and the value that is there after.
  //
  //   a value was typed  -> any tombstone on that label is DROPPED. His own
  //                         answer governs the row now and setRemote cannot
  //                         touch it, so the tombstone has nothing left to do
  //                         and keeping it would grow the store forever.
  //   the box was cleared and what was there was HERS -> record it.
  //   anything else      -> unchanged. Clearing his OWN typed area is not a
  //                         judgement about the other desk, and must not stop
  //                         her answering a row he has given up on.
  //
  // AN UNDATED DAY RECORDS NOTHING, matching canPersistArea: a tombstone this
  // device cannot stamp would be immortal, and an immortal refusal is a worse
  // bug than the one it fixes.
  function recordClear(cleared, label, prevEntry, opts) {
    const o = opts || {};
    const next = restoreCleared(cleared);
    const key = String(label);
    const value = areaText(o.value);
    if (value) { delete next[key]; return next; }
    const day = dayText(o.day);
    const e = prevEntry;
    if (!day || !e || !e.remote) return next;
    const area = areaText(e.area);
    if (!area) return next;
    const entry = { area: area, date: day };
    const by = String(e.by == null ? '' : e.by).trim();
    if (by) entry.by = by;
    next[key] = entry;
    return next;
  }

  // isWithdrawnHere(cleared, label, area, day) -> has a human on THIS device
  // already rejected exactly this answer for this stop, today?
  function isWithdrawnHere(cleared, label, area, day) {
    const store = cleared && typeof cleared === 'object' ? cleared : {};
    const e = store[String(label)];
    if (!e) return false;
    const want = dayText(day);
    if (!want || dayText(e.date) !== want) return false;
    const want2 = areaText(area);
    return !!want2 && areaText(e.area) === want2;
  }

  // rollCleared(cleared, day) -> only the tombstones stamped with the sort day
  // being loaded. AN UNREADABLE DAY DROPS NOTHING, matching
  // SortDay.rollToSortDay: a report whose dates will not parse is not evidence
  // about anything, least of all about a judgement a human made.
  function rollCleared(cleared, day) {
    const next = restoreCleared(cleared);
    const want = dayText(day);
    if (!want) return next;
    Object.keys(next).forEach(function (label) {
      if (next[label].date !== want) delete next[label];
    });
    return next;
  }

  // ─── APPLY ────────────────────────────────────────────────────────────────

  // applyTo(store, env, opts) -> { store, changed }
  //
  // Applies each remote area through ActualArea.setRemote, which owns the two
  // hard rules: it never overwrites a value it did not itself write, and it
  // does not propagate across the stop. This function owns the two rules ABOVE
  // that: the sort-day gate, and not reading your own file back.
  //
  // `opts.self` is this device's name. A file authored by this device is
  // skipped entirely: applying it would re-stamp its own rows `remote` and put
  // a "someone else did this" pill on the user's own work. The comparison is
  // case- and spacing-insensitive for the same reason ActualArea.otherBy's is —
  // the name is typed by hand, once per Windows profile.
  function applyTo(store, env, opts) {
    const o = opts || {};
    const ActualArea = areaLib();
    const by = String((env && env.by) || '').trim();
    const self = String(o.self == null ? '' : o.self).trim();
    const cleared = restoreCleared(o.cleared);
    let next = ActualArea.restore(store);
    const changed = [];

    if (self && by && sameName(by, self)) {
      return { store: next, changed: changed };
    }

    if (!isForDay(env, o.day)) return { store: next, changed: changed };

    const areas = env.areas || {};
    const stamp = dayText(o.day);
    // Labels this pull REFUSED because of a tombstone. Kept because a refusal
    // is not the same as the label being absent, and the withdrawal pass below
    // has to tell those two apart — see the note on it (#918 round-three
    // finding 1).
    const refused = {};
    Object.keys(areas).forEach(function (label) {
      // A tombstone from THIS device outranks her file for exactly the value it
      // names. See the tombstone section above for why this is what makes his
      // clear stick, and why a DIFFERENT value from her still lands.
      if (isWithdrawnHere(cleared, label, areas[label].area, stamp)) {
        refused[label] = true;
        return;
      }
      const r = ActualArea.setRemote(next, label, areas[label].area, { today: stamp, by: by });
      next = r.store;
      r.changed.forEach(function (l) { changed.push(l); });
    });

    // ─── WITHDRAWAL: AN AREA SHE CLEARED HAS TO CLEAR HERE (finding 2) ──────
    //
    // The loop above only ever walks labels the incoming file still CARRIES, so
    // before this pass the one correction path the design's own story promises
    // — "she types 998, sees it is wrong, clears the box" — did not exist. Her
    // file simply stopped mentioning that stop and the stale 998 stood on
    // Tyler's device for the rest of the shift WITH HER NAME ON IT, which is
    // worse than an unattributed stale value: the pill vouches for it. Only a
    // NEW value from her could ever correct it, and clearing is not a new value.
    //
    // A publisher may only withdraw ITS OWN rows, and "its own" means FROM THE
    // SAME FILE (#918 round-three finding 4). A file's identity IS pathFor(by),
    // so comparing slugs asks the question the transport already answered.
    //
    // WHAT THE REVIEW CLAIMED HERE DOES NOT REPRODUCE, and the note is left in
    // because the next reader will re-derive it otherwise. The claim was that
    // the folded-name test is WIDER than the file, letting two distinct files
    // withdraw and re-add each other's rows on alternating pulls. It cannot:
    // sameName folds case and whitespace runs, deviceSlug folds those and more,
    // so sameName(a, b) IMPLIES pathFor(a) === pathFor(b). Two names that fold
    // together always slugged together, and there was never a second file.
    //
    // THE REAL GAP IS THE MIRROR OF IT, and that is what this fixes. Slug-equal
    // does NOT imply sameName-equal: "Marisol R", "Marisol-R" and "Marisol_R"
    // are ONE file, areas/marisol-r.json, and sameName calls them three
    // different people. So a publisher who typed her name with a hyphen on
    // Monday and a space on Tuesday owns the same file and could not withdraw
    // its own rows — her clear crossed as nothing, which is round one's bug
    // surviving inside its own fix. sameFile is strictly WIDER than sameName
    // and every name it newly admits is by construction the same file.
    // Nothing local —
    // typed, auto, early, or a markerless legacy entry — is reachable from here
    // at all (setRemote's oursToTouch refuses those anyway; the `remote` test
    // below is the first of the two locks, not the only one).
    //
    // AN UNNAMED PUBLISHER WITHDRAWS NOTHING. `by: ''` slugs to '' and sameFile
    // refuses an empty slug on either side, so an entry carrying no author is
    // unreachable here. An anonymous file is already off the supported path
    // (deviceSlug returns '' so no such file can be published by this build). A
    // hand-placed one may add areas; it may not delete.
    //
    // A LABEL THIS PULL REFUSED IS TREATED AS ABSENT (round-three finding 1).
    // Presence in `areas` used to be the whole test, which meant a tombstoned
    // label protected the very entry it was supposed to correct: she publishes
    // 200, he clears it, she corrects to 998 (applies), she reverts to 200. The
    // apply is refused by the tombstone and the withdrawal was skipped because
    // her file still carried the label — so his device kept 998 WITH HER PILL
    // ON IT for the rest of the shift, an intermediate value she had already
    // withdrawn. Her file says 200; what this device may not show is 200; so
    // what it must show is nothing, which is what his clear asked for. Reaching
    // the withdrawal is what makes the tombstone a correction rather than a
    // freeze.
    if (by) {
      Object.keys(next).forEach(function (label) {
        const e = next[label];
        if (!e || !e.remote) return;
        if (!sameFile(e.by || '', by)) return;
        if (Object.prototype.hasOwnProperty.call(areas, label) && !refused[label]) return;
        const r = ActualArea.setRemote(next, label, '', { today: stamp, by: by });
        next = r.store;
        r.changed.forEach(function (l) { changed.push(l); });
      });
    }

    return { store: next, changed: changed };
  }

  function sameName(a, b) {
    return String(a).replace(/\s+/g, ' ').trim().toLowerCase() ===
           String(b).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // Do these two author names denote the SAME PUBLISHED FILE? pathFor is the
  // one function that answers that, because it is what put the file there.
  function sameFile(a, b) {
    const pa = pathFor(a);
    const pb = pathFor(b);
    return !!pa && pa === pb;
  }

  return {
    KIND: KIND,
    VERSION: VERSION,
    DIR: DIR,
    deviceSlug: deviceSlug,
    pathFor: pathFor,
    build: build,
    stringify: stringify,
    parse: parse,
    areasForDay: areasForDay,
    isForDay: isForDay,
    localAreas: localAreas,
    applyTo: applyTo,
    restoreCleared: restoreCleared,
    serializeCleared: serializeCleared,
    recordClear: recordClear,
    isWithdrawnHere: isWithdrawnHere,
    rollCleared: rollCleared,
  };
});
