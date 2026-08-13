'use strict';
// E-OPS package-inquiry deep links.
//
// Dual-loadable with no build step:
// - Browser: window.Eops
// - Node: require('./lib/eops')
//
// One tracking number in, one eOps package-inquiry URL out. Deliberately built
// from the tracking number ALONE, the same contract lib/ftrack.js keeps: the
// Inbound and Van Scans report renders this link in its Express column, but a
// CSV export drops hyperlinks and keeps only the display text ("Express"), so
// the URL is not recoverable from the file the tool actually ingests. Deriving
// it from the tracking number is what makes the link work on every export.
//
// eOps is FedEx-network only (see notes/eops-portal.md), so like FTrack these
// always open in a new tab and never replace a tool the user is working in.
//
// Express only, by intent. The Express column is where this link lives in the
// report, and a ground package has no eOps package-inquiry entry to open, so
// callers render it beside FTrack on express rows and nothing on ground rows.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Eops = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Supplied by Tyler 2026-08-06, copied from the report's own Express link.
  const EOPS_BASE = 'https://eai-5530-user-interface-prod.app.paas.fedex.com/pkitracknumber?trkNbr=';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // eopsUrl(trk) -> the eOps deep link, or '' when there is no tracking number
  // to link. Callers render nothing on '' rather than a dead link.
  function eopsUrl(trk) {
    const t = String(trk == null ? '' : trk).trim();
    if (!t) return '';
    return EOPS_BASE + encodeURIComponent(t);
  }

  // eopsLink(trk, opts) -> the ready-to-inject anchor HTML, or '' when there is
  // no tracking number. opts.className overrides the default styling hook;
  // opts.text overrides the label for tight surfaces.
  function eopsLink(trk, opts) {
    const url = eopsUrl(trk);
    if (!url) return '';
    const o = opts || {};
    const cls = o.className == null ? 'eops-link' : String(o.className);
    const text = o.text == null ? 'E-OPS ↗' : String(o.text);
    return '<a class="' + escapeHtml(cls) + '" href="' + escapeHtml(url) + '"' +
      ' target="_blank" rel="noopener" title="Open ' + escapeHtml(trk) + ' in eOps package inquiry">' +
      escapeHtml(text) + '</a>';
  }

  return {
    EOPS_BASE: EOPS_BASE,
    eopsUrl: eopsUrl,
    eopsLink: eopsLink,
  };
});
