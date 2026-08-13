'use strict';

// Parser for the "Inbound Scan - No Van Scan - Post Sort" report export
// (issue #633, second slice of #622). PARSING ONLY — no UI wiring here; see
// notes/report-registry.md's Post Sort row for the full measured shape and
// every trap below (read it before changing this file; do not re-derive its
// measurements).
//
// This is a THIRD report dialect, distinct from both the "During Sort" NVS
// report (lib/nvs-report.js) and "Inbound and Van Scans" (lib/inbound-scans.js)
// — 35 columns, no SSRS preamble in the CSV, a one-row preamble + friendly
// headers in the xlsx. It is closer in shape to Inbound and Van Scans than to
// the During Sort NVS report, but is its own dialect with its own column set.
//
// Dual-loadable with no build step:
// - Browser: window.PostSortScans
// - Node:    require('./lib/post-sort-scans')
//
// THREE MEASURED TRAPS (notes/report-registry.md, Post Sort row):
//
// TRAP 1 — the CSV mangles every tracking number into scientific notation
// (`5.37357E+11`): clean on 0 of 2,467 CSV rows against 284 of 289 xlsx rows.
// Silently accepting the CSV hands Tyler a working list keyed on lossy
// identifiers, so parsePostSortRows() REFUSES LOUDLY (throws
// PostSortMangledTrackingError) the moment it finds a PKG_LABEL_XREF value in
// scientific-notation shape, per the #445 loud-refusal precedent. Use the
// xlsx export; the CSV is kept only as evidence of the mangling.
//
// TRAP 2 — the xlsx's friendly `LOOKUP` column is NOT `PLA_LOOKUP`. It sits
// where the CSV has `PRIORITY_PACKAGE` and holds only `PLY` / `Priority
// Overnight`. `PLA_LOOKUP` is genuinely absent from this report with no
// substitute — HEADER_ALIASES deliberately maps `LOOKUP` -> `PRIORITY_PACKAGE`
// (its real identity), never to PLA_LOOKUP, and PLA_LOOKUP never appears as a
// REQUIRED_COLUMNS entry or a record key. parsePostSortRows()'s return value
// carries `hasPlaLookup`, derived from the detected header keys (currently
// always false for every real sample of this dialect) so a caller can act on
// the absence without having to probe record keys itself — and would flip
// true automatically if a future pull ever adds a genuine PLA_LOOKUP column.
//
// TRAP 3 — INBOUND DATE / INBOUND TIME (and FRO SUBMIT DT/TM, UTC TIMESTAMP)
// arrive as Excel SERIAL numbers in this dialect (`46246`,
// `46246.1556597222`), unlike the During Sort xlsx dialect which arrives as
// clock text (`02:10 AM`). normalizeSerialColumns() converts them into the
// SAME textual form this report's own CSV dialect already uses for the same
// columns (`M/D/YYYY` for a pure date serial, `M/D/YYYY H:MM` for a
// date+time serial — verified against the real CSV: FRO_SUBMIT_TM serial
// 46246.0225347222 converts to "8/12/2026 0:32", matching the CSV's own text
// for the same value) — so downstream date logic (e.g. lib/ibno-rules.js's
// toIsoDate, which already parses US M/D/YYYY) needs no changes to consume
// either dialect. A value that is already text (not a bare number) passes
// through unchanged, so a future dialect that reverts to clock text still
// works.
//
// Also: the xlsx has a multi-line preamble in row 0 and the header in row 1,
// with friendly display names (TRACKING, WA, SID, ADDRESS1, ISSUE, ...)
// rather than the CSV's canonical UPPER_SNAKE names. HEADER_ALIASES maps the
// friendly names onto their canonical equivalents (verified against the real
// 2026-08-12 xlsx fixture header row); the CSV's headers are already
// canonical, so a CSV's headers pass through headerKey() unchanged, same
// discipline as lib/nvs-report.js.
//
// LOUD REFUSAL on a missing required column (#445 precedent, reused rather
// than reinvented): REQUIRED_COLUMNS is the full 35-column canonical schema
// (every HEADER_ALIASES target plus STATION, the one byte-identical column).
// If the detected header row's mapped keys are missing ANY of them,
// parsePostSortRows() throws PostSortMissingColumnsError instead of building
// records from a header this parser does not recognize.
//
// Be precise about WHY, because an earlier version of this comment was not.
// A missing column can NOT misalign the surviving columns: records are built
// by keys.forEach((key, i) => rec[key] = row[i]), so every cell is keyed by
// its own header and a dropped column simply leaves that one key absent. The
// refusal exists because one of those absences is genuinely dangerous rather
// than merely lossy: lose PKG_LABEL_XREF and trackingCol becomes -1, the
// TRAP 1 mangled-tracking scan then silently tests undefined, and every
// record comes back with no tracking number at all. Refusing on the whole
// schema is the cheap way to make that case impossible.
//
// It is cheap because the column names are FIXED. Tyler confirmed on
// 2026-08-12 that FedEx cannot change this report's column names, which is
// what settles the question raised on PR #639 about whether requiring all 35
// is too strict. With the names fixed there is no false-refusal risk to trade
// against, so ALL 35 STAY REQUIRED: do not soften this, and do not split it
// into required/optional tiers. Recorded in notes/report-registry.md row 13.
// Note this is not stricter than the #445 precedent either, despite being
// described that way on #639 — lib/nvs-report.js:137 requires all 17 of its
// columns and builds the list the same way.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PostSortScans = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const csvApi = (typeof require === 'function') ? require('./csv') : null;
  const parseCSV = csvApi && csvApi.parseCSV ? csvApi.parseCSV : (root && root.parseCSV);

  function headerKey(name) {
    return String(name == null ? '' : name).trim().toUpperCase();
  }

  // xlsx friendly header (uppercased/trimmed via headerKey) -> CSV canonical
  // key. Verified against the real 2026-08-12 xlsx fixture's row-1 header,
  // in column order. STATION is intentionally absent (byte-identical).
  const HEADER_ALIASES = {
    'FACILITY NAME': 'FACILITY_NAME',
    'ABBR': 'FACILITY_ABBR',
    'INBOUND DATE': 'INBOUND_DATE',
    'INBOUND TIME': 'IB_SCAN_TIME',
    'TIME ZONE': 'PK_TZCODE',
    'IB SCAN NAME': 'IB_SCAN_NAME',
    'LOOKUP': 'PRIORITY_PACKAGE', // TRAP 2 — NOT PLA_LOOKUP. See file header.
    'TRACKING': 'PKG_LABEL_XREF',
    'EXPRESS TRACK': 'EXPRESS_TRACK',
    'WA': 'IB_WORK_AREA',
    'SID': 'SORT_SID',
    'WEIGHT': 'PKG_WEIGHT',
    'FIRM NAME': 'LABEL_FIRM_NAME',
    'ADDRESS1': 'LABEL_ADDRESS1',
    'ADDRESS2': 'LABEL_ADDRESS2',
    'CITY': 'LABEL_CITY',
    'STATE': 'LABEL_STATE',
    'POSTAL': 'POSTAL_CODE',
    'PLUS 4': 'PLUS_4',
    'STATUS CODES': 'STATUS_CODES',
    'STATUS DESC': 'STATUS_DESC',
    'ISSUE': 'ISSUE_TYPE',
    'VAN SCAN': 'VAN_SCAN_TIME',
    'VAN LOADER': 'VAN_SCAN_NAME',
    'VAN NUMBER': 'VAN_NUMBER',
    'ACTIVE PKG STOP ID': 'ACTIVE_PKG_STOP_ID',
    'ACTIVE PKG STOP ID TYPE': 'ACTIVE_PKG_STOP_ID_TYPE',
    'SORT STOP ID': 'SORT_STOP_ID',
    'SORT STOP ID TYPE': 'SORT_STOP_ID_TYPE',
    'FRO PLAN NAME': 'FRO_PLAN_NAME',
    'FRO SUBMIT DT': 'FRO_SUBMIT_DT',
    'FRO SUBMIT TM': 'FRO_SUBMIT_TM',
    'UTC TIMESTAMP': 'TS_UTC',
    'UTC OFFSET HOURS': 'UTC_OFFSET_HOURS',
  };

  // The full 35-column canonical schema (STATION, the one byte-identical
  // column, plus every HEADER_ALIASES target). A header row missing any of
  // these, from either dialect, fails the parse loudly. PLA_LOOKUP is
  // deliberately NOT in this list: it is genuinely absent from this report
  // (TRAP 2), not a column this parser expects to find.
  //
  // DECIDED, do not re-open: all 35 stay required. FedEx cannot change this
  // report's column names (Tyler, 2026-08-12), so the strict rule has no
  // false-refusal cost. See the LOUD REFUSAL note in the file header for why
  // the refusal is about one dangerous absence, not about misalignment.
  const REQUIRED_COLUMNS = ['STATION'].concat(
    Array.from(new Set(Object.keys(HEADER_ALIASES).map(function (k) { return HEADER_ALIASES[k]; })))
  );

  // Canonical columns that arrive as Excel serial numbers in the xlsx dialect
  // (TRAP 3). INBOUND_DATE and FRO_SUBMIT_DT are pure-date serials (no
  // fraction); IB_SCAN_TIME, FRO_SUBMIT_TM and TS_UTC carry a date+time
  // serial (fractional part = time-of-day).
  const SERIAL_DATE_COLUMNS = ['INBOUND_DATE', 'IB_SCAN_TIME', 'FRO_SUBMIT_DT', 'FRO_SUBMIT_TM', 'TS_UTC'];

  // Raw header cell -> canonical record key. A CSV's headers are already
  // canonical, so they miss HEADER_ALIASES and pass through headerKey()
  // unchanged (same discipline as lib/nvs-report.js's canonicalKey).
  function canonicalKey(rawHeader) {
    const key = headerKey(rawHeader);
    return Object.prototype.hasOwnProperty.call(HEADER_ALIASES, key) ? HEADER_ALIASES[key] : key;
  }

  // The real header row, located by CONTENT rather than a fixed index — the
  // CSV dialect has no preamble (header is row 0); the xlsx dialect has a
  // one-line preamble ahead of it (verified: row 0). Scanning a small window
  // and testing for PKG_LABEL_XREF + INBOUND_DATE (the same signature pair
  // lib/ibno-rules.js's findHeaderIndex uses for the sibling reports)
  // tolerates a preamble that grows a line without breaking ingestion.
  // Falls back to row 0 if nothing matches.
  const HEADER_SCAN_WINDOW = 10;
  function findHeaderRowIndex(rows) {
    const limit = Math.min(rows.length, HEADER_SCAN_WINDOW);
    for (let i = 0; i < limit; i++) {
      if (!Array.isArray(rows[i])) continue;
      const keys = rows[i].map(canonicalKey);
      if (keys.indexOf('PKG_LABEL_XREF') !== -1 && keys.indexOf('INBOUND_DATE') !== -1) return i;
    }
    return 0;
  }

  // "5.37357E+11" / "8.75459E+11" etc — the shape Excel produces when it
  // re-renders a 12-digit tracking number it decided was a number (TRAP 1).
  // Real xlsx tracking values are never in this shape (verified: 0 of 289).
  const SCI_NOTATION_RE = /^\d(\.\d+)?E\+\d+$/i;
  function looksMangled(trackingValue) {
    return SCI_NOTATION_RE.test(String(trackingValue == null ? '' : trackingValue).trim());
  }

  // Excel serial (days since 1899-12-30, matching Excel's own — including its
  // 1900-leap-year-bug — epoch) -> UTC midnight ms for the date part.
  const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
  function excelSerialToText(raw) {
    const s = String(raw == null ? '' : raw).trim();
    // Only a bare number (optionally decimal) is treated as a serial — text
    // already in clock/date form (contains '/' or ':') passes through
    // unchanged, so a dialect that reverts to text still works (TRAP 3 note).
    if (!/^\d+(\.\d+)?$/.test(s)) return s;
    const serial = parseFloat(s);
    // Excel's zero/blank-date placeholder (serial 0, or anything rounding
    // down to it) is not a real 1899-12-30 timestamp — return blank rather
    // than a bogus-looking date.
    if (serial <= 0) return '';
    const wholeDays = Math.floor(serial);
    const frac = serial - wholeDays;
    if (frac <= 0) {
      const d = new Date(EXCEL_EPOCH_MS + wholeDays * 86400000);
      return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + d.getUTCFullYear();
    }
    let totalSeconds = Math.round(frac * 86400);
    let carryDays = 0;
    // Rounding the fractional day up to the nearest second can land exactly
    // on the next midnight (e.g. .999997 of a day). Carry that into the date
    // rather than emitting hour 24, so this text and a plain `new Date()`
    // read of the same instant agree on the calendar date (they otherwise
    // disagree right at the day boundary, which matters because sort dates
    // gate day-pruning downstream).
    if (totalSeconds >= 86400) {
      totalSeconds -= 86400;
      carryDays = 1;
    }
    const d = new Date(EXCEL_EPOCH_MS + (wholeDays + carryDays) * 86400000);
    const dateText = (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + d.getUTCFullYear();
    const hh = Math.floor(totalSeconds / 3600);
    const mm = Math.floor((totalSeconds % 3600) / 60);
    return dateText + ' ' + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }

  // Shared entry point for both dialects: rows already in CsvLib.parseCSV
  // shape (array of row arrays), from either CsvLib.parseCSV or
  // XlsxLib.parseXlsx / SpreadsheetLib.readSpreadsheet.
  //
  // Returns { headers, records, hasPlaLookup }. records: one keyed object per
  // data row (canonical UPPER_SNAKE keys, string values, serial date/time
  // columns normalized per TRAP 3). hasPlaLookup is derived from the detected
  // header keys — currently always false for this dialect (TRAP 2), but a
  // caller never has to probe record keys itself to learn the column is
  // missing (or, if a future pull adds it, that it's present).
  function parsePostSortRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return { headers: [], records: [], hasPlaLookup: false };

    const headerIdx = findHeaderRowIndex(list);
    const headerRow = list[headerIdx];
    // findHeaderRowIndex falls back to index 0 when nothing in the scan
    // window matches, including when row 0 itself is not a row of cells
    // (e.g. the caller handed us garbage instead of a parsed row grid). Throw
    // the same typed refusal a missing-column header gets, rather than
    // letting a bare TypeError escape the documented catch contract at this
    // drop-time refusal surface.
    if (!Array.isArray(headerRow)) {
      const err = new Error(
        'Post Sort report: could not locate a usable header row. ' +
        'Missing required column(s): ' + REQUIRED_COLUMNS.join(', ') + '.'
      );
      err.name = 'PostSortMissingColumnsError';
      err.missingColumns = REQUIRED_COLUMNS.slice();
      throw err;
    }
    const headers = headerRow.map(function (h) { return String(h == null ? '' : h).trim(); });
    const keys = headers.map(canonicalKey);

    const missing = REQUIRED_COLUMNS.filter(function (col) { return keys.indexOf(col) === -1; });
    if (missing.length) {
      const err = new Error(
        'Post Sort report is missing required column(s): ' + missing.join(', ') + '. ' +
        'FedEx likely renamed or dropped a header in the source file — add the new ' +
        'name to HEADER_ALIASES in lib/post-sort-scans.js, or re-check the export.'
      );
      err.name = 'PostSortMissingColumnsError';
      err.missingColumns = missing;
      throw err;
    }

    const trackingCol = keys.indexOf('PKG_LABEL_XREF');
    const dataRows = list.slice(headerIdx + 1);

    // TRAP 1 — refuse loudly the moment a mangled tracking number shows up,
    // rather than silently handing back a list keyed on lossy identifiers.
    for (let r = 0; r < dataRows.length; r++) {
      const row = dataRows[r];
      if (!Array.isArray(row)) continue;
      if (looksMangled(row[trackingCol])) {
        const err = new Error(
          'Post Sort report: PKG_LABEL_XREF is in scientific-notation shape (e.g. "' +
          row[trackingCol] + '"), which means this came from the CSV export — Excel ' +
          'mangles every tracking number in that dialect (0 of 2,467 clean in the ' +
          '2026-08-12 sample). Re-pull and drop the .xlsx export instead; never ' +
          'ingest the CSV for this report.'
        );
        err.name = 'PostSortMangledTrackingError';
        throw err;
      }
    }

    const records = dataRows.map(function (row) {
      const rec = Object.create(null);
      keys.forEach(function (key, i) {
        if (!key || rec[key] !== undefined) return; // first occurrence of a key wins
        const cell = row[i];
        const value = String(cell == null ? '' : cell).trim();
        rec[key] = SERIAL_DATE_COLUMNS.indexOf(key) !== -1 ? excelSerialToText(value) : value;
      });
      return rec;
    });

    // Derived, not hardcoded: PLA_LOOKUP is genuinely absent from every real
    // sample of this dialect (TRAP 2), but if a future pull ever adds it,
    // canonicalKey() passes it through untouched and this flag must track
    // that rather than lying that it's still missing.
    const hasPlaLookup = keys.indexOf('PLA_LOOKUP') !== -1;

    return { headers: headers, records: records, hasPlaLookup: hasPlaLookup };
  }

  // Thin CSV-only wrapper, mirroring lib/nvs-report.js's parseNvsReport. Note
  // that calling this on the report's real CSV export will throw
  // PostSortMangledTrackingError (TRAP 1) — that is the intended behavior,
  // not a bug in this wrapper.
  function parsePostSortReport(text) {
    return parsePostSortRows(parseCSV(String(text == null ? '' : text)));
  }

  return {
    parsePostSortReport: parsePostSortReport,
    parsePostSortRows: parsePostSortRows,
    headerKey: headerKey,
    canonicalKey: canonicalKey,
    findHeaderRowIndex: findHeaderRowIndex,
    HEADER_ALIASES: HEADER_ALIASES,
    REQUIRED_COLUMNS: REQUIRED_COLUMNS,
    SERIAL_DATE_COLUMNS: SERIAL_DATE_COLUMNS,
    excelSerialToText: excelSerialToText,
    looksMangled: looksMangled,
  };
});
