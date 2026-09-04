'use strict';

// 999 Desk channel HEALTH — "is the other desk still there, and is my
// credential still alive?" (#914 records, #915 speaks.)
//
// WHY THIS IS A MODULE AND NOT FOUR VARIABLES IN THE PAGE.
//
// #887's whole promise is that Tyler STOPS CHECKING the Admin's work. That is
// the benefit and it is also the hazard: once he is relying on their areas
// arriving, a channel that quietly stops looks exactly like a normal morning.
// The desk is unstaffed two weekdays a week plus weekends, so "nothing new
// today" is unremarkable — which is the 7-Day Shelf shape named in CONTEXT.md:
// no visible symptom on the day, a hole discovered much later.
//
// The decision of WHEN to shout is therefore load-bearing, and it is made from
// four inputs that arrive on three different code paths (a pull, a push, and
// the clock). Keeping it in the page would put this repo's most silence-prone
// judgement in the one place no test can reach. Here it is a pure function of
// recorded state and `now`.
//
// ── THE GATE IS THE ENTIRE DESIGN (#915) ─────────────────────────────────────
//
// Quiet is only reportable once a desk HAS PUBLISHED AT LEAST ONCE TODAY.
//
// An unconditional "last heard from" alarm would be true and meaningless most
// of the week, and lib/area-conflicts.js already names where that ends: "a
// surface that cries wolf is a surface he stops reading." Gating on a publish
// seen today needs no schedule integration and fires on the case that actually
// matters — an admin who STARTED and then went quiet mid-sort, whose device
// holds real work nobody else has. A schedule-aware version was considered and
// rejected on #887 as five times the cost for a worse failure mode; do not
// rebuild it.
//
// The gate falls out of the data rather than being a flag: a desk is known only
// because its envelope for TODAY was read. No envelope, nothing to be quiet.
//
// ── AUTH IS NOT SILENCE, AND THAT IS THE POINT (#915) ────────────────────────
//
// Fine-grained PATs expire, a year at most, and an expired token fails silently
// from the user's side: the desk simply stops publishing. Collapsed into a
// generic "sync problem" that reads as a quiet day, and nobody looks for weeks.
// So `auth` outranks `quiet` and is NOT gated on the publish-seen-today rule —
// a dead credential is worth saying out loud the moment it is seen, on the
// device that saw it, whatever the rest of the station is doing.
//
// ── NETWORK NEVER SHOUTS ─────────────────────────────────────────────────────
//
// A station network drops. The sync pill already says "offline — the other
// desk's areas are not showing", which is honest and quiet. Promoting that to
// the banner would put a red bar on screen several times a sort for a condition
// that fixes itself, and that is how the banner stops being read. `assess`
// returns null for it deliberately; see the test that pins it.
//
// Dual-loadable with no build step:
// - Browser: window.DeskHealth
// - Node: require('./lib/desk-health')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DeskHealth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // How long a desk that published today may go silent before it is reported.
  //
  // ASSUMPTION, FLAGGED FOR REVIEW (#914 says the cadence is a measurement, not
  // a constant to argue about). 30 minutes, chosen against two facts:
  //
  //   - `updatedAt` advances only when AREAS CHANGE, because that is the only
  //     thing that marks the channel dirty. A desk working steadily still has
  //     lulls; #887 measured the exposure window this feature exists to close
  //     at 5-10 minutes, so anything near that would fire on ordinary lulls.
  //   - The failure actually being caught is a device that DIED or a token that
  //     EXPIRED mid-sort. That does not resolve itself in twenty minutes.
  //
  // 30 is well outside a normal typing gap and well inside a sort. If real
  // shifts show it firing on lulls, raise it; if a dead desk sits unreported
  // too long, lower it. Do not lower it below the poll interval.
  const QUIET_AFTER_MS = 30 * 60 * 1000;

  // Minimum spacing between pulls, whatever asks for one.
  //
  // Tyler re-drops the Post Sort report constantly through a sort (auto-memory
  // `ibno-daily-workflow`, #610). #914 wants a read on every drop OUTSIDE THE
  // 10s WINDOW — a drop inside it rides on the read that just happened. An
  // ungated one is a network round trip per drop, and a burst of drops in one
  // minute would be a burst of listings. This is the throttle, and it is why
  // the claim is "every drop outside the 10s window" and never the stronger
  // "every report drop": a drop inside the gap does NOT read, it reuses the
  // answer the last read got, which is the same answer it would have got.
  const MIN_PULL_GAP_MS = 10 * 1000;

  // The poll. #887 specced 90s; TYLER CHOSE 30s on 2026-09-03, after the cost
  // was measured rather than assumed. Recording the measurement so the number is
  // not re-argued from the spec's 90:
  //
  //   - RATE LIMIT IS NOT THE CONSTRAINT. #945 ADDED A SECOND LANE, so a poll
  //     is now FOUR requests at two devices, not two: a listing and a fetch per
  //     other desk on areas/, and the same pair again on desk/. 30s = 480
  //     requests/hour/device; two active devices = 960/hour. It grows with
  //     the desk count (2 + 2 per other desk): three devices = 6 requests a
  //     poll, 720/hour/device, 2,160 fleet-wide, against a limit confirmed at
  //     5,000 on this account. Still comfortable,
  //     and even 10s would still have fit — but the headroom is now half what
  //     this note originally recorded, so a THIRD lane is the one to cost
  //     before adding. (Before #945 it read: two requests, 240/hour/device,
  //     480 at two devices.)
  //   - BANDWIDTH IS THE REAL COST, and it is the one nobody had costed.
  //     lib/github-json-sync.js sends no If-None-Match, so EVERY poll
  //     re-downloads the whole file whether or not a byte changed — and a real
  //     day's file measured 17KB and still growing (225 areas, 2026-09-02). At
  //     30s that is ~2MB/hour/device, nearly all of it redundant.
  //   - THE FLOOR IS NOT THIS NUMBER. The other desk publishes on a 5s debounce,
  //     so an area is visible here in 5-35s. Polling at 10s would have bought
  //     5-15s — a real but much smaller gain than the 3x suggests.
  //
  // IF A FASTER POLL IS EVER WANTED, ADD ETAGS FIRST. A 304 costs no rate limit
  // by GitHub's own rules and almost no bytes, which makes a 10s poll cost about
  // what this one does. Cutting this constant alone just multiplies the 17KB.
  const POLL_MS = 30 * 1000;

  function empty() {
    return {
      // Last pull that reached the network and came back clean.
      lastOkAt: '',
      // Last pull ATTEMPT, success or not. This is what the throttle reads, so
      // a failing network cannot turn every report drop into a retry storm.
      lastAttemptAt: '',
      // '' | 'auth' | 'network' | 'parse'. The kind, not a message: #915 reads
      // this and owns the words.
      lastFailure: '',
      // Did the LAST PULL ITSELF fail? Distinct from lastFailure, which can
      // hold 'parse' on a pull that reached the network and came back with
      // usable desks (see recordPull's formatProblem note). Only THIS answers
      // the throttle's question — "is there an answer worth riding on?" — and
      // conflating the two made one desk publishing an unsupported format
      // disable the 10s gap for the rest of the sort (#943 review, finding 3).
      lastPullFailed: false,
      // Desks heard from TODAY, by author name -> ISO updatedAt. Rebuilt from
      // each pull rather than accumulated, so a desk that stops being published
      // does not linger forever — see recordPull.
      desks: {},
      // The sort day `desks` was gathered for. A day roll empties it: yesterday
      // having published says nothing about today, and the gate is a
      // today-only question.
      day: '',
    };
  }

  function text(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }

  function ms(iso) {
    const t = Date.parse(text(iso));
    return Number.isFinite(t) ? t : null;
  }

  // Normalize a failure into one of the three kinds #915 distinguishes.
  //
  // THE DEFAULT IS 'network', NOT 'auth', and that direction matters. Guessing
  // `auth` on an unknown error tells Tyler to mint a token that was never the
  // problem — a diagnosis he would act on and could never make come true, which
  // is the exact defect #918's round-two finding 5 caught on the parse path.
  // Guessing `network` under-reports at worst, and the pill still says offline.
  function failureKind(e) {
    if (!e) return '';
    if (typeof e === 'string') {
      return (e === 'auth' || e === 'parse' || e === 'network') ? e : 'network';
    }
    if (e.code === 'auth') return 'auth';
    if (e.code === 'parse' || e.code === 'shape' || e.code === 'json') return 'parse';
    return 'network';
  }

  // Record the outcome of a pull.
  //
  // `desks` is the list of OTHER desks' envelopes this pull actually read, each
  // {by, updatedAt}, already day-filtered by the caller (RemoteAreas.isForDay
  // owns that question and there is no second copy of it here).
  //
  // REBUILT, NOT MERGED, on a clean pull. A desk whose file was deleted or
  // whose publish rolled to a new day must drop out; carrying it forward would
  // keep a stale `updatedAt` on the books and eventually shout about a desk
  // that is not there. On a FAILED pull the previous roster is kept — a pull
  // that never read anything is not evidence that everyone went home.
  function recordPull(state, outcome) {
    const s = Object.assign(empty(), state || {});
    const o = outcome || {};
    const at = text(o.at);
    const day = text(o.day);
    if (day && day !== s.day) { s.day = day; s.desks = {}; }
    if (at) s.lastAttemptAt = at;
    s.lastPullFailed = !o.ok;
    if (o.ok) {
      if (at) s.lastOkAt = at;
      s.lastFailure = '';
      const next = {};
      (Array.isArray(o.desks) ? o.desks : []).forEach(function (d) {
        const by = text(d && d.by).trim();
        if (!by) return;                       // an unattributable desk is not a desk (#918 finding 3)
        const stamp = text(d && d.updatedAt);
        // Keep the NEWEST stamp per author. One person on two machines is not
        // in the spec, but taking the older one would invent a quiet desk out
        // of a working one, and that is the failure this module is for.
        const prev = ms(next[by]);
        const cur = ms(stamp);
        if (prev === null || (cur !== null && cur > prev)) next[by] = stamp;
      });
      s.desks = next;
      // A PULL CAN SUCCEED AND STILL HAVE FAILED SOMEBODY.
      //
      // The adapter deliberately does not throw when ONE file is unreadable: a
      // throw discards the desks that read fine, and on a three-desk morning one
      // bad file would blank the other two. So a per-file format refusal comes
      // back on an otherwise-clean pull, and it still means a real desk's areas
      // are not on screen. Recording it here is what stops that from being
      // indistinguishable from a day they did not work.
      if (o.formatProblem) s.lastFailure = 'parse';
    } else {
      s.lastFailure = failureKind(o.failure);
    }
    return s;
  }

  // Record the outcome of a PUSH. Only its failure kind is interesting: a
  // successful publish says nothing about whether the other desk is alive, and
  // stamping lastOkAt from it would let this device's own healthy publishing
  // paper over a read channel that has been dead all morning.
  //
  // A push 401 IS worth keeping, and it is often the FIRST symptom: on the cage
  // PC the token is used to write far more often than to read, so an expired
  // credential surfaces on the push path minutes before a poll would find it.
  function recordPublish(state, outcome) {
    const s = Object.assign(empty(), state || {});
    const o = outcome || {};
    if (o.ok) {
      if (s.lastFailure === 'auth') s.lastFailure = '';   // recovery, per #915 acceptance 5
      return s;
    }
    const kind = failureKind(o.failure);
    // Do NOT let a push network blip overwrite a recorded auth failure. The
    // credential being dead is the more actionable and longer-lived of the two,
    // and on a flaky network the blip would arrive second and hide it.
    if (kind === 'auth' || !s.lastFailure) s.lastFailure = kind;
    return s;
  }

  // Roll to a new sort day. Same shape as RemoteAreas.rollCleared: yesterday's
  // roster is not evidence about today, and leaving it in place would fire the
  // quiet alarm every morning for a desk nobody has heard from yet BY DESIGN.
  function rollDay(state, day) {
    const s = Object.assign(empty(), state || {});
    const d = text(day);
    if (!d || d === s.day) return s;
    s.day = d;
    s.desks = {};
    return s;
  }

  // Has anything been read cleanly since `sinceMs` ago? Used by the throttle.
  function shouldPull(state, opts) {
    const s = state || {};
    const o = opts || {};
    const now = ms(o.now);
    const last = ms(s.lastAttemptAt);
    if (now === null) return true;             // no clock, no throttle — never block a read
    if (last === null) return true;
    // A FAILED LAST READ IS NOT SOMETHING TO RIDE ON, so it does not throttle.
    //
    // The gap exists for one case: a second ask arriving moments after a read
    // that SUCCEEDED would fetch the same answer twice, so it may as well use
    // the first one. When the last read failed there is no answer to reuse —
    // the screen is missing the other desk's work entirely — and making the
    // next ask wait is just extending the outage.
    //
    // This is #918 round-two finding 1 restated for the throttle, and the DOM
    // test that caught it going is "a FAILED first pull is retried on the next
    // report drop". The first draft of this function stamped every attempt and
    // silently turned that retry into a ten-second wait: strictly better than
    // the shift-long latch it replaced, and still a regression of a fix that was
    // reviewed once already.
    //
    // A dead network does not become a request storm, because the in-flight
    // guard in deskPullForDay collapses overlapping asks and the poll is 30s
    // apart. One request per human gesture during an outage is what retry means.
    //
    // IT READS lastPullFailed, NOT lastFailure, AND THAT DISTINCTION IS THE FIX
    // FOR #943 REVIEW FINDING 3. lastFailure also carries 'parse', which
    // recordPull sets on an OTHERWISE SUCCESSFUL pull whenever one desk's file
    // was refused — a state that is sticky for as long as that desk keeps
    // publishing the bad file. Reading it here meant that one unsupported
    // envelope switched the throttle off for the whole sort, and Tyler re-drops
    // the report constantly (#610): every drop became a full round trip. A pull
    // that came back with the other desks' areas IS an answer to ride on, even
    // if one file in it was unreadable.
    if (s.lastPullFailed) return true;
    const gap = typeof o.minGapMs === 'number' ? o.minGapMs : MIN_PULL_GAP_MS;
    return (now - last) >= gap;
  }

  // The station's calendar day. America/Phoenix, matching lib/qa-checklist.js's
  // phoenixDateKey — the station does not observe DST, and a UTC day key would
  // roll over at 5pm local and call an evening sort "tomorrow".
  //
  // Duplicated rather than imported: ibno-coder.html does not load
  // lib/qa-checklist.js, and adding a whole checklist module to the IBNO bundle
  // to borrow eight lines of date formatting would be a worse trade than the
  // copy. If a third consumer appears, that is the moment to extract it.
  function dayKey(when) {
    const d = when == null ? new Date() : new Date(when);
    if (isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const lookup = {};
    parts.forEach(function (p) { lookup[p.type] = p.value; });
    if (!lookup.year || !lookup.month || !lookup.day) return '';
    return lookup.year + '-' + lookup.month + '-' + lookup.day;
  }

  function minutes(msSpan) {
    return Math.max(1, Math.round(msSpan / 60000));
  }

  function joinNames(names) {
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + ' and ' + names[1];
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  // THE ALARM. Returns null when there is nothing to say, which is the normal
  // state and must stay cheap to reach.
  //
  // Priority is deliberate and is the substance of #915:
  //   1. auth   — a dead credential, ungated, on the device that saw it.
  //   2. parse  — a file this build cannot read. Rare, different fix, its own
  //               words: telling someone to update a device is only useful when
  //               a device is actually behind.
  //   3. quiet  — a desk that published today and then stopped. GATED.
  //   4. network— nothing. See the header.
  function assess(state, opts) {
    const s = Object.assign(empty(), state || {});
    const o = opts || {};
    const now = ms(o.now);
    const quietAfter = typeof o.quietAfterMs === 'number' ? o.quietAfterMs : QUIET_AFTER_MS;

    if (s.lastFailure === 'auth') {
      return {
        level: 'error',
        code: 'auth',
        text: '999 Desk sync stopped: this device’s token is expired or revoked. ' +
              'Mint a new fine-grained token for the desk repo and paste it into Settings → 999 Desk area sync.',
      };
    }
    if (s.lastFailure === 'parse') {
      return {
        level: 'error',
        code: 'parse',
        text: '999 Desk sync read a file this version cannot understand, so the other desk’s areas are not showing. ' +
              'If the other device took an update, this one needs the same one.',
      };
    }

    // THE GATE. No desk heard from today -> silence, and this is the days-off
    // case the whole design turns on. An absence assertion in the test suite
    // pins it, with a paired control proving the alarm CAN fire on the same
    // fixture once a desk has published (CLAUDE.md; #794/#795/#796).
    if (now === null) return null;

    // QUIET IS A STATEMENT ABOUT A LIVE SORT, SO A HISTORICAL REPORT SILENCES IT.
    //
    // The alarm compares each desk's `updatedAt` against the WALL CLOCK, which
    // is right when the loaded report is today's. It is badly wrong the moment
    // it is not: open an archived report, or yesterday's through "Merge
    // yesterday's report", and every envelope in it is hours or weeks old, so
    // every desk reads as having gone silent — a screenful of red about people
    // who worked a full shift and went home.
    //
    // Found by the #915 recovery DOM test, whose fixture is dated 2026-08-12:
    // the alarm cleared its auth message and immediately replaced it with
    // "nothing new from Marisol for 33,000 minutes". That is the same cry-wolf
    // failure the publish-seen-today gate exists to prevent, arriving through a
    // third door, and it would have shipped looking like a passing test.
    //
    // AUTH IS DELIBERATELY ABOVE THIS LINE. A dead credential is dead whatever
    // report happens to be open, and reviewing an old sort is a perfectly good
    // moment to be told the token needs replacing.
    const today = text(o.today) || dayKey(o.now);
    if (s.day && today && s.day !== today) return null;

    const stale = [];
    Object.keys(s.desks).forEach(function (by) {
      const at = ms(s.desks[by]);
      if (at === null) return;
      if ((now - at) >= quietAfter) stale.push({ by: by, at: at });
    });
    if (!stale.length) return null;

    stale.sort(function (a, b) { return a.at - b.at; });
    const names = stale.map(function (d) { return d.by; });
    const worst = minutes(now - stale[0].at);
    return {
      level: 'warn',
      code: 'quiet',
      text: names.length === 1
        ? '999 Desk: nothing new from ' + names[0] + ' for ' + worst + ' minutes. ' +
          'Their work areas are not reaching this screen — check the desk before assuming the list is worked.'
        : '999 Desk: nothing new from ' + joinNames(names) + ' for up to ' + worst + ' minutes. ' +
          'Their work areas are not reaching this screen — check the desks before assuming the list is worked.',
    };
  }

  return {
    empty: empty,
    recordPull: recordPull,
    recordPublish: recordPublish,
    rollDay: rollDay,
    shouldPull: shouldPull,
    assess: assess,
    failureKind: failureKind,
    dayKey: dayKey,
    QUIET_AFTER_MS: QUIET_AFTER_MS,
    MIN_PULL_GAP_MS: MIN_PULL_GAP_MS,
    POLL_MS: POLL_MS,
  };
});
