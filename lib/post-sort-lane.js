'use strict';

// Builds the Post Sort "early" lane's row items from parsed Post Sort report
// records (lib/post-sort-scans.js), for issue #634 (third slice of #622).
//
// Dual-loadable with no build step:
// - Browser: window.PostSortLane
// - Node: require('./lib/post-sort-lane')
//
// WHAT THIS OWNS: turning one Post Sort record into the flat item shape
// ibno-coder.html's shared row helpers already expect — the same field names
// lib/ibno-rules.js's readFields() uses (label, address, postal, firm, ibWork,
// inboundDate, ibScanTime) — so this lane reuses zipOf/ispOf/streetOf/
// ActualArea directly instead of forking a second copy of that plumbing.
//
// WHAT THIS DOES NOT OWN, DELIBERATELY: no QA Scan Code, category, or
// disposition. `PLA_LOOKUP` is genuinely absent from this report (see
// lib/post-sort-scans.js TRAP 2 and notes/report-registry.md's Post Sort
// row), so the classifier in lib/ibno-rules.js cannot tell a QA-Intercept, an
// Invalid HazMat, a Closure Portal, or a Hold to Match package from an
// ordinary one on this report. This module never calls IbnoRules.decideCode
// or lib/ibno-review-plan.js's rowPlan/offeredCode — offering a code on a
// guess is this repo's worst bug class (#602/#618). A caller gets rows and an
// address to pre-fill Goes To with; nothing here proposes a code.
//
// UPDATE (#649): this lane is no longer barcode-independent of the main
// report. IBNO Coder already loads Inbound and Van Scans, which carries
// SCAN_BARCODE — the exact string barcode-mode copy exists to reproduce, and
// measured to cover 96% of a real same-day Post Sort pull. buildMainReportBarcodeMap
// below reads that already-loaded report's FULL RAW ROW SET (ibno-coder.html's
// `lastRows` — every row the report parsed to, independent of whatever coding
// disposition lib/ibno-rules.js gave it) via lib/ibno-rules.js's own
// findHeaderIndex/columnGetter path, and applyBarcodeLookup's mainReportMap
// parameter lets it arbitrate over the Track IDs to Full Barcode lookup. This
// is still barcode resolution only — no code, category, or disposition
// crosses from the main report into this lane; the "no QA Scan Code"
// guarantee above is unchanged.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PostSortLane = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // toIsoDate is a pure, records-tier-safe read: this module does not modify
  // lib/ibno-rules.js, it only reuses its existing US/ISO date normalizer so
  // downstream sort/display code sees one date shape regardless of which
  // report a row came from.
  function resolveIbnoRules() {
    if (root && root.IbnoRules) return root.IbnoRules;
    if (typeof require !== 'undefined') {
      try { return require('./ibno-rules'); } catch (e) { /* fall through */ }
    }
    return null;
  }

  // resolveBarcodeLookup: same dual-load pattern as resolveIbnoRules, for the
  // "Track IDs to Full Barcode" lookup parser (issue #632). This module never
  // parses the lookup CSV itself — it only consumes an already-parsed result
  // (BarcodeLookup.parseBarcodeLookup's return shape) via applyBarcodeLookup
  // below, so this resolver exists only to reach buildBarcodeMap.
  function resolveBarcodeLookup() {
    if (root && root.BarcodeLookup) return root.BarcodeLookup;
    if (typeof require !== 'undefined') {
      try { return require('./barcode-lookup'); } catch (e) { /* fall through */ }
    }
    return null;
  }

  function str(v) {
    return String(v == null ? '' : v).trim();
  }

  // buildPostSortLane(records) -> [{ label, address, postal, firm, ibWork,
  //   inboundDate, inboundDateRaw, ibScanTime, express, priorityPackage }]
  //
  // `records` is parsePostSortRows(...).records — canonical UPPER_SNAKE keys,
  // already normalized (dates/times as text per TRAP 3). Rows with no
  // tracking number are dropped rather than rendered with a blank identity.
  function buildPostSortLane(records) {
    const IbnoRules = resolveIbnoRules();
    const list = Array.isArray(records) ? records : [];
    const out = [];
    list.forEach(function (rec) {
      const r = rec || {};
      const label = str(r.PKG_LABEL_XREF);
      if (!label) return;
      const addr1 = str(r.LABEL_ADDRESS1);
      const addr2 = str(r.LABEL_ADDRESS2);
      const city = str(r.LABEL_CITY);
      const state = str(r.LABEL_STATE);
      const postal = str(r.POSTAL_CODE);
      const address = [addr1, addr2].filter(Boolean).join(' ') +
        (city ? ', ' + city : '') +
        (state ? ', ' + state : '') +
        (postal ? ' ' + postal : '');
      const inboundDateRaw = str(r.INBOUND_DATE);
      out.push({
        label: label,
        address: address,
        postal: postal,
        firm: str(r.LABEL_FIRM_NAME),
        ibWork: str(r.IB_WORK_AREA),
        inboundDateRaw: inboundDateRaw,
        inboundDate: IbnoRules ? IbnoRules.toIsoDate(inboundDateRaw) : inboundDateRaw,
        ibScanTime: str(r.IB_SCAN_TIME),
        express: str(r.EXPRESS_TRACK),
        priorityPackage: str(r.PRIORITY_PACKAGE),
      });
    });
    return out;
  }

  // buildMainReportBarcodeMap(rows) -> { trackingId: SCAN_BARCODE } (#649).
  //
  // CORRECTED CONTRACT (PR #650 code review — confirmed blocking with real
  // data): `rows` is the FULL RAW PARSED main report — in ibno-coder.html
  // that is `lastRows`, the same array IbnoSession.applyRows/IbnoRules.
  // processRows consume, NOT autoItems/manualItems/resolvedItems. The first
  // version of this function read those dispositioned items instead, and on
  // a real 30,343-row Inbound and Van Scans pull that undercounted tier 1 by
  // roughly two orders of magnitude (2 of 56 Post Sort rows resolved instead
  // of 54 of 56) — most rows on a real pull are skip-disposition (already
  // QA-coded, already van-scanned, delivered) and never become an item at
  // all, but they still carry a perfectly good SCAN_BARCODE. Disposition is
  // a CODING answer (does this package need review); it has nothing to do
  // with whether the report holds a barcode for it.
  //
  // Delegates entirely to lib/ibno-rules.js's mainReportScanBarcodeMap,
  // which owns the findHeaderIndex/columnGetter handling for this report
  // shape already (processRows uses the exact same path) — this module does
  // not re-derive header/preamble parsing.
  function buildMainReportBarcodeMap(rows) {
    const IbnoRules = resolveIbnoRules();
    return IbnoRules ? IbnoRules.mainReportScanBarcodeMap(rows) : Object.create(null);
  }

  // applyBarcodeLookup(items, lookupResult, mainReportMap) -> a NEW array
  // (items is never mutated), each item spread with:
  //   barcode:         the resolved full scan barcode for item.label, or ''
  //   barcodeConflict: true when the lookup returned MULTIPLE different
  //                    barcodes for item.label (see lib/barcode-lookup.js's
  //                    `conflicts`) — never resolved by last-write-wins,
  //                    UNLESS a main-report SCAN_BARCODE answers it (below).
  //   barcodeSource:   'main' | 'lookup' | '' — which tier resolved this
  //                    label, so a caller (ibno-coder.html's "copy tracking
  //                    numbers for the lookup" batch) can tell a row that
  //                    needs no further lookup round-trip from one that does.
  //
  // Three-tier resolution (issue #649, follow-up to #635/#634 — read
  // notes/report-registry.md rows 13-14 and issue #649 for the measurements
  // this design rests on):
  //   1. SCAN_BARCODE from the already-loaded main report (mainReportMap)
  //      WINS OUTRIGHT. No lookup round-trip, no shape guessing
  //      (lib/barcode-lookup.js's trailing-tracking rule is not even
  //      consulted for a label mainReportMap answers).
  //   2. The Track IDs to Full Barcode lookup (lookupResult) covers only the
  //      fresh tail — rows mainReportMap has no answer for. This is exactly
  //      the pre-#649 behavior, unchanged for those rows.
  //   3. When both exist, SCAN_BARCODE arbitrates: mainReportMap is checked
  //      FIRST, before any lookup/conflict logic runs, so a label present in
  //      BOTH tiers always resolves to the main report's answer — silently
  //      correcting a wrong lookup candidate and resolving a lookup conflict
  //      for that label (a conflict with a SCAN_BARCODE present is answered,
  //      not a conflict — the #649 acceptance criterion).
  //
  // `mainReportMap` is optional (buildMainReportBarcodeMap's return shape, or
  // omit/pass {} to disable tier 1 entirely) — every existing caller and test
  // that calls applyBarcodeLookup(items, lookupResult) with two arguments
  // keeps its pre-#649 behavior unchanged, since an absent mainReportMap
  // never matches any label.
  //
  // For issue #635 (final slice of #622): closes the loop lib/post-sort-lane.js
  // opened in #634. `lookupResult` is the return value of
  // BarcodeLookup.parseBarcodeLookup(csvText, { requested }) — this module
  // does not parse the CSV itself, it only joins an already-parsed result onto
  // the lane's rows by tracking number (item.label === TRKID). `lookupResult`
  // may also be null/omitted (ibno-coder.html does this right after a Post
  // Sort report loads, and again whenever the main report changes) to apply
  // ONLY tier 1 — no lookup file has necessarily been dropped yet.
  //
  // GUARDRAIL (the reason this ticket exists): buildBarcodeMap already
  // excludes conflicting TRKIDs, so a conflicted label's `barcode` here is ''
  // — this function NEVER guesses between two disagreeing barcodes UNLESS a
  // main-report SCAN_BARCODE answers it (tier 3 above). A caller must treat
  // '' + barcodeConflict:true as "awaiting manual resolution", not "no data
  // yet" (see !hasBarcode && !isConflict below for that distinction). This
  // also means NO fallback to item.label (the tracking number) the way
  // lib/ibno-rules.js:225 falls back to trackingId for the current report —
  // that fallback exists so a barcode-mode copy is never empty, reasoning
  // that does NOT hold here: PKG_LABEL_XREF-shaped fallbacks on THIS report
  // are 9-11 chars and do not scan (see notes/report-registry.md). A caller
  // (ibno-coder.html's Copy-as toggle) must emit nothing for an unresolved
  // row in barcode mode, not the tracking number.
  //
  // MERGE, NOT REPLACE (Tyler feeds the lookup a TARGETED batch, not a
  // full-report join — notes/report-registry.md's "Track IDs to Full Barcode"
  // row): a label this lookupResult says nothing about (not requested, or
  // absent from the file) AND that mainReportMap does not answer either keeps
  // whatever barcode/barcodeConflict/barcodeSource a PRIOR call already
  // resolved for it. Calling this repeatedly across several small batches
  // through a shift must accumulate, never erase an earlier batch's answer.
  // A label either tier DOES have an opinion about always takes the new
  // opinion — newer evidence about the SAME label is allowed to overwrite,
  // only silence about a label is not.
  function applyBarcodeLookup(items, lookupResult, mainReportMap) {
    const list = Array.isArray(items) ? items : [];
    const mainMap = (mainReportMap && typeof mainReportMap === 'object') ? mainReportMap : Object.create(null);
    const BarcodeLookup = resolveBarcodeLookup();
    const map = BarcodeLookup ? BarcodeLookup.buildBarcodeMap(lookupResult) : Object.create(null);
    const conflictIds = new Set(
      (lookupResult && Array.isArray(lookupResult.conflicts) ? lookupResult.conflicts : [])
        .map(function (c) { return c.trackingId; })
    );
    // unresolvedIds: every label this CALL explicitly asked the lookup about
    // and got no single clean answer for (options.requested on the
    // parseBarcodeLookup call that produced lookupResult) — includes
    // conflicting labels too, per lib/barcode-lookup.js's own contract. A
    // label in here gets barcode explicitly set to '' (not left untouched),
    // because this batch DID investigate it and came back empty — distinct
    // from a label this batch never asked about at all (see wasAsked below).
    const unresolvedIds = new Set(
      lookupResult && Array.isArray(lookupResult.unresolved) ? lookupResult.unresolved : []
    );
    return list.map(function (it) {
      const label = it && it.label;

      // Tier 1 + tier 3: checked FIRST, before any lookup/conflict logic, so
      // a main-report SCAN_BARCODE always wins and always resolves a
      // conflict for this label — never last-write-wins between the two
      // tiers, because there is no "last write" here: main always wins.
      const mainBarcode = str(mainMap[label]);
      if (mainBarcode) {
        return Object.assign({}, it, {
          barcode: mainBarcode,
          barcodeConflict: false,
          barcodeSource: 'main',
        });
      }

      const hasBarcode = Object.prototype.hasOwnProperty.call(map, label);
      const isConflict = conflictIds.has(label);
      // conflictIds is computed unconditionally by lib/barcode-lookup.js
      // (grouped straight from `found`, never gated on options.requested), so
      // a conflicting label must count as "asked" even when the caller never
      // passed `requested` at all — otherwise a genuine conflict silently
      // vanishes instead of being surfaced (issue #635 code review finding
      // 3): hasBarcode is false (buildBarcodeMap excludes conflicts) and
      // unresolvedIds is empty (default requested: []), so without this the
      // conflict was dropped on the floor, contradicting this function's own
      // doc comment above.
      const wasAsked = hasBarcode || isConflict || unresolvedIds.has(label);
      if (!wasAsked) return Object.assign({}, it);
      return Object.assign({}, it, {
        barcode: hasBarcode ? map[label] : '',
        barcodeConflict: isConflict,
        barcodeSource: hasBarcode ? 'lookup' : '',
      });
    });
  }

  // buildMainReportDispositionMap(rows) -> { trackingId: 'manual'|'auto'|'skip' }
  // Same `rows` contract as buildMainReportBarcodeMap (ibno-coder.html's
  // `lastRows`), delegating to lib/ibno-rules.js which owns the cascade.
  function buildMainReportDispositionMap(rows) {
    const IbnoRules = resolveIbnoRules();
    return IbnoRules && typeof IbnoRules.mainReportDispositionMap === 'function'
      ? IbnoRules.mainReportDispositionMap(rows)
      : Object.create(null);
  }

  // applyDisposition(items, dispositionMap) -> a NEW array (items never
  // mutated), each item spread with:
  //   mainDisposition: 'manual' | 'auto' | 'skip' | '' — what the ALREADY
  //                    LOADED main report says about this package. '' means
  //                    the main report has not seen it yet, which on a real
  //                    mid-sort pull is 5.9% of the lane and is exactly the
  //                    fresh tail this lane exists to work ahead of.
  //
  // The distinction between 'skip' and '' is the whole value of this join and
  // must never be collapsed: 'skip' is a real answer ("this package will
  // never be worked"), '' is the absence of one ("nobody knows yet"). Folding
  // '' away with 'skip' would hide precisely the packages the Post Sort lane
  // was built for.
  //
  // MERGE, NOT REPLACE, matching applyBarcodeLookup's own contract directly
  // above: a label the map says nothing about keeps whatever mainDisposition
  // a prior call resolved. The main report is re-dropped repeatedly through a
  // shift (job 1 recurs many times), and each drop carries MORE packages than
  // the last, so a later call must be able to fill in a label an earlier one
  // could not — but never to erase an answer by going silent about it.
  //
  // NEVER a coding decision. This orders and folds the VIEW. It writes no
  // code, offers none, and does not touch Goes To. The lane's "never offers a
  // QA Scan Code" guarantee is unchanged, which is why this is a separate
  // function from applyBarcodeLookup rather than another field smuggled into
  // it.
  function applyDisposition(items, dispositionMap) {
    const list = Array.isArray(items) ? items : [];
    const map = (dispositionMap && typeof dispositionMap === 'object') ? dispositionMap : Object.create(null);
    return list.map(function (it) {
      const label = it && it.label;
      const d = str(map[label]);
      if (!d) return Object.assign({}, it);
      return Object.assign({}, it, { mainDisposition: d });
    });
  }

  // needsWork(item) -> does this row still need Tyler's eyes?
  //
  // TRUE for 'manual' (the main report says work it) and for '' (the main
  // report has not seen it, so nobody can say). FALSE only for a POSITIVE
  // answer that it will not be worked. Unknown resolves toward showing the
  // row, because the cost of hiding a package that needed working is a
  // package that does not get worked, and the cost of showing one that did
  // not is one extra row.
  function needsWork(item) {
    const d = str(item && item.mainDisposition);
    return d !== 'skip' && d !== 'auto';
  }

  return {
    buildPostSortLane: buildPostSortLane,
    buildMainReportBarcodeMap: buildMainReportBarcodeMap,
    buildMainReportDispositionMap: buildMainReportDispositionMap,
    applyBarcodeLookup: applyBarcodeLookup,
    applyDisposition: applyDisposition,
    needsWork: needsWork,
  };
});
