'use strict';

// Shift-click range selection over a list of row checkboxes (issue #736,
// spec #690, map #608).
//
// Dual-loadable with no build step:
// - Browser: window.RowRangeSelect
// - Node: require('./lib/row-range-select')
//
// Tyler's motivating case, 2026-08-19: "I was trying to only get a bundle of 12
// pkgs that I knew were going to the same WA but were different addresses. I
// had to select each individually which was tedious."
//
// ─── WHY THIS IS A LIB AND NOT TWELVE LINES IN THE PAGE ──────────────────────
//
// The click handling is small. The SCOPING RULES are not, and #737 (group and
// sort the working list by ZIP and ISP) builds its band-select control on
// exactly these rules — a band header's "select the band" is the same act with
// a different row set. Writing the rules inline would mean #737 either
// re-derives them or hand-copies them, which is the drift class /code-review
// caught on `laneRowsWithArea` and `selectRowsWithArea` in #642 finding 8: two
// copies of one definition, and a control that promises N and selects N+1.
//
// So the rules live here, once, and both consumers call them. #737 injects its
// own row set through `rows` (or its own `match` into `scopeRows`) and calls
// `applyRange` with the same hooks; it never re-implements membership.
//
// ─── THE SCOPING RULES, IN FULL ──────────────────────────────────────────────
//
// 1. SCOPE IS THE CLICKED ROW'S OWN LANE, and a range never crosses one.
//    The caller passes the scope element — in ibno-coder.html that is the
//    checkbox's own <tbody>, the same `laneBody(el)` scope every other
//    selection control in the tool uses. The lanes are worked separately and a
//    mixed selection is a mixed research copy, which the copy controls already
//    refuse. The anchor is tracked PER SCOPE (see `createAnchors`), so a plain
//    click in express can never anchor a shift-click in ground.
//
// 2. "BETWEEN THEM" MEANS BETWEEN ON SCREEN, RIGHT NOW, IN DISPLAY ORDER.
//    Membership is read off the live DOM in document order, which for these
//    tables IS display order: sorting and grouping re-render the rows into the
//    order they are painted in. So a sort change, a chip, a search or a regroup
//    does not need to be known about here — whatever is on screen when the
//    shift-click lands is what the range spans. This matches every other
//    selection control in this tool (see the DOM-scoping argument in
//    `laneRowsWithArea`'s comment, #667 finding 3, and the bucket select-all's
//    own #669 finding 3 comment arguing it from the other direction).
//
// 3. A ROW THAT IS NOT RENDERED IS NOT IN THE RANGE, and is not touched.
//    Two ways a row is not rendered: it is not in the DOM at all (the Post Sort
//    disposition fold, #657, simply does not render folded rows), or it is in
//    the DOM with `display:none` (a collapsed bucket, a search miss, a chip
//    slice, the coded-count chip). Both are skipped, and neither BLOCKS the
//    range: the span runs from anchor to target through the rows that ARE on
//    screen, and a hidden row sitting between them is left exactly as it was.
//    Visibility is read off the inline `display` the renderers write, because
//    that is what `applyManualSearch` sets and it is the only thing that is
//    true on a fresh load, where every bucket is collapsed (the standing
//    landmine from spec #690: collapsed rows are display:none).
//
// 4. A ROW WITH NO CHECKBOX IS NOT IN THE RANGE.
//    A CODED row has none: `markRowCoded` removes it deliberately so that no
//    bulk path can re-resolve a resolved row. Group header rows carry a
//    `.manual-check` but no `data-label`, so the row selector excludes them.
//    Detail rows carry neither.
//
// 5. THE RANGE TAKES THE ANCHOR'S STATE, not the target's.
//    "Every checkbox between them takes the state of the click that started the
//    range" (#736). The anchor's checkbox is read LIVE at shift-click time, so
//    unchecking the anchor and then shift-clicking UNCHECKS the range. The
//    target is included and is forced to the anchor's state too, overriding the
//    toggle the browser already applied to it — which is why a caller must run
//    this from a `click` listener (where `checked` is already toggled) and must
//    not try to do it from `change`.
//
// 6. AN ANCHOR THAT IS NO LONGER THERE DEGRADES TO A PLAIN CLICK.
//    If the anchor row has left the scope — folded out, filtered out, coded,
//    re-rendered away, or the scope has never been clicked in — the shift-click
//    selects nothing extra: it toggles its own row and becomes the new anchor.
//    Nothing is guessed. A stale anchor never silently ranges from a row the
//    supervisor can no longer see.
//
// 7. A RANGE DOES NOT MOVE THE ANCHOR.
//    Shift-clicking again re-ranges from the same anchor, so a range can be
//    widened or narrowed without re-clicking the start. Only a plain click (or
//    a degraded shift-click) moves it.
//
// 8. THIS MODULE ONLY TICKS BOXES. It never codes, resolves, prints, files or
//    copies anything, so it is not a way around any existing refusal. Every
//    downstream guard still runs on the resulting selection: #667's barcode
//    gating still prints NOTHING and says why for a row with no resolved
//    barcode or with two conflicting ones, bulk apply still honours
//    `data-bulk` eligibility, and the copy controls still refuse a mixed
//    selection. A range can put a refusable row in the selection exactly as
//    twelve individual clicks could; the refusal is unchanged.
//
// The caller owns the side effects. `applyRange` sets `checked` and calls back
// per row, so bookkeeping the DOM cannot hold — `postSortChecked`, which is the
// record for early Post Sort rows once rows can fold out of the DOM (#658
// finding 2) — is written by the page, in one place, for every row a range
// touched.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RowRangeSelect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const ROW_SELECTOR = 'tr[data-label]';
  const CHECKBOX_SELECTOR = '.manual-check';
  const ID_ATTR = 'data-label';

  // Rule 3's visibility test. Inline display only, on purpose: it is what the
  // renderers write, and getComputedStyle would answer for a detached or
  // never-laid-out row in ways that differ between a browser and jsdom.
  function isRendered(el) {
    if (!el) return false;
    if (el.hidden) return false;
    const style = el.style;
    if (style && String(style.display || '') === 'none') return false;
    return true;
  }

  function opt(opts, key, fallback) {
    return opts && opts[key] != null ? opts[key] : fallback;
  }

  // scopeRows(scopeEl, opts) -> the rows a range may span, in display order,
  // as [{ id, tr, cb }].
  //
  // Rules 1-4 all land here. opts:
  //   rowSelector      default 'tr[data-label]'
  //   checkboxSelector default '.manual-check'
  //   idAttr           default 'data-label'
  //   rendered         default the inline-display test above
  //   match            optional extra predicate (tr) -> boolean. #737's band
  //                    select passes its band key through this.
  function scopeRows(scopeEl, opts) {
    const out = [];
    if (!scopeEl || typeof scopeEl.querySelectorAll !== 'function') return out;
    const rowSelector = opt(opts, 'rowSelector', ROW_SELECTOR);
    const checkboxSelector = opt(opts, 'checkboxSelector', CHECKBOX_SELECTOR);
    const idAttr = opt(opts, 'idAttr', ID_ATTR);
    const rendered = opt(opts, 'rendered', isRendered);
    const match = opt(opts, 'match', null);
    const list = scopeEl.querySelectorAll(rowSelector);
    for (let i = 0; i < list.length; i++) {
      const tr = list[i];
      if (!rendered(tr)) continue;                       // rule 3
      const cb = tr.querySelector(checkboxSelector);
      if (!cb) continue;                                 // rule 4
      if (match && !match(tr)) continue;
      const id = tr.getAttribute(idAttr);
      if (!id) continue;
      out.push({ id: id, tr: tr, cb: cb });
    }
    return out;
  }

  function indexOfId(rows, id) {
    if (id == null) return -1;
    for (let i = 0; i < rows.length; i++) if (rows[i].id === id) return i;
    return -1;
  }

  // rangeBetween(rows, anchorId, targetId) -> the INCLUSIVE span, or null when
  // either end is not in `rows` (rule 6). Direction-agnostic: shift-clicking
  // upward spans the same rows as shift-clicking downward.
  function rangeBetween(rows, anchorId, targetId) {
    const list = rows || [];
    const a = indexOfId(list, anchorId);
    const b = indexOfId(list, targetId);
    if (a === -1 || b === -1) return null;
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    return {
      anchorIndex: a,
      targetIndex: b,
      rows: list.slice(from, to + 1),
    };
  }

  // applyRange(rows, checked, onRow) -> force every row in `rows` to `checked`
  // and hand each one to the caller. Returns the rows it touched.
  //
  // Sets `.checked` as a property, which fires NO change event — so the caller's
  // onRow is the ONLY place per-row bookkeeping happens, and it must do all of
  // it (the highlight class, `postSortChecked`). #669 finding 9 is the receipt
  // for what happens when a programmatic assignment is assumed to fire one.
  function applyRange(rows, checked, onRow) {
    const list = rows || [];
    const want = !!checked;
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (entry.cb) entry.cb.checked = want;
      if (typeof onRow === 'function') onRow(entry, want);
    }
    return list;
  }

  // createAnchors() -> the per-scope anchor tracker (rules 1, 6, 7).
  //
  // Keyed by a caller-chosen scope key (the lane's tbody id in ibno-coder).
  // `clear` exists for the page's own reset paths: a new report is a new list,
  // and an anchor pointing into the last one must not survive it.
  function createAnchors() {
    const byScope = Object.create(null);
    return {
      get: function (scope) {
        const key = String(scope == null ? '' : scope);
        return Object.prototype.hasOwnProperty.call(byScope, key) ? byScope[key] : null;
      },
      set: function (scope, id) {
        byScope[String(scope == null ? '' : scope)] = id == null ? null : String(id);
      },
      clear: function (scope) { delete byScope[String(scope == null ? '' : scope)]; },
      clearAll: function () { Object.keys(byScope).forEach(k => { delete byScope[k]; }); },
    };
  }

  // handleClick(cfg) -> the whole gesture, in one call.
  //
  // cfg:
  //   anchors    a createAnchors() tracker (required)
  //   scopeKey   which lane this click is in (required)
  //   scopeEl    the element to walk for rows; ignored when `rows` is given
  //   rows       pre-scoped rows, for a caller that already has them (#737)
  //   opts       scopeRows options
  //   id         the clicked row's id
  //   shiftKey   was shift held
  //   onRow      per-row callback, see applyRange
  //
  // Answers { kind, rows, checked }:
  //   'plain'    an ordinary click; the anchor moved here
  //   'degraded' shift held but no usable anchor; treated as plain (rule 6)
  //   'range'    a span was applied
  //
  // A 'plain' or 'degraded' answer touches NOTHING — the browser's own toggle
  // of the clicked box stands, and the page's existing change handler does its
  // usual bookkeeping. Only 'range' needs the caller to refresh counts.
  function handleClick(cfg) {
    const c = cfg || {};
    const anchors = c.anchors;
    const scopeKey = c.scopeKey;
    const id = c.id;
    if (!anchors || id == null) return { kind: 'plain', rows: [], checked: null };

    if (!c.shiftKey) {
      anchors.set(scopeKey, id);
      return { kind: 'plain', rows: [], checked: null };
    }

    const rows = c.rows || scopeRows(c.scopeEl, c.opts);
    const anchorId = anchors.get(scopeKey);
    const span = anchorId == null ? null : rangeBetween(rows, anchorId, id);
    if (!span) {
      anchors.set(scopeKey, id);                        // rule 6
      return { kind: 'degraded', rows: [], checked: null };
    }

    // Rule 5: the state comes off the anchor's own box, read live.
    const anchorEntry = rows[span.anchorIndex];
    const checked = !!(anchorEntry && anchorEntry.cb && anchorEntry.cb.checked);
    applyRange(span.rows, checked, c.onRow);
    // Rule 7: the anchor stays put so the range can be widened or narrowed.
    return { kind: 'range', rows: span.rows, checked: checked };
  }

  return {
    isRendered: isRendered,
    scopeRows: scopeRows,
    indexOfId: indexOfId,
    rangeBetween: rangeBetween,
    applyRange: applyRange,
    createAnchors: createAnchors,
    handleClick: handleClick,
  };
});
