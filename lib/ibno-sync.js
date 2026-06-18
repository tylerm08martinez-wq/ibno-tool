'use strict';

// Cross-device sync for the IBNO Repeat History (issue #172, PRD #170, ADR-0007
// + ADR-0005's GitHub-backed pattern).
//
// This slice is the PURE merge core only — no DOM, no network, no clock, no
// tombstones. The Repeat History is a map { trackingNumber: { dates, category } }
// (ADR-0007; a legacy bare-[dates] entry normalizes to an unknown-category
// record). Two devices' histories merge by UNION of inbound dates per tracking
// number — date facts only accumulate, so the merge is idempotent and
// commutative and needs no last-write-wins clock. The 30-day window is NOT
// applied here: the caller composes this with IbnoRules.pruneHistory(merged,
// 30, today) so this function stays clock-free.
//
// The GitHub contents-API adapter (GET-merge-PUT / sha / 409-retry) arrives in
// slice #2 and will reuse mergeHistory; it is intentionally absent here.
//
// Dual-loadable with no build step:
// - Browser: window.IbnoSync
// - Node: require('./lib/ibno-sync')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IbnoSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // Normalize a history entry to the ADR-0007 { dates, category } shape. A
  // legacy bare-array entry reads as an unknown-category record; anything
  // unrecognized reads as empty. Pure; returns a fresh object.
  function normalizeEntry(entry) {
    if (Array.isArray(entry)) return { dates: entry.slice(), category: '' };
    if (entry && Array.isArray(entry.dates)) return { dates: entry.dates.slice(), category: entry.category || '' };
    return { dates: [], category: '' };
  }

  function uniqSorted(dates) {
    const seen = Object.create(null);
    const out = [];
    (Array.isArray(dates) ? dates : []).forEach(function (d) {
      if (d != null && !seen[d]) { seen[d] = true; out.push(d); }
    });
    return out.sort();
  }

  function maxDate(dates) {
    let m = '';
    (Array.isArray(dates) ? dates : []).forEach(function (d) { if (d != null && d > m) m = d; });
    return m; // true max, independent of input ordering
  }

  // Order-independent category resolution: a non-empty category beats empty;
  // two differing non-empty categories resolve to the one on the side with the
  // later most-recent inbound date (a final tie breaks to the lexically greater
  // string, so the result never depends on argument order).
  function resolveCategory(catA, datesA, catB, datesB) {
    if (catA === catB) return catA;
    if (!catA) return catB;
    if (!catB) return catA;
    const mA = maxDate(datesA);
    const mB = maxDate(datesB);
    if (mA > mB) return catA;
    if (mB > mA) return catB;
    return catA > catB ? catA : catB;
  }

  // mergeHistory(a, b) -> a new history map: union of inbound dates per tracking
  // number, with order-independent category resolution. Pure, idempotent,
  // commutative. Non-object inputs degrade to {}.
  function mergeHistory(a, b) {
    const A = (a && typeof a === 'object') ? a : {};
    const B = (b && typeof b === 'object') ? b : {};
    const out = {};
    const labels = Object.create(null);
    Object.keys(A).forEach(function (k) { labels[k] = true; });
    Object.keys(B).forEach(function (k) { labels[k] = true; });
    Object.keys(labels).forEach(function (label) {
      const na = normalizeEntry(A[label]);
      const nb = normalizeEntry(B[label]);
      const dates = uniqSorted(na.dates.concat(nb.dates));
      out[label] = { dates: dates, category: resolveCategory(na.category, na.dates, nb.category, nb.dates) };
    });
    return out;
  }

  // ─── GitHub contents-API adapter (browser only) ───────────────────────────
  // Reads/writes one JSON file (the Repeat History map) on a dedicated branch,
  // GET-merge-PUT with sha optimistic concurrency and a bounded 409-retry —
  // structurally the same as lib/entries-sync's adapter (ADR-0005). The token is
  // supplied by the caller (from localStorage); it travels only in the
  // Authorization header and is NEVER part of the written file (the file is the
  // history map, which contains no secrets). Repo coordinates are settings-
  // driven (ADR-0005 hosting amendment) so the page hard-codes nothing about
  // where the private data lives; only the in-repo path has a default.
  const DEFAULT_PATH = 'ibno-history.json';

  function nowIso() { return new Date().toISOString(); }

  let transportPromise = null;
  function getTransport() {
    if (root && root.GithubJsonSync) return Promise.resolve(root.GithubJsonSync);
    if (typeof require === 'function') return Promise.resolve(require('./github-json-sync'));
    if (!transportPromise) {
      transportPromise = new Promise(function (resolve, reject) {
        const doc = root && root.document;
        if (!doc || !doc.createElement) { reject(new Error('GithubJsonSync unavailable')); return; }
        const script = doc.createElement('script');
        script.src = 'lib/github-json-sync.js';
        script.onload = function () {
          if (root.GithubJsonSync) resolve(root.GithubJsonSync);
          else reject(new Error('GithubJsonSync unavailable'));
        };
        script.onerror = function () { reject(new Error('GithubJsonSync unavailable')); };
        doc.head.appendChild(script);
      });
    }
    return transportPromise;
  }

  function repoCoords(input) {
    const c = input || {};
    const owner = String(c.owner == null ? '' : c.owner).trim();
    const repo = String(c.repo == null ? '' : c.repo).trim();
    const branch = String(c.branch == null ? '' : c.branch).trim();
    if (!owner || !repo || !branch) {
      const e = new Error('missing repo coordinates'); e.code = 'coords'; throw e;
    }
    const path = String(c.path == null || c.path === '' ? DEFAULT_PATH : c.path).trim();
    return { owner: owner, repo: repo, branch: branch, path: path };
  }

  function apiUrl(coords) {
    return 'https://api.github.com/repos/' + coords.owner + '/' + coords.repo + '/contents/' + coords.path;
  }

  function transportCoords(coords) {
    const repo = repoCoords(coords);
    return { owner: repo.owner, repo: repo.repo, branch: repo.branch, path: repo.path };
  }

  function historyPayload(data) {
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  }

  // GET current file → { history, sha }. sha is null when the file does not yet
  // exist (first write creates it). A non-object payload reads as an empty map.
  async function fetchRemote(token, coords) {
    const transport = await getTransport();
    const remote = await transport.fetchRemote(token, transportCoords(coords));
    return { history: historyPayload(remote.data), sha: remote.sha };
  }

  // PUT the history map with an expected sha. Returns the new sha. 409 (stale
  // sha) throws code 'conflict' so the caller can re-fetch and retry. The body
  // content is the history map only — no token, by construction.
  async function putRemote(token, history, sha, coords) {
    const transport = await getTransport();
    return transport.putRemote(token, historyPayload(history), sha, transportCoords(coords), {
      project: historyPayload,
      messagePrefix: 'ibno repeat-history sync',
    });
  }

  // GET-merge-PUT with bounded 409 retry. `local` is the device's current
  // history map; `prune` (optional) is applied to the merged map before PUT so
  // the remote stays inside the retention window without this module depending
  // on lib/ibno-rules. Returns { history (merged+pruned), sha }.
  async function pushMergeHistory(token, local, knownSha, maxRetries, coords, prune) {
    const repo = repoCoords(coords); // validate once before the retry loop
    const transport = await getTransport();
    const pr = typeof prune === 'function' ? prune : function (m) { return m; };
    const result = await transport.pushMerge(token, historyPayload(local), {
      merge: function (remote, current) { return mergeHistory(historyPayload(remote), current); },
      project: historyPayload,
      prune: pr,
      maxRetries: maxRetries,
      knownSha: knownSha,
      messagePrefix: 'ibno repeat-history sync',
      coords: repo,
    });
    return { history: historyPayload(result.data), sha: result.sha };
  }

  return {
    normalizeEntry: normalizeEntry,
    mergeHistory: mergeHistory,
    repoCoords: repoCoords,
    apiUrl: apiUrl,
    nowIso: nowIso,
    fetchRemote: fetchRemote,
    putRemote: putRemote,
    pushMergeHistory: pushMergeHistory,
  };
});
