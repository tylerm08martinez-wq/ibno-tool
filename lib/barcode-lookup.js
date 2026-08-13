'use strict';

// Parser for the "Track IDs to Full Barcode" lookup report (issue #632,
// tracer bullet for #622). Logic only — no UI in this module.
//
// Report shape (measured 2026-08-12, see notes/report-registry.md's
// "Track IDs to Full Barcode" row for every measurement — read there, do
// not re-derive):
//   - Two columns only: TRKID, PKG_BARCODE. Header row 0, no preamble.
//   - UTF-8 BOM present. Without stripping it the first header cell reads
//     as "﻿TRKID" and the header signature silently fails to match,
//     yielding zero rows. lib/csv.js's parseCSV already strips the BOM, so
//     this module delegates to it rather than re-implementing CSV reading.
//   - The Ground-only sample measured every barcode at 34 chars with 100%
//     of them ending in their own TRKID. Tyler confirmed the same report
//     also covers Express, and real SCAN_BARCODE data carries 20/22/30/34
//     char families — so this module does NOT hard-code a barcode length.
//     The trailing-tracking-number rule is the integrity check; length is
//     not.
//   - 38 data rows / 37 distinct TRKIDs in the real sample: one TRKID
//     (875450837428) repeats with two DIFFERENT barcodes. A duplicate TRKID
//     with a consistent barcode is fine; a duplicate with conflicting
//     barcodes is a data problem this module surfaces rather than resolving
//     with last-write-wins.
//
// Dual-loadable with no build step:
// - Browser: window.BarcodeLookup
// - Node: require('./lib/barcode-lookup')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.BarcodeLookup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  function resolveCsvLib() {
    if (root && root.CsvLib && typeof root.CsvLib.parseCSV === 'function') return root.CsvLib;
    if (typeof require === 'function') return require('./csv');
    return null;
  }

  const CsvLib = resolveCsvLib();

  const HEADER_SIGNATURE = ['TRKID', 'PKG_BARCODE'];

  // findHeaderIndex(rows) -> index of the real header row (TRKID +
  // PKG_BARCODE both present). No match -> 0, matching the documented shape
  // (header row 0, no preamble) so a malformed file still tries row 0.
  function findHeaderIndex(rows) {
    if (!Array.isArray(rows)) return 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const cells = row.map(function (c) { return String(c == null ? '' : c).trim().toUpperCase(); });
      if (HEADER_SIGNATURE.every(function (sig) { return cells.indexOf(sig) !== -1; })) return i;
    }
    return 0;
  }

  // Integrity check: the barcode must end with its own tracking number AND
  // be strictly longer than it. Catches a misaligned join or a mismatched
  // paste, and also catches a bare tracking number reaching this join (e.g.
  // lib/ibno-rules.js falls back to scan.trackingId when both barcode
  // columns are blank) — without the length requirement, barcode === TRKID
  // would satisfy the trailing-match rule and pass as a "full barcode". Not
  // an absolute length check — see module comment; every measured barcode
  // family (20/22/30/34 chars) is longer than a 12-digit TRKID, so a
  // relative comparison holds without hard-coding a constant.
  function isValidPair(trackingId, barcode) {
    return !!trackingId && !!barcode &&
      barcode.length > trackingId.length &&
      barcode.slice(-trackingId.length) === trackingId;
  }

  // parseBarcodeLookup(text, options) -> {
  //   found: [{ trackingId, barcode }],   // every individually-valid pair,
  //                                       // duplicates included as-is
  //   invalid: [{ trackingId, barcode }], // pairs that failed the
  //                                       // trailing-tracking integrity
  //                                       // check, plus rows with a blank
  //                                       // TRKID but a present barcode
  //                                       // (a shifted-column/ragged row);
  //                                       // never kept in `found`
  //   conflicts: [{ trackingId, barcodes: [...] }], // TRKIDs whose valid
  //                                       // pairs disagree on the barcode
  //   unresolved: [trackingId, ...],      // requested TRKIDs with no
  //                                       // SINGLE valid barcode to hand
  //                                       // over (options.requested). This
  //                                       // includes conflicting TRKIDs —
  //                                       // no single barcode can be
  //                                       // resolved for them either — so a
  //                                       // conflicted id appears in BOTH
  //                                       // `unresolved` (no answer) and
  //                                       // `conflicts` (why). It is
  //                                       // computed before any early
  //                                       // return, so a file that failed
  //                                       // to read (empty/non-string
  //                                       // input, missing CsvLib,
  //                                       // unparseable content, or a
  //                                       // header mismatch) reports every
  //                                       // requested id as unresolved
  //                                       // rather than reporting zero
  //                                       // problems.
  //   reason: string|null,                // set on any early-return path
  //                                       // that produced an all-empty
  //                                       // result, so a caller can tell a
  //                                       // failed read from a clean miss
  //                                       // (empty file / wrong report /
  //                                       // CsvLib not loaded). null on a
  //                                       // normal parse.
  // }
  //
  // options.requested: optional array of tracking numbers the caller asked
  // this lookup to resolve. Ids are coerced with String(id).trim() (and
  // compared against trackingId values coerced the same way), so a numeric
  // id from a JSON store or JS-computed list still resolves correctly. When
  // given, any requested id with no single valid, non-conflicting barcode in
  // `found` is reported in `unresolved` as a first-class part of the
  // result, not an absence the caller has to infer.
  function parseBarcodeLookup(text, options) {
    const opts = options || {};
    const requested = Array.isArray(opts.requested)
      ? opts.requested.map(function (id) { return String(id).trim(); })
      : [];
    // Computed up front so every early return still reports the full
    // requested list as unresolved (finding: a failed read must not look
    // like zero problems).
    const result = { found: [], invalid: [], conflicts: [], unresolved: requested.slice(), reason: null };

    if (typeof text !== 'string' || !text) { result.reason = 'empty or non-string input'; return result; }
    if (!CsvLib) { result.reason = 'CsvLib not loaded'; return result; }

    const rows = CsvLib.parseCSV(text);
    if (!Array.isArray(rows) || rows.length === 0) { result.reason = 'unparseable input'; return result; }

    const headerIdx = findHeaderIndex(rows);
    const headerRow = rows[headerIdx];
    const headerCells = Array.isArray(headerRow)
      ? headerRow.map(function (c) { return String(c == null ? '' : c).trim().toUpperCase(); })
      : [];
    const headerFound = HEADER_SIGNATURE.every(function (sig) { return headerCells.indexOf(sig) !== -1; });
    if (!headerFound) { result.reason = 'header not found (wrong report?)'; return result; }

    const sliced = headerIdx > 0 ? rows.slice(headerIdx) : rows;
    if (sliced.length < 2) { result.reason = 'no data rows'; return result; }

    const get = CsvLib.columnGetter(sliced[0]);

    for (let r = 1; r < sliced.length; r++) {
      const row = sliced[r];
      if (!Array.isArray(row)) continue;
      const trackingId = get(row, 'TRKID');
      const barcode = get(row, 'PKG_BARCODE');
      if (!trackingId) {
        // A blank TRKID with a present barcode is a shifted-column/ragged
        // row, not nothing — surface it so found.length + invalid.length
        // still equals the data-row count.
        if (barcode) result.invalid.push({ trackingId: trackingId, barcode: barcode });
        continue;
      }

      if (isValidPair(trackingId, barcode)) {
        result.found.push({ trackingId: trackingId, barcode: barcode });
      } else {
        result.invalid.push({ trackingId: trackingId, barcode: barcode });
      }
    }

    // Group the valid pairs by trackingId to detect conflicting duplicates.
    // A duplicate with a consistent barcode is not a conflict; a duplicate
    // with disagreeing barcodes is surfaced, never last-write-wins.
    const barcodesById = new Map();
    result.found.forEach(function (rec) {
      if (!barcodesById.has(rec.trackingId)) barcodesById.set(rec.trackingId, []);
      const list = barcodesById.get(rec.trackingId);
      if (list.indexOf(rec.barcode) === -1) list.push(rec.barcode);
    });
    barcodesById.forEach(function (barcodes, trackingId) {
      if (barcodes.length > 1) {
        result.conflicts.push({ trackingId: trackingId, barcodes: barcodes });
      }
    });

    if (requested.length) {
      const conflictIds = new Set(result.conflicts.map(function (c) { return c.trackingId; }));
      const foundIds = new Set(
        result.found
          .map(function (rec) { return rec.trackingId; })
          .filter(function (id) { return !conflictIds.has(id); })
      );
      result.unresolved = requested.filter(function (id) { return !foundIds.has(id); });
    }

    return result;
  }

  // buildBarcodeMap(result) -> { trackingId: barcode } for every TRKID with
  // exactly one distinct valid barcode. Conflicting TRKIDs (see
  // result.conflicts) are excluded rather than resolved by last-write-wins
  // — a caller that needs those must consult result.conflicts explicitly.
  function buildBarcodeMap(result) {
    const map = Object.create(null);
    if (!result || !Array.isArray(result.found)) return map;

    const conflictIds = new Set((result.conflicts || []).map(function (c) { return c.trackingId; }));
    result.found.forEach(function (rec) {
      if (conflictIds.has(rec.trackingId)) return;
      map[rec.trackingId] = rec.barcode;
    });
    return map;
  }

  return {
    findHeaderIndex: findHeaderIndex,
    isValidPair: isValidPair,
    parseBarcodeLookup: parseBarcodeLookup,
    buildBarcodeMap: buildBarcodeMap,
  };
});
