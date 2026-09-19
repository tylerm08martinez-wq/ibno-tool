'use strict';

// PER-CARD FEEDBACK ON THE WHAT'S NEW DRAWER (#1030).
//
// The drawer (#1021, cards #1028) tells Tyler what is on staging and not yet on
// the cage PC. It could not tell anyone what he thought of it: he read a card
// at 03:00, found something wrong, and the only route back was to remember it
// until he was at a keyboard. This module is the pure half of the route back —
// the store shape, the markdown one Copy-all produces, and the body of the one
// GitHub comment a card can post.
//
// STAGING-ONLY UI STATE, ON THE SAME TERMS AS THE TESTED TICK. One localStorage
// key, `ibno_whats_new_feedback`, an object keyed by PR number. It is NOT in the
// Day Export envelope, it is NOT synced, and it is NOT a day store (ADR 0022
// does not reach it): "Tyler typed a note about a build" is a fact about one
// person at one browser. Putting it on the wire would have the Cage A Admin's
// device import a paragraph about a build it is not running.
//
// A PARSE FAILURE IS AN EMPTY MAP, never a throw, for the same reason
// whatsNewTestedMap() degrades: the notes are a convenience and a corrupted key
// must not be able to take the drawer down with it — least of all the drawer,
// whose whole job is to be readable when something has gone wrong.
//
// THE RECORD SHAPE, and every field is load-bearing:
//
//   { "1029": { text: "…", updatedAt: "2026-09-14T11:02:00.000Z",
//               sentAt: "2026-09-14T11:03:00.000Z", sentText: "…" } }
//
// `sentText` is the copy of `text` that was actually posted, NOT a flag. A
// boolean "sent" would go on reading Sent after the note had been rewritten,
// which is the one state that loses work: Tyler edits the note, the button says
// Sent, and the edit never leaves the device. isDirty() compares the two, so
// the button re-arms the moment a character changes and the record itself
// carries the evidence of what GitHub has.
//
// NO TOKEN EVER ENTERS THIS MODULE. The token is read at click time by the
// page, sent once as a Bearer header, and never written anywhere — nothing
// here takes it as an argument, so nothing here can put it in a store, a
// markdown block or a comment body.
//
// Dual-loadable with no build step:
// - Browser: window.WhatsNewFeedback
// - Node:    require('./lib/whats-new-feedback')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WhatsNewFeedback = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const STORAGE_KEY = 'ibno_whats_new_feedback';

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  // parseStore(raw) -> { [pr]: { text, updatedAt, sentAt, sentText } }
  //
  // `raw` is whatever came out of localStorage: a JSON string, an already
  // parsed object, null, or garbage. EVERY non-conforming input lands on `{}`,
  // and non-conforming is checked per ENTRY as well as per file — a store whose
  // third key holds a number must not be able to hand the drawer a record whose
  // `text` is not a string, because every consumer below concatenates it.
  function parseStore(raw) {
    let data = raw;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { return {}; }
    }
    if (!isPlainObject(data)) return {};
    const out = {};
    Object.keys(data).forEach(function (k) {
      const rec = data[k];
      if (!isPlainObject(rec)) return;
      if (typeof rec.text !== 'string') return;
      out[String(k)] = {
        text: rec.text,
        updatedAt: str(rec.updatedAt) || null,
        sentAt: str(rec.sentAt) || null,
        sentText: typeof rec.sentText === 'string' ? rec.sentText : null,
      };
    });
    return out;
  }

  // isDirty(rec) -> is there unsent text in this record?
  //
  // Three answers in one predicate: no text at all is not dirty (there is
  // nothing to send), text never sent is dirty, and text that has been sent is
  // dirty again the moment it differs from what was sent. Compared on the
  // TRIMMED strings, because trailing whitespace is not an edit anyone means.
  function isDirty(rec) {
    if (!isPlainObject(rec)) return false;
    const text = str(rec.text).trim();
    if (!text) return false;
    if (!rec.sentAt) return true;
    return str(rec.sentText).trim() !== text;
  }

  // hasText(rec) -> does this record hold anything a reader would call a note?
  // Whitespace is not a note: a card whose box was clicked into and out of must
  // not grow a mark in its header or a heading in the Copy all markdown.
  function hasText(rec) {
    return isPlainObject(rec) && str(rec.text).trim() !== '';
  }

  // withFeedback(entries, map) -> the entries that have a note, IN THE ORDER
  // THEY WERE GIVEN. The drawer hands its pending list, already in ship order,
  // so the markdown reads in the same order as the cards it came from. Shared
  // so the "Copied N notes" count and the markdown cannot disagree about N.
  function withFeedback(entries, map) {
    const m = isPlainObject(map) ? map : {};
    return (entries || []).filter(function (e) {
      return e && hasText(m[String(e.pr)]);
    });
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // A local-clock stamp, "YYYY-MM-DD HH:mm". LOCAL, not UTC, deliberately: this
  // string is read by Tyler beside a shift that starts at 03:00 Phoenix, and a
  // UTC stamp would date half his notes tomorrow. It is a human timestamp on a
  // human note, never a key and never compared — `updatedAt` and `sentAt` keep
  // ISO for that.
  function formatStamp(now) {
    const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // An unnamed device is SAID, not blanked. "Staging feedback from , 2026-09-14"
  // reads as a bug in the tool; "from an unnamed device" reads as a fact about
  // the browser, and tells the reader what to fix if they want a name.
  function deviceLabel(deviceName) {
    const n = str(deviceName).trim();
    return n || 'an unnamed device';
  }

  function testedLabel(tested) {
    return tested ? 'Tested' : 'not tested';
  }

  // formatMarkdown(entries, feedbackMap, testedMap, deviceName, now) -> the
  // whole Copy all payload, or '' when nothing has been written.
  //
  // EMPTY IN, EMPTY OUT, and the caller must not write '' to the clipboard —
  // clipboard.writeText('') CLEARS it and the execCommand fallback copies an
  // empty textarea, so a Copy all with nothing to copy would silently destroy
  // whatever the user already had on the clipboard (the #750 guard, arrived at
  // from the other side). The page's copyWithFeedback() refuses empty text for
  // exactly this reason; returning '' here is what hands it that refusal.
  //
  // The note text is emitted VERBATIM. This is markdown going to a markdown
  // reader (a clipboard paste into an issue, a Teams message); escaping it
  // would show Tyler backslashes in his own words.
  function formatMarkdown(entries, feedbackMap, testedMap, deviceName, now) {
    const map = isPlainObject(feedbackMap) ? feedbackMap : {};
    const tested = isPlainObject(testedMap) ? testedMap : {};
    const mine = withFeedback(entries, map);
    if (!mine.length) return '';
    const head = '## Staging feedback — ' + deviceLabel(deviceName) + ' — ' + formatStamp(now);
    const sections = mine.map(function (e) {
      const rec = map[String(e.pr)];
      return '### #' + e.pr + ' ' + str(e.title).trim() +
        '  (' + testedLabel(tested[String(e.pr)] === true) + ')\n\n' +
        str(rec.text).trim();
    });
    return head + '\n\n' + sections.join('\n\n') + '\n';
  }

  // commentBody(entry, text, deviceName, tested, now) -> the body of the ONE
  // issue comment a card posts. '' when there is nothing to say, and the caller
  // must never POST an empty body: an empty comment on a PR is noise a human
  // then has to delete.
  //
  // The entry is only read for context the comment cannot get from the URL it
  // is posted to — the comment lands ON the PR, so it does not repeat the PR
  // number, and a title in the first line would just repeat the page's own.
  function commentBody(entry, text, deviceName, tested, now) {
    const body = str(text).trim();
    if (!body) return '';
    return '**Staging feedback** from ' + deviceLabel(deviceName) + ', ' + formatStamp(now) +
      ' (tested: ' + (tested ? 'yes' : 'no') + ')\n\n' + body;
  }

  // commentUrl(owner, repo, pr) -> the REST endpoint one comment is posted to.
  // Issue comments, not review comments: a PR is an issue for this purpose, the
  // comment lands in the conversation timeline, and it needs no diff position.
  // Here rather than in the page so the DOM test can assert the URL against the
  // same string the page builds, and so nothing spells api.github.com twice.
  function commentUrl(owner, repo, pr) {
    return 'https://api.github.com/repos/' + owner + '/' + repo + '/issues/' + String(pr) + '/comments';
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    parseStore: parseStore,
    isDirty: isDirty,
    hasText: hasText,
    withFeedback: withFeedback,
    formatStamp: formatStamp,
    formatMarkdown: formatMarkdown,
    commentBody: commentBody,
    commentUrl: commentUrl,
  };
});
