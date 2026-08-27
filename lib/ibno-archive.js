'use strict';

// Device-local accumulating archive behind the IBNO Coder's global search (#286).
//
// The Coder's tables show only the flagged/coded subset of a single file. This
// archive instead keeps EVERY row of EVERY CSV loaded over time so any tracking
// number or address can be looked up with all of its columns intact — full
// access to the raw data. It accumulates across loads (deduped), prunes to the
// same 30-day window the repeat-history uses (so it can't grow without bound),
// and matches a query against any field.
//
// PRIVACY: this archive is localStorage-only. It is NEVER synced to GitHub and
// never written to the repo — recipient/address data stays on the device.
//
// Pure + storage-agnostic (the page persists/loads the array). Dual-loadable,
// no build step (mirrors lib/in-area-12.js): reuses IbnoRules for the single
// date normalizer + preamble detection so date logic lives in one place.
//
// - Browser: window.IbnoArchive
// - Node: require('./lib/ibno-archive')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IbnoArchive = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  const ARCHIVE_DAYS = 30; // matches IbnoRules.HISTORY_DAYS — one retention window.

  function rules() {
    if (root && root.IbnoRules) return root.IbnoRules;
    if (typeof require === 'function') return require('./ibno-rules');
    throw new Error('IbnoArchive needs IbnoRules (load lib/ibno-rules.js first)');
  }

  // Same lazy dual-load resolution for the two render helpers buildSearchRecord
  // needs. Lazy on purpose: the page's <script> order is then irrelevant, and a
  // caller that never renders a record never pays for them.
  function helpers() {
    if (root && root.ToolHelpers) return root.ToolHelpers;
    if (typeof require === 'function') return require('./tool-helpers');
    throw new Error('IbnoArchive needs ToolHelpers (load lib/tool-helpers.js first)');
  }

  function ftrack() {
    if (root && root.FTrack) return root.FTrack;
    if (typeof require === 'function') return require('./ftrack');
    throw new Error('IbnoArchive needs FTrack (load lib/ftrack.js first)');
  }

  // Build one plain record object per data row, keyed by the header column names.
  // Strips any SSRS preamble first (via IbnoRules.findHeaderIndex) so rows[0] is
  // the real header. Keeps every column so search can show all of the data.
  function recordsFromRows(rows) {
    if (!Array.isArray(rows) || rows.length < 2) return [];
    const R = rules();
    const start = typeof R.findHeaderIndex === 'function' ? R.findHeaderIndex(rows) : 0;
    if (start > 0) rows = rows.slice(start);
    if (rows.length < 2) return [];
    const header = rows[0].map(function (h) { return String(h == null ? '' : h).trim(); });
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      const rec = {};
      let any = false;
      for (let c = 0; c < header.length; c++) {
        if (!header[c]) continue;
        const v = String(row[c] == null ? '' : row[c]).trim();
        rec[header[c]] = v;
        if (v !== '') any = true;
      }
      if (any) out.push(rec);
    }
    return out;
  }

  // ─── ONE SCAN TIME, TWO REPORT DIALECTS (#855 review) ─────────────────────
  //
  // The two reports that reach this archive render IB_SCAN_TIME differently for
  // the SAME physical scan. Measured on the real 2026-08-13 pair:
  //
  //   Inbound and Van Scans  ->  "2:32 AM"
  //   Post Sort              ->  "8/13/2026 2:32"
  //
  // keyOf reads that field, so without a canonical form 2,700 of the Post Sort
  // export's 2,868 rows land under a second key for a scan the archive already
  // holds — Search Data lists the same package twice with two different-looking
  // times, and the Day Export's seen-rows inherit the duplication. This is what
  // made routing the Post Sort report into the archive (#855) unshippable in
  // its first form.
  //
  // THE CANONICAL FORM IS THE ONE THE MAIN REPORT ALREADY EMITS ("h:mm AM"),
  // AND THAT CHOICE IS ABOUT MIGRATION, NOT TASTE. Every entry already in a
  // device's archive was keyed off that dialect. Canonicalising to anything
  // else — 24-hour "02:32", say — would re-key all of them, so the next load
  // would re-add every row under a new key and double-list up to 30 days of
  // real history until it aged out. Normalising ONTO the incumbent re-keys
  // nothing that exists: main rows are already in this form, and Post Sort rows
  // have never been in the archive at all.
  //
  // A bare time with no meridiem is read as 24-HOUR, which is what the Post
  // Sort dialect's date-prefixed ".NET H:mm" shape means. Measured: no real
  // export carries an hour >= 13 (the sort runs 01:30 to about 10:00), so the
  // reading cannot be confirmed from the data either way; if a Post Sort export
  // ever shows "8/13/2026 14:32" this reading is right, and if one shows an
  // afternoon scan as "8/13/2026 2:32" it is wrong and this is where to fix it.
  // The cost if it is wrong is bounded: an afternoon scan would collide with a
  // 2:32 AM scan of the SAME package on the SAME day, merging two archive rows.
  //
  // Anything this does not recognise is returned untouched. An unfamiliar shape
  // keeps its own identity rather than being folded into a guess.
  function normalizeScanTime(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    const m = raw.match(/^(?:\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}[\sT]+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?[Mm]?$/);
    if (!m) return raw;
    let h = parseInt(m[1], 10);
    if (!(h >= 0 && h <= 23)) return raw;
    const mer = m[4] ? m[4].toUpperCase() : '';
    if (mer === 'P' && h < 12) h += 12;
    else if (mer === 'A' && h === 12) h = 0;
    let h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + m[2] + (m[3] ? ':' + m[3] : '') + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  // A row's identity: same tracking + same inbound date + same scan time is the
  // same scan, so re-loading a file (or overlapping files) won't duplicate it.
  // The scan time goes through normalizeScanTime so the two report dialects
  // above name the same scan the same way.
  function keyOf(rec) {
    return [rec.PKG_LABEL_XREF || '', rec.INBOUND_DATE || '',
      normalizeScanTime(rec.IB_SCAN_TIME)].join('|');
  }

  function cutoffIso(today) {
    const base = (today instanceof Date) ? today : new Date();
    const d = new Date(base.getTime() - ARCHIVE_DAYS * 24 * 60 * 60 * 1000);
    const iso = d.toISOString().slice(0, 10);
    return iso;
  }

  // Keep a record if its inbound date is within the window. Unparseable dates are
  // KEPT (never silently drop data we couldn't normalize).
  function withinWindow(rec, cutoff) {
    const R = rules();
    const iso = typeof R.toIsoDate === 'function' ? R.toIsoDate(rec.INBOUND_DATE) : '';
    if (!iso) return true;
    return iso >= cutoff;
  }

  // Merge new rows into the archive: dedupe by keyOf (PER FIELD — see
  // mergeRecords, #878), then prune to the 30-day window. Returns a new array;
  // does not mutate the input.
  function addRows(archive, rows, today) {
    const base = Array.isArray(archive) ? archive : [];
    const incoming = recordsFromRows(rows);
    const byKey = new Map();
    for (const rec of base) byKey.set(keyOf(rec), rec);
    for (const rec of incoming) {
      const k = keyOf(rec);
      byKey.set(k, mergeRecords(byKey.get(k), rec));
    }
    const cutoff = cutoffIso(today);
    const out = [];
    for (const rec of byKey.values()) if (withinWindow(rec, cutoff)) out.push(rec);
    return out;
  }

  // Does a record match the (already-lowercased) query? Substring across EVERY
  // field value, so a tracking number, address fragment, firm name, ZIP, etc.
  // all find their rows. Shared by the in-memory searchArchive and the
  // IndexedDB cursor scan in the page.
  function recordMatches(rec, lowerQuery) {
    if (!lowerQuery) return false;
    for (const k in rec) {
      if (String(rec[k]).toLowerCase().indexOf(lowerQuery) !== -1) return true;
    }
    return false;
  }

  // Array-path search (used by tests and as a fallback). The page searches the
  // IndexedDB store directly via recordMatches to avoid loading everything.
  function searchArchive(archive, query) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q || !Array.isArray(archive)) return [];
    return archive.filter(function (rec) { return recordMatches(rec, q); });
  }

  // The union of column names across the archive, header-order-stable enough for
  // a display table (first record's columns first, then any extras appended).
  function columns(archive) {
    const seen = [];
    const have = Object.create(null);
    (Array.isArray(archive) ? archive : []).forEach(function (rec) {
      for (const k in rec) if (!have[k]) { have[k] = true; seen.push(k); }
    });
    return seen;
  }

  // Iso date for a record's INBOUND_DATE, with a never-prune sentinel for
  // unparseable dates (so the IndexedDB prune-by-date can't drop them).
  function recordIso(rec) {
    const R = rules();
    const iso = typeof R.toIsoDate === 'function' ? R.toIsoDate(rec.INBOUND_DATE) : '';
    return iso || '9999-12-31';
  }

  // ─── SEEN ROWS FOR ONE SORT DAY (#855) ────────────────────────────────────
  //
  // The Day Export carries "the report rows the exporting device saw" (#795).
  // That used to be an in-memory accumulator in the page, which an F5 reset —
  // so a refreshed device exported only what it had loaded since. THIS archive
  // is already the persistent store of every row this device has loaded, keyed
  // by the same identity (keyOf) and pruned to the same 30-day window, so the
  // export reads it instead of keeping a second copy alive in a variable.
  //
  // SCOPED TO ONE DAY, and that is what makes the read usable rather than a
  // 30-day dump. It also settles the accumulator's other defect for free: a
  // page left open across the 1:30 AM sort-day roll used to fold yesterday's
  // rows into today's file. A day-scoped read cannot, by construction.
  //
  // The day is an ISO sort day ('2026-08-12') and is compared against the
  // record's OWN INBOUND_DATE, which is where the sort-day clock reads its
  // answer from too (lib/sort-day.js's sortDayOf). A record whose date will not
  // parse carries recordIso's never-prune sentinel and therefore matches no
  // real day: it stays in the archive and out of every export, which is the
  // safe direction for a row nothing can date.
  function isSeenOnDay(rec, day) {
    const d = String(day == null ? '' : day).trim();
    if (!d || !rec || typeof rec !== 'object') return false;
    return recordIso(rec) === d;
  }

  // ─── THE ROWS WITH NO INBOUND DATE ARE THE POPULATION, NOT AN EDGE CASE ────
  //
  // recordIso stamps an unparseable INBOUND_DATE with NO_DATE so the prune
  // cannot drop it. Reading the export back by that same date INVERTED that
  // protection: on the real 21,584-record 2026-08-13 main pull, 1,733 rows —
  // 8.0% — carry ISSUE_TYPE "No Inbound Scan", COMPLIANCE_FLAG Non-Compliant,
  // and a BLANK INBOUND_DATE. A package with no inbound scan has no inbound
  // date by definition. That is the IBNO population; dropping it from the
  // handover is exactly the "structurally unable to find a package the Admin's
  // device saw" failure #855 forbids.
  //
  // SO AN UNDATEABLE ROW IS SCOPED BY WHEN THE DEVICE SAW IT, NOT BY ITS OWN
  // DATE. The store stamps it with the sort day of the load that brought it in
  // (seenDayOf below) and the export reads that. A dateable row is untouched —
  // it is still its own INBOUND_DATE, still on the existing `iso` index, so
  // nothing already in a device's archive has to move.
  //
  // The alternative — unioning the whole NO_DATE bucket into every export — was
  // rejected on measurement: that bucket is deliberately never pruned, so at
  // 1,733 rows a day it reaches roughly 52,000 rows and tens of megabytes
  // inside the 30-day window. Scoping by the seen day keeps one day's worth.
  const NO_DATE = '9999-12-31';

  function isUndateable(rec) { return recordIso(rec) === NO_DATE; }

  // seenDayOf(rec, ingestDay) -> the sort day this record counts as SEEN on: its
  // own inbound date when it has one, otherwise the day of the load that
  // brought it in. '' when neither is known, which keeps it out of every export
  // rather than putting it in an arbitrary one.
  function seenDayOf(rec, ingestDay) {
    const iso = recordIso(rec);
    if (iso !== NO_DATE) return iso;
    return String(ingestDay == null ? '' : ingestDay).trim();
  }

  // ─── WHOSE ANSWER IS THE INGEST DAY? (#879) ───────────────────────────────
  //
  // seenDayOf above answers for ONE record once the ingest day is settled.
  // This settles it, for a whole load, and the order is the point.
  //
  //   hint     a caller that STATES the day the rows are of.
  //   rowsDay  the load's own majority INBOUND_DATE (SortDay.sortDayOf).
  //   fallback the page's current sort day.
  //
  // THE HINT WINS, AND THAT IS THE FIX #879 IS. The code used to consult the
  // rows first while its comment described the hint as being "for a caller that
  // knows better than the rows do" — a comment asserting an invariant the code
  // did not keep, which is the shape #740 is the receipt for.
  //
  // It resolves the hint's way rather than the code's because there is exactly
  // one hinting caller and it really does know better: the Day Export import,
  // whose envelope STATES the day it is of. An envelope is scoped to one sort
  // day by construction, so its rows with no INBOUND_DATE of their own — the
  // "No Inbound Scan" population this tool is named for — belong to that day
  // and to no other. The rows can disagree with it, and when they do the rows
  // are the ones that are wrong: a file taken by the pre-#855 build accumulated
  // across the 1:30 AM roll, so its majority date can be YESTERDAY while the
  // envelope is of today. Rows-first stamped that whole undateable population
  // with yesterday and dropped it out of today's handover.
  //
  // Nothing here reads a device clock. Every candidate is data — the caller's
  // stated day, the rows' own dates, or the sort day the loaded report set.
  //
  // A BLANK IS NOT AN ANSWER at any level: an envelope with no day (`env.day`
  // undefined) falls through to the rows exactly as before, so the reorder
  // changes nothing for a caller that passes no usable hint.
  //
  // AND NEITHER IS A MALFORMED ONE (#905 review). The hint now outranks the
  // rows, so it has to earn that: the Day Export file is deliberately
  // Notepad-readable and DayExport's dayText only TRIMS its `day`, so a
  // hand-edited '08/12/2026' would otherwise become the seenDay stamp on a
  // whole undateable population. That stamp then matches no day in
  // entrySeenOnDay / seenRowsForDay, and because a real "No Inbound Scan" row
  // has blank INBOUND_DATE *and* blank IB_SCAN_TIME its keyOf collides across
  // days, so mergeEntry overwrites the device's OWN correct stamp with the bad
  // one. That is the same rows-drop-out-of-the-handover failure #879 exists to
  // prevent, reached through a different door.
  //
  // So an unusable hint FALLS THROUGH to the rows exactly as a blank one does.
  // It is deliberately not coerced: '08/12/2026' is readable as a US date and
  // IbnoRules.toIsoDate would happily turn it into '2026-08-12', but inventing
  // a day from a payload we already know was hand-edited is the bug class here,
  // and the rows are a dated answer that came from the report itself.
  //
  // isIsoDay reuses that same one date normalizer rather than adding a second
  // near-identical day rule that could drift from it: toIsoDate is the module's
  // existing ISO/US normalizer, and comparing its output against the input is
  // what says "this was ALREADY a bare ISO day" without accepting its US
  // dialect. The calendar check is on top of it because toIsoDate answers a
  // well-SHAPED date, not a real one — '2026-13-45' matches its ISO pattern and
  // comes straight back, and a stamp of a day that does not exist matches
  // nothing just as surely as a US-formatted one does. Date.UTC of numbers
  // already in hand reads no device clock.
  //
  // Only the hint is gated. rowsDay and fallback are computed from loaded report
  // data by SortDay, never typed by a human, and re-validating them here would
  // be a second gate on a value that has no hand-edit door.
  function isIsoDay(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    if (rules().toIsoDate(s) !== s) return false;
    const y = Number(s.slice(0, 4));
    const m = Number(s.slice(5, 7));
    const d = Number(s.slice(8, 10));
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }

  function seenDayFor(hint, rowsDay, fallback) {
    const day = function (v) { return String(v == null || v === false ? '' : v).trim(); };
    const stated = day(hint);
    return (isIsoDay(stated) ? stated : '') || day(rowsDay) || day(fallback) || '';
  }

  // archiveEntry(rec, ingestDay) -> the stored wrapper. One place, so the
  // IndexedDB and in-memory backends cannot drift. `seenDay` is written ONLY
  // for undateable rows: a dateable one is found through the `iso` index it has
  // always been on, and keeping the second index small keeps the read cheap.
  function archiveEntry(rec, ingestDay) {
    const entry = { key: keyOf(rec), iso: recordIso(rec), rec: rec };
    if (entry.iso === NO_DATE) {
      const d = seenDayOf(rec, ingestDay);
      if (d) entry.seenDay = d;
    }
    return entry;
  }

  // ─── A LATER REPORT ADDS COLUMNS. IT DOES NOT BLANK THEM (#878) ───────────
  //
  // Two reports reach this archive and they carry DIFFERENT COLUMNS for the same
  // physical scan: the main pull is 56 columns wide, the Post Sort export 35,
  // and the Post Sort set is not a subset. Once #855 normalised the scan time so
  // both dialects resolve to ONE key (see normalizeScanTime), a straight "new
  // wins" put stopped being a dedupe and became an overwrite: measured on the
  // real same-day 2026-08-13 pair, 2,695 of the Post Sort export's 2,868 rows
  // land on a main record and blanked 25 columns that held real values —
  // COMPLIANCE_FLAG, BELT, SCAN_BARCODE, IB_SCAN_DEVICE, PLA_LOOKUP, EDD,
  // FULL_SID, IB_TRAILER on all 2,695, plus DELV_COMMIT_DT, SERVICE_CODE, PSD,
  // PLANNED_SEQ and the two STATUS columns on most. 61,669 field values in one
  // load. That contradicts this module's own header contract ("EVERY row of
  // EVERY CSV … with all of its columns intact"), and it is the COMMON
  // direction: Post Sort is the ADR-0021 daily driver and typically loads last.
  //
  // SO A WRITE MERGES PER FIELD INSTEAD OF REPLACING THE RECORD.
  //
  // THE ONE DELIBERATE CHOICE HERE IS WHAT A BLANK MEANS, and it is decided on
  // the report's COLUMN LIST, not on the value:
  //
  //   a column the incoming report DOES NOT CARRY -> the stored value stands.
  //       The report said nothing about it. Post Sort has no BELT column at all;
  //       that is silence, not "no belt", and every one of the 25 losses above
  //       is of exactly this kind.
  //
  //   a column the incoming report DOES carry -> the incoming value wins, blank
  //       included. A report that ships the column and leaves it empty has made
  //       a statement about it, and the newer statement is the current one. This
  //       is what keeps a field that genuinely cleared (a van scan reversed, a
  //       status withdrawn) from being frozen at its first non-empty value
  //       forever.
  //
  // THE TWO POLICIES ARE NOT INDISTINGUISHABLE, AND THE LOAD ORDER IS WHY. An
  // earlier version of this paragraph said they were; it had measured only ONE
  // direction. Both are now measured, in tests/ibno-archive-merge.test.js:
  //
  //   Post Sort loaded onto a main pull -> 0 carried-but-empty overwrites. Not
  //       one of the 25 blanked columns is carried-but-empty, so on this
  //       direction the two rules really do preserve the same 61,669 values.
  //
  //   a main pull loaded onto a Post Sort load -> 2,669 carried-but-empty
  //       overwrites, all on PRIORITY_PACKAGE. Both reports carry that column;
  //       the main pull ships it EMPTY for a non-priority package (21,533 of
  //       21,584 rows), the Post Sort export ships a value for every row. So the
  //       rule above clears 2,669 real values that "a blank never clears" would
  //       keep. That order is a normal day too — it is what #877's invariant 1
  //       exercises.
  //
  // The merge is still a large net win in that direction: the replace-write
  // blanked 37,722 values across 16 columns there, and this cuts it to the 2,669.
  // But the residue is real, so WHICH rule is right is a design question, parked
  // for Tyler in #834 rather than settled here. If it is answered "a blank never
  // clears", THIS is the paragraph to revisit, by skipping empty incoming values
  // in mergeRecords — and the two directional numbers in the test are what the
  // change would have to move.
  function mergeRecords(existing, incoming) {
    if (!existing || typeof existing !== 'object') return incoming;
    if (!incoming || typeof incoming !== 'object') return existing;
    // Existing key order first, incoming's new columns appended — the union, in
    // a stable order, so the Search Data expand does not reshuffle on a reload.
    return Object.assign({}, existing, incoming);
  }

  // mergeEntry(existing, entry) -> the wrapper to STORE, given what the store
  // already holds under this key (undefined/null when it holds nothing).
  //
  // `iso` is recomputed from the merged record rather than carried over: the two
  // entries share a key, so they share an INBOUND_DATE and it cannot move, but
  // recomputing means the wrapper can never disagree with the record inside it.
  //
  // `seenDay` takes the NEWER stamp when there is one. That is the #855 rule
  // held onto: an undateable row belongs to the day the device saw it, and a row
  // seen again today has to reach today's Day Export — keeping the older stamp
  // would leave it out of the handover for a day the Admin really did work it.
  function mergeEntry(existing, entry) {
    if (!existing || typeof existing !== 'object' || !existing.rec) return entry;
    if (!entry || typeof entry !== 'object' || !entry.rec) return existing;
    const rec = mergeRecords(existing.rec, entry.rec);
    const merged = { key: entry.key, iso: recordIso(rec), rec: rec };
    const seenDay = entry.seenDay || existing.seenDay;
    if (merged.iso === NO_DATE && seenDay) merged.seenDay = seenDay;
    return merged;
  }

  // archiveEntries(records, ingestDay) -> one wrapper per DISTINCT key in a
  // load, merged in the order the rows arrived. Both backends in the page build
  // their writes from this, so a batch that repeats a key resolves the same way
  // a re-load does — merged, not last-one-wins — and neither backend has to know
  // the rule.
  function archiveEntries(records, ingestDay) {
    const byKey = new Map();
    (Array.isArray(records) ? records : []).forEach(function (rec) {
      if (!rec || typeof rec !== 'object') return;
      const entry = archiveEntry(rec, ingestDay);
      byKey.set(entry.key, mergeEntry(byKey.get(entry.key), entry));
    });
    return Array.from(byKey.values());
  }

  // entrySeenOnDay(entry, day) -> does a STORED WRAPPER belong to this day?
  // The in-memory backend's read; the IndexedDB backend asks the same question
  // of its two indexes instead of scanning.
  function entrySeenOnDay(entry, day) {
    const d = String(day == null ? '' : day).trim();
    if (!d || !entry || typeof entry !== 'object') return false;
    return entry.iso === d || entry.seenDay === d;
  }

  // seenRowsForDay(records, day) -> the day's records, deduped by keyOf, in the
  // order they were given. Applied to whatever the store hands back, so the day
  // rule and the dedupe hold whichever backend answered (IndexedDB index ranges
  // or the in-memory fallback) and a Node test can pin both.
  //
  // A DATEABLE row must match the day. An UNDATEABLE one is admitted, because
  // the only thing that can answer which day it belongs to is the store's own
  // `seenDay` stamp and the store has already applied it — this is the last
  // gate, not the only one. So the dateable half stays a real filter (a row
  // from another day cannot slip through here) and the undateable half is
  // trusted to the layer that actually knows.
  function seenRowsForDay(records, day) {
    const d = String(day == null ? '' : day).trim();
    if (!d) return [];
    const out = [];
    const seen = Object.create(null);
    (Array.isArray(records) ? records : []).forEach(function (rec) {
      if (!rec || typeof rec !== 'object') return;
      if (!isSeenOnDay(rec, d) && !isUndateable(rec)) return;
      const k = keyOf(rec);
      if (seen[k]) return;
      seen[k] = true;
      out.push(rec);
    });
    return out;
  }

  // buildSearchRecord(rec) -> the Search Data panel's HTML for ONE archive
  // record: a collapsed header (tracking, FTrack link, firm + address, the
  // high-value pills) plus the full column list behind the "all fields"
  // expand. Moved here from ibno-coder.html's inline script (#694) because
  // this module already owns the record shape it renders; the page keeps only
  // the querySelector/innerHTML wiring around it.
  //
  // Pure string in, pure string out: no DOM, no storage, so a Node test can
  // pin the markup. Every value goes through ToolHelpers.escapeHtml, which is
  // what keeps an address or firm name from being read as markup.
  function buildSearchRecord(rec) {
    const esc = helpers().escapeHtml;
    const addr = [rec.LABEL_ADDRESS1, rec.LABEL_CITY, rec.LABEL_STATE, rec.POSTAL_CODE].filter(Boolean).join(' ');
    const fields = Object.keys(rec).filter(function (k) { return String(rec[k]) !== ''; })
      .map(function (k) {
        return '<div class="srec-field"><span class="k">' + esc(k) + '</span>' +
               '<span class="v">' + esc(rec[k]) + '</span></div>';
      }).join('');
    // High-value fields surfaced inline on the collapsed header so the most-used
    // columns (date, work area, status) are readable without expanding "all
    // fields" (#310). The full column list still lives in the expand.
    //
    // THE STATUS PILL READS BOTH SPELLINGS (#878). The main pull's status column
    // is STATUS_CODES1 — the "1" is the join suffix it carries on a dozen
    // columns — and the Post Sort export spells the same thing STATUS_CODES. A
    // record that only ever came through Post Sort therefore rendered no STATUS
    // pill at all, on the report that is the ADR-0021 daily driver. Preference
    // goes to the main spelling so a record that has both is unchanged.
    const meta = [
      ['DATE', rec.INBOUND_DATE],
      ['AREA', rec.IB_WORK_AREA],
      ['STATUS', rec.STATUS_CODES1 || rec.STATUS_CODES],
    ].filter(function (p) { return String(p[1] == null ? '' : p[1]).trim() !== ''; })
      .map(function (p) {
        return '<span class="srec-pill"><span class="k">' + esc(p[0]) + '</span>' +
               '<span class="v">' + esc(p[1]) + '</span></span>';
      }).join('');
    return '<div class="search-rec">' +
      '<div class="search-rec-head" onclick="this.parentNode.classList.toggle(\'open\')">' +
        '<span class="mono">' + esc(rec.PKG_LABEL_XREF || '—') + '</span>' +
        '<span onclick="event.stopPropagation()">' + ftrack().ftrackLink(rec.PKG_LABEL_XREF) + '</span>' +
        '<span class="srec-addr">' + esc(rec.LABEL_FIRM_NAME ? rec.LABEL_FIRM_NAME + ' · ' : '') + esc(addr) + '</span>' +
        (meta ? '<span class="srec-meta">' + meta + '</span>' : '') +
        '<span class="srec-toggle">all fields</span>' +
      '</div>' +
      '<div class="search-rec-fields">' + fields + '</div>' +
    '</div>';
  }

  // todaysLabelSet(itemLists, recurringMap) -> the tracking numbers surfaced
  // from the report loaded right now, used to tag history rows whose package is
  // also in today's work ("in today").
  //
  // The page owns the state; this owns the union rule. It takes the lists
  // rather than reading them, so nothing here knows about autoItems /
  // manualItems / resolvedItems — the caller decides which populations count as
  // "today" (ibno-coder.html passes all three plus the recurring map).
  function todaysLabelSet(itemLists, recurringMap) {
    const s = new Set();
    (Array.isArray(itemLists) ? itemLists : []).forEach(function (list) {
      (Array.isArray(list) ? list : []).forEach(function (i) {
        if (i && i.label) s.add(i.label);
      });
    });
    Object.keys(recurringMap || {}).forEach(function (l) { s.add(l); });
    return s;
  }

  return {
    ARCHIVE_DAYS: ARCHIVE_DAYS,
    buildSearchRecord: buildSearchRecord,
    todaysLabelSet: todaysLabelSet,
    recordsFromRows: recordsFromRows,
    keyOf: keyOf,
    addRows: addRows,
    searchArchive: searchArchive,
    recordMatches: recordMatches,
    cutoffIso: cutoffIso,
    recordIso: recordIso,
    NO_DATE: NO_DATE,
    normalizeScanTime: normalizeScanTime,
    isSeenOnDay: isSeenOnDay,
    isUndateable: isUndateable,
    seenDayOf: seenDayOf,
    seenDayFor: seenDayFor,
    archiveEntry: archiveEntry,
    archiveEntries: archiveEntries,
    mergeRecords: mergeRecords,
    mergeEntry: mergeEntry,
    entrySeenOnDay: entrySeenOnDay,
    seenRowsForDay: seenRowsForDay,
    columns: columns,
  };
});
