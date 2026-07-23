'use strict';

// Authoritative QA scan-code taxonomy for Station 849 (issue #199).
//
// Slice #200 shipped the codes QA APPLIES (status family, "apply" workflow) and
// wired the IBNO Coder's manual-entry validation/datalist against it.
//
// Slice #201 (this file) extends the module to the FULL QA-relevant taxonomy
// across all three walled code families from checklists/qa-scan-codes.md:
//   - status  (the codes QA reads, e.g. 02/06/07/12, plus the apply-codes)
//   - vision  (Vision routing codes: 999 and its equivalents, 3399, 9908)
//   - label   (label-creation codes: 889, 998)
// and adds a read-only lookup interface (lookup/meaning/family) so the same
// number can resolve to multiple meanings across families (e.g. 302 is both an
// OP-324 status meaning and a Vision-routing 999-equivalent).
//
// isKnownCode / listApplyCodes are UNCHANGED in behavior: they still resolve
// only against the status/apply set, per #199's decision that only codes QA
// applies drive manual-entry validation.
//
// Anchored to OP-324 "Service Measurement – Status Codes" (rev 11/01/2023); the
// human reference is checklists/qa-scan-codes.md — meanings below are taken
// verbatim from that file, not invented.
//
// Dual-loadable with no build step (browser global + Node require), matching
// lib/csv.js and lib/ibno-rules.js.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.ScanCodes = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // ── Status family: "read" workflow ─────────────────────────────────────────
  // Conditions QA reads (they describe why a package needs QA) — not codes QA
  // scans onto a package. Never part of isKnownCode.
  const STATUS_READ_CODES = [
    { code: '02', meaning: 'Incorrect Recipient Address', commonUse: 'Bad address (wrong street/number, ZIP, apt, unit) → apply 33.' },
    { code: '06', meaning: 'Package Refused by Recipient', commonUse: 'Applies 60 (RTS).' },
    { code: '07', meaning: 'Res. Recip. Not In, unable to Indir/DrRel', commonUse: 'Residential recipient not in. Three 07s = a 3-Timer → needs a call.' },
    { code: '12', meaning: 'Package Sorted to Wrong Route', commonUse: 'Missort (status 12 in either the VSA or STAR column). In-Area 12 = WA# equals the Vision Label’s leading number (suspicious); Correct 12 = differs (legitimate).' },
    // 302's OP-324 meaning is not in the qa-scan-codes.md table body (it isn't
    // part of the verified core QA reads/applies), but the checklist's own intro
    // names it verbatim as the walled-family collision example: 302 is "Shipper
    // loaded package on trailer" in OP-324 vs. a 999-equivalent in Vision routing
    // (checklists/qa-scan-codes.md line 12; same example in CONTEXT.md/#199 PRD).
    // Included here, sourced from that exact text, so lookup('302') demonstrates
    // the cross-family collision the acceptance criteria require.
    { code: '302', meaning: 'Shipper loaded package on trailer', commonUse: 'OP-324 status meaning — distinct from the Vision-routing 999-equivalent use of the same number.' },
  ];

  // ── Status family: "apply" workflow ─────────────────────────────────────────
  // Codes QA scans onto a package. Array order is the canonical suggestion order
  // for the manual-entry datalist. isIbnoAuto marks the five the IBNO Coder
  // applies by rule; `trigger` records the condition.
  const STATUS_APPLY_CODES = [
    { code: '11', meaning: 'Non-Res Recipient Closed on Saturday', commonUse: '(IBNO auto) — Closure Portal / 9908 on a weekend.', isIbnoAuto: true,  trigger: 'Closure Portal / 9908, weekend' },
    { code: '33', meaning: 'Address search',                       commonUse: 'For an 02 (bad address); run before FRO/DRO on a 999.', isIbnoAuto: false },
    { code: '34', meaning: 'Inventory / Request Future Delivery',  commonUse: '(IBNO auto) — Closure Portal, confirmed multi-day closure.', isIbnoAuto: true,  trigger: 'Closure Portal, multi-day closure' },
    { code: '39', meaning: 'Damaged – Delivery Not Complete',      commonUse: 'Package with physical damage.', isIbnoAuto: false },
    { code: '59', meaning: 'Business Closed – No Attempt',         commonUse: '(IBNO auto) — Closure Portal, weekday default (assumes 1-day).', isIbnoAuto: true,  trigger: 'Closure Portal, weekday' },
    { code: '60', meaning: 'Returned to Shipper',                  commonUse: 'RTS. For an 06; or no reply after 7 days on the Red Shelf; or a 3-Timer unresolved after the call.', isIbnoAuto: false },
    { code: '65', meaning: 'Misload from hub',                     commonUse: '(IBNO auto) — Misload / Unassigned Zip / Preload SWAK (12-digit label).', isIbnoAuto: true,  trigger: 'Misload / Unassigned Zip / Preload SWAK' },
    { code: '94', meaning: 'Out for delivery tomorrow',            commonUse: '(IBNO auto) — Hold to Match - 1 / - 2.', isIbnoAuto: true,  trigger: 'Hold to Match - 1 / - 2' },
    { code: '99', meaning: 'Unable to Deliver',                    commonUse: 'At 849, the package is then disposed of. (Note: "disposed of" is the action, not the code’s meaning.)', isIbnoAuto: false },
  ];

  // ── Vision routing family ────────────────────────────────────────────────
  // Work-area / Original-Scan designations seen in report columns. QA reads
  // these to route a package; they are NOT QA scan codes and never drive
  // isKnownCode. Several numbers collide with OP-324 status codes — in this
  // family they mean "unrouted" (999-equivalent).
  const VISION_999_EQUIVALENTS = ['999', '2299', '302', '600', '100', '103', '400', '403'];
  const VISION_ENTRIES = VISION_999_EQUIVALENTS.map(function (code) {
    return {
      code: code,
      meaning: 'Unroutable — Vision isn’t updated for the address; needs manual assignment (FRO/DRO).',
      commonUse: code === '999'
        ? 'The canonical unroutable designation.'
        : 'A 999-equivalent — means the same as 999 in this family (unrouted, manual assignment needed).',
    };
  }).concat([
    { code: '3399', meaning: 'A 999 routed to the 300 belt and staged for Cage B.', commonUse: 'Audited for possible OFD packages.' },
    { code: '9908', meaning: 'Work-area designation; on weekends, packages here get code 11 if not yet coded or van-scanned.', commonUse: 'Bypasses the normal belt and PLA_LOOKUP category filters.' },
  ]);

  // ── Label-creation family ────────────────────────────────────────────────
  // Special labels QA creates outside normal package flow. Reference/lookup
  // only — never drive isKnownCode.
  const LABEL_CODES = [
    { code: '889', meaning: 'Label created when QA knows the recipient info but not the actual tracking number.', commonUse: 'Do not use for Walmart shipments (use 998).' },
    { code: '998', meaning: 'Label created using the shipper number, so the shipper is charged.', commonUse: 'Required for Walmart shipments.' },
  ];

  // ── Assemble the full taxonomy, one entry per (code, family) ────────────────
  // Each entry: { code, family, workflow?, meaning, commonUse, isIbnoAuto?, trigger? }
  const ALL_ENTRIES = []
    .concat(STATUS_READ_CODES.map(function (e) {
      return Object.assign({ family: 'status', workflow: 'read' }, e);
    }))
    .concat(STATUS_APPLY_CODES.map(function (e) {
      return Object.assign({ family: 'status', workflow: 'apply' }, e);
    }))
    .concat(VISION_ENTRIES.map(function (e) {
      return Object.assign({ family: 'vision' }, e);
    }))
    .concat(LABEL_CODES.map(function (e) {
      return Object.assign({ family: 'label' }, e);
    }));

  const applyCodeSet = new Set(STATUS_APPLY_CODES.map(function (e) { return e.code; }));

  function normalize(code) {
    return String(code == null ? '' : code).trim();
  }

  // isKnownCode(code) -> true only for a code QA applies. Drives the IBNO Coder's
  // non-blocking manual-entry sanity check (#158): an out-of-set code still warns
  // but is allowed. Vision-routing (999) and label (889) codes, and status "read"
  // codes (02/06/07/12), are NOT "known" for manual entry — reference-only.
  function isKnownCode(code) {
    return applyCodeSet.has(normalize(code));
  }

  // listApplyCodes() -> a fresh array of the apply-code numbers in canonical
  // order, for the datalist suggestions.
  function listApplyCodes() {
    return STATUS_APPLY_CODES.map(function (e) { return e.code; });
  }

  // lookup(code) -> array of every matching entry across all three families
  // (read-only; a fresh array/objects each call so callers cannot mutate the
  // source taxonomy). Empty array for an unknown code — never throws.
  function lookup(code) {
    const c = normalize(code);
    if (!c) return [];
    return ALL_ENTRIES.filter(function (e) { return e.code === c; })
      .map(function (e) { return Object.assign({}, e); });
  }

  // meaning(code, family?) -> the official OP-324/reference meaning string, or
  // null if the code (in that family, when given) isn't known. With no family
  // and a multi-family collision, returns the first match (callers wanting
  // disambiguation should use lookup() directly).
  function meaning(code, fam) {
    const matches = lookup(code);
    const hit = fam ? matches.find(function (e) { return e.family === fam; }) : matches[0];
    return hit ? hit.meaning : null;
  }

  // family(code) -> array of family names the code belongs to (may be more than
  // one, e.g. '302' -> ['status', 'vision']). Empty array if unknown.
  function family(code) {
    const matches = lookup(code);
    const seen = [];
    matches.forEach(function (e) { if (seen.indexOf(e.family) === -1) seen.push(e.family); });
    return seen;
  }

  return {
    isKnownCode: isKnownCode,
    listApplyCodes: listApplyCodes,
    lookup: lookup,
    meaning: meaning,
    family: family,
  };
});
