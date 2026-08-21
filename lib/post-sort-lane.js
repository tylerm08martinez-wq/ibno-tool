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

  // resolveSortDay: same dual-load pattern again, for THE sort-day clock
  // (lib/sort-day.js, #695 / decision record #621). The early-lane snapshot
  // is day-scoped, and "which day" is a question only INBOUND_DATE can answer
  // — see snapshotEarly below for why the device clock is the wrong one.
  function resolveSortDay() {
    if (root && root.SortDay) return root.SortDay;
    if (typeof require !== 'undefined') {
      try { return require('./sort-day'); } catch (e) { /* fall through */ }
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
          barcodeAsked: false, // answered — clears any earlier "asked and came back empty"
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
        // barcodeAsked (issue #666 review finding 2): THE record that a batch
        // genuinely investigated this label and came back with nothing usable
        // — the terminal state. barcode:'' + barcodeSource:'' was already the
        // shape of "never asked", so without this flag the two are
        // indistinguishable and an unanswerable row is re-sent in every batch
        // forever, and the batch index stalls because that row never counts as
        // done. Set false on a resolution so a later batch that DOES answer
        // (or a main-report SCAN_BARCODE, above) retires the state.
        //
        // Two sub-states share it, told apart by barcodeConflict:
        //   conflict true  — the file holds two disagreeing barcodes; needs a
        //                    human, per this function's own doc comment.
        //   conflict false — the file was asked and simply has no answer.
        // Both are "asked, unanswerable"; neither is "no data yet".
        barcodeAsked: !hasBarcode,
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
  //   mainCategory, mainCode, mainReason — the rest of
  //                    IbnoRules.mainReportDispositionMap's entry (issue
  //                    #664), carried through verbatim as strings. '' when
  //                    dispositionMap has no entry for this label, exactly
  //                    like mainDisposition.
  //   mainKnown:       true when dispositionMap answered for this label AT
  //                    ALL (any of manual/auto/skip), false/absent otherwise.
  //                    A SEPARATE flag from mainDisposition being '' —
  //                    mainDisposition is also '' for a genuine 'skip' entry
  //                    read through str() on an empty string would be
  //                    indistinguishable from "no entry" if this flag did not
  //                    exist. applyEarlyCode below is the reason this is
  //                    here: it must tell "the main report answered, just not
  //                    manual" from "the main report has never seen this
  //                    label" apart, and mainDisposition alone cannot.
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
      if (!entry) return Object.assign({}, it);
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
  //                    written here); OR, for a label the main report has
  //                    NEVER SEEN (the fresh tail) whose OWN Work Area is
  //                    flagged, a synthesized 'Work area: N' reason so the
  //                    SAME flagged-Work-Area rule ReviewPlan already knows
  //                    still offers 33. '' when neither applies (main report
  //                    silent AND work area unflagged — no code, per #664).
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
  //   1. mainKnown && mainDisposition === 'manual' — the main report has
  //      already classified this label. Use ITS category/reason verbatim.
  //      Covers 117 of 285 working rows on the real mid-sort pull, 91 of
  //      those 94 in a flagged Work Area (measured 2026-08-13).
  //   2. Anything else (mainKnown false — the fresh tail — OR mainKnown true
  //      with a non-manual disposition, which never renders as a visible row
  //      anyway per needsWork) — apply the flagged Work Area rule directly
  //      against the row's OWN ibWork, with no PLA_LOOKUP to arbitrate it (3
  //      of 2,868 rows on the real pull: Work Areas 300, 302, 999).
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
    return list.map(function (it) {
      const known = !!(it && it.mainKnown);
      if (known && it.mainDisposition === 'manual') {
        return Object.assign({}, it, {
          category: it.mainCategory || '',
          reason: it.mainReason || '',
          plaArbitrated: true,
        });
      }
      if (known) {
        // The main report answered, just not 'manual' (auto/skip) — never a
        // visible row per needsWork, but still classified by the main
        // report, so this is not the "no PLA" fallback path either. No code
        // offered either way (no 'Work area:' reason set).
        return Object.assign({}, it, { category: '', reason: '', plaArbitrated: true });
      }
      const ibWork = it && it.ibWork;
      const flagged = IbnoRules ? IbnoRules.isWorkAreaFlagged(ibWork) : false;
      return Object.assign({}, it, {
        category: '',
        reason: flagged ? ('Work area: ' + ibWork) : '',
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

  // ─── ISSUE #666: 300-ROW AUTO-COPY BATCH SELECTION ────────────────────────
  //
  // Tyler's lookup loop is: copy tracking numbers -> paste into Track IDs to
  // Full Barcode -> drop the result back in. This picks WHICH tracking numbers
  // go on the clipboard each time. All of it lives here rather than in
  // ibno-coder.html because every part of it is pure (filter, order, cap,
  // index accounting) and every part of it is a place a wrong answer is
  // invisible on screen: the batch is a paste into another system, so a bad
  // batch is only discovered by the lookup coming back wrong.
  //
  // 300 is Tyler's real batch size for the lookup.
  const BARCODE_BATCH_SIZE = 300;

  // normalizeClock('7:45') / ('11:20') / ('5:10 AM') -> 'HH:MM:SS', so times
  // within one day compare as strings. The raw values are UNPADDED
  // (lib/post-sort-scans.js's excelSerialToText emits '8/12/2026 7:45', and the
  // CSV dialect carries the same shape), which is exactly why a plain string
  // sort gets this backwards: '11:20' < '7:45'. Oldest-first is the whole
  // point of the ordering, so getting it backwards silently works the
  // shortest-waiting packages first.
  //
  // An unreadable time returns '~' — greater than every digit, so a row with
  // no usable clock sorts LAST within its day rather than jumping the queue.
  function normalizeClock(t) {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/.exec(str(t));
    if (!m) return '~';
    let h = parseInt(m[1], 10);
    const mer = (m[4] || '').toUpperCase();
    if (mer === 'PM' && h < 12) h += 12;
    if (mer === 'AM' && h === 12) h = 0;
    return (h < 10 ? '0' : '') + h + ':' + m[2] + ':' + (m[3] || '00');
  }

  // scanOrderKey(item) -> a sortable 'YYYY-MM-DDTHH:MM:SS' for "oldest inbound
  // scan first". Prefers ibScanTime (the actual scan instant), falling back to
  // inboundDate when the time column is blank or unparseable. A row with
  // neither returns '￿', sorting after every dated row — an undated row
  // is not evidence of having waited longest.
  function scanOrderKey(item) {
    const IbnoRules = resolveIbnoRules();
    const raw = str(item && item.ibScanTime);
    const sp = raw.indexOf(' ');
    const datePart = sp === -1 ? raw : raw.slice(0, sp);
    const timePart = sp === -1 ? '' : raw.slice(sp + 1);
    let iso = datePart && IbnoRules ? str(IbnoRules.toIsoDate(datePart)) : datePart;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      // ibScanTime carried no date (e.g. a bare '5:10 AM', the shape the
      // sibling main report uses) — take the day from inboundDate and read the
      // whole raw value as the clock.
      iso = str(item && item.inboundDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '￿';
      return iso + 'T' + normalizeClock(raw);
    }
    return iso + 'T' + normalizeClock(timePart);
  }

  function isBarcodeResolved(item) {
    return !!str(item && item.barcode);
  }

  // isBarcodeUnanswerable(item) -> the TERMINAL state (issue #666 review
  // finding 2): a lookup batch already investigated this label and came back
  // with nothing a machine can use. Either sub-state qualifies —
  // barcodeConflict (two disagreeing barcodes in the file, "awaiting manual
  // resolution" per applyBarcodeLookup's doc comment) or barcodeAsked with no
  // barcode (asked, simply not answered).
  //
  // Without this, "unresolved" was just !barcode, which collapsed three
  // genuinely different states into one: not yet asked, asked and
  // unanswerable, and conflicted. The consequence was a loop with no end —
  // an unanswerable row rides in every batch forever, the lane never reaches
  // "Nothing to copy", and the batch index stalls because that row never
  // counts as done.
  function isBarcodeUnanswerable(item) {
    if (isBarcodeResolved(item)) return false;
    return !!(item && (item.barcodeConflict || item.barcodeAsked));
  }

  // ─── ISSUE #667: BARCODE PRINT GATING ─────────────────────────────────────
  //
  // "Barcode selected" prints paper a package handler scans. That makes this
  // the most irreversible surface in this lane: a copy-to-clipboard mistake is
  // discovered when the lookup comes back wrong, but a bad CARD is discovered
  // when a package is already on the wrong belt (or does not scan at all and
  // the handler improvises). So the gating lives here, in the lib, beside the
  // barcode state itself — not in ibno-coder.html, where it could not be
  // tested and could drift from applyBarcodeLookup's own guarantees.
  //
  // TWO REFUSALS, both absolute:
  //
  //   conflict   — the Track IDs to Full Barcode lookup returned two DIFFERENT
  //                barcodes for one tracking number. Real and reproducible: 2
  //                of 56 packages on a fresh pull, both Express. Nobody knows
  //                which of the two is right, so printing either is a coin
  //                flip with a package's destination on it. Never
  //                last-write-wins, never "pick the longer one".
  //   unresolved — neither the main report nor the lookup supplied a barcode.
  //                The row prints NOTHING; it must never fall back to the
  //                tracking number (the #635 noFallback discipline, argued in
  //                full in applyBarcodeLookup's doc comment above — a
  //                PKG_LABEL_XREF-shaped value does not scan).
  //
  // NO LENGTH IS ASSUMED ANYWHERE HERE, deliberately. Real SCAN_BARCODE values
  // measured at 16, 22, 30 AND 34 characters on a single day, one package's
  // real barcode was its own 16-digit tracking number, and the Express return
  // length has never been measured at all. The only test applied is "is there
  // a resolved barcode" — a length gate would silently refuse real packages,
  // and "it looks like a tracking number" would refuse that real 16-digit one.
  const PRINT_REFUSALS = {
    conflict: 'the Track IDs to Full Barcode lookup returned two different barcodes for it',
    unresolved: 'no resolved barcode',
    missing: 'it is no longer in the Post Sort lane',
  };

  // barcodePrintDecision(item) -> { printable, barcode, reason, reasonText }
  //   reason: '' when printable, else 'conflict' | 'unresolved' | 'missing'.
  //
  // The conflict check comes FIRST, before the barcode check, on purpose.
  // applyBarcodeLookup clears barcodeConflict whenever any tier resolves a
  // barcode, so a flagged row should never carry one — but if that invariant
  // is ever broken upstream, the records-tier answer is to refuse, not to
  // print. The flag means "nobody knows which barcode is right"; a value
  // sitting beside it does not make one of them right.
  function barcodePrintDecision(item) {
    if (!item) {
      return { printable: false, barcode: '', reason: 'missing', reasonText: PRINT_REFUSALS.missing };
    }
    if (item.barcodeConflict) {
      return { printable: false, barcode: '', reason: 'conflict', reasonText: PRINT_REFUSALS.conflict };
    }
    const barcode = str(item.barcode);
    if (barcode) return { printable: true, barcode: barcode, reason: '', reasonText: '' };
    return { printable: false, barcode: '', reason: 'unresolved', reasonText: PRINT_REFUSALS.unresolved };
  }

  // planBarcodePrint(entries) -> what to print and what to refuse.
  //
  // `entries` is [{ label, item }] — the label the ROW carried and the lane
  // item it resolves to (or null/undefined when it resolves to nothing). The
  // label is passed separately rather than read off the item precisely so a
  // label with NO item is still nameable in the refusal: silently dropping a
  // row the supervisor explicitly selected is the one outcome worse than
  // refusing it, because a short sheet with no explanation reads as a
  // successful print.
  //
  // Returns { printable: [{ label, item, barcode }], refused: [{ label,
  // reason, reasonText }], printableCount, refusedCount, conflictCount,
  // unresolvedCount, missingCount, totalCount }. printableCount +
  // refusedCount === totalCount, always.
  function planBarcodePrint(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const printable = [];
    const refused = [];
    let conflictCount = 0, unresolvedCount = 0, missingCount = 0;
    list.forEach(function (e) {
      const entry = e || {};
      const item = entry.item;
      const label = str(entry.label || (item && item.label));
      const d = barcodePrintDecision(item);
      if (d.printable) {
        printable.push({ label: label, item: item, barcode: d.barcode });
        return;
      }
      if (d.reason === 'conflict') conflictCount++;
      else if (d.reason === 'missing') missingCount++;
      else unresolvedCount++;
      refused.push({ label: label, reason: d.reason, reasonText: d.reasonText });
    });
    return {
      printable: printable,
      refused: refused,
      printableCount: printable.length,
      refusedCount: refused.length,
      conflictCount: conflictCount,
      unresolvedCount: unresolvedCount,
      missingCount: missingCount,
      totalCount: list.length,
    };
  }

  // ─── ISSUE #693: THE SHEET TIE-BREAK, MOVED HERE FROM ibno-coder.html ────
  //
  // Extraction only. Every rule below ran in the inline script exactly as it
  // reads here; it moved so a Node test can reach it before the sheet rebuild
  // (#690) touches the DOM around it. The COLLECTION of checked rows stays
  // inline, because that is DOM work; the DECISION lives here, beside the
  // barcode state and the print gating it feeds.
  //
  // Read ADR 0021 before touching any of this. The overlap these functions
  // arbitrate is currently UNREACHABLE in the product (one report at a time),
  // and deliberately so: the code is dormant, not dead, and deleting it would
  // silently re-open a CRITICAL finding the moment coexistence returns.

  // barcodeValueOf(item) -> what a FULL-REPORT card actually encodes.
  //
  // item.scanBarcode is filled by lib/ibno-rules.js from [SCAN_BARCODE,
  // VAN_SCAN_BARCODE, trackingId], so it FALLS BACK to the tracking number
  // when the report carried no barcode column — deliberately, so a
  // barcode-mode copy of a full-report row is never empty. That fallback is
  // long-standing full-report behaviour and is NOT changed here; it is only
  // made recognisable, by barcodeIsFallback below.
  function barcodeValueOf(item) {
    return String((item && item.scanBarcode) || (item && item.label) || '');
  }

  // barcodeIsFallback(item) -> is the encoded value just the tracking number?
  //
  // NO LENGTH IS TESTED, here or anywhere on this path (#667). One measured
  // package's REAL 16-digit SCAN_BARCODE equalled its own tracking number, so
  // it reads as a fallback here — a benign false positive, handled below.
  function barcodeIsFallback(item) {
    return barcodeValueOf(item) === String((item && item.label) || '');
  }

  // fullReportBarcodeIsUnusable(fullItem) -> would the FULL-REPORT card for
  // this package encode a tracking number rather than a real barcode?
  // (#667 review, CRITICAL.)
  //
  // Deliberately expressed as "is the full-report value unusable", not "does
  // the early item have something better": the question is whether the
  // pre-existing full-report path is safe to take for an overlapping package,
  // and if it is not, the answer is to hand the package to the GATED early
  // path — which refuses rather than guesses. A doubly-unresolved package
  // therefore prints nothing and says why, instead of printing an unscannable
  // card.
  //
  // The caller resolves the item (ibno-coder.html's itemByLabel walks the
  // manual/auto/resolved lists); a missing item is unusable.
  //
  // The benign false positive noted on barcodeIsFallback costs nothing: that
  // package is handed to the early half, which holds the SAME value via
  // mainReportScanBarcodeMap and prints the identical card.
  function fullReportBarcodeIsUnusable(fullItem) {
    if (!fullItem) return true;
    return barcodeIsFallback(fullItem);
  }

  // dedupeLaneBarcodeEntries(rows, fullItemByLabel) -> [{ label, early }],
  // ONE entry per package (issue #667).
  //
  // `rows` is the checked rows of ONE lane in collection order, full-report
  // half first and early half second, each { label, early }. The DOM walk that
  // produces them stays in ibno-coder.html.
  //
  // DEDUPED BY LABEL. A tracking number can be checked in BOTH halves at once
  // — the early lane deliberately keeps a row the main report also calls
  // 'manual' — so this is a normal state whenever the two reports coexist, not
  // an edge case. Two cards for one package is paper a handler has to
  // reconcile.
  //
  // WHICH HALF WINS IS DECIDED BY WHICH ONE ACTUALLY KNOWS THE BARCODE, never
  // by collection order (#667 review, CRITICAL). "Full report always wins" is
  // wrong, and wrong in the one direction that whole ticket exists to prevent:
  //
  //   - the full-report card encodes barcodeValueOf, which falls back to the
  //     tracking number when the report carried no barcode column;
  //   - lib/ibno-rules.js's mainReportScanBarcodeMap maps only REAL
  //     SCAN_BARCODE values, so for that same label the early item keeps the
  //     good barcode the Track IDs to Full Barcode lookup resolved.
  //
  // So an unconditional full-report win would throw away a resolved barcode
  // and print a Code128 of a 12-digit tracking number — the exact unscannable
  // card, in one click of "Select with area" + "Barcode selected".
  //
  // The tie-break: the early half wins whenever the full-report half's value
  // is a FALLBACK or the full-report item cannot be found at all. The early
  // half is then subject to #667's gating like any other early row, so the
  // outcomes are "print the resolved lookup barcode" or "print nothing and say
  // why" — never "encode a tracking number". When the main report has a real
  // SCAN_BARCODE it still wins, which is the #649 tier order holding.
  //
  // `fullItemByLabel` is optional. Without it the full-report value is unknown,
  // and an unknown value is treated as unusable: that hands the overlap to the
  // gated half, which refuses, rather than to the ungated one, which would
  // encode a tracking number.
  function dedupeLaneBarcodeEntries(rows, fullItemByLabel) {
    const list = Array.isArray(rows) ? rows : [];
    const resolve = typeof fullItemByLabel === 'function' ? fullItemByLabel : function () { return null; };
    const entries = [];
    const byLabel = new Map();
    list.forEach(function (row) {
      const label = row && row.label;
      if (!label) return;
      const early = !!(row && row.early);
      const prev = byLabel.get(label);
      if (!prev) {
        const entry = { label: label, early: early };
        byLabel.set(label, entry);
        entries.push(entry);
        return;
      }
      // The overlap. `prev` is the full-report half whenever the caller
      // collects in the documented order; mutate it in place so the row keeps
      // its position on the sheet and the caller still sees exactly one entry
      // per package. This only ever PROMOTES a full-report entry to early; it
      // never demotes an early one back onto the fallback path.
      if (early && !prev.early && fullReportBarcodeIsUnusable(resolve(label))) prev.early = true;
    });
    return entries;
  }

  // How many refused tracking numbers the sentence names before it gives up
  // and counts the rest. A 300-row refusal must still be a sentence a human
  // reads, but naming NONE of them leaves Tyler hunting the lane for rows he
  // cannot identify — the on-row "awaiting barcode" / "barcode conflict" tags
  // carry the rest.
  const PRINT_REFUSAL_NAME_CAP = 6;

  // describeBarcodePrint(plan) -> the sentence the tool shows after a print.
  //
  // ALWAYS said, including the all-clear. A sheet that is short by two cards
  // is indistinguishable from a sheet that printed everything asked of it —
  // the supervisor walks away with paper either way — so the refusal has to
  // announce itself rather than wait to be noticed.
  function describeBarcodePrint(plan) {
    const p = plan || {};
    const refused = Array.isArray(p.refused) ? p.refused : [];
    const printableCount = p.printableCount || 0;
    const total = p.totalCount || (printableCount + refused.length);
    if (!total) return 'Nothing to print — no early rows were selected.';
    if (!refused.length) {
      return 'Printing ' + printableCount + ' early barcode card' + (printableCount === 1 ? '' : 's') + '.';
    }
    const parts = [];
    if (p.conflictCount) {
      parts.push(p.conflictCount + ' ' + (p.conflictCount === 1 ? 'has' : 'have') +
        ' conflicting barcodes in the lookup and need' + (p.conflictCount === 1 ? 's' : '') +
        ' manual resolution');
    }
    if (p.unresolvedCount) {
      parts.push(p.unresolvedCount + ' ' + (p.unresolvedCount === 1 ? 'has' : 'have') +
        ' no resolved barcode yet');
    }
    if (p.missingCount) {
      parts.push(p.missingCount + ' ' + (p.missingCount === 1 ? 'is' : 'are') +
        ' no longer in the Post Sort lane');
    }
    const names = refused.map(function (r) { return r.label; }).filter(Boolean);
    const shown = names.slice(0, PRINT_REFUSAL_NAME_CAP).join(', ');
    const more = names.length > PRINT_REFUSAL_NAME_CAP
      ? ' and ' + (names.length - PRINT_REFUSAL_NAME_CAP) + ' more'
      : '';
    const named = shown ? ' (' + shown + more + ')' : '';
    const printedNote = printableCount
      ? ' ' + printableCount + ' card' + (printableCount === 1 ? '' : 's') + ' printed.'
      : '';
    return refused.length + ' of ' + total + ' early row' + (total === 1 ? '' : 's') +
      ' printed NOTHING: ' + parts.join('; ') + named +
      '. No tracking number was printed in place of a barcode — it would not scan.' + printedNote;
  }

  // selectBarcodeBatch(items, options) -> {
  //   batch:        [trackingNumber] — what goes on the clipboard, in order
  //   batchIndex:   1-based, or 0 when nothing is copied
  //   batchCount:   how many batches this lookup job takes in total
  //   resolvedCount / totalCount:  progress through the WORKING SET
  //   pendingCount: working-set rows still eligible for a future batch
  //   unanswerableCount: working-set rows a lookup already investigated and
  //                 could not answer (conflicted, or asked and empty) — the
  //                 terminal state, out of every future batch
  //   batchSize:    the cap actually applied
  // }
  //
  // resolvedCount + pendingCount + unanswerableCount === totalCount, always.
  //
  // THREE FILTERS, ALL LOAD-BEARING:
  //
  //   1. needsWork only. The #657 fold already decided which rows will ever be
  //      worked — 285 of 2,868 on the real mid-sort pull (measured 2026-08-13).
  //      This reads `items` (the whole lane) and applies needsWork itself
  //      rather than taking a pre-filtered list, so the caller's VIEW state
  //      cannot leak in: toggling the fold off to look at everything is a
  //      viewing action, and must not make a skip row eligible for a batch.
  //   2. Unresolved only, with the #649 division of labour intact: a row the
  //      main report already holds a SCAN_BARCODE for needs no lookup
  //      round-trip at all, and a row a PRIOR batch resolved must not be sent
  //      again.
  //   3. Not already answered-as-unanswerable (isBarcodeUnanswerable, issue
  //      #666 review finding 2). Without this the loop has no terminal state:
  //      a row the lookup cannot answer is re-sent forever and the lane never
  //      reaches "Nothing to copy".
  //
  // Drop either of the first two and the real pull puts thousands of lines on
  // the clipboard instead of ~168; drop the third and the loop never ends.
  //
  // STATELESS BY DESIGN: batchIndex is derived from how much of the lookup job
  // is already done, not from a counter. There is no session state to get out
  // of step with the data, and a re-drop of the same report reports the same
  // batch rather than inventing a "batch 4".
  function selectBarcodeBatch(items, options) {
    const opts = options || {};
    const size = (typeof opts.batchSize === 'number' && isFinite(opts.batchSize) && opts.batchSize > 0)
      ? Math.floor(opts.batchSize)
      : BARCODE_BATCH_SIZE;
    const list = Array.isArray(items) ? items : [];

    const working = list.filter(needsWork);
    const totalCount = working.length;
    const resolvedCount = working.filter(isBarcodeResolved).length;
    const unanswerableCount = working.filter(isBarcodeUnanswerable).length;

    // The lookup job: working rows the main report does NOT already answer.
    // Rows already resolved BY the lookup stay in scope — they are batches
    // already completed, and dropping them would shrink batchCount as work
    // progressed ("batch 1 of 3" then "batch 1 of 2").
    const lookupScope = working.filter(function (it) {
      return str(it && it.barcodeSource) !== 'main';
    });
    const pending = lookupScope
      // Resolved rows AND terminal (unanswerable) rows are both out. Both
      // still count toward `done` below, so retiring a row into the terminal
      // state advances the batch index instead of stalling it.
      .filter(function (it) { return !isBarcodeResolved(it) && !isBarcodeUnanswerable(it); })
      // Decorate-sort-undecorate, over a COPY: `items` is the lane's own
      // render order and must survive untouched.
      .map(function (it, i) { return { it: it, i: i, key: scanOrderKey(it) }; })
      .sort(function (a, b) {
        if (a.key < b.key) return -1;
        if (a.key > b.key) return 1;
        return a.i - b.i; // ties keep report order
      })
      .map(function (d) { return d.it; });

    const pendingCount = pending.length;
    const batchCount = Math.ceil(lookupScope.length / size);
    const done = lookupScope.length - pendingCount;
    const batchIndex = pendingCount ? Math.min(Math.floor(done / size) + 1, batchCount) : 0;

    return {
      batch: pending.slice(0, size).map(function (it) { return str(it && it.label); }),
      batchIndex: batchIndex,
      batchCount: batchCount,
      resolvedCount: resolvedCount,
      totalCount: totalCount,
      pendingCount: pendingCount,
      unanswerableCount: unanswerableCount,
      batchSize: size,
    };
  }

  // describeBarcodeBatch(selection) -> the sentence the status line shows.
  //
  // Writing to the clipboard is a side effect Tyler did not click for, so it
  // is ALWAYS announced — including the two silent-looking cases (nothing to
  // copy, and an empty lane), which say explicitly that the clipboard was left
  // alone. Silently leaving whatever he had on the clipboard in place reads
  // exactly like a copy that worked.
  function describeBarcodeBatch(selection) {
    const s = selection || {};
    const batch = Array.isArray(s.batch) ? s.batch : [];
    const n = batch.length;
    const total = s.totalCount || 0;
    // The terminal rows are named explicitly rather than folded into
    // "unresolved" (issue #666 review finding 2). Leaving them unnamed makes
    // resolvedCount look permanently short of totalCount with no explanation,
    // which is the same class of status-line misinformation AC8 exists to
    // prevent — and it is the only prompt Tyler gets that those rows need a
    // human rather than another lookup round-trip.
    const stuck = s.unanswerableCount || 0;
    const stuckNote = stuck
      ? ' ' + stuck + ' need' + (stuck === 1 ? 's' : '') + ' manual resolution.'
      : '';
    const progress = ' ' + (s.resolvedCount || 0) + ' of ' + total + ' row' + (total === 1 ? '' : 's') +
      ' resolved.' + stuckNote;
    if (!n) {
      if (!total) return 'Nothing to copy — no rows need a barcode yet. The clipboard was left untouched.';
      const why = stuck
        ? 'every row the lookup can answer already has a barcode'
        : 'every row that needs a barcode already has one';
      return 'Nothing to copy — ' + why + '.' + progress + ' The clipboard was left untouched.';
    }
    const remaining = s.pendingCount || n;
    const scope = n < remaining
      ? 'the next ' + n + ' of ' + remaining + ' unresolved tracking numbers'
      : 'all ' + n + ' remaining tracking number' + (n === 1 ? '' : 's');
    return 'Batch ' + s.batchIndex + ' of ' + s.batchCount + ' copied to the clipboard — ' + scope +
      ', oldest inbound scan first.' + progress;
  }

  // flaggedLookupBatch(items) -> the tracking numbers behind the one-click
  // "Copy flagged-area tracking #s" button (PR #684), and the auto-copy that
  // fires the moment a Post Sort report loads.
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

  // ─── EARLY-LANE CLASSIFICATION (#694, moved from ibno-coder.html) ─────────
  //
  // These four were inline in the page until #694 (pre-build extraction 4 of 4
  // on spec #690). They are the shared bucketing first-class Post Sort rows
  // ride, so they belong beside the lane they describe, where a Node test can
  // reach them. Behaviour is unchanged; the page keeps the state (postSortItems,
  // the fold flag, the lane cache) and calls these for the decisions.

  // earlyIsMine(item) -> THE one predicate deciding whether an early row is part
  // of Tyler's queue, shared by the stat cards (earlyWorkingItems) and by what
  // actually renders (earlyVisibleItems). One predicate, two readers, so a count
  // on a card can never disagree with the rows on screen (ADR 0021).
  //
  // Two conditions, the second added 2026-08-14 (Tyler, on the first real Post
  // Sort run through the one-at-a-time workflow: "its still showing all not just
  // my flagged work areas"):
  //   needsWork ............... the disposition fold (#657), unchanged.
  //   isWorkAreaFlagged ....... The Post Sort report is a building-wide pull;
  //                             on the 2026-08-12 export that is 289 rows
  //                             across 110 Work Areas, of which 8 sit in the
  //                             areas Tyler actually works. The other 281 are
  //                             someone else's queue and were burying his.
  //
  // FOLDED, NOT REMOVED — the same constraint the disposition fold obeys
  // (constraint 1 on map #608: nothing this tool does disappears). The hidden
  // rows stay one click away behind the SAME "Show all" toggle, which always
  // states its own count.
  //
  // Reads the SAME configured list as the Flagged Work Areas settings box and as
  // flaggedLookupBatch above, via IbnoRules.isWorkAreaFlagged — so what is on
  // screen and what the Copy button puts on the clipboard can never diverge.
  //
  // A MISSING IbnoRules IS FATAL HERE (#711, item 1 of the #710 review).
  //
  // The first extraction copied flaggedLookupBatch's quiet fallback: no rules
  // module meant "nothing is flagged", so this predicate answered false for
  // every row and the lane rendered empty, the stat card read 0 and the Copy
  // batch came out empty — three surfaces agreeing on a wrong answer, none of
  // them saying anything. The inline original in ibno-coder.html called
  // IbnoRules.isWorkAreaFlagged directly and threw, and earlyLaneOf below still
  // throws, so the quiet version was both a behaviour change and a second
  // answer to one question inside one module. It throws.
  //
  // Unreachable in the shipped page (ibno-coder.html loads lib/ibno-rules.js
  // and the deploy ASSETS list carries it), which is exactly why it must be
  // loud: the only way to reach it is a wiring mistake, and a wiring mistake
  // that renders "0 rows need work" looks identical to a finished sort.
  //
  // The check is deliberately BEFORE needsWork, so the fold cannot swallow it:
  // needsWork answers false for a skipped row without consulting IbnoRules, and
  // most of a real pull is skipped rows.
  //
  // flaggedLookupBatch above keeps its quiet [] on purpose and is unchanged —
  // it fails toward copying NOTHING to the clipboard, never toward copying
  // everything, and no count on screen rides it.
  function earlyIsMine(item) {
    const IbnoRules = resolveIbnoRules();
    if (!IbnoRules || typeof IbnoRules.isWorkAreaFlagged !== 'function') {
      throw new Error('PostSortLane.earlyIsMine needs IbnoRules (load lib/ibno-rules.js first)');
    }
    return needsWork(item) && IbnoRules.isWorkAreaFlagged(item && item.ibWork);
  }

  // earlyLaneOf(item) -> which SERVICE lane an early Post Sort row belongs in:
  // 'ground' / 'express' / 'express-other', decided by IbnoRules.manualLane,
  // the SAME function a full-report row is routed by (issue #663, OPTION B --
  // Tyler's decision, 2026-08-13).
  //
  // STALE-COMMENT CORRECTION (#711; out of scope for that issue, fixed here
  // because it is comment text in a file the change already touches): those
  // three keys WERE the MANUAL_LANES keys until #696 merged the page's lanes
  // into two need lanes, 'mine' and 'other'. The rule below is unchanged and
  // still unit-tested here, but ibno-coder.html no longer asks it -- the merged
  // page injects its own laneOf (IbnoMergedView.inWorkingPopulation) into
  // earlyLanesByKey, because a lane keyed on service is exactly what let an
  // express intercept sit under "not mine to work" (#616). Everything below is
  // the service split's own reasoning, not a description of what the page
  // renders today.
  //
  // It reads the `express` and `ibWork` fields buildPostSortLane above already
  // derives from EXPRESS_TRACK (the report's own service label -- "Express" --
  // NOT a tracking number, the exact trap #663 calls out) and IB_WORK_AREA, so
  // manualLane's rule 1 (isWorkAreaFlagged(row.ibWork)) does the work here: an
  // early Express row outside the flagged areas falls through to
  // 'express-other', which is precisely the intent.
  //
  // Its category-based rules 2 and 3 (Unassigned Zip, and the AREA_GROUPED
  // "worked alongside the flagged area" categories) used to be inert for an
  // early row by construction, because earlyReviewFields always set category ''
  // (#662). Since #664 they are LIVE: applyEarlyCode fills item.category from
  // the main report's OWN classification for a label it has already coded
  // 'manual' (and leaves it '' for the fresh tail the main report has never
  // seen). That is the RIGHT outcome under Option B rather than a leak of #664
  // into routing -- an early Express QA-Intercept now lands in the same lane its
  // full-report twin lands in a few minutes later, instead of jumping lanes the
  // moment the main report catches up. It changes nothing about CODING: routing
  // reads item.category, and #661's "explicitly not modified" list still keeps
  // decideCode/decideCodeInner untouched (applyEarlyCode never calls them).
  //
  // Why Option B and not "every early Express row into Tyler's queue": on a real
  // pull (2026-08-12 fixture) 72 of the 73 early Express rows are OUTSIDE the
  // flagged work areas. Routing them by the Express label alone would put 72
  // rows he does not work at the top of the lane that exists to show what he
  // DOES work -- exactly the mis-read the express-other lane was created on
  // 2026-08-06 to prevent. The Express split still holds for early rows; it
  // simply holds the same way it holds everywhere else in this tool, through
  // one shared rule rather than a second one that only early rows obey.
  //
  // A missing IbnoRules is FATAL here: there is no safe lane to guess, and a
  // silently mis-routed row is exactly the failure this extraction exists to
  // make untestable-by-accident. Since #711, earlyIsMine above answers the same
  // way, and the two halves of the early-lane rule now agree on what a missing
  // dependency means.
  function earlyLaneOf(item) {
    const IbnoRules = resolveIbnoRules();
    if (!IbnoRules || typeof IbnoRules.manualLane !== 'function') {
      throw new Error('PostSortLane.earlyLaneOf needs IbnoRules (load lib/ibno-rules.js first)');
    }
    return IbnoRules.manualLane(item);
  }

  // earlyLanesByKey(items, laneKeys) -> { laneKey: [items in report order] }.
  //
  // The lane split computed ONCE per data change rather than per lane
  // per caller (PR #673 review finding 9): on a real 2,868-row mid-sort pull the
  // per-caller version re-ran manualLane over the whole population ~8 times per
  // render AND per search keystroke, rebuilding a fresh set of RegExps each
  // time. The page owns the cache and its invalidation; this owns the split.
  //
  // `laneKeys` seeds the result so a lane with no early rows still answers []
  // instead of undefined. A row routed to a key nobody asked for still gets a
  // bucket rather than being dropped — no early row disappears silently.
  //
  // `laneOf` is the routing rule, injected (#696). It defaults to earlyLaneOf,
  // the service split this lib has always applied. The merged page hands in its
  // own population rule instead, so an early row and its full-report twin are
  // routed by ONE rule rather than two — the same one-rule-one-place property
  // Option B bought, now keyed on need rather than on service.
  function earlyLanesByKey(items, laneKeys, laneOf) {
    const route = typeof laneOf === 'function' ? laneOf : earlyLaneOf;
    const byKey = {};
    (Array.isArray(laneKeys) ? laneKeys : []).forEach(function (k) { byKey[k] = []; });
    (Array.isArray(items) ? items : []).forEach(function (it) {
      const key = route(it);
      (byKey[key] || (byKey[key] = [])).push(it);
    });
    return byKey;
  }

  // earlyReviewFields(item) -> shapes ONE lane item into the field shape
  // ibno-coder.html's buildManualRow() expects (issue #662, extended by #664).
  // No code/category/reason is DECIDED here -- that happens in applyEarlyCode,
  // called right after applyDisposition wherever postSortItems is (re)built.
  // This function only reads what applyEarlyCode already resolved onto
  // item.category/item.reason (the main report's real classification when it
  // has one, or the flagged-Work-Area fallback for the fresh tail, each with
  // item.plaArbitrated saying which) and falls back to the pre-#664 canned
  // strings when applyEarlyCode has not run yet (e.g. a direct call in a
  // context that skips it). provenance: 'early' is the ONLY signal
  // buildManualRow reads to take the early-specific branches.
  function earlyReviewFields(item) {
    return Object.assign({}, item, {
      category: (item && item.category) || '',
      reason: (item && item.reason) || 'Post Sort, awaiting full report',
      scanBarcode: (item && item.barcode) || '',
      provenance: 'early',
    });
  }

  // ─── ISSUE #668: EARLY-LANE PERSISTENCE ───────────────────────────────────
  //
  // The main report already survives a refresh (lib/ibno-session.js + the
  // page's SESSION_KEY). The Post Sort load had no save path at all. While it
  // lived in its own box that was survivable; now that its rows sit inside
  // Needs Manual Review, a refresh empties a group that looks like it should
  // persist, mid-sort, at the worst possible moment.
  //
  // PERSIST THE PARSED ROWS, NEVER THE RAW FILE. This is the known
  // localStorage-quota area of this tool. A Post Sort pull runs to thousands
  // of rows; storing its file text is how a ~5MB origin quota fills, and a
  // FULL quota does not announce itself as "storage full" — it announces
  // itself as "a refresh re-inputs the CSV", which reads as a completely
  // different bug and has already cost one debugging session here. So the
  // payload is a WHITELIST of parsed scalar fields:
  //
  //   * everything buildPostSortLane derives from the report,
  //   * the four barcode fields applyBarcodeLookup resolves — including
  //     barcodeSource, so #649's "main report SCAN_BARCODE always wins over a
  //     lookup value" arbitration still holds after a restore, and
  //     barcodeAsked, #666's terminal "asked and unanswerable" state, without
  //     which every such row is re-sent in every batch forever,
  //   * the disposition fold (#651) and the early-code decision (#664),
  //     plaArbitrated included — that flag is the ONLY thing telling a code
  //     the main report confirmed apart from one guessed off Work Area alone
  //     (the page's "no PLA" marker).
  //
  // Anything else an item carries — render bookkeeping like _ord, and any
  // field a future change hangs off an item — is dropped on the way in AND on
  // the way out. Restoring through the same whitelist means a hand-edited or
  // half-written payload cannot inject fields into the lane either.
  //
  // NOT persisted, deliberately: the fold state and the checked selection
  // (both already documented as per-load state in ibno-coder.html), and the
  // typed Goes To areas — those live in their own store (lib/actual-area.js)
  // with their own provenance and their own 30-day prune, and duplicating
  // them here is how the two would drift.
  const EARLY_SNAPSHOT_VERSION = 1;
  const EARLY_TEXT_FIELDS = [
    'label', 'address', 'postal', 'firm', 'ibWork', 'inboundDate',
    'inboundDateRaw', 'ibScanTime', 'express', 'priorityPackage',
    'barcode', 'barcodeSource',
    'mainDisposition', 'mainCategory', 'mainCode', 'mainReason',
    'category', 'reason',
  ];
  const EARLY_FLAG_FIELDS = ['barcodeConflict', 'barcodeAsked', 'mainKnown', 'plaArbitrated'];
  const EARLY_PERSIST_FIELDS = EARLY_TEXT_FIELDS.concat(EARLY_FLAG_FIELDS);

  // pickEarly(item) -> a fresh object carrying ONLY the whitelisted fields the
  // item actually has. A field the item never grew stays ABSENT rather than
  // becoming '' or false: applyBarcodeLookup distinguishes "never asked" (no
  // barcode fields at all) from "asked and came back empty" (barcodeAsked
  // true), and inventing the keys would erase that distinction on the way
  // through storage.
  function pickEarly(item) {
    const src = item || {};
    const out = {};
    EARLY_TEXT_FIELDS.forEach(function (f) {
      if (Object.prototype.hasOwnProperty.call(src, f)) out[f] = str(src[f]);
    });
    EARLY_FLAG_FIELDS.forEach(function (f) {
      if (Object.prototype.hasOwnProperty.call(src, f)) out[f] = !!src[f];
    });
    return out;
  }

  // snapshotEarly(items) -> the plain serializable payload:
  //   { v, day, items }
  //
  // `day` IS THE SORT DAY OF THE ROWS, read off their own INBOUND_DATE through
  // SortDay.sortDayOf — never the device clock. This is spec #690's mandate 2
  // and decision record #621, and on this lane it is not a nicety:
  //
  //   Station 849's sort starts around 1:30 AM and crosses midnight EVERY
  //   night. On a calendar-day stamp, a lane last rendered at 23:59 is refused
  //   AND DELETED at 00:05 — mid-sort, which is the precise moment #668 exists
  //   to protect. The inverse bites just as hard: a 1:30 AM sort worked on a
  //   report dated YESTERDAY would be resurrected later that same calendar day,
  //   putting last night's packages back into tonight's queue.
  //
  // The device clock is wrong in both directions because it changes in the
  // middle of one shift and is identical across two different sorts either side
  // of a midnight. The report is the only thing that knows which sort it is.
  //
  // Pure — items is never mutated. The day is derived, not passed in, so the
  // stamp and the rows can never disagree about which sort they belong to.
  function snapshotEarly(items, opts) {
    const SortDay = resolveSortDay();
    const list = Array.isArray(items) ? items : [];
    const kept = list.filter(function (it) { return it && str(it.label); }).map(pickEarly);
    return {
      v: EARLY_SNAPSHOT_VERSION,
      day: SortDay && typeof SortDay.sortDayOf === 'function' ? SortDay.sortDayOf(kept) : '',
      items: kept,
    };
  }

  // restoreEarly(stored, { sortDay }) -> the items to put back in the lane, or
  // [] when there is nothing trustworthy to restore.
  //
  // `sortDay` is the page's SORT-DAY CLOCK as it already stands (the page hands
  // in currentSortDay, '' on a cold boot). The gate is the same FORWARD-ONLY
  // rule applySortDayFrom uses and lib/sort-day.js documents as "reset on a new
  // sort day": a payload is refused only when the page ALREADY KNOWS a LATER
  // sort day. That is the one circumstance under which these rows are provably
  // last night's — and it is a fact about the sort, not about the calendar.
  //
  // Three refusals, each for its own reason:
  //   * unreadable rows ....... a lane whose own dates will not parse is an
  //                             unprovable working set; an empty lane the
  //                             supervisor fixes with one drop of the report he
  //                             already has is strictly better.
  //   * a stamp that disagrees with the rows ... the payload was hand-edited
  //                             or half-written. The stamp cannot be used to
  //                             smuggle rows past the clock, because it is
  //                             re-derived from the rows and compared.
  //   * a wrong version ....... this build does not know the shape.
  function restoreEarly(stored, opts) {
    const SortDay = resolveSortDay();
    if (!SortDay || typeof SortDay.sortDayOf !== 'function') return [];
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];
    if (stored.v !== EARLY_SNAPSHOT_VERSION) return [];
    if (!Array.isArray(stored.items)) return [];
    const items = stored.items.filter(function (it) { return it && str(it.label); }).map(pickEarly);
    if (!items.length) return [];
    const day = SortDay.sortDayOf(items);
    if (!day) return [];
    if (SortDay.parseInboundDate(stored.day) !== day) return [];
    if (SortDay.isLaterSortDay(str((opts || {}).sortDay), day)) return [];
    return items;
  }

  return {
    buildPostSortLane: buildPostSortLane,
    earlyIsMine: earlyIsMine,
    earlyLaneOf: earlyLaneOf,
    earlyLanesByKey: earlyLanesByKey,
    earlyReviewFields: earlyReviewFields,
    buildMainReportBarcodeMap: buildMainReportBarcodeMap,
    buildMainReportDispositionMap: buildMainReportDispositionMap,
    applyBarcodeLookup: applyBarcodeLookup,
    applyDisposition: applyDisposition,
    applyEarlyCode: applyEarlyCode,
    needsWork: needsWork,
    flaggedLookupBatch: flaggedLookupBatch,
    isBarcodeUnanswerable: isBarcodeUnanswerable,
    barcodePrintDecision: barcodePrintDecision,
    barcodeValueOf: barcodeValueOf,
    barcodeIsFallback: barcodeIsFallback,
    fullReportBarcodeIsUnusable: fullReportBarcodeIsUnusable,
    dedupeLaneBarcodeEntries: dedupeLaneBarcodeEntries,
    planBarcodePrint: planBarcodePrint,
    describeBarcodePrint: describeBarcodePrint,
    selectBarcodeBatch: selectBarcodeBatch,
    describeBarcodeBatch: describeBarcodeBatch,
    BARCODE_BATCH_SIZE: BARCODE_BATCH_SIZE,
    // Issue #668 early-lane persistence. The rescued work-in-progress defined
    // these three but never wired them into the export block, so nothing could
    // reach them and its own tests could not run — added here as part of the
    // rescue, unchanged in behaviour.
    snapshotEarly: snapshotEarly,
    restoreEarly: restoreEarly,
    EARLY_PERSIST_FIELDS: EARLY_PERSIST_FIELDS,
  };
});
