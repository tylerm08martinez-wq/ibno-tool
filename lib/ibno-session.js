'use strict';

// IBNO coding session — the DOM-free core behind ibno-coder.html.
//
// Composes the canonical coding rules (lib/ibno-rules.js) and the CSV parser
// (lib/csv.js) into one testable interface. No DOM, no localStorage, no
// network: the page passes in the current Repeat History and owns the side
// effects (persisting history, scheduling sync, rendering). This makes the
// coding pipeline — the records-critical path — reachable from unit tests and
// from a real-data verify, instead of only through the page's DOM.
//
// Dual-loadable with no build step:
// - Browser: window.IbnoSession  (parseCSV + IbnoRules already on root)
// - Node: require('./lib/ibno-session')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IbnoSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // Resolve the rules engine + CSV parser from the browser globals, falling
  // back to require() under Node. Kept lazy so neither loader order nor a
  // missing global breaks module evaluation — only a real call fails, loudly.
  function deps() {
    const parseCSV = (root && root.parseCSV) ||
      (typeof require === 'function' ? require('./csv').parseCSV : null);
    const IbnoRules = (root && root.IbnoRules) ||
      (typeof require === 'function' ? require('./ibno-rules') : null);
    if (typeof parseCSV !== 'function' || !IbnoRules) {
      throw new Error('IbnoSession dependencies unavailable (need parseCSV + IbnoRules)');
    }
    return { parseCSV: parseCSV, IbnoRules: IbnoRules };
  }

  // applyFile(csvText, { history, today }) -> snapshot
  //   { rows, auto, manual, dayType, recurring, updatedHistory }
  //
  // Parses the CSV once and runs BOTH the coding rules (processRows) and the
  // recurring-IBNO detection (detectRecurring) off the same rows — mirroring
  // what the page does on file load. `rows` is returned so the caller can
  // re-run rules without re-reading the file; `updatedHistory` is the map the
  // caller should persist. Pure: no side effects, safe to call in tests.
  function applyFile(csvText, opts) {
    opts = opts || {};
    const d = deps();
    const rows = d.parseCSV(csvText == null ? '' : csvText);
    const results = d.IbnoRules.processRows(rows); // { auto, manual, dayType }
    const today = opts.today || new Date();
    const rec = d.IbnoRules.detectRecurring(rows, opts.history || {}, today);
    return {
      rows: rows,
      auto: results.auto,
      manual: results.manual,
      dayType: results.dayType,
      recurring: rec.recurringMap,
      updatedHistory: rec.updatedHistory,
    };
  }

  // rerun(rows) -> { auto, manual, dayType }
  //
  // Re-run the coding rules on already-parsed rows (the "Re-run Rules" action).
  // Deliberately does NOT re-run recurring detection or touch history: those
  // were settled on file load, and a re-run only re-applies the (possibly
  // edited) flagged-work-area settings to the same rows.
  function rerun(rows) {
    const d = deps();
    return d.IbnoRules.processRows(Array.isArray(rows) ? rows : []);
  }

  // ── Session model: the in-progress coding session, persisted by the page ────
  // The page holds five models (auto / manual / resolved / dayType / recurring)
  // and mirrors them to storage on each mutation, so a reload mid-shift restores
  // the work (#157). These helpers own the persisted SHAPE and the resolve/undo
  // transitions so they are testable off-DOM; the page keeps the rendering and
  // the storage I/O. No DOM, no storage, no network here.

  // snapshot(state) -> the plain serializable session object to persist.
  function snapshot(state) {
    state = state || {};
    return {
      auto: Array.isArray(state.auto) ? state.auto : [],
      manual: Array.isArray(state.manual) ? state.manual : [],
      resolved: Array.isArray(state.resolved) ? state.resolved : [],
      dayType: state.dayType || 'weekday',
      recurring: state.recurring || {},
    };
  }

  // restore(stored) -> a usable session object, or null when the stored value
  // is the wrong shape or carries nothing worth restoring (all three lists
  // empty). The page treats null as "no session to restore".
  function restore(stored) {
    if (!stored || typeof stored !== 'object') return null;
    if (!Array.isArray(stored.auto) || !Array.isArray(stored.manual) || !Array.isArray(stored.resolved)) return null;
    if (!stored.auto.length && !stored.manual.length && !stored.resolved.length) return null;
    return {
      auto: stored.auto,
      manual: stored.manual,
      resolved: stored.resolved,
      dayType: stored.dayType || 'weekday',
      recurring: stored.recurring || {},
    };
  }

  // resolve(manual, resolved, item) -> { manual, resolved }
  // Drop the manual-review row matching item.label and add `item` to resolved.
  // The caller passes the RESOLVED item (a copy of the manual row carrying the
  // chosen QA code / skipped flag), so that — not the bare manual row — is what
  // lands in resolved. Pure: returns fresh arrays, inputs untouched.
  function resolve(manual, resolved, item) {
    const label = item && item.label;
    const m = Array.isArray(manual) ? manual.slice() : [];
    const r = Array.isArray(resolved) ? resolved.slice() : [];
    const idx = m.findIndex(function (it) { return it && it.label === label; });
    if (idx !== -1) m.splice(idx, 1);
    r.push(item);
    return { manual: m, resolved: r };
  }

  // undo(manual, resolved, label) -> { manual, resolved }
  // Move the resolved item with this label back into the manual list. Pure.
  function undo(manual, resolved, label) {
    const m = Array.isArray(manual) ? manual.slice() : [];
    const r = Array.isArray(resolved) ? resolved.slice() : [];
    const idx = r.findIndex(function (it) { return it && it.label === label; });
    if (idx !== -1) m.push(r.splice(idx, 1)[0]);
    return { manual: m, resolved: r };
  }

  return {
    applyFile: applyFile,
    rerun: rerun,
    snapshot: snapshot,
    restore: restore,
    resolve: resolve,
    undo: undo,
  };
});
