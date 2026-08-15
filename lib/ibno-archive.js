'use strict';

// Device-local accumulating archive behind the IBNO Coder's global search (#286).
//
// The Coder's tables show only the flagged/coded subset of a single file. This
// archive instead keeps EVERY row of EVERY CSV loaded over time so any tracking
// number or address can be looked up with all of its columns intact — full
// access to the raw data. It accumulates across loads (deduped), prunes to the
// same 30-day window the repeat-history uses (so it can't grow without bound),
// and matches a query against any field.
//
// PRIVACY: this archive is localStorage-only. It is NEVER synced to GitHub and
// never written to the repo — recipient/address data stays on the device.
//
// Pure + storage-agnostic (the page persists/loads the array). Dual-loadable,
// no build step (mirrors lib/in-area-12.js): reuses IbnoRules for the single
// date normalizer + preamble detection so date logic lives in one place.
//
// - Browser: window.IbnoArchive
// - Node: require('./lib/ibno-archive')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IbnoArchive = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  const ARCHIVE_DAYS = 30; // matches IbnoRules.HISTORY_DAYS — one retention window.

  function rules() {
    if (root && root.IbnoRules) return root.IbnoRules;
    if (typeof require === 'function') return require('./ibno-rules');
    throw new Error('IbnoArchive needs IbnoRules (load lib/ibno-rules.js first)');
  }

  // Same lazy dual-load resolution for the two render helpers buildSearchRecord
  // needs. Lazy on purpose: the page's <script> order is then irrelevant, and a
  // caller that never renders a record never pays for them.
  function helpers() {
    if (root && root.ToolHelpers) return root.ToolHelpers;
    if (typeof require === 'function') return require('./tool-helpers');
    throw new Error('IbnoArchive needs ToolHelpers (load lib/tool-helpers.js first)');
  }

  function ftrack() {
    if (root && root.FTrack) return root.FTrack;
    if (typeof require === 'function') return require('./ftrack');
    throw new Error('IbnoArchive needs FTrack (load lib/ftrack.js first)');
  }

  // Build one plain record object per data row, keyed by the header column names.
  // Strips any SSRS preamble first (via IbnoRules.findHeaderIndex) so rows[0] is
  // the real header. Keeps every column so search can show all of the data.
  function recordsFromRows(rows) {
    if (!Array.isArray(rows) || rows.length < 2) return [];
    const R = rules();
    const start = typeof R.findHeaderIndex === 'function' ? R.findHeaderIndex(rows) : 0;
    if (start > 0) rows = rows.slice(start);
    if (rows.length < 2) return [];
    const header = rows[0].map(function (h) { return String(h == null ? '' : h).trim(); });
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      const rec = {};
      let any = false;
      for (let c = 0; c < header.length; c++) {
        if (!header[c]) continue;
        const v = String(row[c] == null ? '' : row[c]).trim();
        rec[header[c]] = v;
        if (v !== '') any = true;
      }
      if (any) out.push(rec);
    }
    return out;
  }

  // A row's identity: same tracking + same inbound date + same scan time is the
  // same scan, so re-loading a file (or overlapping files) won't duplicate it.
  function keyOf(rec) {
    return [rec.PKG_LABEL_XREF || '', rec.INBOUND_DATE || '', rec.IB_SCAN_TIME || ''].join('|');
  }

  function cutoffIso(today) {
    const base = (today instanceof Date) ? today : new Date();
    const d = new Date(base.getTime() - ARCHIVE_DAYS * 24 * 60 * 60 * 1000);
    const iso = d.toISOString().slice(0, 10);
    return iso;
  }

  // Keep a record if its inbound date is within the window. Unparseable dates are
  // KEPT (never silently drop data we couldn't normalize).
  function withinWindow(rec, cutoff) {
    const R = rules();
    const iso = typeof R.toIsoDate === 'function' ? R.toIsoDate(rec.INBOUND_DATE) : '';
    if (!iso) return true;
    return iso >= cutoff;
  }

  // Merge new rows into the archive: dedupe by keyOf (new wins), then prune to the
  // 30-day window. Returns a new array; does not mutate the input.
  function addRows(archive, rows, today) {
    const base = Array.isArray(archive) ? archive : [];
    const incoming = recordsFromRows(rows);
    const byKey = new Map();
    for (const rec of base) byKey.set(keyOf(rec), rec);
    for (const rec of incoming) byKey.set(keyOf(rec), rec);
    const cutoff = cutoffIso(today);
    const out = [];
    for (const rec of byKey.values()) if (withinWindow(rec, cutoff)) out.push(rec);
    return out;
  }

  // Does a record match the (already-lowercased) query? Substring across EVERY
  // field value, so a tracking number, address fragment, firm name, ZIP, etc.
  // all find their rows. Shared by the in-memory searchArchive and the
  // IndexedDB cursor scan in the page.
  function recordMatches(rec, lowerQuery) {
    if (!lowerQuery) return false;
    for (const k in rec) {
      if (String(rec[k]).toLowerCase().indexOf(lowerQuery) !== -1) return true;
    }
    return false;
  }

  // Array-path search (used by tests and as a fallback). The page searches the
  // IndexedDB store directly via recordMatches to avoid loading everything.
  function searchArchive(archive, query) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q || !Array.isArray(archive)) return [];
    return archive.filter(function (rec) { return recordMatches(rec, q); });
  }

  // The union of column names across the archive, header-order-stable enough for
  // a display table (first record's columns first, then any extras appended).
  function columns(archive) {
    const seen = [];
    const have = Object.create(null);
    (Array.isArray(archive) ? archive : []).forEach(function (rec) {
      for (const k in rec) if (!have[k]) { have[k] = true; seen.push(k); }
    });
    return seen;
  }

  // Iso date for a record's INBOUND_DATE, with a never-prune sentinel for
  // unparseable dates (so the IndexedDB prune-by-date can't drop them).
  function recordIso(rec) {
    const R = rules();
    const iso = typeof R.toIsoDate === 'function' ? R.toIsoDate(rec.INBOUND_DATE) : '';
    return iso || '9999-12-31';
  }

  // buildSearchRecord(rec) -> the Search Data panel's HTML for ONE archive
  // record: a collapsed header (tracking, FTrack link, firm + address, the
  // high-value pills) plus the full column list behind the "all fields"
  // expand. Moved here from ibno-coder.html's inline script (#694) because
  // this module already owns the record shape it renders; the page keeps only
  // the querySelector/innerHTML wiring around it.
  //
  // Pure string in, pure string out: no DOM, no storage, so a Node test can
  // pin the markup. Every value goes through ToolHelpers.escapeHtml, which is
  // what keeps an address or firm name from being read as markup.
  function buildSearchRecord(rec) {
    const esc = helpers().escapeHtml;
    const addr = [rec.LABEL_ADDRESS1, rec.LABEL_CITY, rec.LABEL_STATE, rec.POSTAL_CODE].filter(Boolean).join(' ');
    const fields = Object.keys(rec).filter(function (k) { return String(rec[k]) !== ''; })
      .map(function (k) {
        return '<div class="srec-field"><span class="k">' + esc(k) + '</span>' +
               '<span class="v">' + esc(rec[k]) + '</span></div>';
      }).join('');
    // High-value fields surfaced inline on the collapsed header so the most-used
    // columns (date, work area, status) are readable without expanding "all
    // fields" (#310). The full column list still lives in the expand.
    const meta = [
      ['DATE', rec.INBOUND_DATE],
      ['AREA', rec.IB_WORK_AREA],
      ['STATUS', rec.STATUS_CODES1],
    ].filter(function (p) { return String(p[1] == null ? '' : p[1]).trim() !== ''; })
      .map(function (p) {
        return '<span class="srec-pill"><span class="k">' + esc(p[0]) + '</span>' +
               '<span class="v">' + esc(p[1]) + '</span></span>';
      }).join('');
    return '<div class="search-rec">' +
      '<div class="search-rec-head" onclick="this.parentNode.classList.toggle(\'open\')">' +
        '<span class="mono">' + esc(rec.PKG_LABEL_XREF || '—') + '</span>' +
        '<span onclick="event.stopPropagation()">' + ftrack().ftrackLink(rec.PKG_LABEL_XREF) + '</span>' +
        '<span class="srec-addr">' + esc(rec.LABEL_FIRM_NAME ? rec.LABEL_FIRM_NAME + ' · ' : '') + esc(addr) + '</span>' +
        (meta ? '<span class="srec-meta">' + meta + '</span>' : '') +
        '<span class="srec-toggle">all fields</span>' +
      '</div>' +
      '<div class="search-rec-fields">' + fields + '</div>' +
    '</div>';
  }

  // todaysLabelSet(itemLists, recurringMap) -> the tracking numbers surfaced
  // from the report loaded right now, used to tag history rows whose package is
  // also in today's work ("in today").
  //
  // The page owns the state; this owns the union rule. It takes the lists
  // rather than reading them, so nothing here knows about autoItems /
  // manualItems / resolvedItems — the caller decides which populations count as
  // "today" (ibno-coder.html passes all three plus the recurring map).
  function todaysLabelSet(itemLists, recurringMap) {
    const s = new Set();
    (Array.isArray(itemLists) ? itemLists : []).forEach(function (list) {
      (Array.isArray(list) ? list : []).forEach(function (i) {
        if (i && i.label) s.add(i.label);
      });
    });
    Object.keys(recurringMap || {}).forEach(function (l) { s.add(l); });
    return s;
  }

  return {
    ARCHIVE_DAYS: ARCHIVE_DAYS,
    buildSearchRecord: buildSearchRecord,
    todaysLabelSet: todaysLabelSet,
    recordsFromRows: recordsFromRows,
    keyOf: keyOf,
    addRows: addRows,
    searchArchive: searchArchive,
    recordMatches: recordMatches,
    cutoffIso: cutoffIso,
    recordIso: recordIso,
    columns: columns,
  };
});
