'use strict';

// THE OTHER DESK'S GOES TO ACTIVITY. "When did they last type an area, and
// what has reached this screen from them lately?" (Tyler, 2026-09-08.)
//
// WHY THIS IS NOT THE STATE LANE'S FRESHNESS. The Other desk pane (#949) heads
// each admin with lib/desk-state.js's `updatedAt`, which moves only when they
// PARK or FILE. An admin coding Goes To boxes for an hour never touches it, so
// that heading reads "nothing new for 60 minutes" about a desk that is flat
// out. The areas lane's `updatedAt` is the stamp that moves when a Goes To is
// typed (lib/remote-areas.js; it advances only when areas change, per the
// QUIET_AFTER_MS note in lib/desk-health.js), and lib/desk-health.js already
// keeps it per author in `desks`. This module reads that roster and says so.
//
// NO WIRE CHANGE. Per-entry `at` on the areas envelope is a DATE, not a time,
// so "which rows did they type most recently" is not on the wire, and putting
// a timestamp there is a version bump for a mixed fleet. Instead the page
// records WHEN EACH REMOTE ROW ARRIVED HERE (the adapter's `changed` list,
// within 5-35s of the keystroke), in memory only. That log is never persisted,
// never exported, and nothing on the answer path reads it.
//
// AUTHORS FOLD BY SLUG (#968 review finding 3). `JORGE`, `Jorge` and `jorge`
// are one file, areas/jorge.json, and one person.
//
// Dual-loadable with no build step:
// - Browser: window.DeskActivity
// - Node:    require('./lib/desk-activity')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DeskActivity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function dep(name, file) {
    const m = (root && root[name]) || (typeof require === 'function' ? require(file) : null);
    if (!m) throw new Error('DeskActivity dependencies unavailable (need ' + name + ')');
    return m;
  }
  function areaLib() { return dep('ActualArea', './actual-area'); }
  function remoteLib() { return dep('RemoteAreas', './remote-areas'); }
  function stateLib() { return dep('DeskState', './desk-state'); }

  const MAX_LOG = 400;   // arrivals kept in memory; a real day measured 225 areas (2026-09-02)
  const RECENT_N = 10;

  function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
  function slugOf(by) { return remoteLib().deviceSlug(str(by).trim()); }
  function ms(iso) { const t = Date.parse(str(iso)); return Number.isFinite(t) ? t : null; }

  // lastTypedFor(roster, by, opts) -> DeskState.freshness shape over the AREAS
  // lane's stamp for that author. `roster` is deskHealth.desks. Newest stamp
  // wins when two spellings fold to one slug.
  function lastTypedFor(roster, by, opts) {
    const slug = slugOf(by);
    const r = roster && typeof roster === 'object' ? roster : {};
    let best = '';
    if (slug) {
      Object.keys(r).forEach(function (name) {
        if (slugOf(name) !== slug) return;
        const cur = ms(r[name]);
        if (cur === null) return;
        const prev = ms(best);
        if (prev === null || cur > prev) best = str(r[name]);
      });
    }
    return stateLib().freshness({ updatedAt: best }, opts || {});
  }

  // areasTodayFor(store, by, day) -> how many entries in the local area store
  // ARRIVED from that author TODAY (remote, by-slug, and stamped with this sort
  // day). A row Tyler re-typed to agree with them keeps `by` but drops `remote`
  // (ADR-0023 amendment), so it is his decision now and is not counted.
  //
  // THE DAY GATE IS NOT OPTIONAL. The area store is not day-scoped: it keeps a
  // month of sort days and lib/actual-area.js only prunes at 30 days, so an
  // ungated count answers "areas from them still on file", while the sentence
  // this feeds says "N areas here today". Every remote entry carries its sort
  // day in `date` (lib/actual-area.js setRemote), and there is no date reader
  // on ActualArea, so the entry is read straight off the store. No day means
  // no honest count, so it fails closed at 0 rather than reporting a month.
  function areasTodayFor(store, by, day) {
    const slug = slugOf(by);
    const today = str(day);
    if (!slug || !today || !store || typeof store !== 'object') return 0;
    const ActualArea = areaLib();
    let n = 0;
    Object.keys(store).forEach(function (label) {
      if (!ActualArea.isRemote(store, label)) return;
      if (slugOf(ActualArea.byOf(store, label)) !== slug) return;
      const entry = store[label];
      if (str(entry && entry.date) !== today) return;
      n++;
    });
    return n;
  }

  // THE ARRIVAL LOG (in memory only)

  function emptyLog() { return { day: '', items: [] }; }

  function rollDay(log, day) {
    const l = log && typeof log === 'object' ? log : emptyLog();
    const d = str(day);
    if (!d || d === l.day) return { day: l.day, items: (l.items || []).slice() };
    return { day: d, items: [] };
  }

  // recordArrivals(log, labels, store, opts) -> a new log. `labels` is the
  // adapter's `changed` list after RemoteAreas.applyTo; the store is read AFTER
  // apply so a label that is remote now is an arrival and one that is not is a
  // withdrawal (or a row Tyler answered himself, which stops being theirs).
  function recordArrivals(log, labels, store, opts) {
    const o = opts || {};
    const next = rollDay(log, o.day);
    const now = str(o.now);
    const ActualArea = areaLib();
    const s = store && typeof store === 'object' ? store : {};
    (Array.isArray(labels) ? labels : []).forEach(function (raw) {
      const label = str(raw);
      if (!label) return;
      next.items = next.items.filter(function (it) { return it.label !== label; });
      if (!ActualArea.isRemote(s, label)) return;
      const by = str(ActualArea.byOf(s, label)).trim();
      const slug = slugOf(by);
      if (!slug) return;
      next.items.push({ label: label, slug: slug, by: by, area: str(ActualArea.get(s, label)), at: now });
    });
    if (next.items.length > MAX_LOG) next.items = next.items.slice(next.items.length - MAX_LOG);
    return next;
  }

  // recentFor(log, by, n, opts) -> newest first, that author only. Pass
  // `opts.store` and the list is filtered through the local area store as it
  // stands NOW, with the store's current area on each row.
  //
  // THE STORE FILTER BELONGS HERE, BEFORE THE CAP. The log only ever hears the
  // pull adapter, so a row Tyler cleared here or answered himself is still in
  // it, and showing that row as "arrived from her" would put her name on a
  // decision that is now his. Filtering at the call site instead means the cap
  // has already run, so those dropped rows leave holes that older valid
  // arrivals never fill. Filter, then sort, then slice.
  function recentFor(log, by, n, opts) {
    const slug = slugOf(by);
    const items = (log && Array.isArray(log.items)) ? log.items : [];
    const cap = typeof n === 'number' && n > 0 ? n : RECENT_N;
    if (!slug) return [];
    const store = (opts && opts.store && typeof opts.store === 'object') ? opts.store : null;
    const ActualArea = store ? areaLib() : null;
    return items
      .filter(function (it) {
        if (it.slug !== slug) return false;
        if (!store) return true;
        if (!ActualArea.isRemote(store, it.label)) return false;
        return slugOf(ActualArea.byOf(store, it.label)) === slug;
      })
      .sort(function (a, b) { return (ms(b.at) || 0) - (ms(a.at) || 0); })
      .slice(0, cap)
      .map(function (it) {
        return {
          label: it.label,
          by: it.by,
          area: store ? str(ActualArea.get(store, it.label)) : it.area,
          at: it.at,
        };
      });
  }

  // THE ONE SENTENCE UNDER THE ADMIN'S NAME

  // activityFor(input) -> everything the pane needs about one admin, from the
  // three sources that answer it: the areas roster (when they last typed), the
  // local store (how much of theirs is here), and the arrival log (what landed
  // most recently).
  function activityFor(input) {
    const i = input || {};
    const by = str(i.by).trim();
    return {
      by: by,
      typed: lastTypedFor(i.roster, by, { now: i.now, quietAfterMs: i.quietAfterMs }),
      areasToday: areasTodayFor(i.store, by, i.day),
      recent: recentFor(i.log, by, i.recentN, { store: i.store }),
    };
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  // text(activity, opts) -> the one sentence under the admin's name.
  function textFor(activity, opts) {
    const a = activity || {};
    const t = a.typed || {};
    const n = typeof a.areasToday === 'number' ? a.areasToday : 0;
    const clock = (opts && typeof opts.clock === 'function') ? opts.clock : function (iso) { return str(iso).slice(11, 16); };
    const count = plural(n, 'area') + ' here today';
    if (t.state !== 'fresh' && t.state !== 'stale') {
      return n ? count + ' · last typed: not known' : 'no Goes To from this device has reached this screen today';
    }
    const when = 'last Goes To typed ' + clock(t.at);
    if (t.state === 'stale') return when + ' · nothing new for ' + t.minutes + ' minutes · ' + count;
    return when + ' · ' + t.minutes + ' min ago · ' + count;
  }

  return {
    MAX_LOG: MAX_LOG,
    RECENT_N: RECENT_N,
    lastTypedFor: lastTypedFor,
    areasTodayFor: areasTodayFor,
    emptyLog: emptyLog,
    rollDay: rollDay,
    recordArrivals: recordArrivals,
    recentFor: recentFor,
    activityFor: activityFor,
    text: textFor,
  };
});
