'use strict';

// Manual Review plan for the Station 849 IBNO Coder.
//
// Dual-loadable with no build step:
// - Browser: window.ReviewPlan
// - Node: require('./lib/ibno-review-plan')
//
// WHAT THIS OWNS: for one package already bound for Manual Review, the four
// facts the coding list needs about it —
//
//   rowPlan(item) -> { lane, bucket, code, bulkable }
//
//   lane     which of the three Manual Review lists works this package
//            ('ground' | 'express' | 'express-other'), delegated to
//            IbnoRules.manualLane
//   bucket   which heading it sits under inside that lane
//            ('area' | 'zip' | 'other')
//   code     the QA Scan Code the tool OFFERS for it ('33' | '65' | ''),
//            '' meaning the package needs an individual look
//   bulkable whether a bucket's "Apply <code> to N checked" button may write
//            that code onto this package
//
// WHY IT IS ITS OWN MODULE (issue #631): this decision used to live in
// ibno-coder.html as suggestedManualCode + manualBucket while every other
// coding rule lived in lib/. It has five call sites, and reaching it from a
// test meant rendering a page — so #618 shipped a wrong code offer against real
// packages on two surfaces at once, and the DOM test that should have caught it
// only ever used UNFLAGGED work areas. Behind this interface the same rule is a
// plain table test (tests/ibno-review-plan.test.js) that sweeps every category
// against both flagged and unflagged areas.
//
// WHAT THIS DOES NOT OWN: rendering, heading text, sort order, search, collapse
// state, DOM ids. Those stay in ibno-coder.html. Nor the rulebook that decided
// the package needs Manual Review in the first place — that is IbnoRules.
// decideCode, which runs BEFORE anything here.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ReviewPlan = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // THROWS when IbnoRules is absent, deliberately. Every branch below that asks
  // IbnoRules a question is a records guarantee, so a missing dependency must
  // not degrade to an answer — it must stop.
  //
  // A soft `if (IbnoRules && ...)` guard here would fail OPEN: a QA-Intercept or
  // Invalid HazMat on a flagged work area would fall through to the reason test
  // and be offered 33 again, silently reinstating the exact #618 defect this
  // module exists to prevent, and rowPlan would call every express package
  // 'ground' and print it onto a ground barcode sheet. The pre-extraction code
  // referenced a bare `IbnoRules` and threw; that loudness is worth keeping.
  function resolveIbnoRules() {
    if (root && root.IbnoRules) return root.IbnoRules;
    if (typeof require !== 'undefined') {
      try { return require('./ibno-rules'); } catch (e) { /* fall through to throw */ }
    }
    throw new Error('ReviewPlan requires IbnoRules: load lib/ibno-rules.js before lib/ibno-review-plan.js');
  }

  // The buckets a Manual Review lane splits into, in render order, each with
  // the QA Scan Code its bulk button applies. This is the CODE half of what
  // ibno-coder.html used to hold in MANUAL_GROUPS; the heading text and its
  // symbols stay in the tool, because they are screen vocabulary and this
  // module must not need to know about the screen.
  const BUCKETS = [
    { key: 'area',  code: '33' },   // Flagged Work Area
    { key: 'zip',   code: '65' },   // Unassigned ZIP Code
    { key: 'other', code: ''   },   // needs an individual look
  ];

  function bucketCode(key) {
    for (let i = 0; i < BUCKETS.length; i++) {
      if (BUCKETS[i].key === key) return BUCKETS[i].code;
    }
    return '';
  }

  // The QA Scan Code offered for a Manual Review package (#batch-code): most
  // flagged rows come out the same way — Unassigned Zip -> 65, a flagged work
  // area -> 33 — which is how the section groups them and what each group's
  // bulk button applies. Unassigned Zip wins over the work-area flag (a zip row
  // flagged on work area still buckets to 65). Returns '' for rows that need an
  // individual look (no bulk bucket).
  function offeredCode(item) {
    const IbnoRules = resolveIbnoRules();
    const category = (item && item.category) || '';
    const reason   = (item && item.reason) || '';
    if (category === 'Unassigned Zip') return '65';
    // QA-Intercept / Invalid HazMat are GROUPED with flagged-area rows but are
    // never CODED by that bucket: 33 is the flagged-work-area code and is not
    // known to be right for an intercept or a hazmat exception (#602).
    //
    // This test has to come BEFORE the reason test, not after it. On a flagged
    // work area decideCode's catch-all gives these rows reason "Work area: N",
    // identical to an ordinary flagged row, so matching on the reason string
    // alone handed them a one-click 33 and made them sweepable by "Apply 33 to
    // N checked" — a wrong record against the Manual Assignment Detail, and the
    // one outcome #602's grouping exists to prevent (#604).
    //
    // Returning '' here does NOT un-group them: bucketOf falls through to its
    // own groupsWithFlaggedArea check and still buckets them under the flagged
    // header. Pinned by tests/ibno-review-plan.test.js and, on the rendered
    // page, by tests/ibno-area-grouped-dom.test.js.
    if (IbnoRules.groupsWithFlaggedArea(category)) return '';
    // #680: the phrasing this matches on is no longer written out here. Both
    // this matcher and every producer of the text (IbnoRules.decideCodeInner's
    // five branches, PostSortLane.applyEarlyCode's fresh-tail fallback) derive
    // from IbnoRules.WORK_AREA_REASON_PREFIX, so the cascade's wording and this
    // read of it cannot drift apart. See workAreaReason/isWorkAreaReason there
    // for why the definition sits in IbnoRules rather than in this module.
    if (IbnoRules.isWorkAreaReason(reason)) return '33';
    return '';
  }

  // The heading a Manual Review package sits under inside its lane.
  function bucketOf(item) {
    const IbnoRules = resolveIbnoRules();
    const c = offeredCode(item);            // '33' | '65' | ''
    if (c === '33') return 'area';
    if (c === '65') return 'zip';
    // QA-Intercept and Invalid HazMat are worked alongside flagged-work-area
    // packages, so they GROUP there even though they carry no offered code
    // (they reach review via the unknown-PLA rule, on unflagged work areas).
    // Grouping only — `bulkable` below is false for them, so the bucket's
    // "Apply 33" can never reach them.
    if (IbnoRules.groupsWithFlaggedArea(item && item.category)) return 'area';
    return 'other';
  }

  // The whole plan for one Manual Review package. This is the module's front
  // door: every caller wants some subset of these four facts, and asking for
  // them one call at a time is what let the offered code and the bucket
  // disagree in #618.
  function rowPlan(item) {
    const IbnoRules = resolveIbnoRules();
    const code   = offeredCode(item);
    const bucket = bucketOf(item);
    return {
      lane:   IbnoRules.manualLane(item),
      bucket: bucket,
      code:   code,
      // A package is sweepable by its bucket's bulk button only when the code
      // it is offered IS that bucket's code. Stated as the comparison rather
      // than as `Boolean(code)` so the invariant is visible: a package grouped
      // under a heading for visibility alone can never be swept by it.
      bulkable: code !== '' && code === bucketCode(bucket),
    };
  }

  // #680 front door. The "Work area: N" reason is the one fact the cascade and
  // the Post Sort early lane pass to this module as prose, and this module is
  // what reads it — so it is named here, where a Manual Review caller looks.
  // The DEFINITION is in lib/ibno-rules.js (dependency root; address-catcher.html
  // loads that file without this one, so the cascade cannot point back here);
  // these are thin delegations, resolved lazily like every other IbnoRules call
  // in this module so both script load orders work.
  function workAreaReason(ibWork) { return resolveIbnoRules().workAreaReason(ibWork); }
  function isWorkAreaReason(reason) { return resolveIbnoRules().isWorkAreaReason(reason); }

  return {
    BUCKETS: BUCKETS,
    bucketCode: bucketCode,
    rowPlan: rowPlan,
    workAreaReason: workAreaReason,
    isWorkAreaReason: isWorkAreaReason,
  };
}));
