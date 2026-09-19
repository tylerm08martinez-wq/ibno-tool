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
  //   remote  the OTHER DESK typed it, arriving over the 999 Desk live area
  //           lane (#913, ActualArea.setRemote). Admitted by #1038, and it is a
  //           DECISION, reversing the one recorded when #913 shipped.
  //
  //           Why it belongs here. The allowlist's question is "did a PERSON
  //           decide this stop's belt", not "did a person at THIS keyboard".
  //           Under the 999 Desk there are two people on one list (ADR 0023),
  //           each doing the same FRO lookup against the same physical stop, so
  //           the other desk's Goes To is the same KIND of answer as 'typed' —
  //           it merely has someone else's name on it, which `by` already
  //           carries (#793). Refusing it did not make the sheet safer; it made
  //           the sheet DISAGREE WITH THE ROW on the very same screen. Tyler,
  //           2026-09-17: "When I assign the Goes To it shows up for the admin,
  //           but when they generate barcodes it shows only the dash, so they
  //           don't know where to assign it." A dash there is not a fail-closed
  //           guard doing work — the area is on screen, so the handler either
  //           walks the package back to a human who reads it off the row, or
  //           guesses. Symmetric on both desks, because both receive through
  //           the same lane.
  //
  //           It prints PLAIN, with no UNCONFIRMED mark. That mark (#642) means
  //           "typed against an earlier report and not yet confirmed against a
  //           scan", which is a statement about the REPORT a value was typed
  //           against, not about who typed it — so 'remote' is the answer for
  //           an area the other desk CONFIRMED, and only for that. An area
  //           they had not confirmed is the fifth answer below, because the
  //           doubt is the same doubt whichever keyboard it was typed on.
  //
  //   remote-unconfirmed
  //           the OTHER DESK typed it AND their envelope made no confirmation
  //           claim about it (#1051, RemoteAreas VERSION 2). It prints WITH
  //           the #642 mark, so the card reads the same on both desks for the
  //           same package — which is the whole ticket. Before it existed, an
  //           `early` Post Sort area (which is every Goes To on a normal sort
  //           day, and Tyler, 2026-09-17: "the admins only use the post sort")
  //           was published as an area with no provenance and printed caveated
  //           on the desk that typed it and CONFIDENT on the desk that
  //           received it. The doubt was erased in transit, on the only lane in
  //           use, in both directions.
  //
  //           IT IS ITS OWN ANSWER RATHER THAN `early` STUFFED ONTO A REMOTE
  //           ENTRY. `early` means "pre-filled by THIS device's Post Sort lane"
  //           and `.early-tag` renders straight off it; one flag answering two
  //           questions is the #740 class ADR 0022 exists about. It is equally
  //           not `remote` with a side-channel, because the allowlist is the
  //           one place that decides what may occupy the 30px line.
  //
  //           AN ENVELOPE THAT DOES NOT SAY LANDS HERE, and that is the
  //           fail-closed direction, not an accident: a VERSION 1 file, a
  //           store persisted before #1051, a hand-placed file. A redundant
  //           caveat costs a second glance; a missing one costs a walk.
  //
  //           What did NOT change. `remote` is still a fourth INDEPENDENT flag
  //           (ADR 0022), `hasKnownProvenance` still stays false for it, and
  //           `reflow` still refuses a remote entry as a propagation SOURCE —
  //           printing the card the other desk's person decided is not the same
  //           permission as spreading their answer onto packages nobody saw.
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
  const PRINTABLE_PROVENANCE = ['typed', 'auto', 'early', 'remote', 'remote-unconfirmed'];

  // WHICH PRINTABLE PROVENANCES CARRY THE #642 MARK. An allowlist for the same
  // reason the one above is: a provenance nobody has thought about yet gets no
  // mark because it gets no AREA, and one that is admitted to the card later
  // has to come here and decide, rather than defaulting into silence.
  //
  // IT LIVES BESIDE THE ALLOWLIST ON PURPOSE. Until #1051 the page asked
  // `ActualArea.isEarly` directly, which is the store's answer to a DIFFERENT
  // question — "did this device's Post Sort lane write it" — and it is false
  // for an area the other desk had not confirmed. Two rules about one 30px
  // line, in two files, is how they drift; the card's honesty is decided here,
  // next to what the card may say at all.
  const UNCONFIRMED_PROVENANCE = ['early', 'remote-unconfirmed'];

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

  // cardUnconfirmed(entry) -> does this card carry the #642 UNCONFIRMED line?
  //
  // Same `{ area, provenance }` it reads for cardArea, and it reads nothing
  // else for the same reason. TRUE ONLY WHEN THE CARD ACTUALLY PRINTS AN AREA:
  // a dashed card has nothing to caveat, and a caveat under a dash would read
  // as a doubt about a belt number that is not there.
  function cardUnconfirmed(entry) {
    if (!cardArea(entry)) return false;
    return UNCONFIRMED_PROVENANCE.indexOf(str((entry || {}).provenance)) !== -1;
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

  // ─── WHAT IS ACTUALLY ON THE PAPER (#704, chip-count honesty) ─────────────
  //
  // Round 26 was "Multi-stop says 4, clicking it shows 2": a count computed
  // over one population while a DIFFERENT population is rendered. On the sheet
  // that class is worse than on a chip, because the number in the header is how
  // Tyler answers "did I lose a page?" — a header promising 6 over a 4-card
  // sheet sends him hunting for two packages that were never printed, or worse,
  // stops him hunting for two that were.
  //
  // The fix is structural rather than careful: BOTH the header count and the
  // done count are derived from `plan.groups` — the very structure the renderer
  // walks to emit cards — so they cannot be computed over anything else without
  // the renderer changing too. Nothing here re-reads the caller's request list.
  //
  // sheetLabels(plan) -> every label PLACED on the sheet, in print order.
  // Duplicates are preserved: two cards is two cards, and a header that quietly
  // de-duplicated would disagree with the paper in the other direction.
  function sheetLabels(plan) {
    const groups = (plan && Array.isArray(plan.groups)) ? plan.groups : [];
    const out = [];
    groups.forEach(function (g) {
      (g && Array.isArray(g.cards) ? g.cards : []).forEach(function (c) {
        out.push(str(c && c.card && c.card.label));
      });
    });
    return out;
  }

  // sheetProgress(plan, isDone) -> { cards, done } for the sheet header.
  //
  // `isDone(label)` is injected rather than a store being passed in, so this
  // module never learns what a tick store looks like (that is
  // lib/barcode-done.js's, and only its).
  //
  // `done` de-duplicates by label while `cards` does not, deliberately: the tick
  // is per PACKAGE, so one tracking number printed twice is one thing ticked on
  // two pieces of card, and counting it twice would let "done" exceed "cards"
  // for a sheet nobody finished.
  function sheetProgress(plan, isDone) {
    const labels = sheetLabels(plan);
    const fn = typeof isDone === 'function' ? isDone : function () { return false; };
    const seen = new Set();
    labels.forEach(function (l) { if (l && fn(l)) seen.add(l); });
    return { cards: labels.length, done: seen.size };
  }

  // ─── GROUP DONE (#704, prototype round 27 item 2) ─────────────────────────
  //
  // One tick finishes the whole stop. Individual ticks still work, and this is
  // expressed AS a set of individual ticks rather than as a band-level flag:
  // there is no "band done" state anywhere, only N labels that are each done,
  // so ticking a band and ticking its cards one at a time leave the store in
  // byte-identical shape and nothing downstream can tell them apart.
  //
  // ADR 0022, INVARIANT 1, AND WHY THIS DOES NOT BREAK IT. "Worked never
  // implies scanned": a dock-flexed sibling is worked and is NOT scanned,
  // because propagation is an INFERENCE the tool made. Group done is not an
  // inference — it is a human assertion, made by a person standing at the stop
  // with the packages in hand, that all N of them are handled. The tool derives
  // nothing; it records what it was told, once per label, through the same
  // single-label path a card click uses. Invariant 5 ("nothing PROPAGATED may
  // satisfy scanned") is likewise untouched: no propagation is involved.
  //
  // bandDoneState(group, isDone) -> { labels, total, done, allDone }
  function bandDoneState(group, isDone) {
    const cards = (group && Array.isArray(group.cards)) ? group.cards : [];
    const fn = typeof isDone === 'function' ? isDone : function () { return false; };
    const labels = cards.map(function (c) { return str(c && c.card && c.card.label); })
      .filter(Boolean);
    let done = 0;
    labels.forEach(function (l) { if (fn(l)) done++; });
    return {
      labels: labels,
      total: labels.length,
      done: done,
      // An EMPTY band is not "all done". Vacuous truth here would make the one
      // group-done click untick a band it had nothing to say about.
      allDone: labels.length > 0 && done === labels.length,
    };
  }

  // bandToggleTarget(group, isDone) -> what ONE group-done click should set
  // every card in the band to. Fully ticked bands untick (round 27: "a second
  // click unticks"); anything else — including a part-ticked band — ticks, so
  // the common motion of finishing a stop is always one click and never two.
  function bandToggleTarget(group, isDone) {
    return !bandDoneState(group, isDone).allDone;
  }

  // ─── ONE DEFINITION OF THE GROUP-DONE RULE (#873) ─────────────────────────
  //
  // The sheet is a GENERATED DOCUMENT: document.write'n into an about:blank
  // pop-up on the main path, and set as an <iframe srcdoc> on the blocked-
  // pop-up fallback. It cannot `<script src>` this module — about:blank has no
  // base URL for a relative src to resolve against, and even where one could
  // be forced, a separately fetched script would race the inline handler that
  // needs it, on a document whose whole point is that it still works when the
  // network and the opener are gone.
  //
  // So before #873 the rule was RESTATED in ibno-coder.html's inline sheet
  // script, with a comment pointing here and NOTHING pinning the two together.
  // Measured on origin/main at 00897f1: inverting bandToggleTarget above left
  // tests/ibno-sheet-scan-mode-dom.test.js at 17 passed, 0 failed — an edit
  // here fixed nothing, the suite stayed green, and the paper a handler
  // carries to a belt kept the old rule. That is the csp-zip-breakdown.html
  // duplication without csp-zip-breakdown.html's drift-guard chain.
  //
  // The sheet therefore does not restate the rule; it CARRIES it.
  // bandRuleSource() serializes THESE VERY FUNCTION OBJECTS, and the sheet
  // builder splices the result into the sheet's own <script>. There is one
  // definition — this one — and the sheet's copy is a transport of it, minted
  // at print time. Change bandToggleTarget and the sheet changes with it.
  //
  // `str` travels too because bandDoneState calls it; a transport that dropped
  // a dependency would produce a sheet that throws on the first band click.
  // tests/ibno-sheet-band-rule-source-dom.test.js pins both halves: that the
  // emitted sheet carries this module's own source, and that a MUTATED rule
  // reaches the sheet's behaviour.
  function bandRuleSource() {
    return [str, bandDoneState, bandToggleTarget]
      .map(function (f) { return f.toString(); })
      .join('\n') + '\n';
  }

  return {
    PRINTABLE_PROVENANCE: PRINTABLE_PROVENANCE,
    UNCONFIRMED_PROVENANCE: UNCONFIRMED_PROVENANCE,
    stopKey: stopKey,
    bandKey: bandKey,
    hasPhysicalStop: hasPhysicalStop,
    cardArea: cardArea,
    cardUnconfirmed: cardUnconfirmed,
    planSheetBands: planSheetBands,
    sheetLabels: sheetLabels,
    sheetProgress: sheetProgress,
    bandDoneState: bandDoneState,
    bandToggleTarget: bandToggleTarget,
    bandRuleSource: bandRuleSource,
  };
});
