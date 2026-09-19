'use strict';

// THE STATION PANE'S TEAMS TEXT (#1001, spec #996 stories 27-29).
//
// When the Cage A Admin cannot find a station package, Tyler pastes the list of
// what is still out into Teams. Today he would retype it off the pane. This
// module is the one place that text is written, so the button, the unit test
// and any later surface produce the same bytes.
//
// WHAT IT LOOKS LIKE, and the shape is the ticket's, not a preference:
//
//   Station packages still out today (3)
//
//   789456123012  ACME SUPPLY  came in 9/8
//   789456123099  no firm name  came in 9/9, 2 days
//   789456123150  DESERT MED  came in 9/10
//
//   Let me know which ones you find.
//
// PLAIN TEXT, AND THAT IS A REQUIREMENT RATHER THAN A STYLE. No bullets, no
// markdown, no headers beyond the first line, no emoji: Teams renders a pasted
// `- ` as a list and a `#` as a heading, and a message that arrives looking
// generated is a message the Admin reads as generated. It is meant to read like
// Tyler typed it, which is also why the closing line is configurable
// (lib/station-config.js) instead of being a literal in here.
//
// THE POPULATION IS STILL-NEEDING, FILTERED IN HERE. A delivered row is on the
// pane and is not work left, and "needing" is StationStore.rowState — the SAME
// predicate the badge and the header counts read, never a second statement of
// it (ADR 0022: one predicate per question). A caller that handed in the whole
// pane and a caller that pre-filtered get the same answer, so the button cannot
// paste a package the Admin already walked to the office.
//
// THE COUNT IN THE HEADER IS THE NUMBER OF LINES BELOW IT. It is derived from
// the rows actually written, never passed in, because a header claiming 6 over
// 5 lines is the one defect this text can have that a reader will act on.
//
// "no firm name" IS WRITTEN OUT, exactly as the pane's cell does it: a blank
// gap in the middle of a line reads as the tool failing to load something,
// while "no firm name" is itself a fact the Admin can use to find the package.
//
// THE AGE IS ONLY ON A CARRIED ROW, through StationStore.ageNote, which is the
// same pill the pane draws. A row first seen today has its "came in" date and
// nothing more to say; ", 2 days" on every line would stop meaning anything.
//
// Dual-loadable with no build step:
// - Browser: window.StationCopy
// - Node:    require('./lib/station-copy')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.StationCopy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // Looked up LAZILY, the house pattern (lib/desk-roles.js): the browser loads
  // the script tags in order and Node resolves on first call, so neither loader
  // needs the dependency present at definition time.
  function dep(name, file) {
    const m = (root && root[name]) || (typeof require === 'function' ? require(file) : null);
    if (!m) throw new Error('StationCopy dependencies unavailable (need ' + name + ')');
    return m;
  }
  function storeLib() { return dep('StationStore', './station-store'); }
  function configLib() { return dep('StationConfig', './station-config'); }
  function sortDayLib() { return dep('SortDay', './sort-day'); }

  // The two fixed sentences. The closing line is NOT here: it is config.
  const HEADER = 'Station packages still out today';
  const EMPTY_LINE = 'No station packages are still out today.';

  // Two spaces between fields on a row. One space reads as a single run-on
  // token in a proportional font, and a tab is eaten by Teams.
  const GAP = '  ';

  function str(v) { return String(v == null ? '' : v).trim(); }

  // shortDate(iso) -> '9/8'. No leading zeros and no year: the message is about
  // packages that came in within the last few days, and "09/08/2026" is four
  // characters of ceremony on a line a person scans.
  function shortDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(iso));
    if (!m) return '';
    return String(Number(m[2])) + '/' + String(Number(m[3]));
  }

  // cameInDate(entry) -> the day the package came in, ISO, or ''.
  //
  // THE REPORT'S OWN INBOUND_DATE FIRST, with first-seen as the fallback — the
  // same order (and the same reason) as the pane's "Came in" cell: spec #996
  // story 12 is explicit that Tyler wants the day the package came in, not the
  // day this tool first saw it.
  function cameInDate(entry) {
    const SortDay = sortDayLib();
    const e = entry || {};
    return SortDay.parseInboundDate(e.inboundDate) ||
           SortDay.parseInboundDate(e.inboundDateRaw) ||
           SortDay.parseInboundDate(e.firstSeenDay) || '';
  }

  // needingRows(rows) -> the rows this text speaks about, in the order given.
  // Order is the caller's (the pane's) so the paste matches the screen it was
  // copied from.
  function needingRows(rows) {
    const Store = storeLib();
    return (Array.isArray(rows) ? rows : []).filter(function (entry) {
      return !!entry && str(entry.label) && Store.rowState(entry) !== 'delivered';
    });
  }

  // rowLine(entry, day) -> one package's line.
  //
  // A missing "came in" date DROPS THE SEGMENT rather than writing "came in ?"
  // or today's date. The tool does not know when it came in, and a date it
  // invented is a date the Admin would search on.
  function rowLine(entry, day) {
    const Store = storeLib();
    const e = entry || {};
    const parts = [str(e.label), str(e.firm) || 'no firm name'];
    const came = shortDate(cameInDate(e));
    if (came) {
      const age = Store.ageNote(e, day);
      parts.push('came in ' + came + (age ? ', ' + age.text : ''));
    }
    return parts.join(GAP);
  }

  // build(rows, opts) -> { text, lines, count }.
  //
  //   rows ..... the Station pane's rows (delivered ones are filtered in here)
  //   day ...... the sort day the pane is showing, for the age
  //   config ... the station config, for the closing line. Folded through
  //              StationConfig.load so a caller that passes nothing, or a
  //              config missing the field, still gets the shipped sign-off
  //              rather than a message that ends mid-air.
  //
  // `lines` is the same text split, because the page's shared clipboard write
  // (setAsideCopyWrite) takes lines and joins them — one write path for every
  // copy on the page, including its no-auto-revert failure paint.
  function build(rows, opts) {
    const o = opts || {};
    const config = configLib().load(o.config || null);
    const list = needingRows(rows);
    const day = o.day;

    // THE EMPTY CASE IS A DIFFERENT MESSAGE, not the header with a (0) and a
    // sign-off under it. "Let me know which ones you find" below an empty list
    // asks the Admin to go find nothing; the one sentence says the whole thing.
    // The button early-returns on an empty pane anyway (copyAll503's rule), so
    // this is the belt to that braces — but a builder that answered '' would
    // make an accidental empty write indistinguishable from a failed one.
    if (!list.length) {
      return { text: EMPTY_LINE, lines: [EMPTY_LINE], count: 0 };
    }

    const lines = [HEADER + ' (' + list.length + ')', ''];
    list.forEach(function (entry) { lines.push(rowLine(entry, day)); });
    lines.push('');
    lines.push(config.closingLine);
    return { text: lines.join('\n'), lines: lines, count: list.length };
  }

  return {
    HEADER: HEADER,
    EMPTY_LINE: EMPTY_LINE,
    GAP: GAP,
    shortDate: shortDate,
    cameInDate: cameInDate,
    needingRows: needingRows,
    rowLine: rowLine,
    build: build,
  };
});
