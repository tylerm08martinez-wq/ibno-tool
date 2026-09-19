'use strict';

// THE RELEASE NOTES LIST (#1020, spec #1019).
//
// Since 2026-09-12 (#1017) the IBNO Coder ships to a staging mirror from `main`
// and to production only when the `release` branch is moved forward. That made
// "what is on staging but not production" a fact knowable only by reading git,
// which is not a thing Tyler can do from the cage PC at 03:00.
//
// `release-notes.json` at the repo root is the one source of truth: one entry
// per merged PR that changed a shipped tool. This module is the only place its
// shape is stated, so the guard test, the staging panel (#1021) and the release
// queue script (#1022) all agree about what an entry is.
//
// THE ENTRY SHAPE, and every field is load-bearing:
//
//   { "id": "pr-1004", "pr": 1004, "issue": 998, "tool": "ibno-coder",
//     "title": "Station tab pulls station packages out of Needs Review",
//     "summary": "…one or two PLAIN sentences, written for the cage PC…",
//     "watchFor": ["…0-4 one-line things to look out for while testing…"],
//     "howToSee": ["Load the full-detail export", "Open Set aside", "…"],
//     "mergedAt": "2026-09-11", "commit": "bc1f21c", "shippedAt": null,
//     "order": 1 }
//
// `order` IS WRITTEN BY `scripts/release-queue.js`, NEVER BY HAND — the entry's
// rank in git first-parent order, `null` for one git cannot place. It exists so
// the queue issue and the staging drawer cannot list the same queue in two
// different orders; see the comparator below.
//
// `mergedAt` IS THE UTC DATE OF THE SQUASH COMMIT (#1023 review, LOW). Read it
// with `git log -1 --date=iso-strict` (which prints the commit's own recorded
// offset, so it does not depend on where the reader is) and normalise to UTC —
// `new Date(iso).toISOString().slice(0, 10)`, or `git log --date=iso-strict` +
// `TZ=UTC0`. The backfill originally used Phoenix local dates, which put three
// entries (pr-1009, pr-1011, pr-1013 — all merged after 17:00 local) on the
// wrong day; `tests/release-notes-guard.test.js` now pins every entry against
// its commit's UTC date. Same clock as `build-info.json`'s `builtAt`, so
// #1022's `--stamp` re-deriving these dates cannot shuffle them.
//
// `shippedAt` is null until the entry's commit reaches `release` AND production
// has been deployed; the promote step stamps it. NOTHING ELSE MAY BE READ AS
// "shipped": a commit can be on `release` for hours before the deploy runs, and
// the whole point of this file is that merging is not shipping.
//
// THE REGISTER IS THE CAGE PC, NOT THE REVIEWER (#1028). `summary`, `watchFor`
// and `howToSee` are read at 03:00 by a supervisor deciding whether a change is
// safe to put in front of the admins: plain words, no code identifiers, no repo
// paths, one or two sentences. The dense engineering detail is NOT lost — it is
// in the PR body every card links to, which is where a reviewer reads it.
//
// #1019 said decisions Tyler should know go in `summary` rather than a new
// field, and the reason still holds — a field nobody renders is a field nobody
// writes. `watchFor` is not that field: it is ALWAYS rendered when it has
// items, and it exists because cramming the judgement calls into `summary`
// measured 5,268px of solid prose across 11 cards, which is the same as not
// showing them at all. One prose field plus a short always-shown list beats
// either alone.
//
// `parse` VALIDATES AND THROWS. A release-notes file that is silently half-read
// is worse than one that is missing: the panel would show four items of seven
// and there is no visible difference between "three are unlisted" and "three
// were not built". Every rejection names the entry index and the field.
//
// Dual-loadable with no build step:
// - Browser: window.ReleaseNotes
// - Node:    require('./lib/release-notes')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ReleaseNotes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const SHA_RE = /^[0-9a-f]{7,40}$/;

  const REQUIRED_STRINGS = ['id', 'tool', 'title', 'summary'];

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function fail(where, msg) {
    throw new Error('release-notes: ' + where + ' ' + msg);
  }

  // parse(json) -> entries[]
  //
  // Accepts either the raw JSON text or an already-parsed value, because the
  // browser reads it through fetch().json() and Node through readFileSync.
  // Accepts either a bare array or `{ entries: [...] }` — the file ships the
  // wrapped form so a later top-level key (a schema version, say) does not
  // force a reader change.
  function parse(json) {
    let data = json;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); }
      catch (e) { fail('file', 'is not valid JSON: ' + (e && e.message)); }
    }
    const entries = Array.isArray(data) ? data : (isPlainObject(data) ? data.entries : null);
    if (!Array.isArray(entries)) fail('file', 'must be an array of entries or { entries: [...] }');

    const seenId = Object.create(null);
    const seenPr = Object.create(null);

    entries.forEach(function (e, i) {
      const where = 'entry ' + i + (e && e.id ? ' (' + e.id + ')' : '');
      if (!isPlainObject(e)) fail(where, 'is not an object');

      REQUIRED_STRINGS.forEach(function (k) {
        if (typeof e[k] !== 'string' || e[k] === '') fail(where, 'needs a non-empty string ' + k);
      });

      if (typeof e.pr !== 'number' || !Number.isInteger(e.pr) || e.pr <= 0) {
        fail(where, 'needs an integer pr number');
      }
      // `issue` is OPTIONAL AND NULLABLE. Not every shipped change has a
      // ticket — #1011 came off a chore issue, and a hotfix may have none at
      // all. Requiring it would push someone to invent a number.
      if (e.issue !== null && e.issue !== undefined &&
          (!Number.isInteger(e.issue) || e.issue <= 0)) {
        fail(where, 'issue must be a positive integer or null');
      }
      // `alsoCloses` (#1051) — THE OTHER TICKETS ONE PR CLOSES. Optional, and
      // almost always absent: branch discipline is one issue, one branch, one
      // PR, and `issue` is still the single ticket the card is filed under.
      //
      // IT EXISTS BECAUSE THE GUARD READS TICKET NUMBERS OFF COMMIT SUBJECTS.
      // tests/release-notes-guard.test.js ties each unmerged branch commit to
      // the note that covers it by matching the `(#N)`s in its subject against
      // the note's `pr` and `issue` — two numbers. A PR that legitimately
      // closes two tickets has commits naming a third, and NO value of `issue`
      // can cover both: PR #1047 closed #1038 and #1051 together (Tyler,
      // 2026-09-17, choosing the full envelope fix over a stopgap), and its
      // branch carried a commit for each. The choice was to widen what a note
      // may NAME, not to weaken what the guard REQUIRES — it still demands one
      // pending note per PR, and a tool-touching PR with no note still fails.
      //
      // Refused rather than ignored when it is not an array of positive
      // integers, for the reason `order` is: a garbage value here silently
      // covers nothing, which reads as a guard that passed.
      if (e.alsoCloses !== null && e.alsoCloses !== undefined) {
        if (!Array.isArray(e.alsoCloses) ||
            !e.alsoCloses.every(function (n) { return Number.isInteger(n) && n > 0; })) {
          fail(where, 'alsoCloses must be an array of positive integers');
        }
      }
      if (e.id !== 'pr-' + e.pr) fail(where, 'id must be "pr-" + pr (got ' + e.id + ')');
      // `mergedAt` and `commit` ARE NULL UNTIL THE PR IS SQUASHED, and that is
      // not a loophole — it is the only order the facts arrive in. An entry is
      // written IN the PR that makes the change (that is what makes the guard
      // able to fail a forgetful PR at all), and the squash sha does not exist
      // until someone merges. A schema that demanded the sha up front would
      // force either a lie or a second PR per change.
      //
      // Both must be DECLARED — the keys are the reminder that something later
      // fills them (#1022's release-queue script does, from the merge).
      ['mergedAt', 'commit'].forEach(function (k) {
        if (!Object.prototype.hasOwnProperty.call(e, k)) {
          fail(where, 'must declare ' + k + ' (null until the PR is squashed onto main)');
        }
      });
      // YYYY-MM-DD in UTC (see the header): the shape is all this can check,
      // and tests/release-notes-guard.test.js checks the timezone against git.
      if (e.mergedAt !== null && !DATE_RE.test(e.mergedAt)) fail(where, 'mergedAt must be null or YYYY-MM-DD (UTC)');
      if (e.commit !== null && !SHA_RE.test(String(e.commit))) fail(where, 'commit must be null or a lowercase hex sha');
      // A shipped entry with no commit is incoherent: shippedAt means "this
      // sha reached production", so there has to be a sha.
      if (e.shippedAt && !e.commit) fail(where, 'cannot be shippedAt with no commit');

      if (!Array.isArray(e.howToSee) || e.howToSee.length < 2 || e.howToSee.length > 5) {
        fail(where, 'needs howToSee: 2 to 5 steps');
      }
      e.howToSee.forEach(function (s, j) {
        if (typeof s !== 'string' || s.trim() === '') fail(where, 'howToSee[' + j + '] must be a non-empty string');
      });

      // `watchFor` IS OPTIONAL: 0 to 4 one-line things to look out for while
      // testing the change (#1028). An edge case, a deliberate behaviour that
      // could be mistaken for a bug, a fail-safe. It is OPTIONAL because most
      // changes have none and an empty required array is a field people fill
      // with noise; it is CAPPED AT 4 because the drawer's whole problem was
      // that every card was a wall of prose, and an uncapped list rebuilds the
      // wall under a friendlier heading.
      //
      // ABSENT AND EMPTY BOTH MEAN "nothing to watch for" and the drawer
      // renders no block for either. A MALFORMED one is refused rather than
      // ignored, on the same grounds as `order` above: a silently dropped
      // watch-for is a warning the reader never sees and cannot know is
      // missing.
      if (e.watchFor !== null && e.watchFor !== undefined) {
        if (!Array.isArray(e.watchFor)) fail(where, 'watchFor must be an array of strings or absent');
        if (e.watchFor.length > 4) fail(where, 'watchFor takes at most 4 lines (got ' + e.watchFor.length + ')');
        e.watchFor.forEach(function (s, j) {
          if (typeof s !== 'string' || s.trim() === '') fail(where, 'watchFor[' + j + '] must be a non-empty string');
        });
      }

      // shippedAt MUST BE PRESENT AND EXPLICITLY NULL when unshipped. An absent
      // key and `null` would read the same to `pending()`, but they do not read
      // the same to a person adding an entry by hand: the null is the reminder
      // that the field exists and that something later fills it.
      if (!(Object.prototype.hasOwnProperty.call(e, 'shippedAt'))) {
        fail(where, 'must declare shippedAt (null until production has it)');
      }
      if (e.shippedAt !== null && !(typeof e.shippedAt === 'string' && DATE_RE.test(e.shippedAt))) {
        fail(where, 'shippedAt must be null or YYYY-MM-DD');
      }

      // `order` IS OPTIONAL, WRITTEN BY THE SCRIPT, NEVER BY HAND. It is the
      // entry's rank in git first-parent order (see the comparator below);
      // `null` means git could not place the commit. Absent is legal — an entry
      // is born without one and the next resolve/generate/stamp fills it — but
      // a MALFORMED one is refused rather than ignored: silently dropping a bad
      // rank would fall back to the date sort and split the two surfaces that
      // are supposed to agree, which is the whole reason the field exists.
      if (e.order !== null && e.order !== undefined &&
          (!Number.isInteger(e.order) || e.order < 0)) {
        fail(where, 'order must be a non-negative integer or null');
      }

      if (seenId[e.id]) fail(where, 'duplicates id ' + e.id);
      if (seenPr[e.pr]) fail(where, 'duplicates pr ' + e.pr);
      seenId[e.id] = true;
      seenPr[e.pr] = true;
    });

    return entries;
  }

  // ── THE ONE ORDER, SHARED BY BOTH SURFACES (#1021 review, MEDIUM) ──────────
  //
  // The list is ascending, oldest first, because a checkpoint promotion takes a
  // PREFIX of it — the list has to read as the prefix the operator ticks.
  //
  // `order` IS THE TRUTH WHEN IT IS THERE, AND IT IS GIT'S ANSWER. The queue
  // issue (#1022/#1024) and this panel (#1021) are read side by side, so they
  // must not be able to disagree. Git first-parent order is the real shipping
  // order and `mergedAt` is DAY-granular, which #1024's review measured
  // disagreeing with git about one merge in six. The browser cannot run git, so
  // `scripts/release-queue.js` writes its rank into each entry as an integer
  // `order` on every resolve/generate/stamp, and this comparator reads it.
  // CHANGING EITHER SIDE ALONE SPLITS THE TWO SURFACES — the pin that catches
  // it is in tests/release-queue.test.js, asserting the issue's list order and
  // this module's `pending` order are the same sequence.
  //
  // No `order` (git could not place the commit, or nothing has run the script
  // since the entry was written) falls back to `mergedAt` then `pr`, and sorts
  // AFTER every ranked entry: an entry git cannot place is not in the prefix a
  // checkpoint promotes, so it must not sit in the middle of one. A null
  // `mergedAt` (an in-flight PR) sorts last within that tail for the same
  // reason.
  function rankOf(e) {
    return (e && Number.isInteger(e.order) && e.order >= 0) ? e.order : null;
  }

  function byShipOrder(a, b) {
    const ar = rankOf(a);
    const br = rankOf(b);
    if (ar !== null && br !== null) return ar - br;
    if (ar !== null) return -1;
    if (br !== null) return 1;
    const am = a.mergedAt || '9999-99-99';
    const bm = b.mergedAt || '9999-99-99';
    if (am !== bm) return am < bm ? -1 : 1;
    return a.pr - b.pr;
  }

  function sorted(entries) {
    return (entries || []).slice().sort(byShipOrder);
  }

  // pending(entries) — merged but not in production. The staging panel's list.
  function pending(entries) {
    return sorted((entries || []).filter(function (e) { return !e.shippedAt; }));
  }

  // live(entries) — already in production.
  function live(entries) {
    return sorted((entries || []).filter(function (e) { return !!e.shippedAt; }));
  }

  // stamp(entries, shippedCommits, date) -> a NEW array with shippedAt set on
  // every entry whose commit is now in `release`.
  //
  // PURE, AND IT NEVER RE-STAMPS. An already-shipped entry keeps its original
  // date even if its commit is handed in again, because the date records when
  // it reached the cage PC and re-running the promote step must not rewrite
  // history. Returns new objects; the input array is not mutated.
  //
  // `shippedCommits` may be full or short shas in either direction, so the
  // comparison is prefix-based both ways — the JSON carries 7 chars and
  // `git rev-list` hands back 40.
  function stamp(entries, shippedCommits, date) {
    if (!DATE_RE.test(String(date || ''))) {
      throw new Error('release-notes: stamp() needs a YYYY-MM-DD date');
    }
    const list = (shippedCommits || []).map(function (c) { return String(c || '').toLowerCase(); })
      .filter(Boolean);
    return (entries || []).map(function (e) {
      const out = Object.assign({}, e);
      if (out.shippedAt) return out;
      const mine = String(out.commit || '').toLowerCase();
      const hit = mine && list.some(function (c) {
        return c === mine || c.indexOf(mine) === 0 || mine.indexOf(c) === 0;
      });
      if (hit) out.shippedAt = date;
      return out;
    });
  }

  // unmerged(entries) — written but not yet squashed onto main. The guard uses
  // this to tell "this branch forgot its note" from "this branch has one, the
  // sha just does not exist yet".
  function unmerged(entries) {
    return sorted((entries || []).filter(function (e) { return !e.commit; }));
  }

  // firstSentence(text) — the lead line a closed card and the queue issue both
  // show. ONE IMPLEMENTATION, because those two surfaces are read side by side
  // (the drawer links to the queue issue) and a card whose lead line differs
  // from the queue's bullet reads as two different changes. `scripts/
  // release-queue.js` used to carry its own copy; it now calls this.
  //
  // The split is on sentence-ending punctuation followed by whitespace and a
  // capital — not on the first period — so a date, a decimal or an abbreviation
  // mid-sentence does not cut the line in half. No sentence break at all means
  // the whole string, which is right: a one-sentence summary IS its lead.
  function firstSentence(text) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const m = /[.!?]\s+(?=["'“(\[]?[A-Z])/.exec(s);
    return m ? s.slice(0, m.index + 1) : s;
  }

  function byPr(entries, pr) {
    const n = Number(pr);
    return (entries || []).filter(function (e) { return e.pr === n; })[0] || null;
  }

  return {
    DATE_RE: DATE_RE,
    SHA_RE: SHA_RE,
    parse: parse,
    sorted: sorted,
    pending: pending,
    live: live,
    unmerged: unmerged,
    firstSentence: firstSentence,
    stamp: stamp,
    byPr: byPr,
  };
});
