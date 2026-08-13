'use strict';

// Street-only extraction — the house number and street name of a package's
// address, without the unit, the city, the state or the ZIP.
//
// Dual-loadable with no build step:
// - Browser: window.StreetAddress
// - Node: require('./lib/street-address')
//
// ─── WHY THIS ISN'T A ONE-LINE SPLIT ────────────────────────────────────────
//
// "Everything before the first comma" looks right until it meets a real export.
// Two shapes from the 2026-07-08 Inbound and Van Scans report break it, both
// because the street line carries extra text with no comma to cut on:
//
//   36889 N TOM DARLINGTON DR 2800 149 UPS STORE, CAREFREE, AZ 85377
//   10240 NW 71ST TER DORAL - FLORIDA 33178, MIAMI, FL 33178
//
// The first glues a business name onto the street; the second glues a second
// city and ZIP onto it.
//
// ─── HOW IT CUTS ────────────────────────────────────────────────────────────
//
// lib/address-normalize.js already knows where a street ends: stripUnitTokens
// truncates right after the last street-suffix token (DR, TER, AVE, ST …),
// which is exactly the boundary wanted here, and it drops unit markers on the
// way. Rather than copy its street-suffix and unit vocabularies into a second
// table that could drift, this module asks stripUnitTokens HOW MANY tokens the
// street is, then returns that many tokens of the ORIGINAL string.
//
// The indirection buys one specific thing: stripUnitTokens canonicalizes for
// MATCHING — it uppercases and abbreviates, so "SOUTH" becomes "S". That is
// right for comparing two addresses and wrong for text a human is about to
// paste somewhere. Copy has to hand back what the label actually says.
//
// The token-count mapping holds because the folding is one-for-one up to the
// street suffix: a directional or suffix word is rewritten, never split or
// merged. It does NOT hold across a unit — stripUnitTokens DROPS unit markers,
// so past one, its count runs ahead of the original string. That matters
// because STREET_SUFFIXES holds ordinary words (PARK, RIDGE, SQUARE, COVE …),
// so a building name after the unit reads as a later suffix and pulls the
// truncation point past it (issue #645). streetOf therefore caps the count at
// the first unit marker in the ORIGINAL tokens; see the comment in the body.
//
// Where the mapping still fails the count is clamped to the original length, so
// the worst case is copying a little too much — never a truncated house number.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.StreetAddress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const AddressNormalize = (root && root.AddressNormalize) ||
      (typeof require === 'function' ? require('./address-normalize') : null);
    if (!AddressNormalize) {
      throw new Error('StreetAddress dependencies unavailable (need AddressNormalize)');
    }
    return { AddressNormalize: AddressNormalize };
  }

  // Suffixes that are routinely followed by a NUMBER that is part of the street
  // name, not a unit: "COUNTY ROAD 59", "HIGHWAY 60", "ROUTE 66". Cutting at the
  // suffix would drop that number and produce a different road entirely — a
  // wrong address, which is the one outcome worse than copying too much. Every
  // other suffix keeps the plain cut, so "TOM DARLINGTON DR 2800" still loses
  // its box number.
  const NUMBERED_ROUTE = {
    ROAD: true, RD: true, HIGHWAY: true, HWY: true, ROUTE: true, RTE: true,
    CR: true, FM: true, PIKE: true, LOOP: true,
  };

  // streetOf(address) -> "9782 E SOUTH BEND DR", or '' when the row has no
  // street to copy.
  //
  // Returns '' rather than a guess when the address does not begin with a house
  // number, or is a lone token. 14 of 45 review rows on the 2026-07-08 report
  // have an empty LABEL_ADDRESS1 and compose down to nothing but a ZIP; a copy
  // button on those would put "85032" on the clipboard as if it were an
  // address. Callers render no affordance at all on ''.
  function streetOf(address) {
    const full = String(address == null ? '' : address);
    const head = full.split(',')[0].replace(/\s+/g, ' ').trim();
    if (!head) return '';

    const tokens = head.split(' ').filter(Boolean);
    if (tokens.length < 2) return '';   // a bare ZIP is not a street
    if (!/^\d/.test(tokens[0])) return ''; // no house number, no street

    const AddressNormalize = deps().AddressNormalize;
    const folded = AddressNormalize.stripUnitTokens(head);
    if (!folded) return head;           // nothing recognized: hand back the line as-is

    let n = Math.min(folded.split(' ').filter(Boolean).length, tokens.length);

    // ─── THE FOLDED COUNT ALONE IS NOT A SAFE INDEX (issue #645) ────────────
    //
    // The header above claims the token mapping is one-for-one "because unit
    // markers appear after the suffix, not before it". Real addresses break
    // that: STREET_SUFFIXES holds ordinary words (PARK, RIDGE, POINT, SQUARE,
    // PLAZA, COVE, RUN, WAY), so a building or complex name trailing the unit
    // reads as a LATER street suffix. stripUnitTokens truncates at the last
    // one while DROPPING the unit markers, so its count runs past the unit in
    // the original string and lands mid-name:
    //
    //   5635 E BELL RD APT 1054 DESERT RIDGE  ->  5635 E BELL RD APT 1054 DESERT
    //
    // So cap n at the FIRST unit marker in the ORIGINAL tokens. The street
    // always ends before the unit begins, whatever follows it.
    //
    // hasUnitToken is reused per-token rather than adding a marker table here,
    // per this file's own warning about a second vocabulary that can drift. It
    // reads the superset (STE/SUITE/UNIT/APT/# plus LOT/TRLR/RM/BLDG) and
    // handles fused forms like "APT#" and "#1034".
    let unitIndex = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (AddressNormalize.hasUnitToken(tokens[i])) { unitIndex = i; break; }
    }
    // Only honor a cap that still leaves a street behind it. A marker at index
    // 0 or 1 means the line was never "house number + street name" in the first
    // place, and cutting there would hand back a bare house number.
    const unitCap = unitIndex >= 2 ? unitIndex : -1;
    if (unitCap !== -1) n = Math.min(n, unitCap);

    // Keep a route number that the suffix cut would have orphaned.
    const suffix = String(tokens[n - 1] || '').toUpperCase().replace(/[.,]/g, '');
    const next = tokens[n];
    if (next && NUMBERED_ROUTE[suffix] && /^\d+$/.test(next)) n += 1;
    // The bump must never carry n across the unit marker.
    if (unitCap !== -1) n = Math.min(n, unitCap);

    return tokens.slice(0, n).join(' ');
  }

  return { streetOf: streetOf };
});
