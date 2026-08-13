'use strict';

// Code 128 barcode encoder — the scannable rendering of a package's FULL scan
// barcode.
//
// Dual-loadable with no build step:
// - Browser: window.Barcode128
// - Node: require('./lib/barcode-128')
//
// WHY THIS EXISTS AS A LIB, not inline in a tool: the tools are buildless and
// offline-first (opened from file://, no CDN, no bundler), so a barcode library
// cannot be pulled from a CDN. Encoding is also pure, table-driven logic — the
// exact place a unit test earns its keep, since a wrong bar pattern produces a
// barcode that LOOKS right on screen and fails at the scanner.
//
// What gets encoded is the full scan barcode (SCAN_BARCODE / VAN_SCAN_BARCODE,
// ~34 chars), never the 12-digit tracking number alone — a scanner pointed at
// this must see what it would have seen on the package label.
//
// Symbology: Code 128, subsets B and C with automatic switching (C for digit
// runs, which is what a mostly-numeric FedEx barcode is, so the symbol stays
// about half as wide). Subset A (control characters) is not needed and not
// implemented — every character on a package barcode is in the printable
// ASCII 32..126 range that subset B covers.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Barcode128 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ─── SYMBOL TABLE ─────────────────────────────────────────────────────────
  //
  // One entry per Code 128 symbol value 0..106. Each string is the run-length
  // encoding of the symbol: alternating bar, space, bar, space, bar, space
  // widths in modules. Values 0..105 are six elements summing to 11 modules;
  // 106 (STOP) is the seven-element terminator summing to 13.
  //
  // Guarded by tests/barcode-128.test.js: a single mistyped digit here breaks
  // the sum-to-11 invariant, which is exactly the failure that would otherwise
  // only surface as a barcode the scanner refuses to read.
  const PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
    '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
    '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
    '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
    '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
    '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
    '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
    '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
    '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
    '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
    '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
    '211214', '211232', '2331112',
  ];

  const CODE_C     = 99;  // from subset B: switch to C
  const CODE_B     = 100; // from subset C: switch to B
  const START_B    = 104;
  const START_C    = 105;
  const STOP       = 106;
  const QUIET_ZONE = 10;  // modules of blank margin each side, per the spec

  function isDigit(ch) { return ch >= '0' && ch <= '9'; }

  // digitRunAt(text, i) -> how many consecutive digits start at index i.
  function digitRunAt(text, i) {
    let n = 0;
    while (i + n < text.length && isDigit(text[i + n])) n++;
    return n;
  }

  // Subset C packs TWO digits into one symbol, so it is worth switching into
  // whenever a long enough digit run is ahead. The thresholds are the standard
  // ones: 4+ digits at the very start (or at the end), 6+ mid-string — below
  // that, the switch symbol costs more than the packing saves.
  function shouldStartC(text) {
    const run = digitRunAt(text, 0);
    return run >= 4 || (run >= 2 && run === text.length);
  }

  function shouldSwitchToC(text, i) {
    const run = digitRunAt(text, i);
    if (run >= 6) return true;
    // A run that reaches the end of the string is worth packing at 4+, because
    // no switch back to B is needed afterwards.
    return run >= 4 && i + run === text.length;
  }

  // ─── ENCODING ─────────────────────────────────────────────────────────────

  // codesFor(text) -> the symbol values for `text`, from the start symbol
  // through the check symbol and STOP. Throws on characters Code 128 subset B
  // cannot represent, rather than silently emitting a barcode that scans as
  // something other than what is printed under it.
  function codesFor(text) {
    const s = String(text == null ? '' : text);
    if (!s) throw new Error('barcode-128: nothing to encode');
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 32 || c > 126) {
        throw new Error('barcode-128: character not encodable in subset B at index ' + i);
      }
    }

    let mode = shouldStartC(s) ? 'C' : 'B';
    const codes = [mode === 'C' ? START_C : START_B];
    let i = 0;

    while (i < s.length) {
      if (mode === 'C') {
        if (isDigit(s[i]) && isDigit(s[i + 1])) {
          codes.push(parseInt(s.substr(i, 2), 10));
          i += 2;
        } else {
          // An odd digit left over, or a non-digit: subset C cannot express it.
          codes.push(CODE_B);
          mode = 'B';
        }
      } else {
        if (shouldSwitchToC(s, i)) {
          codes.push(CODE_C);
          mode = 'C';
        } else {
          codes.push(s.charCodeAt(i) - 32); // subset B: ASCII 32..126 -> 0..94
          i += 1;
        }
      }
    }

    // Modulo-103 weighted checksum: start symbol counts once, then each data
    // symbol is weighted by its 1-based position.
    let sum = codes[0];
    for (let k = 1; k < codes.length; k++) sum += codes[k] * k;
    codes.push(sum % 103);
    codes.push(STOP);
    return codes;
  }

  // modulesFor(text) -> the bar/space run lengths for the whole symbol,
  // starting with a BAR and alternating, with no quiet zone included.
  function modulesFor(text) {
    const runs = [];
    codesFor(text).forEach(function (v) {
      const pattern = PATTERNS[v];
      for (let i = 0; i < pattern.length; i++) runs.push(Number(pattern[i]));
    });
    return runs;
  }

  // ─── SVG RENDERING ────────────────────────────────────────────────────────

  function escapeXml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // toSvg(text, opts) -> a standalone <svg> string, black bars on an explicit
  // white background.
  //
  //   opts.moduleWidth  px per narrow module (default 2)
  //   opts.height       px of bar height (default 80)
  //   opts.showText     render the encoded value under the bars (default true)
  //   opts.text         override the human-readable line (defaults to `text`)
  //   opts.fontSize     px for that line (default 13)
  //
  // The background is painted WHITE explicitly and the bars are hard #000
  // rather than theme tokens: this is the one surface in the toolset that must
  // NOT follow dark mode. A scanner needs dark bars on a light field, and this
  // SVG is also what goes to the printer.
  function toSvg(text, opts) {
    const o = opts || {};
    const mw = o.moduleWidth > 0 ? Number(o.moduleWidth) : 2;
    const barHeight = o.height > 0 ? Number(o.height) : 80;
    const showText = o.showText !== false;
    const fontSize = o.fontSize > 0 ? Number(o.fontSize) : 13;
    const label = o.text == null ? String(text) : String(o.text);

    const runs = modulesFor(text);
    const totalModules = runs.reduce(function (a, b) { return a + b; }, 0) + QUIET_ZONE * 2;
    const width = totalModules * mw;
    const textGap = showText ? fontSize + 6 : 0;
    const height = barHeight + textGap;

    let x = QUIET_ZONE * mw;
    let bars = '';
    runs.forEach(function (run, i) {
      const w = run * mw;
      if (i % 2 === 0) { // even index = bar, odd = space
        bars += '<rect x="' + x.toFixed(2) + '" y="0" width="' + w.toFixed(2) +
          '" height="' + barHeight + '" fill="#000"/>';
      }
      x += w;
    });

    let readable = '';
    if (showText) {
      readable = '<text x="' + (width / 2).toFixed(2) + '" y="' + (height - 2) +
        '" text-anchor="middle" font-family="monospace" font-size="' + fontSize +
        '" fill="#000">' + escapeXml(label) + '</text>';
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width.toFixed(2) +
      '" height="' + height + '" viewBox="0 0 ' + width.toFixed(2) + ' ' + height +
      '" role="img" aria-label="Barcode ' + escapeXml(label) + '">' +
      '<rect x="0" y="0" width="' + width.toFixed(2) + '" height="' + height + '" fill="#fff"/>' +
      bars + readable + '</svg>';
  }

  return {
    PATTERNS: PATTERNS,
    QUIET_ZONE: QUIET_ZONE,
    codesFor: codesFor,
    modulesFor: modulesFor,
    toSvg: toSvg,
  };
});
