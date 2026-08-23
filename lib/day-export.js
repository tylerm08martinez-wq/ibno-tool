'use strict';

// THE DAY EXPORT — one file a day, from the Admin's copy into Tyler's
// (issue #794, PRD #790, ADR-0023 item 4).
//
// Under the 999 Desk the IBNO Coder has two users for the first time, on two
// machines, with no shared state and no credential anywhere (ADR-0023 rejects
// both). The Admin's device therefore holds the ONLY record of most of the
// day's work. This module is the whole of the file that carries it across:
// three pure functions over plain objects, no DOM, no clock, no network.
//
// Dual-loadable with no build step:
// - Browser: window.DayExport
// - Node:    require('./lib/day-export')
//
// ─── SCOPE: THE WHOLE DAY (#795), AND THE VERSION THAT SAYS SO ──────────────
//
// #794 shipped VERSION 1, carrying work areas alone. #795 widens the envelope
// to the rest of the day: PARK decisions, the BARCODED and SCANNED lifecycle
// states (ADR-0022), and the REPORT ROWS the exporting device saw. That is
// VERSION 2.
//
// ADDING A STORE TO THE ENVELOPE BUMPS THE VERSION. It is not enough to start
// emitting a new key: a version-1 parser tolerating an unknown key would import
// half a file and say nothing, which is precisely the silent partial import
// story 35 refuses. New store -> new VERSION -> old builds refuse the file out
// loud, which is the whole point of the field.
//
// ─── HOW VERSION 1 AND VERSION 2 GET ALONG ──────────────────────────────────
//
// The compatibility is deliberately ONE-WAY, and each direction is a different
// promise:
//
//   A v1 FILE STILL IMPORTS INTO THIS BUILD. The Admin may send one from a
//     device that has not been updated yet, and the areas in it are real work.
//     `parse` accepts it and normalises the four missing stores to EMPTY, so
//     `merge` treats it as "this file has nothing to say about park, filing,
//     ticks or rows" rather than as "this file says they are empty". The
//     distinction is not academic: merge never removes from any store, so an
//     empty store can only ever be a no-op. A v1 file is exactly a v2 file
//     whose other four stores happen to be empty.
//
//   A v2 FILE IS REFUSED BY A v1 BUILD, LOUDLY. That refusal already exists and
//     needed no change: the shipped v1 `parse` is `if (raw.version !== VERSION)
//     throw DayExportUnknownVersionError` against its own VERSION of 1, so a
//     `"version": 2` file trips it and names both numbers. The person is told
//     to update this copy of the tool rather than half-importing. Do NOT
//     "helpfully" make a future v3 parser tolerate unknown keys — the whole
//     mechanism is that an old build cannot half-read a new file.
//
// SUPPORTED_VERSIONS is therefore a LIST and not a single number, and the
// refusal message names all of it.
//
// ─── EACH STORE MERGES ON ITS OWN TERMS (ADR-0022, AND IT IS LOAD-BEARING) ──
//
// The four stores are NOT unified behind one serialization interface, and the
// inconsistency between them is the point rather than a mess to tidy. ADR-0022:
// "the states are stored independently, and no store may be inferred from
// another. A row can be answered without being barcoded, and barcoded without
// being scanned." Collapsing them into one generic map-merge is the #740 class
// — a predicate quietly starting to answer a question nobody asked it.
//
//   areas ... the merge above. Fills a blank, agrees, or DISAGREES and is
//     reported (#796) rather than resolved. Sort-day filtered, see below.
//   parked .. STRICTLY ADDITIVE, AND NEVER SUBTRACTIVE. An import may ADD a
//     park and may NEVER remove one. A file must not be able to undo a
//     judgment call: Park is cleared by hand, and #730 froze it against every
//     automatic clear. NOT sort-day filtered, and that is the one place this
//     module deliberately differs from the areas rule — a park SURVIVES the day
//     roll by design (#730/#753) and a carried park is SHOWN as carried, so
//     filtering one out by date would delete deferred FTrack work that has no
//     other record anywhere. A park is also not a routing decision: it writes
//     no record, no code and no area, so an off-day park cannot walk a package
//     to a belt the way #621's off-day AREA can.
//   filed ... the BARCODED state (lib/ibno-filed.js). Additive union, and
//     SORT-DAY GATED on the incoming store's own stamp. Filing resets on a new
//     sort day (#734 AC7) precisely because "yesterday's assignment is not
//     evidence about today's package" (ADR-0022 invariant 6), and a filed row
//     LEAVES THE WORKING LIST — so importing a stale filing would hide a
//     package that still needs work. Fail closed: an undated filed store cannot
//     prove it belongs to today and is skipped whole.
//   done .... the SCANNED state (lib/barcode-done.js). Additive union, gated
//     exactly as `filed` is and for the same reason, and merged SEPARATELY from
//     it. Nothing here reads one to decide the other in either direction —
//     ADR-0022 invariant 2, barcoded never implies scanned.
// HOW LONG AN IMPORTED PARK OR FILING ACTUALLY LIVES, WHICH IS NOT LONG FOR
// THE POPULATION THIS TICKET IS ABOUT. Every report load prunes both stores to
// the labels the fresh report still carries — IbnoParked.pruneToReport /
// prunePostSortToReport and IbnoFiled.pruneToReport — and a `post-sort` park the
// fresh slice does not carry is explicitly DROPPED. So for a package the report
// has already pruned away, which is most of what the Admin resolved early, an
// imported park has no row to draw and is deleted at Tyler's next drop, and an
// imported filing goes the same way. Only the ARCHIVE ROWS genuinely survive
// for that half.
//
// THAT IS CORRECT AND MUST NOT BE "FIXED" HERE. It is lib/ibno-parked.js's
// standing rule applied to an imported park exactly as it applies to a local
// one: PARK NEVER KEEPS A PACKAGE ALIVE, and a park whose package the fresh
// report no longer carries is moot because someone on the dock got it to the
// right area. Exempting imported parks from the prune would make a file able to
// resurrect deferred work the report says is done — the mirror image of the
// never-unpark rule, and worse, because it would be automatic. The practical
// consequence to know: the park/filed/done halves of the envelope pay off on
// the OVERLAP, where both devices still hold the package; the pruned-away half
// is served by the seen-rows and the archive, which is what they are for.
//
//   rows .... the report rows the exporting device saw. Carried UNCONDITIONALLY
//     and merged into nothing: `merge` hands them back and the page puts them
//     in the 30-day archive, where lib/ibno-archive.js's `keyOf` (tracking +
//     inbound date + scan time) collapses the ones both devices saw BY
//     CONSTRUCTION. They go to the archive unconditionally and to the WORKING
//     LIST NEVER — a package the Admin already finished must not reappear as
//     work on Tyler's screen while its record still lands.
//
// ─── WHY THE SEEN-ROWS ARE COLUMNAR ─────────────────────────────────────────
//
// Measured on the real 2026-08-12 Post Sort export (289 rows, 35 columns):
//
//   one keyed object per row, pretty-printed .... 323.0 KB
//   one keyed object per row, compact ........... 262.0 KB
//   { columns, values }, one line per row ....... 112.4 KB
//
// The Admin's device accumulates every load of a self-pruning report across a
// whole shift, and the 07:54 pull alone is 2,467 rows — so the per-row constant
// is what decides whether this stays emailable. 0.39 KB/row keeps a full day
// under a megabyte; 1.1 KB/row does not. The columnar form is also still
// READABLE BY A PERSON (story 31): a header line naming the columns, then one
// line per row, which is a CSV wearing JSON's clothes.
//
// Columns are NOT trimmed to the ones that carry a value anywhere. It would
// save 2% (109.8 KB of the 112.4) and it would make an imported record a
// SUBSET of the local one with the same archive key — and since the import
// writes second, the fuller local record would be replaced by the thinner
// imported one. A 2% saving is not worth a lossy write into the archive.
//
// ─── WHY REFUSAL IS THE INTERESTING PART ────────────────────────────────────
//
// The worst outcome here is not a merge that gets a package slightly wrong. It
// is a MIS-DROP DESTROYING A GOOD LOADED REPORT: Tyler drops files into this
// tool all day, and the day's coded report is on the other side of the
// operation. So `parse` follows the #445 loud-refusal precedent that
// lib/post-sort-scans.js sets, and ADR-0021's parse-before-reset ordering — it
// throws a TYPED error and the page has changed nothing by the time it does.
//
// FOUR TYPED ERRORS, AND ONLY ONE OF THEM IS A FALL-THROUGH:
//
//   DayExportNotJsonError ......... the file is not JSON at all. This is the
//     CLEAN "not a Day Export" signal, and the ONLY one the page hands on to
//     the existing spreadsheet path. A CSV and an .xlsx both land here.
//   DayExportMalformedError ....... it opens like JSON but does not parse
//     (truncated, half-copied, corrupted in transit), or it is a genuine
//     version-1 envelope whose payload is the wrong shape. TERMINAL: a
//     truncated export must never be handed to the CSV reader, because a
//     spreadsheet parser fed half a JSON file produces rows rather than an
//     error, and rows are how a good report gets replaced by garbage.
//   DayExportForeignJsonError ..... valid JSON, but not this tool's file.
//     TERMINAL for the same reason: a JSON file is definitively not a
//     spreadsheet, so falling through could only ever mis-load it.
//   DayExportUnknownVersionError .. an envelope from a build this one does not
//     understand. TERMINAL, per story 35: fail clearly rather than half-import.
//
// The sniff that separates the first from the rest is deliberately crude and
// deliberately cheap: the first non-whitespace character after any byte-order
// mark. A CSV never starts with `{`, and an .xlsx is a ZIP whose first two
// bytes are `PK`. Anything that DOES start with `{` is claiming to be JSON, and
// this module owns the consequences of that claim rather than passing them on.
//
// ─── THE MERGE, AND THE ONE THING IT DELIBERATELY WILL NOT DO ───────────────
//
// The merge key is the tracking number, which is already how lib/actual-area.js
// stores answers, so a report re-drop and an import cannot collide and there is
// no order the user can get wrong.
//
// `merge` is IDEMPOTENT. Merging the same envelope twice is identical to
// merging it once, so Tyler never has to remember whether he already did it.
// It achieves that WITHOUT a clock: an incoming entry either fills a blank,
// agrees with what is already held, or disagrees with it, and only the first of
// those three writes anything.
//
// A DISAGREEMENT KEEPS THE LOCAL VALUE AND IS REPORTED, NEVER RESOLVED.
// Latest-write-wins is explicitly rejected by PRD #790: it would settle a real
// disagreement about a physical package by clock order, and that is this repo's
// wrong-belt error class. Surfacing the disagreement to Tyler is #796; this
// module's job is to make sure #796 has something to surface, and to leave a
// seam it can replace rather than a resolution it has to undo.
//
// ─── WHY MERGE FILTERS BY SORT DAY ──────────────────────────────────────────
//
// #621 is the reason. An area carried across sort days does not merely display
// stale — it reads as FINISHED in three places at once (the Work-mode cursor
// skips the row, the progress bar counts it, and a typed value reads as
// scanned), so a package can be walked to a belt that was right yesterday. A
// late-arriving email must not be able to do that, so an incoming entry whose
// stamp is not the local device's sort day is SKIPPED and counted, never
// imported. An entry with no stamp cannot prove it belongs to today and is
// skipped too — the same fail-closed choice ActualArea.reflow's rule 2 makes,
// for the same reason.
//
// When the local device has no sort day at all (nothing loaded yet), there is
// nothing to judge against and the filter does not apply. That is safe because
// the next report load rolls any off-day area into a dated note before it can
// be worked (SortDay.rollToSortDay, #695), which is the existing net this case
// falls into rather than a new hole.
//
// ─── `by` UNDER reflow: THE DECISION ADR-0022 HANDED FORWARD ────────────────
//
// ADR-0022 ("`by` is attribution, and it is not in that table") names this as
// #794's to make deliberately. Once this merge lands, ActualArea.reflow's
// source can be an IMPORTED entry, so the blank it fills would be stamped with
// someone who was never at that machine.
//
// DECIDED: it propagates, unchanged. `by` answers "who decided this stop's
// belt", not "who was sitting at this keyboard". The Admin's FRO lookup is what
// puts every package at that address on that belt, whichever machine renders
// the row, so the name is true of the sibling in the only sense the field is
// used for — coaching a repeated wrong-belt pattern back to the person whose
// judgement produced it. The alternative writes a BLANK, which is worse twice
// over: it is indistinguishable from genuine pre-#793 unattributed work, and it
// would make the Admin's own archive and Tyler's disagree about the same row,
// which is the opposite of story 19. reflow therefore needs no change, and this
// paragraph exists so that stays a decision rather than an inheritance.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DayExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // Resolved LAZILY, so script order in the page cannot matter — same shape as
  // lib/actual-area.js's own deps().
  function areaLib() {
    const mod = (typeof require === 'function') ? require('./actual-area') : null;
    return mod || (root && root.ActualArea);
  }

  // The other three stores, resolved the same lazy way. Each keeps its OWN
  // module's normalisation gate, which is what stops this file quietly growing
  // a fourth opinion about what a park entry or a filing entry looks like.
  function dayLib() {
    const mod = (typeof require === 'function') ? require('./sort-day') : null;
    return mod || (root && root.SortDay);
  }
  function parkedLib() {
    const mod = (typeof require === 'function') ? require('./ibno-parked') : null;
    return mod || (root && root.IbnoParked);
  }
  function filedLib() {
    const mod = (typeof require === 'function') ? require('./ibno-filed') : null;
    return mod || (root && root.IbnoFiled);
  }
  function doneLib() {
    const mod = (typeof require === 'function') ? require('./barcode-done') : null;
    return mod || (root && root.BarcodeDone);
  }

  // What this file IS. Content, not filename: a renamed or re-saved attachment
  // still imports, and a file called `ibno-day-export-2026-08-12.json` that is
  // actually a spreadsheet still does not (PRD stories 5 and 6).
  const KIND = 'ibno-day-export';

  // Bump this whenever the PAYLOAD changes shape — see the scope note above.
  // 1: work areas only (#794). 2: + park, barcoded, scanned, seen-rows (#795).
  const VERSION = 2;

  // Every version this build can READ. `build` always emits VERSION; `parse`
  // accepts anything in this list and refuses everything else out loud, naming
  // both what it was handed and what it understands.
  const SUPPORTED_VERSIONS = [1, 2];

  // The device name on the envelope is a LABEL, for the import summary and for
  // a person reading the file. It is not the attribution of record: that is the
  // per-entry `by`, normalised by lib/actual-area.js's restore(), which #793
  // made the single gate for entry shape.
  const MAX_BY_LEN = 40;

  function typedError(name, message) {
    const e = new Error(message);
    e.name = name;
    return e;
  }

  function labelText(raw) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_BY_LEN).trim();
  }

  function dayText(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim();
  }

  // ─── THE THREE DAY STORES ─────────────────────────────────────────────────
  //
  // Park, filing and ticks all ride lib/sort-day.js's DAY STORE shape
  // ({ day, items }), so serialising them is one call each. What is NOT shared
  // is the ENTRY normalisation: each store's own module owns the shape of its
  // own value, and this file borrows those gates rather than inventing a
  // generic one (ADR-0022 again — a generic entry is how one store starts being
  // inferred from another).
  //
  // A store that is missing entirely normalises to an EMPTY day store, which is
  // what makes a version-1 file merge as a clean no-op.
  function emptyStore() { return { day: '', items: {} }; }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  // A day store is legal only as an object (or absent). An ARRAY or a string in
  // one of these slots is a malformed payload, not an empty one — a file that
  // says `"parked": []` was written by something that does not understand this
  // format, and importing part of it is the silent partial import story 35
  // refuses.
  function readStore(raw, label, normalize) {
    if (raw === undefined || raw === null) return emptyStore();
    if (!isPlainObject(raw)) {
      throw typedError('DayExportMalformedError',
        'That Day Export\'s ' + label + ' is the wrong shape. Nothing was imported.');
    }
    const s = dayLib().serializeDayStore(raw);
    if (!isPlainObject(s.items)) {
      throw typedError('DayExportMalformedError',
        'That Day Export\'s ' + label + ' is the wrong shape. Nothing was imported.');
    }
    return normalize(s);
  }

  // migrateEntries is lib/ibno-parked.js's own gate: it backfills a per-label
  // day from the store's stamp, which is the only evidence a pre-#753 entry has
  // about when the park was made. Running it HERE means a park exported from an
  // old device arrives with its day already resolved rather than inheriting the
  // receiving device's.
  function normalizeParked(store) { return parkedLib().migrateEntries(store); }
  function normalizeFiled(store) { return filedLib().normalizeEntries(store); }

  // The ticks are the one store whose entries carry nothing at all: lib/
  // barcode-done.js's shape is `{ [label]: true }` and ONLY done labels are
  // present, so anything that is not exactly `true` is dropped rather than
  // stored as a tombstone.
  function normalizeDone(store) {
    const items = {};
    Object.keys(store.items).forEach(function (k) {
      const label = String(k == null ? '' : k).trim();
      if (label && store.items[k] === true) items[label] = true;
    });
    return { day: dayText(store.day), items: items };
  }

  // ─── THE SEEN-ROWS TABLE ──────────────────────────────────────────────────
  //
  // In:  an array of ARCHIVE RECORDS, one plain object per report row keyed by
  //      column name — exactly what IbnoArchive.recordsFromRows produces and
  //      what ArchiveStore.addAll consumes, so nothing has to be reshaped at
  //      either end.
  // Out: { columns, values }, the columnar form the header note measures.
  //
  // Column order is FIRST-SEEN order across the whole set, and a record missing
  // a column contributes '' rather than shifting the row — the same
  // "a missing column can not misalign the surviving columns" rule
  // lib/post-sort-scans.js states, because two reports in one day's
  // accumulation can genuinely have different column sets.
  function tableFromRecords(records) {
    const list = Array.isArray(records) ? records : [];
    const columns = [];
    const seen = Object.create(null);
    list.forEach(function (rec) {
      if (!isPlainObject(rec)) return;
      Object.keys(rec).forEach(function (k) {
        if (!k || seen[k]) return;
        seen[k] = true;
        columns.push(k);
      });
    });
    const values = [];
    list.forEach(function (rec) {
      if (!isPlainObject(rec)) return;
      values.push(columns.map(function (c) {
        const v = rec[c];
        return v == null ? '' : String(v);
      }));
    });
    return { columns: columns, values: values };
  }

  // recordsFromTable(table) -> the array of records again. A value array
  // SHORTER than the column list fills the tail with '', and a longer one is
  // truncated: a hand-edited file must not be able to produce a record whose
  // keys and values are off by one.
  function recordsFromTable(table) {
    if (!isPlainObject(table)) return [];
    const columns = Array.isArray(table.columns) ? table.columns : [];
    const values = Array.isArray(table.values) ? table.values : [];
    const out = [];
    values.forEach(function (row) {
      if (!Array.isArray(row)) return;
      const rec = {};
      let any = false;
      for (let c = 0; c < columns.length; c++) {
        const key = String(columns[c] == null ? '' : columns[c]).trim();
        if (!key) continue;
        const v = row[c];
        rec[key] = v == null ? '' : String(v);
        if (rec[key] !== '') any = true;
      }
      if (any) out.push(rec);
    });
    return out;
  }

  function readTable(raw) {
    if (raw === undefined || raw === null) return { columns: [], values: [] };
    if (!isPlainObject(raw) || !Array.isArray(raw.columns) || !Array.isArray(raw.values)) {
      throw typedError('DayExportMalformedError',
        'That Day Export\'s report rows are the wrong shape. Nothing was imported.');
    }
    return {
      columns: raw.columns.map(function (c) { return String(c == null ? '' : c); }),
      values: raw.values.filter(Array.isArray).map(function (row) {
        return row.map(function (v) { return v == null ? '' : String(v); });
      }),
    };
  }

  // ─── BUILD ────────────────────────────────────────────────────────────────
  //
  // build({ areas, parked, filed, done, rows, by, day }) -> the envelope object.
  //
  // The caller stringifies it (the page pretty-prints, so the file is readable
  // in Notepad — story 31). Reads no clock and no storage: everything it knows
  // is in its argument.
  function build(input) {
    const o = input || {};
    const AA = areaLib();
    return {
      kind: KIND,
      version: VERSION,
      day: dayText(o.day),
      by: labelText(o.by),
      // Every store goes through its OWN module's normalisation gate, so an
      // envelope can only ever carry entries the receiving store would
      // accept — junk drops here rather than at the far end, where it would
      // have to be explained.
      areas: AA.restore(o.areas || {}),
      parked: readStore(o.parked, 'park decisions', normalizeParked),
      filed: readStore(o.filed, 'barcoded rows', normalizeFiled),
      done: readStore(o.done, 'scanned rows', normalizeDone),
      // `rows` is an array of ARCHIVE RECORDS in, a columnar table out.
      rows: tableFromRecords(o.rows),
    };
  }

  // stringify(env) -> the file's text.
  //
  // Pretty-printed (story 31), EXCEPT that each seen-row stays on ONE line.
  // JSON.stringify(env, null, 2) would put every cell of every row on its own
  // line and turn a 112 KB file into a 1.3 MB one, which is the same amount of
  // information rendered unemailable. One line per row is also how a person
  // actually reads a table.
  //
  // The rows block is spliced in through a sentinel rather than assembled by
  // hand around the rest, so the envelope's other keys are still serialised by
  // JSON.stringify and cannot drift from it. The sentinel is deliberately not
  // something an area value could contain, and the replacement is a FUNCTION so
  // a `$` in the payload is never read as a capture reference.
  const ROWS_SENTINEL = ' ibno-day-export-rows ';

  function stringify(env) {
    const e = env || {};
    const table = isPlainObject(e.rows) ? e.rows : { columns: [], values: [] };
    const shell = Object.assign({}, e, { rows: ROWS_SENTINEL });
    const text = JSON.stringify(shell, null, 2);
    const columns = Array.isArray(table.columns) ? table.columns : [];
    const values = Array.isArray(table.values) ? table.values : [];
    const block = '{\n' +
      '    "columns": ' + JSON.stringify(columns) + ',\n' +
      '    "values": [' + (values.length ? '\n      ' + values.map(function (row) {
        return JSON.stringify(row);
      }).join(',\n      ') + '\n    ' : '') + ']\n' +
      '  }';
    return text.replace(JSON.stringify(ROWS_SENTINEL), function () { return block; });
  }

  // ─── PARSE ────────────────────────────────────────────────────────────────
  //
  // parse(text) -> the envelope, or throws one of the four typed errors above.
  // Takes the text and nothing else: there is no filename to be fooled by.
  function parse(text) {
    if (typeof text !== 'string') {
      throw typedError('DayExportNotJsonError',
        'That file is not a Day Export — nothing was imported.');
    }
    const trimmed = text.replace(/^﻿/, '').trim();
    if (!trimmed || trimmed.charAt(0) !== '{') {
      throw typedError('DayExportNotJsonError',
        'That file is not a Day Export — nothing was imported.');
    }

    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch (e) {
      throw typedError('DayExportMalformedError',
        'That file opens like a Day Export but is not valid JSON — it is most likely ' +
        'truncated or was damaged in transit. Nothing was imported; ask for the file again.');
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.kind !== KIND) {
      throw typedError('DayExportForeignJsonError',
        'That is a JSON file, but not an IBNO Day Export. Nothing was imported.');
    }

    if (SUPPORTED_VERSIONS.indexOf(raw.version) === -1) {
      throw typedError('DayExportUnknownVersionError',
        'That Day Export is version ' + JSON.stringify(raw.version) + ', and this copy of the ' +
        'tool understands version ' + SUPPORTED_VERSIONS.join(' and ') + '. Nothing was ' +
        'imported — update this copy of the IBNO Coder rather than importing part of the file.');
    }

    if (!raw.areas || typeof raw.areas !== 'object' || Array.isArray(raw.areas)) {
      throw typedError('DayExportMalformedError',
        'That Day Export is version ' + raw.version + ' but its work areas are missing or the ' +
        'wrong shape. Nothing was imported.');
    }

    // A VERSION-1 FILE HAS NOTHING TO SAY ABOUT THE OTHER FOUR STORES, and that
    // is not the same as saying they are empty — but because `merge` never
    // REMOVES from any store, an empty store can only ever be a no-op, so the
    // two collapse to the same behaviour and the merge needs no version branch.
    // A v1 file therefore imports exactly as it did before this ticket.
    //
    // The keys are refused OUTRIGHT on a v1 envelope rather than read anyway: a
    // file claiming version 1 while carrying a `parked` key was not written by
    // any build of this tool, and reading it would be the tolerate-unknown-keys
    // behaviour the version field exists to prevent.
    if (raw.version === 1) {
      ['parked', 'filed', 'done', 'rows'].forEach(function (key) {
        if (raw[key] !== undefined) {
          throw typedError('DayExportMalformedError',
            'That file claims to be Day Export version 1 but carries `' + key + '`, which no ' +
            'version-1 build writes. Nothing was imported — ask for the file again.');
        }
      });
    }

    const AA = areaLib();
    return {
      kind: KIND,
      version: raw.version,
      day: dayText(raw.day),
      by: labelText(raw.by),
      areas: AA.restore(raw.areas),
      parked: readStore(raw.parked, 'park decisions', normalizeParked),
      filed: readStore(raw.filed, 'barcoded rows', normalizeFiled),
      done: readStore(raw.done, 'scanned rows', normalizeDone),
      rows: readTable(raw.rows),
    };
  }

  // recordsOf(env) -> the seen-rows as ARCHIVE RECORDS, ready for
  // ArchiveStore.addAll / IbnoArchive.keyOf. Exposed separately from `merge` so
  // a caller that only wants the rows (or only wants the stores) can say so.
  function recordsOf(env) {
    return recordsFromTable(env && env.rows);
  }

  // ─── MERGE ────────────────────────────────────────────────────────────────
  //
  // merge(local, incoming) -> {
  //   areas,          the merged store, a NEW object; neither side is mutated
  //   changed: [],    labels whose stored value actually moved, for repainting
  //   added,          labels this device did not hold and now does
  //   matched,        labels both sides already agreed on — the local entry stands
  //   conflicts: [],  [{ label, local, incoming, by }] — kept local, NOT resolved
  //   staleSkipped,   entries stamped with another sort day, refused entry
  //   staleDays: [],  the DISTINCT dates those skipped entries carry, sorted
  //   total,          entries in the file; the four buckets above sum to it
  // }
  //
  // `staleDays` exists so a caller can NAME the disagreement rather than only
  // count it. A total skip is a reachable, legitimate state — the documented
  // 1:30 AM case puts two devices on different sort days for the same shift —
  // and a caller that can only say "289 skipped" cannot tell the user which two
  // days it is talking about or that the fix is to load today's report first.
  //
  //   local.areas   this device's work area store
  //   local.day     this device's sort day, or '' when no report has been loaded
  //   local.parked  this device's park day store   (optional)
  //   local.filed   this device's filing day store (optional)
  //   local.done    this device's tick day store   (optional)
  //   incoming      a parsed envelope (or anything carrying `.areas`)
  //
  // #795 widened it with four more results, each computed by its OWN rule (see
  // the header note). None of them is derived from another, and none of them
  // ever REMOVES anything:
  //
  //   parked, parkedAdded, parkedHeld, parkedChanged
  //   filed,  filedAdded,  filedHeld,  filedSkipped
  //   done,   doneAdded,   doneHeld,   doneSkipped
  //   rows (archive records), rowsSeen
  function merge(local, incoming) {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming) ||
        !incoming.areas || typeof incoming.areas !== 'object' || Array.isArray(incoming.areas)) {
      throw typedError('DayExportMalformedError',
        'There is nothing importable in that Day Export. Nothing was imported.');
    }

    const AA = areaLib();
    const l = local || {};
    const next = AA.restore(l.areas || {});
    const inc = AA.restore(incoming.areas);
    const day = dayText(typeof l.day === 'string' ? l.day : '');
    const envelopeBy = labelText(incoming.by);

    const out = {
      areas: next,
      changed: [],
      added: 0,
      matched: 0,
      conflicts: [],
      staleSkipped: 0,
      staleDays: [],
      total: 0,
    };
    const staleSeen = Object.create(null);

    // Sorted, so a conflict list and a summary read the same way twice running
    // rather than in whatever order the JSON happened to be written in.
    Object.keys(inc).sort().forEach(function (label) {
      const entry = inc[label];
      out.total++;

      // The #621 guard. See the sort-day note in this file's header.
      if (day && String(entry.date || '') !== day) {
        out.staleSkipped++;
        const stamp = String(entry.date || '');
        if (stamp && !staleSeen[stamp]) { staleSeen[stamp] = true; out.staleDays.push(stamp); }
        return;
      }

      const held = next[label];
      if (!held) {
        next[label] = entry;
        out.added++;
        out.changed.push(label);
        return;
      }
      if (held.area === entry.area) {
        // AGREEMENT KEEPS THE LOCAL ENTRY WHOLE, provenance and author included.
        // Rewriting it with the incoming one would restamp a row this device
        // typed with someone else's name, and would flip its auto/early flags
        // to a lane it was never written on — `by` and the provenance pair are
        // independent axes (ADR-0022) and neither is the import's to move.
        out.matched++;
        return;
      }
      // NOT RESOLVED. #796 surfaces this; keeping local is the seam it replaces.
      out.conflicts.push({
        label: label,
        local: held.area,
        incoming: entry.area,
        by: entry.by || envelopeBy,
      });
    });

    out.staleDays.sort();

    mergeParked(out, l, incoming);
    mergeFiled(out, l, incoming, day);
    mergeDone(out, l, incoming, day);

    // UNCONDITIONAL, AND MERGED INTO NOTHING. The rows are not a store and have
    // no local counterpart to arbitrate against: the archive is the only place
    // they go, and IbnoArchive.keyOf collapses the ones both devices saw by
    // construction. No sort-day filter either — the archive's window is 30 days
    // and its whole job is to hold what the self-pruning report already lost.
    out.rows = recordsOf(incoming);
    out.rowsSeen = out.rows.length;

    return out;
  }

  // ─── PARK: ADDITIVE, NEVER SUBTRACTIVE, NEVER RE-STAMPED ──────────────────
  //
  // The one rule in this file that is about a PERSON'S JUDGEMENT rather than
  // about a package: an import may ADD a park and may NEVER remove one. Park is
  // cleared by hand (#730), so a file that could unpark would let one device
  // silently undo the other's deliberate deferral — deferred FTrack work that
  // has no other record anywhere.
  //
  // A label ALREADY parked here keeps the LOCAL entry whole, source and day
  // included, for the same reason an agreeing area does: re-stamping it with
  // the incoming entry would rewrite when and from which report THIS device
  // parked it. It counts as held, not added, and reports no change.
  //
  // NOT sort-day gated. See the header note: a park survives the roll by
  // design, a carried park is meant to be SHOWN as carried, and a park is not a
  // routing decision so an off-day one cannot walk a package anywhere.
  function mergeParked(out, l, incoming) {
    const P = parkedLib();
    const inc = readStore(incoming.parked, 'park decisions', normalizeParked);
    let next = normalizeParked(dayLib().serializeDayStore(l.parked || emptyStore()));
    out.parkedAdded = 0;
    out.parkedHeld = 0;
    out.parkedChanged = [];
    Object.keys(inc.items).sort().forEach(function (label) {
      if (P.isParked(next, label)) { out.parkedHeld++; return; }
      const entry = inc.items[label];
      next = P.park(next, label, { source: entry.source, day: entry.day });
      out.parkedAdded++;
      out.parkedChanged.push(label);
    });
    out.parked = next;
  }

  // ─── BARCODED: A UNION, ON ITS OWN CLOCK ──────────────────────────────────
  //
  // Additive union, and NOTHING here reads or writes the scanned store —
  // ADR-0022 invariant 2, barcoded never implies scanned. This is one of the
  // two places the ticket says explicitly not to unify.
  //
  // SORT-DAY GATED on the incoming store's OWN stamp, unlike park. Filing
  // resets on a new sort day (#734 AC7) because yesterday's assignment is not
  // evidence about today's package (ADR-0022 invariant 6), and a filed row
  // LEAVES THE WORKING LIST — so importing a stale filing hides a package that
  // still needs work, which is the same shape of harm as #621's off-day area.
  //
  // FAIL CLOSED: an undated incoming store cannot prove it belongs to today and
  // is skipped whole, the same choice the areas filter makes for an undated
  // entry. When THIS device has no sort day yet there is nothing to judge
  // against and the gate does not apply, again matching the areas rule.
  //
  // The gate is on the STORE and not per label because lib/ibno-filed.js
  // deliberately carries no per-label day ("a field that can hold only one
  // value answers no question"). Reading the store's stamp is reading the only
  // day a filing has.
  function mergeFiled(out, l, incoming, day) {
    const F = filedLib();
    const inc = readStore(incoming.filed, 'barcoded rows', normalizeFiled);
    let next = normalizeFiled(dayLib().serializeDayStore(l.filed || emptyStore()));
    out.filedAdded = 0;
    out.filedHeld = 0;
    out.filedSkipped = 0;
    const labels = Object.keys(inc.items).sort();
    if (day && inc.day !== day) {
      out.filedSkipped = labels.length;
      out.filed = next;
      return;
    }
    labels.forEach(function (label) {
      if (F.isFiled(next, label)) { out.filedHeld++; return; }
      next = F.file(next, label, { source: inc.items[label].source });
      out.filedAdded++;
    });
    out.filed = next;
  }

  // ─── SCANNED: A SEPARATE UNION, MERGED SEPARATELY ─────────────────────────
  //
  // Same gate as `filed` and the same reasoning, in its own function reading
  // its own store. The duplication is deliberate: folding the two into one
  // generic union is exactly the collapse ADR-0022 forbids, and the day one of
  // them needs a different rule (they already differ from park) a shared
  // helper would have to grow a flag saying which store it is — which is the
  // #740 class with extra steps.
  //
  // The ticks are day-scoped for the sharpest reason of the three: since #733 a
  // tick can HOLD A ROW OUT of "Select with area", and a tracking number does
  // repeat across days.
  function mergeDone(out, l, incoming, day) {
    const D = doneLib();
    const inc = readStore(incoming.done, 'scanned rows', normalizeDone);
    const localStore = normalizeDone(dayLib().serializeDayStore(l.done || emptyStore()));
    let items = Object.assign({}, localStore.items);
    out.doneAdded = 0;
    out.doneHeld = 0;
    out.doneSkipped = 0;
    const labels = Object.keys(inc.items).sort();
    if (day && inc.day !== day) {
      out.doneSkipped = labels.length;
      out.done = { day: localStore.day, items: items };
      return;
    }
    labels.forEach(function (label) {
      if (D.isDone(items, label)) { out.doneHeld++; return; }
      items = D.setDone(items, label, true);
      out.doneAdded++;
    });
    out.done = { day: localStore.day, items: items };
  }

  return {
    KIND: KIND,
    VERSION: VERSION,
    SUPPORTED_VERSIONS: SUPPORTED_VERSIONS.slice(),
    MAX_BY_LEN: MAX_BY_LEN,
    build: build,
    stringify: stringify,
    parse: parse,
    recordsOf: recordsOf,
    merge: merge,
  };
});
