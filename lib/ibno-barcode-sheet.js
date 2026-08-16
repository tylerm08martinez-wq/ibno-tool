'use strict';

// The barcode SHEET's own planning rules (issue #700, spec #690 stories 23/26).
//
// Dual-loadable with no build step:
// - Browser: window.IbnoBarcodeSheet
// - Node: require('./lib/ibno-barcode-sheet')
//
// WHAT LIVES HERE and what does not. The sheet's *barcode* decisions — which
// half of an overlapping selection wins, and whether a card may be printed at
// all — belong to lib/post-sort-lane.js (the #693 extraction: dedupeLaneBarcode
// Entries, planBarcodePrint, barcodePrintDecision). Nothing in this module
// re-decides any of that; ibno-coder.html plans THROUGH post-sort-lane first
// and hands the surviving cards here for LAYOUT and for the area rule. Two
// modules deciding "may this barcode print" is exactly how a bare tracking
// number reaches paper (#667), so there is only ever one.
//
// This module answers three questions, all of them about the paper:
//
//   1. Is this address a real physical stop? (the invariant, below)
//   2. Which cards band together as one street, and where does each card sit
//      in its band? (round 23/24/25)
//   3. What may the card's big AREA line say? (round 27)
//
// ─── THE STOP-KEY PHYSICAL-ADDRESS INVARIANT ────────────────────────────────
//
// A stop is a NUMBER AND A NAME, or there is no stop.
//
// Found by Tyler on prototype round 24: zip-only and blank addresses were
// banding together as "same stop" on the sheet, because they compose down to
// identical junk strings ("85032", ""). A band is a claim that ONE FRO lookup
// covers every card in it — so banding two unrelated packages that merely share
// a ZIP is a claim to walk a package to the wrong belt.
//
// WHERE THE RULE ACTUALLY LIVES: lib/actual-area.js (isMatchable — leads with a
// house number and carries at least one more token). That module is what
// enforces it for dock-flex propagation; this one only composes it, so the
// sheet cannot drift from the thing propagation uses. Nothing here guards
// propagation, and no caller of this module should be relied on to.
//
// stopKey and hasPhysicalStop below are exported as the sheet's NAMED view of
// that shared rule — a seam the invariant's own unit test can address (spec
// #690 asks for exactly that test) and the granularity the sheet's bands are
// deliberately NOT using. They are one-liners on purpose; the value is that the
// two granularities are stated where the sheet's reader is looking:
//
//   stopKey(address)  unit-EXACT. "APT 171" and "APT 370" are different stops.
//                     This is the granularity dock flex propagates on (#612):
//                     an area typed on one apartment never spreads to another.
//
//   bandKey(address)  STREET-level, units stripped. "APT 171" and "APT 370" are
//                     ONE band. Tyler's Butler catch (round 24): 6767 W Butler
//                     Dr APT 171 and APT 370 are one FRO lookup and one walk,
//                     so the sheet must show them together even though dock
//                     flex will not spread between them. Visibility loose,
//                     spread exact.
//
// Both return '' for anything that is not a physical stop, and '' never bands.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IbnoBarcodeSheet = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const ActualArea = (root && root.ActualArea) ||
      (typeof require === 'function' ? require('./actual-area') : null);
    if (!ActualArea) {
      throw new Error('IbnoBarcodeSheet dependencies unavailable (need ActualArea)');
    }
    return { ActualArea: ActualArea };
  }

  function str(v) {
    return String(v == null ? '' : v);
  }

  // ─── THE INVARIANT ────────────────────────────────────────────────────────

  // stopKey(address) -> the unit-exact key, or '' when there is no stop.
  function stopKey(address) {
    return deps().ActualArea.exactKey(address);
  }

  // bandKey(address) -> the street-level key the SHEET bands on, or '' when
  // there is no stop. Units stripped; a real street still required.
  function bandKey(address) {
    return deps().ActualArea.clusterKey(address);
  }

  // hasPhysicalStop(address) -> does this address name a real place at all?
  //
  // Expressed against the BAND key because that is the looser of the two: an
  // address with no street-level key has no unit-level one worth trusting
  // either, and the sheet's question is always "may this row band".
  function hasPhysicalStop(address) {
    return bandKey(address) !== '';
  }

  // ─── THE CARD'S AREA (round 27, spec story 26) ────────────────────────────
  //
  // The big line on a card is a COMMAND: whoever picks the package up walks it
  // to what that line says. So only an area Tyler actually decided may appear
  // there; everything else shows a dash and sends the package back to a human.
  //
  // Tyler's catch on round 27: cards were falling back to the report's own work
  // area, so a card read "999" in 30px type — which reads as "send it to 999",
  // a place no package goes.
  //
  // PRINTABLE PROVENANCE, and why each one qualifies:
  //   typed   Tyler typed it on this row. The case the feature exists for.
  //   auto    dock flex spread Tyler's typed area across the stop, unit-exact
  //           and guarded by the invariant above (lib/actual-area.js). It is
  //           the same decision he typed, applied to the same physical stop —
  //           dashing these would put a dash on every card of a band but one,
  //           which is the whole point of banding undone.
  //   early   Tyler typed it in the Post Sort pre-assignment lane (#634). Still
  //           his decision, just made against the earlier report, so it prints
  //           WITH the on-card UNCONFIRMED mark that #642 decided on. That mark
  //           is the card's honesty, not a dash.
  //
  // REFUSED, and why:
  //   report  IB_WORK_AREA and friends. The report's area is frequently the
  //           very thing that flagged the row for review.
  //   carried an area typed on an EARLIER sort day (lib/sort-day.js). A route
  //           can move overnight; a carried area is a dated NOTE on the row and
  //           never a command on paper (spec story 20).
  //   anything else, including a missing or unrecognised provenance — the rule
  //           is an allowlist on purpose, so a provenance nobody has thought
  //           about yet fails closed, to a dash.
  const PRINTABLE_PROVENANCE = ['typed', 'auto', 'early'];

  // cardArea(entry) -> the string the card may print, or '' for the dash.
  //
  // entry: { area, provenance }. It reads NOTHING else — deliberately. Passing
  // the whole row here would let a future edit reach entry.workArea for a
  // "nicer" fallback, which is precisely the regression round 27 fixed.
  function cardArea(entry) {
    const e = entry || {};
    const area = str(e.area).trim();
    if (!area) return '';
    return PRINTABLE_PROVENANCE.indexOf(str(e.provenance)) === -1 ? '' : area;
  }

  // ─── BANDS (rounds 23, 24, 25) ────────────────────────────────────────────

  // planSheetBands(cards) -> { groups, cardCount, bandCount, bandedCardCount }
  //
  // `cards` is the sheet's cards IN PRINT ORDER, each at least { label,
  // address }, optionally { street } (the number-and-name form the row already
  // shows; used for the band's label so the sheet and the list read the same).
  // Whatever else a card carries rides along untouched on `group.cards[].card`,
  // so the renderer stays free to put anything on the card itself.
  //
  // Returns groups in PRINT ORDER:
  //   1. real bands (2+ cards sharing a street), BIGGEST FIRST — the stops
  //      where one FRO lookup pays off most are the ones to walk first;
  //   2. every other card as its own single-card group, in the order it was
  //      given, so a sheet with no bands prints exactly as it always has.
  //
  // Ties among equal-sized bands keep first-appearance order, so the sheet is
  // stable across re-prints of the same selection.
  //
  // Each card carries `position` and `of` (the "2 of 5" pill). Singles get
  // 1 of 1, and the renderer shows the pill only when `of` > 1 — the number
  // exists so walking the dock can tell "I have all five of these" from "I am
  // missing one", which a bare band label cannot say once the cards are split
  // across two printed pages.
  //
  // A card with NO physical stop (the invariant) is never banded, even with
  // another address-less card: identical junk is not a shared destination.
  function planSheetBands(cards) {
    const list = Array.isArray(cards) ? cards : [];
    const bands = new Map();   // key -> { key, street, cards: [], order }
    const singles = [];        // { card, order }

    list.forEach(function (card, index) {
      // A missing card is dropped rather than given a slot: every caller reads
      // group.cards[].card.label straight back out, so keeping the slot would
      // hand the renderer a null to dereference. Unreachable from
      // ibno-coder.html (it filters before calling), pinned here because this
      // is a shared seam and the next caller will not know that.
      if (!card) return;
      const key = bandKey(card && card.address);
      if (!key) { singles.push({ card: card, order: index }); return; }
      let band = bands.get(key);
      if (!band) {
        band = { key: key, street: '', cards: [], order: index };
        bands.set(key, band);
      }
      if (!band.street) band.street = str(card && card.street).trim();
      band.cards.push(card);
    });

    const real = [];
    bands.forEach(function (band) {
      // A band of one is not a band. It rejoins the singles at its own
      // original position rather than leading the sheet, so a lone card never
      // outranks a genuine pair.
      if (band.cards.length < 2) { singles.push({ card: band.cards[0], order: band.order }); return; }
      real.push(band);
    });

    real.sort(function (a, b) {
      return (b.cards.length - a.cards.length) || (a.order - b.order);
    });
    singles.sort(function (a, b) { return a.order - b.order; });

    const groups = real.map(function (band) {
      return {
        key: band.key,
        banded: true,
        size: band.cards.length,
        street: band.street || band.key,
        label: 'same street × ' + band.cards.length,
        cards: band.cards.map(function (card, i) {
          return { card: card, position: i + 1, of: band.cards.length };
        }),
      };
    }).concat(singles.map(function (s) {
      return {
        key: bandKey(s.card && s.card.address),
        banded: false,
        size: 1,
        street: str(s.card && s.card.street).trim(),
        label: '',
        cards: [{ card: s.card, position: 1, of: 1 }],
      };
    }));

    let bandedCardCount = 0;
    let cardCount = 0;
    groups.forEach(function (g) {
      cardCount += g.cards.length;
      if (g.banded) bandedCardCount += g.size;
    });

    return {
      groups: groups,
      // What was actually PLACED, which is what the sheet header counts. It
      // equals the input length for every real caller and differs only when a
      // missing card was dropped above.
      cardCount: cardCount,
      bandCount: real.length,
      bandedCardCount: bandedCardCount,
    };
  }

  return {
    PRINTABLE_PROVENANCE: PRINTABLE_PROVENANCE,
    stopKey: stopKey,
    bandKey: bandKey,
    hasPhysicalStop: hasPhysicalStop,
    cardArea: cardArea,
    planSheetBands: planSheetBands,
  };
});
