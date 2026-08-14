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
  //   inboundDate, inboundDateRaw, ibScanTime, express, priorityPackage,
  //   statusCodes }]
  //
  // `statusCodes` is the Post Sort report's OWN STATUS_CODES column (#664
  // code review, finding 3), carried for exactly one purpose: it is the only
  // veto this lane has on the fresh-tail fallback code. A package that
  // already carries a QA scan code must never be offered another one, and on
  // a fresh-tail row there is no main report to say so — but this report
  // does, in a column that was being dropped on the floor here. NOT a
  // category, NOT a coding decision, and never fed to ReviewPlan: it is read
  // in exactly one place, applyEarlyCode's fallback branch below. The
  // "never carries a category/code/reason/disposition" guarantee this
  // function's own test pins is unchanged.
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
        statusCodes: str(r.STATUS_CODES),
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

  // buildMainReportDispositionMap(rows) ->
  //   { trackingId: { disposition, category, code, reason } }
  // Same `rows` contract as buildMainReportBarcodeMap (ibno-coder.html's
  // `lastRows`), delegating to lib/ibno-rules.js which owns the cascade AND
  // the entry shape (extended from a bare disposition string by #664 — read
  // mainReportDispositionMap's own header comment for what each field means
  // and why a skip row still reports a category).
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
  //   mainCategory, mainCode, mainReason — the rest of
  //                    IbnoRules.mainReportDispositionMap's entry (issue
  //                    #664), carried through verbatim as strings. Set only
  //                    when dispositionMap has an entry for this label, the
  //                    same way mainDisposition is. mainCode is carried for
  //                    completeness (an 'auto' row's literal code); the
  //                    early-code path below never reads it, because an
  //                    'auto' row is folded out of the lane by needsWork.
  //   mainKnown:       true when dispositionMap answered for this label AT
  //                    ALL (any of manual/auto/skip); the field is absent
  //                    otherwise. Stated as its OWN flag rather than left
  //                    implicit in mainDisposition being set, because
  //                    applyEarlyCode's whole rule turns on "did the main
  //                    report answer at all" — the fresh tail is defined by
  //                    the absence of an entry, not by any disposition value
  //                    — and reading that off a string field would make a
  //                    future empty/blank disposition silently look like the
  //                    fresh tail and hand the row a Work-Area-only code.
  //
  // The distinction between 'skip' and '' is the whole value of this join and
  // must never be collapsed: 'skip' is a real answer ("this package will
  // never be worked"), '' is the absence of one ("nobody knows yet"). Folding
  // '' away with 'skip' would hide precisely the packages the Post Sort lane
  // was built for.
  //
  // MERGE, NOT REPLACE, FOR THE FOLD — matching applyBarcodeLookup's own
  // contract directly above: a label the map says nothing about keeps whatever
  // mainDisposition a prior call resolved. The main report is re-dropped
  // repeatedly through a shift (job 1 recurs many times), and each drop
  // carries MORE packages than the last, so a later call must be able to fill
  // in a label an earlier one could not — but never to erase an answer by
  // going silent about it.
  //
  // REPLACE, NOT MERGE, FOR THE ATTRIBUTION (#664 code review, finding 2).
  // The four fields this ticket added are NOT part of that merge: when this
  // call's map has no entry for a label, mainKnown/mainCategory/mainCode/
  // mainReason are CLEARED. The two contracts differ because they answer
  // different questions. The fold asks "has any report ever said this row is
  // done", where forgetting costs Tyler a package. Attribution asks "does the
  // report loaded RIGHT NOW back the code and the 'from main report' label on
  // screen", where remembering is the failure: a discarded report's answer
  // would keep a code on screen with no marker beside it, which is exactly
  // the claim the 'no PLA' marker exists to make trustworthy. Clearing
  // demotes such a row back to the fresh-tail treatment (marked, or no code
  // at all), which is always the safe direction.
  //
  // NEVER a coding decision itself. This orders and folds the VIEW and (since
  // #664) carries the main report's own classification text through for
  // applyEarlyCode to read — it still writes no code and does not touch Goes
  // To. The lane's "never offers a QA Scan Code" guarantee is unchanged,
  // which is why this stays a separate function from applyBarcodeLookup
  // rather than another field smuggled into it.
  //
  // EXPECT ZERO 'auto' ROWS, and do not treat that as a broken join. Measured
  // on the real 2026-08-13 mid-sort pair: 117 manual, 2,583 skip, 168
  // unknown, and 0 auto. Tyler explained it the same day — the Post Sort
  // report FILTERS auto-code-eligible packages out — and the report's own
  // preamble corroborates it, excluding Hold to Match (the auto-94 rule) and
  // a list of reconciliation status codes that covers the rest (Misload ->
  // 65, Closure Portal -> 11/59, Unassigned Zip / Preload SWAK -> 65). So on
  // THIS report the manual/skip split is the whole story. A non-zero auto
  // count means the report's population changed, not that the code is
  // working better. needsWork still handles 'auto' because this function's
  // contract is the disposition vocabulary, not one report's sample of it.
  function applyDisposition(items, dispositionMap) {
    const list = Array.isArray(items) ? items : [];
    const map = (dispositionMap && typeof dispositionMap === 'object') ? dispositionMap : Object.create(null);
    return list.map(function (it) {
      const label = it && it.label;
      const entry = map[label];
      if (!entry) {
        // Fold answer merges (untouched); attribution is cleared, per the
        // two contracts above.
        return Object.assign({}, it, {
          mainKnown: false, mainCategory: '', mainCode: '', mainReason: '',
        });
      }
      return Object.assign({}, it, {
        mainDisposition: str(entry.disposition),
        mainCategory: str(entry.category),
        mainCode: str(entry.code),
        mainReason: str(entry.reason),
        mainKnown: true,
      });
    });
  }

  // applyEarlyCode(items) -> a NEW array (items never mutated), each item
  // spread with:
  //   category:       the main report's real category when it has already
  //                    classified this label 'manual', '' otherwise.
  //   reason:          the main report's real reason string when 'manual'
  //                    (feeds lib/ibno-review-plan.js's offeredCode/bucketOf
  //                    exactly like any other Manual Review row — same
  //                    cascade-derived text, no second code-decision rule
  //                    written here), reconciled against this row's own Work
  //                    Area by reasonFor() below; OR, for a label the main
  //                    report has NEVER SEEN (the fresh tail) whose OWN Work
  //                    Area is flagged, a synthesized 'Work area: N' reason so
  //                    the SAME flagged-Work-Area rule ReviewPlan already
  //                    knows still offers 33; OR, for a row the current map
  //                    answered non-manually, a plain statement of what the
  //                    main report concluded. '' only when nothing at all is
  //                    known and the work area is unflagged.
  //   plaArbitrated:   true when category/reason came from the main report's
  //                    own classification; false when reason came from the
  //                    flagged-Work-Area fallback alone, with no PLA_LOOKUP
  //                    behind it. THIS is the only guard telling a caller
  //                    apart a code the main report actually confirmed from
  //                    one guessed off Work Area alone — Tyler's 2026-08-13
  //                    decision keeps the fallback, on the condition that a
  //                    caller can always tell the two apart (the 'no PLA'
  //                    marker ibno-coder.html renders from this flag).
  //
  // Two-branch rule (issue #664, decided against a recommendation to drop the
  // fallback):
  //   1. The CURRENT map classified this label 'manual' — use ITS
  //      category/reason. Covers 117 of 285 working rows on the real mid-sort
  //      pull, 91 of those 94 in a flagged Work Area (measured 2026-08-13).
  //      With one correction (#664 review, finding 4): the main report's
  //      reason names the Work Area the MAIN report saw, and this row renders
  //      the Post Sort report's own IB_WORK_AREA. On a re-inducted package
  //      those disagree, and the flagged-area code must follow where the
  //      package IS NOW, not where an older scan found it — see reasonFor().
  //   2. The current map answered with a non-manual disposition (auto/skip) —
  //      classified, never the fallback, and never a code: the package is
  //      already coded, already van-scanned, delivered, or auto-coded. Its
  //      category is carried for DISPLAY only (finding 5) and deliberately
  //      never fed to ReviewPlan, which would offer 65 off an 'Unassigned
  //      Zip' category alone on a package that is already done.
  //   3. The current map has no answer — the fresh tail. Apply the flagged
  //      Work Area rule directly against the row's OWN ibWork with no
  //      PLA_LOOKUP to arbitrate it (3 of 2,868 rows on the real pull: Work
  //      Areas 300, 302, 999), UNLESS this report's own STATUS_CODES column
  //      already shows a QA scan code on the package (#664 review, finding
  //      3). That veto is not the accepted QA-Intercept risk: the data is
  //      present in the report Tyler already dropped, so offering a duplicate
  //      code over the top of it is a plain defect, not a known blind spot.
  //
  // A disposition outside the known vocabulary ('' / anything unrecognized)
  // falls to branch 3, the MARKED direction (#664 review, finding 9). Never
  // the reverse: an unrecognized answer must not read as report-arbitrated.
  //
  // NOT a third walk over the main report: reads only what applyDisposition
  // already folded onto each item from IbnoRules.mainReportDispositionMap.
  // NOT a change to the coding cascade: decideCode/decideCodeInner in
  // lib/ibno-rules.js are never called here — flagged-Work-Area detection
  // reuses IbnoRules.isWorkAreaFlagged, the exact same check the cascade
  // itself uses, so this can never disagree with it on what counts as
  // flagged.
  function applyEarlyCode(items) {
    const IbnoRules = resolveIbnoRules();
    const list = Array.isArray(items) ? items : [];
    const flaggedArea = function (ibWork) {
      return IbnoRules ? IbnoRules.isWorkAreaFlagged(ibWork) : false;
    };

    // The main report's reason, reconciled against the Work Area THIS row
    // renders (#664 review, finding 4). The only reason text that carries a
    // code is the cascade's flagged-work-area phrasing, and it names the area
    // the main report saw. A re-inducted package moves: the Post Sort report
    // is the newer scan, and the Work Area cell, the reason pill and the lane
    // split all read the Post Sort value, so leaving the main report's area in
    // the reason lets the row show a 33 while every other cell on it says the
    // package is somewhere the 33 does not apply to.
    //
    //   - reasons that are not the work-area phrasing: passed through
    //     untouched (they carry no code, so there is nothing to reconcile).
    //   - the areas agree: untouched.
    //   - they disagree and THIS row's area is flagged too: restate the
    //     reason with this row's own area, so the pill matches the cell and
    //     the 33 is the one this row's area earns.
    //   - they disagree and this row's area is NOT flagged: the area rule
    //     does not hold where the package is now, so no code is offered. The
    //     text says both areas plainly rather than silently dropping the main
    //     report's finding, and deliberately avoids the 'Work area:' phrasing
    //     ReviewPlan.offeredCode keys on.
    const AREA_REASON = /^Work area:\s*(.+)$/i;
    function reasonFor(it) {
      const reason = str(it && it.mainReason);
      const rowArea = str(it && it.ibWork);
      const m = AREA_REASON.exec(reason);
      if (!m) return reason;
      const mainArea = str(m[1]);
      if (!rowArea || mainArea === rowArea) return reason;
      if (flaggedArea(rowArea)) return 'Work area: ' + rowArea;
      return 'Reinducted — the main report flagged work area ' + mainArea +
        ', this scan is in ' + rowArea;
    }

    return list.map(function (it) {
      const known = !!(it && it.mainKnown);
      const disposition = str(it && it.mainDisposition);
      if (known && disposition === 'manual') {
        return Object.assign({}, it, {
          category: str(it.mainCategory),
          reason: reasonFor(it),
          plaArbitrated: true,
        });
      }
      if (known && (disposition === 'auto' || disposition === 'skip')) {
        // The current map answered, just not 'manual'. Folded out of the lane
        // by needsWork, so this only ever renders under Show all — and there
        // it must say what the main report actually concluded rather than the
        // canned "awaiting" placeholder (finding 5). mainCategory is rendered
        // as inert text by the caller; `category` stays EMPTY so no code can
        // be derived from it for a package that is already done.
        return Object.assign({}, it, {
          category: '',
          reason: disposition === 'auto'
            ? 'Main report: auto-coded, nothing to work here'
            : 'Main report: already answered, nothing to work here',
          plaArbitrated: true,
        });
      }
      // Fresh tail (or an unrecognized disposition — the marked direction).
      const ibWork = str(it && it.ibWork);
      // The report's own STATUS_CODES veto: a package already carrying a QA
      // scan code is never offered another one. Read from the Post Sort row
      // itself, so it works with no main report loaded at all — which is the
      // only situation this branch runs in.
      const alreadyCoded = str(it && it.statusCodes) !== '';
      const offerArea = !alreadyCoded && flaggedArea(ibWork);
      return Object.assign({}, it, {
        category: '',
        reason: offerArea ? ('Work area: ' + ibWork)
          : (alreadyCoded ? 'Already carries a QA scan code on this report' : ''),
        plaArbitrated: false,
      });
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

  // flaggedLookupBatch(items) -> [label, ...] — the one-click paste batch for
  // the Track IDs to Full Barcode lookup: the tracking numbers for THIS
  // lane's rows that are (a) in a flagged work area, (b) still needing work,
  // and (c) still without a scannable barcode. ibno-coder.html's
  // "Copy flagged-area tracking #s" button copies exactly this list, so Tyler
  // no longer checks rows by hand to build the lookup paste.
  //
  // Each filter reuses an existing decision rather than inventing a new one:
  //   - Flagged area: IbnoRules.isWorkAreaFlagged, the SAME rule the main
  //     report's express lane uses (lib/ibno-rules.js) — including its
  //     "CLOSED - NNN is not a work area" trap handling — so a row is in this
  //     batch iff the same package would be Tyler's on the full report.
  //   - Still needing work: needsWork above — a row the loaded main report
  //     already calls 'skip' will never be worked, so its tracking number
  //     does not belong in the paste. Unknown ('') resolves toward INCLUDED,
  //     same as needsWork resolves toward showing the row.
  //   - No barcode yet: a row already resolved (barcodeSource 'main' or
  //     'lookup') needs no lookup round-trip — the same exclusion
  //     copySelectedPostSort already applies in tracking mode for tier 1,
  //     generalized here to tier 2 as well.
  //   - Not a conflict: barcodeConflict rows have TWO disagreeing barcodes in
  //     the lookup already; re-pasting the same TRKID returns the same
  //     conflict. They need manual resolution, not another round-trip.
  //
  // Labels are de-duplicated: a repeated tracking number in the report pastes
  // into the lookup once. When IbnoRules is not loadable the batch is EMPTY
  // (fail quiet toward copying nothing, never toward copying everything).
  function flaggedLookupBatch(items) {
    const IbnoRules = resolveIbnoRules();
    const isFlagged = IbnoRules && typeof IbnoRules.isWorkAreaFlagged === 'function'
      ? IbnoRules.isWorkAreaFlagged
      : function () { return false; };
    const list = Array.isArray(items) ? items : [];
    const seen = new Set();
    const out = [];
    list.forEach(function (it) {
      if (!it || !isFlagged(it.ibWork)) return;
      if (!needsWork(it)) return;
      if (str(it.barcode)) return;
      if (it.barcodeConflict) return;
      if (seen.has(it.label)) return;
      seen.add(it.label);
      out.push(it.label);
    });
    return out;
  }

  return {
    buildPostSortLane: buildPostSortLane,
    buildMainReportBarcodeMap: buildMainReportBarcodeMap,
    buildMainReportDispositionMap: buildMainReportDispositionMap,
    applyBarcodeLookup: applyBarcodeLookup,
    applyDisposition: applyDisposition,
    applyEarlyCode: applyEarlyCode,
    needsWork: needsWork,
    flaggedLookupBatch: flaggedLookupBatch,
  };
});
