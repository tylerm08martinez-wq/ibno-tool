'use strict';

// Authoritative QA scan-code taxonomy for Station 849 (issue #199).
//
// Slice #200 scope: the codes QA APPLIES (status family, "apply" workflow). This
// module is the single source of truth for the IBNO Coder's manual-entry
// validation and its code-suggestion datalist, replacing the inline KNOWN_CODES.
// Anchored to OP-324 "Service Measurement – Status Codes" (rev 11/01/2023); the
// human reference is checklists/qa-scan-codes.md. Later slices extend this to the
// read / Vision-routing / label families plus lookup.
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
  // Codes QA scans onto a package. Array order is the canonical suggestion order
  // for the manual-entry datalist. isIbnoAuto marks the five the IBNO Coder
  // applies by rule; `trigger` records the condition (kept for the lookup slice).
  const APPLY_CODES = [
    { code: '11', meaning: 'Non-Res Recipient Closed on Saturday', isIbnoAuto: true,  trigger: 'Closure Portal / 9908, weekend' },
    { code: '33', meaning: 'Address search',                       isIbnoAuto: false },
    { code: '34', meaning: 'Inventory / Request Future Delivery',  isIbnoAuto: true,  trigger: 'Closure Portal, multi-day closure' },
    { code: '39', meaning: 'Damaged – Delivery Not Complete',      isIbnoAuto: false },
    { code: '59', meaning: 'Business Closed – No Attempt',         isIbnoAuto: true,  trigger: 'Closure Portal, weekday' },
    { code: '60', meaning: 'Returned to Shipper',                  isIbnoAuto: false },
    { code: '65', meaning: 'Misload from hub',                     isIbnoAuto: true,  trigger: 'Misload / Unassigned Zip / Preload SWAK' },
    { code: '94', meaning: 'Out for delivery tomorrow',           isIbnoAuto: true,  trigger: 'Hold to Match - 1 / - 2' },
    { code: '99', meaning: 'Unable to Deliver',                    isIbnoAuto: false },
  ];

  const applyCodeSet = new Set(APPLY_CODES.map(function (e) { return e.code; }));

  function normalize(code) {
    return String(code == null ? '' : code).trim();
  }

  // isKnownCode(code) -> true only for a code QA applies. Drives the IBNO Coder's
  // non-blocking manual-entry sanity check (#158): an out-of-set code still warns
  // but is allowed. Vision-routing (999) and label (889) codes are NOT "known"
  // for manual entry — they're reference-only in later slices.
  function isKnownCode(code) {
    return applyCodeSet.has(normalize(code));
  }

  // listApplyCodes() -> a fresh array of the apply-code numbers in canonical
  // order, for the datalist suggestions.
  function listApplyCodes() {
    return APPLY_CODES.map(function (e) { return e.code; });
  }

  return {
    isKnownCode: isKnownCode,
    listApplyCodes: listApplyCodes,
  };
});
