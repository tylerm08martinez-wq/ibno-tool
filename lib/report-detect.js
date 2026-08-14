'use strict';

// Dialect sniffer for ibno-coder.html's ONE file input: which report did
// Tyler just drop? The main pipeline historically assumed every drop was the
// "Inbound and Van Scans" report; the Post Sort workflow (drop the "Inbound
// Scan - No Van Scan - Post Sort" report in the same slot, get its flagged-
// area tracking numbers onto the clipboard, then drop the "Track IDs to Full
// Barcode" lookup result back into the same slot) needs the input to tell
// three dialects apart by CONTENT, never by filename.
//
// Dual-loadable with no build step:
// - Browser: window.ReportDetect
// - Node:    require('./lib/report-detect')
//
// Detection is header-based, scanning a small window for a header-like row
// (the Post Sort xlsx dialect carries a one-line preamble ahead of its
// header; see lib/post-sort-scans.js's findHeaderRowIndex):
//
//   TRKID + PKG_BARCODE ............ 'barcode-lookup' — checked FIRST. Its
//                                    two-column header names also appear as
//                                    DATA values nowhere in either report,
//                                    and checking it first means a lookup
//                                    CSV can never be mistaken for a report.
//   ACTIVE_PKG_STOP_ID (canonical) or
//   ACTIVE PKG STOP ID (friendly) .. 'post-sort' — unique to the Post Sort
//                                    dialect across both its header forms
//                                    (lib/post-sort-scans.js HEADER_ALIASES
//                                    maps the friendly xlsx names; the CSV
//                                    dialect's headers are already
//                                    canonical). PKG_LABEL_XREF alone would
//                                    NOT distinguish it — the main report
//                                    has that column too.
//   anything else .................. 'main' — the historical default. The
//                                    main path never validated its input
//                                    before this module existed, and this
//                                    adds no new refusal to it.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ReportDetect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const HEADER_SCAN_WINDOW = 10;

  function cellSet(row) {
    const set = new Set();
    (Array.isArray(row) ? row : []).forEach(function (c) {
      set.add(String(c == null ? '' : c).trim().toUpperCase());
    });
    return set;
  }

  // detectReportKind(rows) -> 'barcode-lookup' | 'post-sort' | 'main'.
  // rows: parseCSV-shape (array of row arrays), as SpreadsheetLib.
  // readSpreadsheet hands back for every file format.
  function detectReportKind(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const limit = Math.min(list.length, HEADER_SCAN_WINDOW);
    for (let i = 0; i < limit; i++) {
      const cells = cellSet(list[i]);
      if (!cells.size) continue;
      if (cells.has('TRKID') && cells.has('PKG_BARCODE')) return 'barcode-lookup';
      if (cells.has('ACTIVE_PKG_STOP_ID') || cells.has('ACTIVE PKG STOP ID')) return 'post-sort';
    }
    return 'main';
  }

  return {
    detectReportKind: detectReportKind,
    HEADER_SCAN_WINDOW: HEADER_SCAN_WINDOW,
  };
});
