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

  return {
    buildPostSortLane: buildPostSortLane,
    buildMainReportBarcodeMap: buildMainReportBarcodeMap,
    buildMainReportDispositionMap: buildMainReportDispositionMap,
    applyBarcodeLookup: applyBarcodeLookup,
    applyDisposition: applyDisposition,
    applyEarlyCode: applyEarlyCode,
    needsWork: needsWork,
    flaggedLookupBatch: flaggedLookupBatch,
    isBarcodeUnanswerable: isBarcodeUnanswerable,
    barcodePrintDecision: barcodePrintDecision,
    planBarcodePrint: planBarcodePrint,
    describeBarcodePrint: describeBarcodePrint,
    selectBarcodeBatch: selectBarcodeBatch,
    describeBarcodeBatch: describeBarcodeBatch,
    BARCODE_BATCH_SIZE: BARCODE_BATCH_SIZE,
  };
});
