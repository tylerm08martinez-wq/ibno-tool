'use strict';

// IBNO Coder — the job-2 working loop (issue #697, spec #690 user stories
// 11-22, confirmed design #612 / #613 rounds 12-18).
//
// Dual-loadable with no build step:
// - Browser: window.IbnoWorkLoop
// - Node: require('./lib/ibno-work-loop')
//
// The loop Tyler runs for most of a sort, in his words: "just the ease of
// quickly getting the address copied and then quickly get a work area typed in
// then move on to the next one." Land on a row, its street is already on the
// clipboard for FRO, type the Goes To area, press Enter, the next row that
// needs him takes focus with ITS street copied.
//
// This module owns the RULES of that loop. The tool owns the DOM wiring, and
// nothing in here reads a global, a clock, or storage.
//
// ─── THE THREE-WAY ADDRESS SPLIT (do not collapse it) ───────────────────────
//
// There are three different notions of "the address" in this tool, and each one
// answers a different question. Merging any two of them puts a package on the
// wrong belt.
//
//   streetOf   (lib/street-address.js) — number and name ONLY, no unit. This is
//              the FRO paste text and the Work-mode display. Tyler's call,
//              2026-08-08: the copy must not carry the unit or apartment.
//
//   stopKeyOf  (ActualArea.exactKey)  — unit-PRESERVING. DOCK FLEX rides this.
//              Tyler, 2026-08-16: "we have multiple packages going to the same
//              building but different apartments. I can't dock flex all of
//              them. I have to do it per apartment." APT 2 must never receive
//              APT 5's area. The real 2026-07-08 export carries the case:
//              6767 W BUTLER DR APT 171, APT 328 and APT 370, three stops at
//              one building.
//
//   buildingOf (ActualArea.clusterKey) — unit STRIPPED. Sheet bands and
//              same-stop clustering ride this, so one building still walks
//              together in list order.
//
// Both keys additionally require a house NUMBER and a street NAME, or there is
// no stop at all: an empty LABEL_ADDRESS1 composes down to a bare ZIP, and a
// ZIP is a region, not a destination. Five such rows once matched each other on
// a real export. That is the invariant tests/ibno-work-loop.test.js exists for.
//
// Nothing here re-implements address matching. Both keys delegate to
// lib/actual-area.js so the preview a supervisor sees and the write that
// actually happens can never disagree.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IbnoWorkLoop = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const ActualArea = (root && root.ActualArea) ||
      (typeof require === 'function' ? require('./actual-area') : null);
    if (!ActualArea) {
      throw new Error('IbnoWorkLoop dependencies unavailable (need ActualArea)');
    }
    return { ActualArea: ActualArea };
  }

  function str(v) { return String(v == null ? '' : v).trim(); }

  // ─── STOP AND BUILDING ────────────────────────────────────────────────────

  // stopKeyOf(address) -> the PROPAGATION key: unit-preserving, and '' unless
  // the address carries a house number and a street name.
  function stopKeyOf(address) {
    return deps().ActualArea.exactKey(address || '');
  }

  // buildingOf(address) -> the CLUSTERING key: unit stripped. Never a
  // propagation key. Reading this where stopKeyOf belongs is exactly the bug
  // the split exists to prevent.
  function buildingOf(address) {
    return deps().ActualArea.clusterKey(address || '');
  }

  // ─── DOCK FLEX ────────────────────────────────────────────────────────────

  // dockFlexPlan(items, label) -> exactly what one typed area will cover.
  //
  //   { stopKey, targets, refused }
  //
  // `targets` are the OTHER labels at the same unit-exact stop. `refused` is
  // 'no-stop' when the row has no matchable physical address, in which case
  // there is no stop and dock flex does nothing at all — never a fallback to
  // the building, the ZIP or the city.
  //
  // This is a PREVIEW of ActualArea.set()'s own sibling walk, and the test
  // pins the two together: a marker that brackets rows the write will not
  // touch is the same wrong-belt lie as propagating across a unit.
  function dockFlexPlan(items, label) {
    const list = Array.isArray(items) ? items : [];
    const key = String(label);
    let source = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].label) === key) { source = list[i]; break; }
    }
    const stop = stopKeyOf(source && source.address);
    if (!stop) return { stopKey: '', targets: [], refused: 'no-stop' };
    const targets = [];
    list.forEach(function (it) {
      if (!it) return;
      const l = String(it.label);
      if (!l || l === key) return;
      if (stopKeyOf(it.address) !== stop) return;
      targets.push(l);
    });
    return { stopKey: stop, targets: targets, refused: null };
  }

  // ─── WORKED vs DONE ───────────────────────────────────────────────────────
  //
  // Two different states, and #612 decision 3 is why they cannot be one:
  //
  //   WORKED — the row carries a Goes To area. A dock-flexed sibling is worked.
  //   DONE   — the package was scanned. Tyler: "i scan each package
  //            individually", so a dock-flexed sibling is NOT done, and the
  //            progress bar must say so rather than reporting a stop finished
  //            because one of its packages was.
  //
  // Both readers are injected: worked lives in ActualArea provenance, done
  // lives in lib/barcode-done.js, and this module knows neither store.
  function pct(n, total) {
    if (!total) return 0;
    return Math.round(n / total * 100);
  }

  function progress(labels, ctx) {
    const list = Array.isArray(labels) ? labels : [];
    const c = ctx || {};
    const worked = typeof c.isWorked === 'function' ? c.isWorked : function () { return false; };
    const done = typeof c.isDone === 'function' ? c.isDone : function () { return false; };
    let w = 0, d = 0;
    list.forEach(function (l) {
      if (worked(l)) w++;
      if (done(l)) d++;
    });
    return {
      total: list.length,
      worked: w,
      done: d,
      workedPct: pct(w, list.length),
      donePct: pct(d, list.length),
    };
  }

  // progressText(p) -> the one sentence the bar prints, so the bar and any
  // other caller can never word the same numbers differently.
  function progressText(p) {
    const v = p || progress([], null);
    return v.worked + ' worked · ' + v.done + ' scanned · of ' + v.total;
  }

  // ─── GLOBAL ENTER ─────────────────────────────────────────────────────────

  // enterAdvances(target) -> may a bare Enter re-enter the working loop?
  //
  // No, whenever something owns that Enter already. A focused BUTTON is the
  // case #613 round 18 named explicitly: tab to a button, press Enter, the
  // button must fire — advancing the cursor instead would silently skip a row
  // AND leave the button unpressed. Fields, links, selects and anything
  // wearing an activating ARIA role are the same argument.
  const OWNS_ENTER_TAGS = ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SUMMARY', 'LABEL'];
  const OWNS_ENTER_ROLES = ['button', 'link', 'checkbox', 'radio', 'menuitem', 'option', 'switch', 'tab', 'textbox'];

  function enterAdvances(target) {
    if (!target) return true;
    const tag = String(target.tagName || '').toUpperCase();
    if (OWNS_ENTER_TAGS.indexOf(tag) !== -1) return false;
    if (target.isContentEditable) return false;
    let role = '';
    if (typeof target.getAttribute === 'function') role = str(target.getAttribute('role'));
    if (!role) role = str(target.role);
    if (OWNS_ENTER_ROLES.indexOf(role.toLowerCase()) !== -1) return false;
    return true;
  }

  // ─── THE CODED CHIP ───────────────────────────────────────────────────────
  //
  // #612 decision 2, Tyler's words: "they should stay but let me filter them
  // out." A coded row does not vanish from the working list — it dims in place
  // and this chip hides it. The chip is absent at zero, because a control that
  // reads "0 coded" is volume without information (the findability rule, #611).
  function codedChipVisible(count) { return Number(count) > 0; }

  function codedChipText(count, hidden) {
    const n = Number(count) || 0;
    return hidden ? ('✓ ' + n + ' coded (hidden)') : ('✓ ' + n + ' coded');
  }

  function codedChipTitle(hidden) {
    return hidden
      ? 'Show the rows you have already coded'
      : 'Hide the rows you have already coded — they stay in the list, behind this filter';
  }

  return {
    stopKeyOf: stopKeyOf,
    buildingOf: buildingOf,
    dockFlexPlan: dockFlexPlan,
    progress: progress,
    progressText: progressText,
    enterAdvances: enterAdvances,
    codedChipVisible: codedChipVisible,
    codedChipText: codedChipText,
    codedChipTitle: codedChipTitle,
  };
});
