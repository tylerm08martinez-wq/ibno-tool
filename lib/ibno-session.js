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
    const columnGetter = (root && root.columnGetter) ||
      (typeof require === 'function' ? require('./csv').columnGetter : null);
    const IbnoRules = (root && root.IbnoRules) ||
      (typeof require === 'function' ? require('./ibno-rules') : null);
    if (typeof parseCSV !== 'function' || typeof columnGetter !== 'function' || !IbnoRules) {
      throw new Error('IbnoSession dependencies unavailable (need parseCSV + columnGetter + IbnoRules)');
    }
    return { parseCSV: parseCSV, columnGetter: columnGetter, IbnoRules: IbnoRules };
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
    const d = deps();
    return applyRows(d.parseCSV(csvText == null ? '' : csvText), opts);
  }

  // applyRows(rows, opts) — the parse-free core of applyFile. Accepts rows
  // already in parseCSV shape, so a caller that read an .xlsx/.xls through
  // SpreadsheetLib.readSpreadsheet can feed them straight in (#321) without
  // round-tripping through CSV text. applyFile is just parseCSV + this.
  function applyRows(rows, opts) {
    opts = opts || {};
    const d = deps();
    rows = Array.isArray(rows) ? rows : [];
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

  // ── Early-sort merge (#459) ──────────────────────────────────────────────
  // When the sort starts early (e.g. Monday 1:30 AM), packages scanned in that
  // window land on YESTERDAY'S "Inbound and Van Scans" report (its Sort Date
  // preamble is the prior day), but those rows carry TODAY'S date in the
  // per-row INBOUND_DATE column. The coder loads one file per session (a
  // re-drop replaces), so those rows are silently missed. mergeEarlySort is an
  // additive, opt-in merge: pull just the today-dated rows out of yesterday's
  // freshly-loaded report and append them to the already-loaded (primary)
  // report's rows.

  // sliceReport(rows, IbnoRules) -> { header, data } with any SSRS preamble
  // stripped (IbnoRules.findHeaderIndex), or null when the file has no
  // recognizable Inbound and Van Scans header (PKG_LABEL_XREF + INBOUND_DATE)
  // or no data rows below it — the 'unreadable' case.
  function sliceReport(rows, IbnoRules) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const start = IbnoRules.findHeaderIndex(rows);
    const sliced = rows.slice(start);
    if (sliced.length < 2) return null;
    const header = sliced[0];
    if (!Array.isArray(header)) return null;
    const cells = header.map(function (c) { return String(c == null ? '' : c).trim().toUpperCase(); });
    if (cells.indexOf('PKG_LABEL_XREF') === -1 || cells.indexOf('INBOUND_DATE') === -1) return null;
    return { header: header, data: sliced.slice(1) };
  }

  // modeInboundDate(data, get, IbnoRules) -> the MOST COMMON normalized
  // INBOUND_DATE across a report's data rows (ties broken by first
  // occurrence).
  //
  // DELEGATES to ReportFreshness.modeInboundDate (issue #464) — the one reader
  // both tools' SESSION layers use. (lib/sort-day.js keeps a separate, and
  // deliberately different, INBOUND_DATE reader; see its header.)
  // The Address Catcher's AddressCatcherSession.inboundSortDate
  // computed the same mode with different blank-tracking semantics and the two
  // could disagree on the same file; there is now a single implementation, and
  // it SKIPS rows with a blank PKG_LABEL_XREF (a row with no tracking id is not
  // a package). See lib/report-freshness.js for the measurement that settled
  // that. This thin wrapper stays because mergeEarlySort calls it twice with
  // its own already-sliced data and header getters.
  function modeInboundDate(data, get, IbnoRules) {
    return reportFreshness().modeInboundDate(data, get, {
      toIsoDate: function (raw) { return IbnoRules.toIsoDate(raw); },
    });
  }

  // Resolved LAZILY per call, like deps() above: no <script src> order in
  // ibno-coder.html can leave a load-time capture undefined, and a genuinely
  // missing lib/report-freshness.js fails loudly and by name.
  function reportFreshness() {
    const RF = (root && root.ReportFreshness) ||
      (typeof require === 'function' ? require('./report-freshness') : null);
    if (!RF || typeof RF.modeInboundDate !== 'function') {
      throw new Error('IbnoSession dependency unavailable (need ReportFreshness for the report sort date — is lib/report-freshness.js loaded?)');
    }
    return RF;
  }

  // mergeEarlySort(primaryRows, secondaryRows) -> {
  //   status: 'merged' | 'no-early-rows' | 'all-duplicates' | 'same-report' | 'no-dates' | 'unreadable',
  //   rows, added, duplicates, sortDate, secondarySortDate, header
  // }
  // Pure — never mutates either input; `rows`/`header` are present only on 'merged'.
  function mergeEarlySort(primaryRows, secondaryRows) {
    const d = deps();

    const primary = sliceReport(primaryRows, d.IbnoRules);
    const secondary = sliceReport(secondaryRows, d.IbnoRules);
    if (!primary || !secondary) return { status: 'unreadable' };

    const getPrimary = d.columnGetter(primary.header);
    const getSecondary = d.columnGetter(secondary.header);

    const sortDate = modeInboundDate(primary.data, getPrimary, d.IbnoRules);
    const secondarySortDate = modeInboundDate(secondary.data, getSecondary, d.IbnoRules);
    // Both files have a real header + data rows (sliceReport already confirmed
    // that), so a '' mode here means no row's INBOUND_DATE parsed at all — a
    // true binary .xlsx export carries it as an Excel serial number, which
    // toIsoDate can't normalize. Distinct from 'unreadable' (no report shape
    // at all): the file IS a report, we just can't read its dates (#459
    // review F4).
    if (!sortDate || !secondarySortDate) return { status: 'no-dates' };

    // Same-report test (#459 review F3): comparing the two files' MODE dates
    // is wrong on a fresh pull of yesterday's report — on a low-volume day
    // (Sunday/holiday) the today-dated early-sort rows can tie or outnumber
    // yesterday's own bulk rows, making secondarySortDate === sortDate even
    // though this is exactly the file the merge exists for. Instead: the
    // secondary IS the same report only when EVERY dated row in it matches
    // the primary's sortDate (no other date appears anywhere in it).
    // Otherwise proceed to dedup below — the PKG_LABEL_XREF+IB_SCAN_TIME
    // dedup key already makes any duplicated rows harmless.
    const candidates = secondary.data.filter(function (row) {
      return d.IbnoRules.toIsoDate(getSecondary(row, 'INBOUND_DATE')) === sortDate;
    });
    if (candidates.length === 0) {
      return { status: 'no-early-rows', sortDate: sortDate, secondarySortDate: secondarySortDate };
    }
    let otherDated = 0;
    secondary.data.forEach(function (row) {
      const iso = d.IbnoRules.toIsoDate(getSecondary(row, 'INBOUND_DATE'));
      if (iso && iso !== sortDate) otherDated++;
    });
    if (otherDated === 0) {
      return { status: 'same-report', sortDate: sortDate, secondarySortDate: secondarySortDate };
    }

    // Dedup against the primary's already-loaded rows so re-ingesting the same
    // early-sort package twice cannot double-count it.
    const seen = new Set();
    primary.data.forEach(function (row) {
      seen.add(getPrimary(row, 'PKG_LABEL_XREF') + '|' + getPrimary(row, 'IB_SCAN_TIME'));
    });
    const survivors = candidates.filter(function (row) {
      return !seen.has(getSecondary(row, 'PKG_LABEL_XREF') + '|' + getSecondary(row, 'IB_SCAN_TIME'));
    });
    const duplicates = candidates.length - survivors.length;

    if (survivors.length === 0) {
      return {
        status: 'all-duplicates',
        sortDate: sortDate,
        secondarySortDate: secondarySortDate,
        duplicates: duplicates,
        added: 0,
      };
    }

    // Remap survivors onto the PRIMARY header's column order by NAME — two
    // SSRS pulls of the same report type can drift in column order, so a
    // position-based concat would misalign cells.
    const remapped = survivors.map(function (row) {
      return primary.header.map(function (name) { return getSecondary(row, name); });
    });

    return {
      status: 'merged',
      rows: primaryRows.concat(remapped),
      header: primary.header,
      added: remapped.length,
      duplicates: duplicates,
      sortDate: sortDate,
      secondarySortDate: secondarySortDate,
    };
  }

  // reportSortDate(rows) -> a single report's sort date (the MODE of
  // normalized INBOUND_DATE across its data rows), or '' when unreadable.
  // Shared with mergeEarlySort so the page's "loaded a report dated
  // yesterday" soft note (#459) uses the SAME mode-based read mergeEarlySort
  // relies on, not a naive first-row read — first-row is exactly what's
  // unreliable on the report this note exists to flag.
  function reportSortDate(rows) {
    const d = deps();
    const sliced = sliceReport(rows, d.IbnoRules);
    if (!sliced) return '';
    return modeInboundDate(sliced.data, d.columnGetter(sliced.header), d.IbnoRules);
  }

  return {
    applyFile: applyFile,
    applyRows: applyRows,
    rerun: rerun,
    snapshot: snapshot,
    restore: restore,
    resolve: resolve,
    undo: undo,
    mergeEarlySort: mergeEarlySort,
    reportSortDate: reportSortDate,
  };
});
