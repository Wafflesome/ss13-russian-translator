// Map overlay: English speech bubbles above characters.
//
// Speech bubbles ("runechat") are drawn by BYOND's map renderer, not its browser, so they can't be
// changed in place. Every bubble is also printed in the chat window, where it is already translated,
// so nothing on the map has to be read:
//   * overlay/OverlayHost.cs looks at the map for rows of outlined, single-colour letters (that is what
//     a bubble looks like) and reports where they are, their colour and size - never the letters;
//   * the chat page reports each new spoken line: who said it, their name colour, the Russian words and,
//     once translated, the English;
//   * this module works out what each chat line's bubble must look like - the server's bubble font is
//     known pixel for pixel (src/bubblefont.js), so the number of lines and the exact width and height
//     of every line follow from the words - and pairs each new bubble with the one chat line it fits,
//     also checking the speaker's colour, where that speaker was last seen, and timing. When two chat
//     lines fit a bubble about equally well it waits a moment, and if it is still unsure it leaves the
//     bubble alone rather than show the wrong English.
//   * The host then follows the bubble ~60 times a second and draws the English over it in the game's
//     own font, size, colour and outline, on a box just big enough to hide the Russian.
'use strict';
const fs = require('fs');
const path = require('path');
const { BubbleFont, LINE_PITCH, MAX_CHARS } = require('./bubblefont.js');

const TILE = 32; // game pixels per tile

// ---------------------------------------------------------------------------------- colour helpers
function cdist(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}
function parseColor(s) {
  if (Array.isArray(s)) return s.length >= 3 ? s.slice(0, 3).map(Number) : null;
  if (!s) return null;
  s = String(s).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m[1][i] + m[1][i], 16));
  m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}
function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let h = 0;
  let s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function hslToRgb([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((v) => Math.round((v + m) * 255));
}
/** The colours a speaker's bubble can have: normal, and the dimmer one used for emotes and whispers. */
function variants(c) {
  if (!c) return [];
  const [h, s, l] = rgbToHsl(c);
  return [c, c.map((v) => Math.max(0, v - 23)), hslToRgb([h, s * 0.85, l * 0.85])];
}
/** Distance between two speaker colours, allowing either one to be the dimmed variant. */
function colorGap(a, b) {
  let d = Infinity;
  for (const v of variants(b)) d = Math.min(d, cdist(a, v));
  for (const v of variants(a)) d = Math.min(d, cdist(b, v));
  return d;
}
const isGrey = (c) => Math.max(...c) - Math.min(...c) < 26;
const toInt = (c) => ((c[0] & 255) << 16) | ((c[1] & 255) << 8) | (c[2] & 255);
function hexToInt(s, def) {
  const c = parseColor(s);
  return c ? toInt(c) : def;
}

// ---------------------------------------------------------------------------------- small helpers
function median(a) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function meanColor(items) {
  let n = 0;
  const s = [0, 0, 0];
  for (const it of items) {
    const k = it.n || 1;
    n += k;
    for (let i = 0; i < 3; i++) s[i] += it.c[i] * k;
  }
  return s.map((v) => Math.round(v / Math.max(1, n)));
}
const sumGlyphs = (items) => items.reduce((a, t) => a + t.n, 0);
function* combinations(arr, k, start = 0, acc = []) {
  if (acc.length === k) {
    yield acc.slice();
    return;
  }
  for (let i = start; i <= arr.length - (k - acc.length); i++) {
    acc.push(arr[i]);
    yield* combinations(arr, k, i + 1, acc);
    acc.pop();
  }
}
// ---------------------------------------------------------------------------------- text helpers
// Pixel-font letters that look the same in Latin and Cyrillic; the reader can return either.
const TO_CYR = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', n: 'п', o: 'о', p: 'р', r: 'г', t: 'т', u: 'и', x: 'х', y: 'у' };
const TO_LAT = { а: 'a', в: 'b', с: 'c', е: 'e', н: 'h', к: 'k', м: 'm', п: 'n', о: 'o', р: 'p', г: 'r', т: 't', и: 'u', х: 'x', у: 'y' };
/** Letters only, lower case, look-alikes and й/ё folded: for comparing what was read with what was said. */
function normRu(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/й/g, 'и')
    .replace(/ъ/g, 'ь')
    .replace(/[a-z]/g, (ch) => TO_CYR[ch] || ch)
    .replace(/[^а-я0-9]/g, '');
}
/** Fewest edits that turn `p` into some piece of `t` (how well a part of a bubble fits a chat line). */
function editsInside(p, t) {
  const n = p.length;
  const m = t.length;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1);
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (p[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return Math.min(...prev);
}
/** How alike a line as read is to a line of text (0..1), letters only. */
function lineSim(read, text) {
  const a = normRu(read);
  const b = normRu(text);
  if (a.length < 2 || !b.length) return -1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
/** The hover text as read, tidied: stray dots/quotes the reader may add between letters become spaces. */
/** Balloon alerts are white (a little grey while they fade). */
function isBalloonColor(c) {
  if (!c) return false;
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  return mn >= 165 && mx - mn <= 28;
}
function cleanRead(s) {
  return String(s || '')
    .replace(/[^\p{L}\p{N}\s\-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
/**
 * The hover reader sometimes splits a wide Russian letter into thin Latin ones ("lIlильтр" for "Фильтр",
 * "инf ерком" for "интерком", "торiовый" for "торговый"). Each such word is tried with the Russian letters
 * those pieces could be, and the version that is a known word (or name) is kept. isKnown(word) -> bool.
 */
const OCR_PIECE = /[lIi|!1fuj]{1,3}/g;
const OCR_CANDS = ['г', 'т', 'ц', 'п', 'м', 'ш', 'щ', 'н', 'ф', 'ы', 'и', 'л', 'ж', 'д'];
const LOOKALIKE = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в', A: 'А', C: 'С', E: 'Е', O: 'О', P: 'Р', X: 'Х', Y: 'У', K: 'К', M: 'М', T: 'Т', H: 'Н', B: 'В' };
function repairRead(text, isKnown) {
  const toks = String(text || '').split(' ');
  const out = [];
  const hasCyr = (w) => /[А-Яа-яЁё]/.test(w);
  const suspicious = (w) => /[lIi|!1fuj]/.test(w) && (hasCyr(w) || /^[lIi|!1fuj ]+$/.test(w));
  const fixWord = (w) => {
    if (!suspicious(w) || isKnown(w.toLowerCase())) return null;
    const base = [...w].map((ch) => (/[lIi|!1fuj]/.test(ch) ? ch : LOOKALIKE[ch] || ch)).join('');
    const runs = [];
    let m;
    OCR_PIECE.lastIndex = 0;
    while ((m = OCR_PIECE.exec(base))) runs.push([m.index, m[0].length]);
    if (!runs.length || runs.length > 2) return null;
    let best = null;
    const tryCombo = (k, str, shift) => {
      if (k === runs.length) {
        const lw = str.toLowerCase();
        if (/[a-z]/i.test(lw) || lw.length < 4) return;
        if (isKnown(lw) && !best) best = str;
        return;
      }
      const [at, len] = runs[k];
      const a = at + shift;
      for (const c of OCR_CANDS) {
        const shout = (str.match(/[А-ЯЁ]/g) || []).length >= 2 && !/[а-яё]/.test(str);
        const up = shout || (a === 0 && /^[А-ЯЁA-Z]/.test(w)) || (a === 0 && /[lIi|!1]/.test(w[0]) && /^[^а-яё]*[а-яё]/.test(str.slice(a + len))) ? c.toUpperCase() : c;
        tryCombo(k + 1, str.slice(0, a) + up + str.slice(a + len), shift + 1 - len);
        if (best) return;
      }
    };
    tryCombo(0, base, 0);
    return best;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const next = toks[i + 1];
    // a letter split in two by a space: "инf ерком", "мотиваu ионный", "l lеркинс", "УТИЛИЗАl l ИЯ"
    if (next !== undefined && toks[i + 2] !== undefined && /^[lIi|!1fuj]{1,3}$/.test(next) && (/[lIi|!1fuj]$/.test(t) || (hasCyr(t) && hasCyr(toks[i + 2])))) {
      const joined3 = fixWord(t + next + toks[i + 2]);
      if (joined3) {
        out.push(joined3);
        i += 2;
        continue;
      }
    }
    if (next !== undefined && /[lIi|!1fuj]$/.test(t) && (hasCyr(t) || hasCyr(next) || /^[lIi|!1fuj]+$/.test(t))) {
      const joined = fixWord(t + next);
      if (joined) {
        out.push(joined);
        i++;
        continue;
      }
    }
    out.push(fixWord(t) || t);
  }
  return out.join(' ');
}

/**
 * Names can mix Russian and English ("торговый автомат Robust Softdrinks"). The reader returns Cyrillic for
 * letters that look the same in both, so each word is sorted out on its own: a word with letters only
 * Latin has is English and is spelled in Latin. Returns null when no word is Russian.
 */
function mixedWords(text) {
  let russian = 0;
  const one = (w) => {
    const lat = (w.match(/[dfgijlqrsvwzDFGIJLQRSVWZ]/g) || []).length;
    const cyr = w.match(/[бгдёжзийлфцчшщъыьэюяБГДЁЖЗИЙЛФЦЧШЩЪЫЬЭЮЯ]/g) || [];
    // an English word with one letter read as its Russian look-alike ("Саnistег": г is the pixel font's r)
    const lookalike = lat >= 2 && cyr.length === 1 && /[гпи]/i.test(cyr[0]) && w.length >= 4;
    if (lat && (!cyr.length || lookalike)) {
      return [...w].map((ch) => {
        const lo = ch.toLowerCase();
        const l = TO_LAT[lo] || (lookalike ? { г: 'r', п: 'n', и: 'u' }[lo] : null);
        return l ? (ch === lo ? l : l.toUpperCase()) : ch;
      }).join('');
    }
    if (cyr.length) russian++;
    return w;
  };
  // (each part of "PDA-Илья" on its own)
  const words = String(text || '').split(' ').map((w) => w.split('-').map(one).join('-'));
  return russian ? words.join(' ') : null;
}
const letterCount = (s) => String(s || '').replace(/\s+/g, '').length;
/** The detector's smallest letter height in screen pixels (OverlayHost.SetZoom). */
const minGlyphPx = (z) => (z ? Math.max(4, Math.min(6, Math.round(z * 1.75))) : 5);

class MapOverlay {
  constructor({ root, logDir, cfg, log, translator, tm }) {
    this.translator = translator || null;
    // detailed logs (src/telemetry.js); a stand-in that does nothing when there is none
    this.tm = tm || { event() {}, count() {}, sample() {}, addSummary() {} };
    this.tm.addSummary('Map overlay', () => {
      const h = this.hostStats || {};
      const out = [
        `status ${this.status}${this.problem ? ' (' + this.problem + ')' : ''}, map zoom ${this.zEst ? this.zEst.toFixed(3) : 'not found'}, map area ${this.rect ? this.rect.join(',') : '?'}`,
        `spoken chat lines ${this.stats.chatLines}, bubbles paired ${this.stats.matched}, labels lost ${this.stats.lost || 0}, unsure ${this.stats.unsure}`,
      ];
      if (h.t) out.push(`last minute: whole-map looks ${h.full} (${h.same} unchanged, avg ${h.fullAvg} ms), close-up looks ${h.fast} (avg ${h.fastAvg} ms), labels drawn ${h.draws}, label vs bubble distance median ${h.err50} px / 90% ${h.err90} px, processor ${h.cpu}% of one core`);
      return out;
    });
    this.pairedAt = new Map(); // speaker -> when one of their bubbles was last paired (their stack slides then)
    this.knownNames = new Map(); // speaker name (normalised) -> name as written in chat
    this.tipRu = '';
    this.tipEn = '';
    this.zRead = 0; // map zoom the host found by reading text
    this.root = root;
    this.logDir = logDir;
    this.cfg = cfg;
    this.log = log || (() => {});
    this.proc = null;
    this.status = 'off'; // off | starting | running | error
    this.problem = '';
    this.excluded = true;
    this.frames = 0;
    this.lastFrameMs = 0;
    this.font = null;
    try {
      this.font = new BubbleFont(path.join(root, 'overlay', 'fonts', 'grand9k.txt'));
    } catch (e) {
      this.log('Speech bubbles: bubble font missing (' + e.message + ').');
    }
    this.msgs = new Map(); // key -> chat line
    this.tracks = new Map(); // detector id -> line on the map
    this.graveyard = []; // scenery lines that disappeared recently
    this.learned = new Map(); // speaker name -> {c, hits, strong}: their bubble colour
    this.anchors = new Map(); // speaker name -> {x, y, t, live}: where their bubble was
    this.zHist = []; // map zoom measured from confident pairings
    this.zEst = 0;
    this.zSent = 0;
    this.wrapLo = 0; // what the server's bubble width can be, learned from pairings
    this.wrapHi = Infinity;
    this.rect = null;
    this.order = 0;
    this.history = [];
    this.tipHistory = [];
    this.labelsShown = [];
    this.interval = 0;
    this.stats = { chatLines: 0, matched: 0, unsure: 0 };
    this._lastLabels = '';
    this._lastWatch = '';
    this._lastStyle = '';
  }

  // ---------------------------------------------------------------- inputs from the chat page
  /** A new chat line that may also appear as a speech bubble. `now` is for tests. */
  noteChatLine(key, m, now) {
    now = now || Date.now();
    const ru = String(m.ru || '').replace(/\s+/g, ' ').trim();
    if (!ru) return;
    this.msgs.set(key, {
      key,
      t: now,
      ru,
      n: Math.max(1, Number(m.n) || letterCount(ru)),
      color: parseColor(m.color),
      name: String(m.name || '').slice(0, 80),
      en: typeof m.en === 'string' && m.en.trim() ? m.en.trim() : null,
      italic: !!m.it,
      radio: !!m.rd, // a radio line: no bubble of its own, so it doesn't make the map be checked more often
      // heard as a ghost from someone out of view: their bubble is only seen if they come into view, so
      // the line can still be paired, but it doesn't make the map be checked more often
      far: !!m.far,
      icon: m.icon === true || m.icon === false ? m.icon : null,
      lines: null, // track id per bubble line once paired
      layout: null,
      z: 0,
      color2: null,
      assignedAt: 0,
      layouts: null,
    });
    this.stats.chatLines++;
    this.tm.count('chat lines (spoken, may have a bubble)');
    if (m.rd) this.tm.count('chat lines over the radio');
    if (m.it) this.tm.count('chat lines in the small font (quiet / radio nearby / machines)');
    if (m.far) this.tm.count('chat lines heard as a ghost from someone out of view');
    this.tm.event('chat', { key, name: m.name, n: Number(m.n) || 0, it: m.it ? 1 : 0, rd: m.rd ? 1 : 0, far: m.far ? 1 : 0, color: m.color, en: m.en ? 1 : 0, ru: String(m.ru || '').slice(0, 120) });
    // a bubble appears together with its chat line and fades in over about 0.2 s: look at the map just
    // then, instead of whenever the next turn would have come
    if (!m.rd && !m.far && this.proc && this.cfg.mapOverlayWakeOnChat !== false) {
      // once as it fades in, and once more when it is fully there (if it wasn't found the first time)
      clearTimeout(this._wakeTimer);
      clearTimeout(this._wakeTimer2);
      this._wakeTimer = setTimeout(() => this.proc && this._write('N\n'), this.cfg.mapOverlayWakeDelayMs || 180);
      this._wakeTimer2 = setTimeout(() => {
        const x = this.msgs.get(key);
        if (this.proc && x && !x.lines) this._write('N\n');
      }, (this.cfg.mapOverlayWakeDelayMs || 180) + 230);
    }
    if (m.name) {
      this.knownNames.set(normRu(m.name), String(m.name));
      if (this.knownNames.size > 500) this.knownNames.delete(this.knownNames.keys().next().value);
    }
    this._prune(now);
    this._updateInterval(now);
    this._updateWatch(now);
  }
  /** The translated text of a chat line reported earlier. */
  noteChatEnglish(key, en) {
    const m = this.msgs.get(key);
    if (!m || typeof en !== 'string' || !en.trim()) return;
    if (!m.en) {
      const ms = Date.now() - m.t;
      this.tm.event('english', { key, ms });
      this.tm.sample('chat line: English ready after (ms)', ms);
    }
    m.en = en.trim();
    for (const h of this.history) if (h.key === key) h.en = m.en.slice(0, 80);
    if (m.lines) this._sendLabels();
  }

  _prune(now) {
    for (const [k, m] of this.msgs) {
      const age = now - m.t;
      const live = m.lines && m.lines.some((id) => id && this.tracks.has(id));
      if (age > 7000 && !live) this.msgs.delete(k);
      else if (age > 60000) this.msgs.delete(k);
    }
    if (this.msgs.size > 300) {
      const keys = [...this.msgs.keys()].slice(0, this.msgs.size - 300);
      for (const k of keys) this.msgs.delete(k);
    }
  }

  // ---------------------------------------------------------------- process control
  start() {
    const custom = this.cfg._overlayCommand; // tests: run the simulator instead
    if (this.proc || (process.platform !== 'win32' && !custom)) {
      if (process.platform !== 'win32' && !custom) this.status = 'off';
      return;
    }
    const script = path.join(this.root, 'overlay', 'MapOverlay.ps1');
    const dbg = path.join(this.logDir, 'overlay');
    this.status = 'starting';
    this.problem = '';
    this._zoomOffered = false;
    this._smallSent = undefined;
    this.tracks.clear();
    this._lastLabels = '';
    this._lastWatch = '';
    this._lastStyle = '';
    this.zSent = 0;
    try {
      fs.writeFileSync(path.join(this.logDir, 'overlay.log'), '');
    } catch (e) {}
    try {
      this.proc = Bun.spawn(
        custom || ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-LogFile', path.join(this.logDir, 'overlay.log'), '-DebugDir', dbg, '-IntervalMs', String(this._idleMs()), '-CacheDir', path.join(this.root, 'cache'), '-ShowInScreenshots', this.cfg.mapOverlayShowInScreenshots ? '1' : '0'],
        { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
      );
    } catch (e) {
      this.status = 'error';
      this.problem = 'Could not start the map overlay: ' + e.message;
      this.log(this.problem);
      return;
    }
    this.interval = this._idleMs();
    this.log('Map overlay starting (English speech bubbles)...');
    this._readLines(this.proc.stdout, (line) => this._onLine(line));
    this._readLines(this.proc.stderr, (line) => {
      if (line.trim()) fs.appendFile(path.join(this.logDir, 'overlay.log'), 'stderr: ' + line + '\n', () => {});
    });
    const proc = this.proc;
    proc.exited.then((code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.status !== 'error') {
        this.status = 'off';
        this.log(`Map overlay stopped (code ${code}).`);
      }
    });
    this._sendThresholds();
    this._write('F' + Math.max(10, Number(this.cfg.mapOverlayFollowMs) || 33) + '\n');
    this._write('V' + (this.cfg.detailedLogs === false ? 0 : 1) + '\n');
    this.setStyle();
  }

  stop(immediate) {
    if (!this.proc) return;
    try {
      this.proc.stdin.write('Q\n');
      this.proc.stdin.flush();
    } catch (e) {}
    const p = this.proc;
    this.proc = null;
    const kill = () => {
      try {
        p.kill();
      } catch (e) {}
    };
    if (immediate) kill();
    else setTimeout(kill, 800);
    this.status = 'off';
  }

  /** Box colour/opacity and font, from the settings. */
  setStyle() {
    const c = this.cfg;
    const color = hexToInt(c.mapOverlayBoxColor, 0x0b0d12);
    const op = Number.isFinite(Number(c.mapOverlayBoxOpacity)) ? Math.max(0, Math.min(100, Number(c.mapOverlayBoxOpacity))) : 100;
    const clean = String(c.mapOverlayFont || '').toLowerCase() === 'clean' ? 1 : 0;
    const predict = c.mapOverlayPredict === false ? 0 : 1;
    const mode = String(c.mapOverlayBoxFit || 'tight');
    const fit = mode === 'cover' ? 0 : mode === 'english' ? 1 : 2;
    const line = `S${color},${Math.round(op * 2.55)},${clean},${predict},${fit}\n`;
    this._lastStyle = line;
    if (this.proc) this._write(line);
  }
  // kept for older callers
  setFont() {
    this.setStyle();
  }

  /** Ask the host to save what it sees right now (logs/overlay). */
  snapshot() {
    if (this.proc) this._write('D\n');
  }

  _activeMs() {
    return Math.max(30, Number(this.cfg.mapOverlayIntervalMs) || 60);
  }
  _idleMs() {
    return Math.max(this._activeMs(), Number(this.cfg.mapOverlayIdleMs) || 450);
  }
  /** Look at the whole map often while a bubble is expected; otherwise keep a slow watch. */
  _updateInterval(now) {
    if (!this.proc) return;
    let busy = false;
    for (const m of this.msgs.values()) {
      if (!m.lines && !m.radio && !m.far && now - m.t < 2500) {
        busy = true;
        break;
      }
    }
    const want = busy ? this._activeMs() : this._idleMs();
    if (want !== this.interval) {
      this.interval = want;
      this._write('I' + want + '\n');
    }
  }

  _sendThresholds() {
    const t = this.cfg.mapOverlayThresholds;
    if (t && this.proc) this._write('T' + [t.text, t.outline, t.radius].filter((x) => x != null).join(',') + '\n');
  }

  _write(s) {
    try {
      this.proc.stdin.write(s);
      this.proc.stdin.flush();
    } catch (e) {}
  }

  async _readLines(stream, onLine) {
    const reader = stream.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    for (;;) {
      let r;
      try {
        r = await reader.read();
      } catch (e) {
        break;
      }
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        try {
          onLine(line);
        } catch (e) {
          this.log('overlay: ' + e.message);
        }
      }
    }
  }

  _onLine(line) {
    if (!line.startsWith('{')) {
      if (line.trim()) fs.appendFile(path.join(this.logDir, 'overlay.log'), 'out: ' + line + '\n', () => {});
      return;
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      return;
    }
    if (msg.t === 'ready') {
      this.status = 'running';
      this.excluded = msg.excluded !== false;
      this.log('Map overlay running: speech bubbles will show the English from chat.' + (this.excluded ? '' : ' (Labels can\'t be hidden from screen capture here, so the game window is read directly - a little slower.)'));
    } else if (msg.t === 'error') {
      this.status = 'error';
      this.problem = 'The map overlay could not start (' + msg.code + '): ' + (msg.msg || '');
      this.log(this.problem);
    } else if (msg.t === 'labels') {
      // the labels are hidden from the overlay's own look at the screen (fast; nothing to blink)
      this.keyed = msg.keyed === 1;
      this.tm.event('labels', { keyed: msg.keyed });
      if (this.keyed) this.log('Map overlay: labels are hidden from screen capture (sharp-edged boxes), so the map is read straight from the screen - faster following.');
    } else if (msg.t === 'capture') {
      this.captureMode = msg.mode;
      this.log(msg.mode === 1 ? 'Map overlay: reading the game window directly (boxes stay steady).' : 'Map overlay: this Windows version can\'t hide the boxes from the screen check, so they will blink a little.');
    } else if (msg.t === 'tip') {
      this._onTip(String(msg.ru || ''));
    } else if (msg.t === 'truth') {
      if (this.onTruth) this.onTruth(msg);
    } else if (msg.t === 'stats') {
      // once a minute from the host: how well the labels kept up with moving bubbles, timings, processor
      this.hostStats = msg;
      this.tm.event('overlay', msg);
      for (const k of ['err50', 'err90', 'errMax']) if (typeof msg[k] === 'number') this.tm.sample('label vs bubble distance ' + k.replace('err', '') + ' (px)', msg[k]);
      if (typeof msg.age50 === 'number') this.tm.sample('label drawn from data this old (ms, median)', msg.age50);
      if (typeof msg.cpu === 'number') this.tm.sample('overlay processor use (% of one core)', msg.cpu);
      if (typeof msg.capAvg === 'number' && msg.capAvg > 0) this.tm.sample('overlay: taking a close-up picture (ms, average per minute)', msg.capAvg);
      if (typeof msg.printMs === 'number' && msg.printMs >= 0) this.tm.sample('overlay: game window drawing itself for us (ms)', msg.printMs);
    } else if (msg.t === 'frame') {
      if (msg.full !== 0) {
        this.frames++;
        this.lastFrameMs = msg.ms;
        this.tm.sample('overlay: whole-map look (ms)', msg.ms);
      } else this.tm.sample('overlay: close-up look at a bubble (ms)', msg.ms);
      this.onFrame(msg, Date.now() - (msg.ms || 0));
    }
  }

  // ---------------------------------------------------------------- frame logic
  /** One detector report (whole map, or a close-up of one area). `now` = capture time. Public for tests. */
  onFrame(frame, now) {
    const full = frame.full !== 0 && frame.full !== false;
    if (frame.zoom > 0.5 && Math.abs(frame.zoom - (this._zLogged || 0)) > 0.002) {
      this._zLogged = frame.zoom;
      this.tm.event('zoom', { zoom: frame.zoom, confirmed: frame.zc });
    }
    if (full && frame.rect && (!this.rect || frame.rect.join() !== this.rect.join())) this.tm.event('map-area', { rect: frame.rect.join(',') });
    if (frame.zoom > 0.5) {
      // the host measured the zoom exactly from text it read
      this.zRead = frame.zoom;
      this.zEst = frame.zoom;
      if (full && frame.zc === 1 && frame.rect) this._rememberZoom(frame.rect, frame.zoom);
    } else if (full && frame.rect && !this._zoomOffered) {
      // the zoom found in an earlier session for a map of this size: reading can start right away
      this._zoomOffered = true;
      const z = this._zoomMemory()[frame.rect[2] + 'x' + frame.rect[3]];
      if (z > 0.5 && this.proc) this._write(`R${frame.rect[2]},${frame.rect[3]},${Number(z).toFixed(4)}\n`);
    }
    if (full && frame.rect) {
      if (this.rect && (this.rect[2] !== frame.rect[2] || this.rect[3] !== frame.rect[3])) {
        // the game window was resized: the zoom may have changed
        this.zHist = [];
        this.zEst = 0;
      }
      this.rect = frame.rect;
    }
    const minU = this.cfg.mapOverlayMinUniform || 0.75;
    const dxs = [];
    const dys = [];
    const fresh = [];
    for (const l of frame.lines || []) {
      if (!l.box || !l.c || l.id == null) continue;
      if (l.u < minU || l.n < 2) continue;
      const [x, y, w, h] = l.box;
      let t = this.tracks.get(l.id);
      if (t) {
        if (full && !t.msg) {
          dxs.push(x + w / 2 - (t.x + t.w / 2));
          dys.push(y + h - (t.y + t.h));
        }
        Object.assign(t, { x, y, w, h, n: Math.max(t.n, l.n), c: l.c, u: l.u, seen: now, small: !!l.sm });
        if (Array.isArray(l.bx)) t.bx = l.bx;
        if (typeof l.ts === 'number') {
          const before = t.txt;
          t.txt = typeof l.txt === 'string' ? l.txt : '';
          t.ts = l.ts;
          if (!t.read) t.readAt = now;
          t.read = true;
          if (t.msg && t.txt !== before) this._recheck(t, now);
        }
      } else {
        const read = typeof l.ts === 'number';
        t = { id: l.id, x, y, w, h, n: l.n, c: l.c, u: l.u, born: now, seen: now, readAt: read ? now : 0, msg: null, edge: false, scenery: false, txt: read && typeof l.txt === 'string' ? l.txt : '', ts: read ? l.ts : -1, read, small: !!l.sm, bx: Array.isArray(l.bx) ? l.bx : null };
        this.tracks.set(l.id, t);
        fresh.push(t);
      }
    }
    for (const id of frame.gone || []) this._dropTrack(id, now);
    // safety net if a "gone" was missed
    for (const [id, t] of this.tracks) if (now - t.seen > 4000) this._dropTrack(id, now);

    // How far the whole view moved (the camera follows your character).
    let mx = 0;
    let my = 0;
    if (full && dxs.length >= 3) {
      mx = median(dxs);
      my = median(dys);
      if (Math.abs(mx) > 3 || Math.abs(my) > 3) {
        this.camMovedAt = now;
        // the view moved (you walked): how far between two whole-map looks, and how many lines agreed
        this.tm.count('view moved (you walked or were moved)');
        this.tm.event('view-moved', { dx: mx, dy: my, lines: dxs.length });
      }
    }
    if (full) {
      for (const a of this.anchors.values()) {
        if (!a.live) {
          a.x += mx;
          a.y += my;
        }
      }
    }
    for (const t of fresh) {
      // scenery text that flickers in the detector comes back where it was
      for (const g of this.graveyard) {
        if (now - g.died > 15000) continue;
        if (Math.abs(g.x + g.w / 2 - (t.x + t.w / 2)) <= 12 && Math.abs(g.y + g.h - (t.y + t.h)) <= 8 && Math.abs(g.n - t.n) <= 2 && cdist(g.c, t.c) <= 30) {
          t.scenery = true;
          break;
        }
      }
      // text sliding in at the map edge while the camera moves is scenery coming into view
      const rect = this.rect;
      if (full && rect && (Math.abs(mx) > 6 || Math.abs(my) > 6)) {
        const mg = Math.max(Math.abs(mx), Math.abs(my)) * 1.5 + 40;
        if (mx < -6 && t.x + t.w > rect[0] + rect[2] - mg) t.edge = true;
        if (mx > 6 && t.x < rect[0] + mg) t.edge = true;
        if (my < -6 && t.y + t.h > rect[1] + rect[3] - mg) t.edge = true;
        if (my > 6 && t.y < rect[1] + mg) t.edge = true;
      }
    }
    this._complete(now);
    this._refreshAnchors(now);
    this._assign(now);
    this._readOnly(now);
    this._checkMissed(now);
    this._prune(now);
    this._updateInterval(now);
    this._updateWatch(now);
    this._sendLabels();
  }

  /**
   * A labelled line was read again and now says something else: a new bubble has appeared where the
   * speaker's previous one was and took over its place. Free the line so the new chat line can have it.
   */
  _recheck(t, now) {
    const m = this.msgs.get(t.msg);
    if (!m) return;
    // Lines of one moving bubble can swap places in the tracker: this line now shows another line of the
    // same bubble. Put it where it belongs; the line it replaces is found again by _complete().
    const L = m.layout && m.layout.lines;
    const i = m.lines ? m.lines.indexOf(t.id) : -1;
    if (L && i >= 0 && L.some((g) => g.text)) {
      const sims = L.map((g) => (g.text && !g.empty ? lineSim(t.txt, g.text) : -1));
      let j = 0;
      for (let k = 1; k < sims.length; k++) if (sims[k] > sims[j]) j = k;
      if (j !== i && sims[j] >= 0.7 && sims[i] < 0.45) {
        const holder = m.lines[j] && this.tracks.get(m.lines[j]);
        if (holder) holder.msg = null;
        m.lines[j] = t.id;
        m.lines[i] = 0;
        return;
      }
    }
    const tm = this._textMatch([t], m);
    if (!tm || tm.len < 2) return;
    if (tm.sim >= 0.5) return;
    // does it fit another waiting chat line better? (otherwise it is just a poor reading)
    const other = [...this.msgs.values()].some((x) => x !== m && now - x.t < 6000 && (() => {
      const o = this._textMatch([t], x);
      return o && o.sim >= this._needSim(o);
    })());
    if (!other) return; // just a poor reading (busy background behind it): keep the line
    t.msg = null;
    t.born = now;
    t.scenery = false;
    if (m.lines) m.lines = m.lines.map((id) => (id === t.id ? 0 : id));
    this._blog(`relabel  a line of "${m.ru.slice(0, 40)}" now reads "${t.txt}": looking for its chat line again`);
    this.tm.count('labels taken off (the bubble line now says something else)');
    this.tm.event('relabel', { key: m.key, read: t.txt });
  }

  _zoomFile() {
    return this.cfg._zoomMemFile || path.join(this.root, 'cache', 'overlay_zoom.json');
  }
  _zoomMemory() {
    if (!this._zoomMem) {
      try {
        this._zoomMem = JSON.parse(fs.readFileSync(this._zoomFile(), 'utf8')) || {};
      } catch (e) {
        this._zoomMem = {};
      }
    }
    return this._zoomMem;
  }
  _rememberZoom(rect, z) {
    const mem = this._zoomMemory();
    const key = rect[2] + 'x' + rect[3];
    if (mem[key] && Math.abs(mem[key] / z - 1) < 0.0005) return;
    mem[key] = Math.round(z * 10000) / 10000;
    try {
      fs.mkdirSync(path.dirname(this._zoomFile()), { recursive: true });
      fs.writeFileSync(this._zoomFile(), JSON.stringify(mem, null, 1));
    } catch (e) {}
  }

  /**
   * A bubble paired with only some of its lines (one was unreadable at first, or lost while moving):
   * find the missing lines where the bubble's shape says they must be, in the same colour.
   */
  _complete(now) {
    for (const m of this.msgs.values()) {
      if (!m.lines || !m.layout || !m.layout.lines.some((g) => g.text)) continue;
      const L = m.layout.lines;
      const live = m.lines.map((id) => (id && this.tracks.has(id) ? this.tracks.get(id) : null));
      const k = live.findIndex((t) => t && now - t.seen <= 300);
      if (k < 0 || !L.some((g, i) => !g.empty && !live[i])) continue;
      const ref = live[k];
      const gk = L[k];
      const z = m.z || this.zEst;
      if (!z) continue;
      const cx = ref.x + (gk.W / 2 - gk.x0) * z; // bubble centre
      const baseK = ref.y + ref.h + gk.bottom * z; // baseline of line k
      for (let i = 0; i < L.length; i++) {
        const g = L[i];
        if (g.empty || live[i]) continue;
        const base = baseK + (i - k) * LINE_PITCH * z;
        const wantBottom = base - g.bottom * z;
        const wantCx = cx + ((g.x0 + g.x1) / 2 - g.W / 2) * z; // centre of this line's letters
        let best = null;
        let bestD = Infinity;
        for (const t of this.tracks.values()) {
          if (t.msg || t.scenery || now - t.seen > 300 || cdist(t.c, ref.c) > 40) continue;
          const dy = Math.abs(t.y + t.h - wantBottom);
          const dx = Math.abs(t.x + t.w / 2 - wantCx);
          if (dy > 4 * z || dx > 8 * z) continue;
          const sim = t.read ? lineSim(t.txt, g.text) : -1;
          if (sim >= 0) {
            if (sim < 0.6) continue;
          } else if (Math.abs(t.w / z - (g.x1 - g.x0)) > 6) continue; // unreadable: the width must fit
          const d = dx + dy - (sim > 0 ? sim * 20 : 0);
          if (d < bestD) {
            bestD = d;
            best = t;
          }
        }
        if (best) {
          best.msg = m.key;
          m.lines[i] = best.id;
          live[i] = best;
        }
      }
    }
  }

  _dropTrack(id, now) {
    const t = this.tracks.get(id);
    if (!t) return;
    this.tracks.delete(id);
    if (t.msg) {
      // a labelled bubble that disappeared while it should still be on screen: the label was lost
      const m = this.msgs.get(t.msg);
      if (m && now - m.t < 4000 && !m.lostLogged) {
        m.lostLogged = true;
        this.stats.lost = (this.stats.lost || 0) + 1;
        this.tm.count('labels lost while the bubble should still be there');
        this.tm.sample('label lost after chat (ms)', now - m.t);
        this.tm.event('lost', { key: m.key, ms: now - m.t, x: t.x, y: t.y, unseen: now - t.seen });
        this._blog(`lost  ${m.name || '?'}: "${m.ru.slice(0, 60)}"  label lost ${Math.round(now - m.t)} ms after chat (last seen at ${t.x},${t.y}, ${Math.round(now - t.seen)} ms before)`);
      }
    }
    if (!t.msg && t.seen - t.born >= 1000) {
      this.graveyard.push({ x: t.x, y: t.y, w: t.w, h: t.h, n: t.n, c: t.c, died: now });
      if (this.graveyard.length > 300) this.graveyard.splice(0, this.graveyard.length - 300);
    }
  }

  /** Remember where each speaker's bubble is, to recognise their next one. */
  _refreshAnchors(now) {
    for (const a of this.anchors.values()) a.live = false;
    for (const m of this.msgs.values()) {
      if (!m.lines || !m.name) continue;
      const pos = this._msgAnchor(m);
      if (!pos) continue;
      const a = this.anchors.get(m.name);
      // the speaker is under their lowest bubble (two lines said together can be paired in either order)
      if (a && a.live && (a.y > pos.y + 4 || (Math.abs(a.y - pos.y) <= 4 && a.order > m.order))) continue;
      this.anchors.set(m.name, { x: pos.x, y: pos.y, t: now, live: true, order: m.order });
    }
    if (this.anchors.size > 300) this.anchors.delete(this.anchors.keys().next().value);
  }

  /** Centre and last baseline (screen) of a paired message's bubble. */
  _msgAnchor(m) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    const L = m.layout.lines.length;
    m.lines.forEach((id, i) => {
      const t = id && this.tracks.get(id);
      const g = m.layout.lines[i];
      if (!t || !g || g.empty) return;
      sx += t.x + (g.W / 2 - g.x0) * m.z;
      sy += t.y + t.h + g.bottom * m.z + (L - 1 - i) * LINE_PITCH * m.z;
      n++;
    });
    return n ? { x: sx / n, y: sy / n } : null;
  }

  // ---------------------------------------------------------------- what a bubble should look like
  _wrapWidths() {
    const base = [96, 112];
    let lo = this.wrapLo;
    let hi = this.wrapHi;
    if (lo >= hi) {
      this.wrapLo = 0;
      this.wrapHi = Infinity;
      lo = 0;
      hi = Infinity;
    }
    // the usual widths are always tried; learned limits add their own candidates and rank them
    const out = base.slice();
    if (lo > 0 && lo < hi) out.push(Math.ceil(lo));
    if (hi < Infinity && hi - 1 >= lo) out.push(Math.ceil(hi - 1));
    return [...new Set(out)];
  }

  /** Every way this chat line's bubble could be laid out (bubble width not yet known, maybe an icon). */
  _layouts(m, minH) {
    const widths = this._wrapWidths();
    const sig = minH + '|' + widths.join(',');
    if (m.layouts && m.layoutsSig === sig) return m.layouts;
    const seen = new Set();
    const out = [];
    const icons = m.icon === true ? [true, false] : [false, true];
    for (const icon of icons) {
      for (const w of widths) {
        const b = this.font.bubble(m.ru, icon, minH, w);
        if (seen.has(b.key)) continue;
        seen.add(b.key);
        b.iconPenalty = (m.icon !== null && icon !== m.icon ? 0.3 : 0) + (w >= this.wrapLo && w < this.wrapHi ? 0 : 0.4);
        out.push(b);
      }
    }
    m.layouts = out;
    m.layoutsSig = sig;
    return out;
  }

  /**
   * How well a run of detected lines (top to bottom) matches a chat line's predicted bubble.
   * Returns {err (game pixels), z, layout, map (line index per run line)} or null.
   */
  _geometry(run, m) {
    const zMin = minGlyphPx(this.zSent);
    let best = null;
    // the size limit for "visible" letters depends on the zoom; try the likely zoom first
    const zGuess = this.zEst || this._zPrior() || 2.5;
    const minH = Math.max(1, Math.ceil(zMin / zGuess));
    for (const lay of this._layouts(m, minH)) {
      const all = [];
      lay.lines.forEach((g, i) => {
        if (!g.empty) all.push(i);
      });
      // Some lines of a bubble can be missed (busy background behind them): try every way the seen
      // lines can be some of the predicted ones, in order, with a cost for each missing line.
      if (run.length > all.length || run.length < Math.ceil(all.length / 2)) continue;
      for (const idx of combinations(all, run.length)) {
        const r = this._fit(run, lay, idx, all.length - run.length);
        if (r && (!best || r.err < best.err)) best = r;
      }
    }
    return best;
  }

  /** Fewest and most lines this chat line's bubble can have (the bubble width isn't known exactly). */
  _lineCount(m) {
    if (!this.font || m.italic) return null;
    const zGuess = this.zEst || this._zPrior() || 2.5;
    const minH = Math.max(1, Math.ceil(minGlyphPx(this.zSent) / zGuess));
    let min = Infinity;
    let max = 0;
    for (const lay of this._layouts(m, minH)) {
      const n = lay.lines.filter((g) => !g.empty).length;
      min = Math.min(min, n);
      max = Math.max(max, n);
    }
    return max ? { min, max } : null;
  }

  _fit(run, lay, idx, missing) {
    {
      const L = lay.lines.length;
      const zs = [];
      for (let k = 0; k < run.length; k++) {
        const g = lay.lines[idx[k]];
        if (g.x1 - g.x0 >= 12 && !this._atEdge(run[k])) zs.push(run[k].w / (g.x1 - g.x0));
      }
      if (!zs.length) for (let k = 0; k < run.length; k++) zs.push(run[k].h / Math.max(1, lay.lines[idx[k]].top - lay.lines[idx[k]].bottom));
      const zPair = median(zs);
      if (!(zPair > 0.7 && zPair < 9)) return null;
      let z = zPair;
      let zPenalty = 0;
      if (this.zEst) {
        const rel = Math.abs(zPair / this.zEst - 1);
        if (rel > 0.06) return null;
        z = this.zEst;
        zPenalty = rel * 10;
      }
      let ew = 0;
      let nw = 0;
      let eh = 0;
      let maxEw = 0;
      const cs = [];
      const bs = [];
      for (let k = 0; k < run.length; k++) {
        const t = run[k];
        const g = lay.lines[idx[k]];
        bs.push((t.y + t.h) / z + g.bottom + (L - 1 - idx[k]) * LINE_PITCH);
        eh += Math.abs(t.h / z - (g.top - g.bottom));
        // a line cut off by the edge of the map has no reliable width or centre
        if (this._atEdge(t)) continue;
        const e1 = Math.abs(t.w / z - (g.x1 - g.x0));
        ew += e1;
        nw++;
        maxEw = Math.max(maxEw, e1);
        cs.push(t.x / z + (g.W / 2 - g.x0));
      }
      if (!nw || maxEw > 4.5) return null;
      const spreadC = cs.length > 1 ? Math.max(...cs) - Math.min(...cs) : 0;
      const spreadB = Math.max(...bs) - Math.min(...bs);
      if (spreadC > 5 || spreadB > 4) return null;
      // typical real-world noise: a game pixel at a line's ends (faint edge letters), one in height
      const err = (0.6 * ew) / nw + (0.3 * eh) / run.length + 0.3 * spreadC + 0.3 * spreadB + zPenalty + lay.iconPenalty + 0.6 * missing;
      return { err, z, zPair, layout: lay, map: idx };
    }
  }

  _atEdge(t) {
    const r = this.rect;
    if (!r) return false;
    return t.x <= r[0] + 2 || t.x + t.w >= r[0] + r[2] - 2 || t.y <= r[1] + 2 || t.y + t.h >= r[1] + r[3] - 2;
  }

  /** Zoom guessed from the map size (the game view is 15 tiles tall when it fills the window height). */
  _zPrior() {
    return this.rect ? this.rect[3] / (15 * TILE) : 0;
  }

  _colorScore(c, m) {
    let col = 0;
    const learned = m.name ? this.learned.get(m.name) : null;
    const chatCol = m.color ? colorGap(c, m.color) : Infinity;
    if (learned && colorGap(c, learned.c) <= 30) col = 1.2;
    else if (chatCol <= 30) col = 1;
    else if (learned && learned.strong) col = -1.5;
    else if (chatCol <= 55) col = 0.4;
    else if (chatCol > 110 && m.color) col = -0.4;
    // a colour that already belongs to someone else is unlikely to be this speaker
    for (const [name, lc] of this.learned) {
      if (name !== m.name && lc.strong && cdist(c, lc.c) <= 10) {
        // even less likely if that person has just said something too
        const busy = [...this.msgs.values()].some((x) => x.name === name && !x.lines && this._now - x.t < 4500);
        col -= busy ? 2 : 0.7;
        break;
      }
    }
    if (isGrey(c) && !(m.color && isGrey(m.color))) col -= 0.5;
    return col;
  }

  /** Is the run where this speaker was last seen? */
  _positionScore(run, m, z) {
    const a = m.name ? this.anchors.get(m.name) : null;
    if (!a || !z) return 0;
    const last = run[run.length - 1];
    const dx = last.x + last.w / 2 - a.x;
    const dy = last.y + last.h - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) / (TILE * z);
    const age = Math.max(0, (this._now - a.t) / 1000);
    if (a.live) {
      // their earlier bubble is still up: the new one appears right where it was
      if (dist <= 0.6) return 2;
      if (dist <= 1.5) return 1;
      return dist > 3 ? -2 : 0;
    }
    const reach = Math.min(10, 0.7 + 5 * age); // tiles they can have walked since
    if (dist <= Math.min(1, reach)) return 1;
    if (dist <= reach) return 0.3;
    return age <= 5 ? -2 : 0;
  }

  /** Score for pairing `run` with chat line `m`, or null when it can't be that line. */
  /** How well the words read from the bubble lines fit a chat line. */
  _textMatch(run, m) {
    const said = normRu([...m.ru].slice(0, MAX_CHARS).join(''));
    if (!said.length) return null;
    // Lines of a bubble over a busy background can read as nonsense while the others read fine: those
    // lines are left out of the comparison (the shape check then has to vouch for them).
    const parts = run.map((t) => normRu(t.txt || ''));
    let skipped = 0;
    let kept = parts;
    if (parts.length > 1) {
      kept = parts.filter((p) => {
        if (p.length < 4) return true;
        const ok = 1 - editsInside(p, said) / p.length >= 0.6;
        if (!ok) skipped++;
        return ok;
      });
      if (!kept.some((p) => p.length >= 2)) {
        kept = parts;
        skipped = 0;
      }
    }
    const read = kept.join('');
    if (read.length < 2) return null;
    // whole bubble read: compare whole texts; only part of it read: how well that part fits inside
    const ed = editsInside(read, said);
    const big = Math.max(read.length, said.length);
    let sim = 1 - (ed + Math.max(0, said.length - read.length)) / big;
    const coverage = Math.min(1, read.length / said.length);
    // A piece of a bubble (the rest hidden by a busy background) only counts when it is long enough
    // not to turn up inside any sentence by chance.
    if (read.length >= 5) sim = Math.max(sim, (1 - ed / read.length) * (0.4 + 0.6 * coverage));
    return { sim: Math.max(0, sim), coverage, len: read.length, said: said.length, skipped };
  }

  /** How close the words read must be to count as this chat line (short lines must match almost exactly). */
  _needSim(text) {
    if (text.said <= 4 || text.len <= 4) return 0.75;
    return this.cfg.mapOverlayTextMatch || 0.65;
  }

  _score(run, m) {
    const born = Math.min(...run.map((t) => t.born));
    const dt = born - m.t;
    // A bubble appears after its chat line (allow a little clock jitter): lines that were already on
    // screen before the chat line arrived are scenery, not this bubble.
    if (dt < -150 || dt > 4000) return null;
    const ts = dt <= 1600 ? 1 : 0.3;
    const c = meanColor(run);
    const col = this._colorScore(c, m);
    // Whispers, quiet speech (radio, no air) and machines use a small smoothed font ("italics") that can't
    // be read: those bubbles are found by the host as "small" lines and paired by length, colour and place.
    if (m.italic) return this._scoreSmall(run, m, c, col, ts);
    if (run.some((t) => t.small)) return null;
    // The letters of the bubble were read: that settles which chat line it is.
    const text = this._textMatch(run, m);
    if (text) {
      // a so-so reading is not enough on its own when the colour says it is someone else
      // (emote lines in chat carry no name colour: then there is nothing to contradict)
      const colourOk = text.sim >= 0.85 || col > 0 || (!m.color && !(m.name && this.learned.has(m.name)));
      if (text.sim >= this._needSim(text) && colourOk) {
        let geo = this.font && !m.italic ? this._geometry(run, m) : null;
        // How many lines this chat line makes as a bubble: a run with that many lines is the whole
        // bubble (preferred over a part of it); lines that read as nonsense only belong to it then.
        const lc = this._lineCount(m);
        const whole = !lc || (run.length >= lc.min && run.length <= lc.max);
        if (text.skipped && !whole && !(geo && geo.err <= 2.5)) return null;
        if (lc && run.length > lc.max) return null;
        const z = geo ? geo.z : this.zEst || this._zPrior() || run[0].h / 7;
        const pos = this._positionScore(run, m, z);
        const s = 8 * text.sim + 1.5 * col + ts + Math.max(0, pos) + (whole ? 1 : geo ? 0.5 : 0) + (geo ? 0.3 : 0);
        return { s, geo, z, col, pos, c, text };
      }
      // different words (or a doubtful reading in someone else's colour): not this chat line
      if (text.len >= 3 || text.sim < 0.4 || !colourOk) return null;
    }
    // Nothing readable on these lines. Floors, carpets, signs and wall panels can look like rows of
    // letters, so without the words a bubble is only accepted on very strong evidence, and not
    // before the reader has had its turn at it.
    if (this.cfg.mapOverlayShapeOnly === false) return null;
    if (run.some((t) => !t.read) && this._now - born < 1500) return null;
    if (run.some((t) => t.edge || t.scenery)) return null;
    if (col < 1) return null;
    let geomScore;
    let geo = null;
    let z = this.zEst || 0;
    if (this.font && !m.italic) {
      geo = this._geometry(run, m);
      if (!geo || geo.err > 1.2) return null;
      if (sumGlyphs(run) < 6) return null; // "Да." fits a thousand things
      z = geo.z;
      geomScore = 3.2 * Math.exp(-geo.err / 1.2);
      if (!this.zEst) {
        // Zoom not learned yet: a one-line bubble "fits" any chat line at some zoom.
        const prior = this._zPrior();
        const priorOk = prior && Math.abs(geo.zPair / prior - 1) <= 0.03;
        if (run.length < 2 || !priorOk) return null;
      }
    } else {
      // italic bubbles use another font: fall back to letter count, colour and place
      const G = sumGlyphs(run);
      const r = G / (Math.min(m.n, MAX_CHARS) * 1.15);
      if (r < 0.8 || r > 1.4 || G < 6) return null;
      geomScore = 1.2;
      if (!z) z = this._zPrior() || run[0].h / 7;
    }
    const pos = this._positionScore(run, m, z);
    if (pos < 1 && col < 1.2) return null; // not where this speaker was, and colour not confirmed before
    const s = 2 * geomScore + 1.5 * col + ts + pos;
    return { s, geo, z, col, pos, c };
  }

  /**
   * A bubble that was read clearly but has no chat line (machines and some messages never reach your
   * chat): translate the words read from it. Only clean, word-like Russian is used, so map text that
   * merely looks like letters is never "translated".
   */
  _readOnly(now) {
    if (!this.translator || this.cfg.mapOverlayReadOnly === false || !this.zEst) return;
    this._balloons(now);
    const cands = [...this.tracks.values()].filter(
      (t) => !t.msg && !t.small && !t.scenery && !t.edge && t.read && t.ts >= 0.85 && now - t.seen <= 250 && now - t.born >= 1500 && now - t.born <= 8000 && !t.roTried
    );
    if (!cands.length) return;
    cands.sort((a, b) => a.y - b.y);
    const z = this.zEst;
    const top = this.rect ? this.rect[1] + 30 * z : 0; // the hover name lives up there
    const groups = [];
    for (const t of cands) {
      const g = groups.find((cand) => {
        const last = cand[cand.length - 1];
        const gap = t.y - (last.y + last.h);
        return gap > -3 && gap < 8.5 * z && Math.abs(t.x + t.w / 2 - (last.x + last.w / 2)) < 8 * z && cdist(t.c, last.c) <= 30;
      });
      if (g) g.push(t);
      else groups.push([t]);
    }
    for (const g of groups) {
      for (const t of g) t.roTried = true;
      if (g[0].y < top) continue;
      const text = g.map((t) => t.txt).join(' ').replace(/\s+/g, ' ').trim();
      const letters = (text.match(/[\p{L}]/gu) || []).length;
      const cyr = (text.match(/[а-яё]/gi) || []).length;
      const latOnly = (text.match(/[dfgijlqrsvwzDFGIJLQRSVWZ]/g) || []).length;
      const junk = (text.match(/[Il1!|'`.,:;_\-—"„“”…]/g) || []).length;
      const words = text.split(/\s+/).filter((w) => (w.match(/[а-яё]/gi) || []).length >= 2);
      if (letters < 8 || cyr < 0.8 * letters || latOnly > 0 || junk > 0.2 * text.length || words.length < 2) continue;
      if (isGrey(meanColor(g)) && g.length === 1 && letters < 12) continue;
      const ru = cleanRead(text);
      const key = 'r' + g[0].id;
      const m = {
        key, t: now, ru, n: letters, color: null, name: '', en: null, italic: false, icon: null,
        lines: g.map((t) => t.id), z, color2: meanColor(g), assignedAt: now, order: ++this.order, readOnly: true,
        layout: {
          lines: g.map((t) => {
            const W = t.w / z;
            return { W, x0: 0, x1: W, top: t.h / z, bottom: 0, fx0: 0, fx1: W, ftop: t.h / z, fbot: 0, empty: false, indent: 0 };
          }),
          cut: false,
          width: 112,
        },
      };
      for (const t of g) t.msg = key;
      this.msgs.set(key, m);
      this.translator
        .toEnglish([ru], 'live')
        .then((r) => {
          const en = r && r[ru];
          if (!en || !this.msgs.has(key)) return;
          m.en = en;
          this._blog(`unpaired bubble read as "${ru}" (no chat line for it) -> "${en}"`);
          this.tm.count('bubbles without a chat line, translated from the picture');
          this.tm.event('readonly', { ru, en });
          this._sendLabels();
        })
        .catch(() => {});
    }
  }

  /**
   * Balloon alerts: the white text that floats up when an action can't be done ("не является пищей!",
   * "нет места!"). They never reach chat and last about a second, so they are translated as soon as they
   * are read - most of them come from the list of the server's alerts translated beforehand.
   */
  _balloons(now) {
    if (this.cfg.mapOverlayBalloons === false) return;
    const z = this.zEst;
    const top = this.rect ? this.rect[1] + 30 * z : 0; // the hover name lives up there
    for (const t of this.tracks.values()) {
      if (t.msg || t.small || t.edge || t.balTried || !t.read || t.ts < 0.85 || now - t.seen > 250 || now - t.born > 4000) continue;
      if (!isBalloonColor(t.c) || t.y < top) continue;
      const text = String(t.txt || '').replace(/\s+/g, ' ').trim();
      const letters = (text.match(/[\p{L}]/gu) || []).length;
      const cyr = (text.match(/[а-яё]/gi) || []).length;
      const latOnly = (text.match(/[dfgijlqrsvwzDFGIJLQRSVWZ]/g) || []).length;
      const junk = (text.match(/[Il1|'`_„“”…]/g) || []).length;
      t.balTried = true;
      if (letters < 3 || cyr < 0.8 * letters || latOnly > 0 || junk > 0.15 * text.length) continue;
      const key = 'b' + t.id;
      const W = (t.bx ? t.bx[1] : t.w) / z;
      const left = t.bx ? -t.bx[0] / z : 0;
      const m = {
        key, t: now, ru: text, n: letters, color: null, name: '', en: null, italic: false, icon: null,
        lines: [t.id], z, color2: [255, 255, 255], assignedAt: now, order: ++this.order, readOnly: true, balloon: true,
        layout: {
          lines: [{ W, x0: left, x1: left + W, top: t.h / z, bottom: 0, fx0: 0, fx1: W, ftop: t.h / z, fbot: 0, empty: false, indent: 0 }],
          cut: false,
          width: 200,
        },
      };
      t.msg = key;
      this.msgs.set(key, m);
      const show = (en, how) => {
        if (!en || !this.msgs.has(key)) return;
        m.en = en;
        this._blog(`balloon "${text}" -> "${en}" (${how}, ${Date.now() - t.born} ms after it appeared)`);
        this.tm.count('balloon alerts translated');
        this.tm.event('balloon', { ru: text, en, how, ms: Date.now() - t.born });
        this._sendLabels();
      };
      const bare = text.replace(/[.!?…]+$/, '');
      const local = this.translator.lookupLocal(text) || this.translator.lookupLocal(bare + '!') || this.translator.lookupLocal(bare);
      if (local) {
        show(local, 'ready');
        continue;
      }
      this.translator
        .toEnglish([text], 'live')
        .then((r) => show(r && r[text], 'translated'))
        .catch(() => {});
    }
  }

  /** A small-font bubble: its width must fit the number of letters said (about 4 game pixels each). */
  _scoreSmall(run, m, c, col, ts) {
    if (!run.every((t) => t.small)) return null;
    if (run.some((t) => t.edge || t.scenery)) return null;
    const z = this.zEst || this._zPrior();
    if (!z) return null;
    const chars = Math.min([...m.ru].length, MAX_CHARS) + ([...m.ru].length > MAX_CHARS ? 3 : 0);
    const est = run.reduce((a, t) => a + t.w, 0) / (z * (this.cfg.mapOverlaySmallCharW || 4.0));
    const r = est / Math.max(1, chars);
    if (r < 0.7 || r > 1.35) return null;
    // the small bubbles wrap at about 28 letters a line
    const minL = Math.max(1, Math.ceil(chars / 34));
    const maxL = Math.ceil(chars / 20) + 1;
    if (run.length < minL || run.length > maxL) return null;
    if (m.color && col < 0.4) return null; // the speaker's colour doesn't fit
    if (isGrey(c) && !(col >= 1)) return null; // grey map text is everywhere: only a grey speaker's own
    if (this.rect && run[0].y < this.rect[1] + 30 * z) return null; // the hover name's place
    // short lines fit too many things: they need the speaker's colour, and where they were if it isn't
    // confirmed yet; so does anything that appears while the view is moving (map text slides in then)
    if (chars <= 10 && !(col >= 1.2 || (col >= 1 && this._positionScore(run, m, z) >= 1))) return null;
    const moving = this.camMovedAt && this._now - this.camMovedAt < 1200;
    if (moving && !(col >= 1 && chars >= 8)) return null;
    const fit = r >= 0.75 && r <= 1.25 ? 1.2 : 0.7;
    const pos = this._positionScore(run, m, z);
    if (pos <= -2) return null;
    const s = 2 * fit + 1.5 * Math.max(0, col) + ts + Math.max(0, pos);
    return { s, geo: null, z, col, pos, c };
  }

  /** Pair new bubble lines with the chat lines they came from. */
  _assign(now) {
    this._now = now;
    const freshTracks = [...this.tracks.values()].filter((t) => !t.msg && !t.scenery && now - t.seen <= 250 && now - t.born <= 2500);
    if (!freshTracks.length) return;
    const newerFrom = new Map(); // speaker -> time of their newest line still waiting for its bubble
    for (const m of this.msgs.values()) if (m.name && !m.lines && now - m.t <= 4500 && !(newerFrom.get(m.name) > m.t)) newerFrom.set(m.name, m.t);
    const pending = [...this.msgs.values()].filter((m) => {
      if (now - m.t > 4500 || now - m.t < -500) return false;
      if (!m.lines) return true;
      if (now - m.t > 5500) return false;
      // paired before, but every line was lost: it may be found again
      const live = m.lines.filter((id) => id && this.tracks.has(id));
      if (!live.length) return true;
      // ... or not seen for a while (the speaker or the view moved faster than the bubble could be
      // followed): look for it now instead of waiting a second for its old place to be given up
      if (!live.every((id) => now - this.tracks.get(id).seen > (this.cfg.mapOverlayRepickMs || 300))) return false;
      // (not while the same speaker has a new line on the way: their bubbles are sliding up, and a new
      // bubble with the same words would be taken for this one)
      if (m.name && now - (this.pairedAt.get(m.name) || -1e9) < 1200) return false; // ... or just got one
      return !newerFrom.has(m.name || '\u0000' + m.key) || newerFrom.get(m.name) < m.t;
    });
    if (!pending.length) return;
    const z0 = this.zEst || this._zPrior();

    // Lines of one colour stacked directly above each other, centred on each other: one bubble or a
    // speaker's stack of bubbles.
    const groups = [];
    for (const t of freshTracks.slice().sort((a, b) => a.y - b.y)) {
      let g = null;
      for (const cand of groups) {
        const last = cand[cand.length - 1];
        const gap = t.y - (last.y + last.h);
        const maxGap = z0 ? 8.5 * z0 : Math.max(t.h, last.h) * 1.7;
        const dc = Math.abs(t.x + t.w / 2 - (last.x + last.w / 2));
        const maxDc = z0 ? 8 * z0 : Math.max(t.w, last.w) / 2 + 20;
        const overlapX = Math.min(t.x + t.w, last.x + last.w) - Math.max(t.x, last.x) > 0;
        if (!!t.small === !!last.small && gap > -3 && gap < maxGap && (dc < maxDc || overlapX) && cdist(t.c, last.c) <= 30) {
          g = cand;
          break;
        }
      }
      if (g) g.push(t);
      else groups.push([t]);
    }

    const threshold = this.cfg.mapOverlayMatch || 3.2;
    const options = [];
    for (const g of groups) {
      for (let a = 0; a < g.length; a++) {
        for (let b = a + 1; b <= g.length && b - a <= 12; b++) {
          const run = g.slice(a, b);
          for (const m of pending) {
            const r = this._score(run, m);
            if (!r) continue;
            // Part of a stack of same-coloured lines: the rest of the stack is the same speaker's, so a
            // different speaker's line fitting only part of it is suspicious.
            if (run.length < g.length && r.pos < 1.5) r.s -= 1.0;
            if (r.s >= threshold) options.push({ run, m, ...r, born: Math.min(...run.map((t) => t.born)) });
          }
        }
      }
    }
    if (!options.length) return;
    options.sort((x, y) => y.s - x.s || y.run.length - x.run.length);
    if (this.cfg._debugAssign) this.cfg._debugAssign(options, pending, now);
    const usedT = new Set();
    const usedM = new Set();
    const margin = this.cfg.mapOverlayMargin || 1.0;
    const sameWords = new Map(); // how many waiting chat lines have exactly these words
    for (const m of pending) sameWords.set(m.ru, (sameWords.get(m.ru) || 0) + 1);
    for (const o of options) {
      if (usedM.has(o.m.key) || o.run.some((t) => usedT.has(t.id))) continue;
      // Is another chat line almost as good for these lines, or another place almost as good for
      // this chat line? Then it isn't safe to say which is which yet.
      let rival = null;
      for (const p of options) {
        if (p === o || usedM.has(p.m.key) || p.run.some((t) => usedT.has(t.id))) continue;
        const sameLines = p.run.some((t) => o.run.includes(t));
        const sameMsg = p.m === o.m;
        if (!sameLines && !sameMsg) continue;
        if (sameLines && !sameMsg && p.m.ru === o.m.ru) continue; // same words: either is right
        if (sameLines && sameMsg) continue; // a sub-run of the same pairing
        if (sameMsg && sameWords.get(o.m.ru) > 1) continue; // two people said the same thing
        if (!rival || p.s > rival.s) rival = p;
      }
      if (rival && rival.s > o.s - margin) {
        const age = now - o.born;
        if (age < (this.cfg.mapOverlayWaitMs || 700)) continue; // look again in the next frames
        if (rival.s > o.s - margin / 2) {
          if (!o.m.unsureLogged) {
            o.m.unsureLogged = true;
            this.stats.unsure++;
          }
          continue;
        }
      }
      for (const t of o.run) usedT.add(t.id);
      usedM.add(o.m.key);
      this._commit(o, now);
    }
  }

  _commit(o, now) {
    const m = o.m;
    if (m.lines && m.lines.some((id) => id && this.tracks.has(id))) {
      this.tm.count('labels moved to where their bubble went (before it was given up)');
      this.tm.event('repick', { key: m.key, unseen: Math.min(...m.lines.filter((id) => id && this.tracks.has(id)).map((id) => now - this.tracks.get(id).seen)) });
    }
    if (m.lines) for (const id of m.lines) if (id && this.tracks.get(id)) this.tracks.get(id).msg = null;
    let layout;
    let lines;
    if (o.geo) {
      layout = o.geo.layout;
      lines = layout.lines.map(() => 0);
      o.geo.map.forEach((li, k) => {
        lines[li] = o.run[k].id;
      });
    } else {
      // no prediction (italic bubble, or paired by its words alone): describe the lines as seen
      const z = o.z;
      layout = {
        lines: o.run.map((t) => {
          const W = t.w / z;
          return { W, x0: 0, x1: W, top: t.h / z, bottom: 0, fx0: 0, fx1: W, ftop: t.h / z, fbot: 0, empty: false, indent: 0 };
        }),
        cut: m.n > MAX_CHARS,
        width: this._wrapWidths()[0],
      };
      lines = o.run.map((t) => t.id);
    }
    for (const t of o.run) t.msg = m.key;
    m.lines = lines;
    m.layout = layout;
    m.z = o.z;
    m.color2 = o.c;
    m.assignedAt = now;
    m.order = ++this.order;
    if (m.name) {
      this.pairedAt.delete(m.name);
      this.pairedAt.set(m.name, now);
      if (this.pairedAt.size > 300) this.pairedAt.delete(this.pairedAt.keys().next().value);
    }
    if (m.name) {
      const old = this.learned.get(m.name);
      let rec;
      if (old && colorGap(old.c, o.c) <= 30) rec = { c: o.c, hits: old.hits + 1, strong: true };
      else rec = { c: o.c, hits: 1, strong: !!(m.color && colorGap(o.c, m.color) <= 30) };
      this.learned.delete(m.name);
      this.learned.set(m.name, rec);
      if (this.learned.size > 200) this.learned.delete(this.learned.keys().next().value);
    }
    // Learn the zoom and the server's bubble width from clear-cut pairings.
    if (o.geo && o.geo.err <= 1.6) {
      this.zHist.push(o.geo.zPair);
      if (this.zHist.length > 15) this.zHist.shift();
      if (this.zHist.length >= 2) {
        const zm = median(this.zHist);
        const agree = this.zHist.filter((z) => Math.abs(z / zm - 1) <= 0.03).length;
        if (agree >= 2 && Math.abs(zm - this.zEst) > 0.002) {
          this.zEst = zm;
          if (this.proc && (!this.zSent || Math.abs(this.zEst / this.zSent - 1) > 0.01)) {
            this.zSent = this.zEst;
            this._write('Z' + this.zEst.toFixed(4) + '\n');
          }
        }
      }
      const lay = o.geo.layout;
      const clean = o.geo.err <= 0.8 && o.geo.map.length === lay.lines.filter((g) => !g.empty).length;
      if (clean && lay.lines.length >= 2) {
        const lo = Math.max(this.wrapLo, lay.lo);
        const hi = Math.min(this.wrapHi, lay.hi);
        if (lo < hi) {
          this.wrapLo = lo;
          this.wrapHi = hi;
        } else {
          // contradicts what was learned before: start over from this bubble
          this.wrapLo = lay.lo;
          this.wrapHi = lay.hi;
        }
      }
    }
    this.stats.matched++;
    {
      const seen = Math.min(...o.run.map((t) => t.born)) - m.t;
      const readAt = o.run.every((t) => t.readAt) ? Math.max(...o.run.map((t) => t.readAt)) - m.t : null;
      this.tm.count('bubbles paired with their chat line');
      if (!o.text) this.tm.count('bubbles paired without reading (shape/colour/place)');
      if (m.lostLogged) this.tm.count('bubbles paired again after the label was lost');
      this.tm.sample('bubble: paired after chat (ms)', now - m.t);
      this.tm.sample('bubble: first seen after chat (ms)', seen);
      if (readAt != null) this.tm.sample('bubble: read after chat (ms)', readAt);
      this.tm.sample('bubble: paired after first seen (ms)', now - m.t - seen);
      if (o.text) this.tm.sample('bubble: reading matched chat (%)', Math.round(o.text.sim * 100));
      this.tm.event('pair', { key: m.key, ms: now - m.t, seen, read: readAt, lines: o.run.length, score: o.s, sim: o.text ? o.text.sim : null, geo: o.geo ? o.geo.err : null, small: o.run.some((t) => t.small) ? 1 : 0, en: m.en ? 1 : 0, x: o.run[0].x, y: o.run[0].y, again: m.lostLogged ? 1 : 0 });
    }
    this.history.push({ key: m.key, t: now, lag: Math.round(now - m.t), name: m.name, ru: m.ru.slice(0, 80), en: (m.en || '').slice(0, 80), score: Math.round(o.s * 10) / 10, lines: o.run.length, fit: o.geo ? Math.round(o.geo.err * 10) / 10 : null, read: o.text ? Math.round(o.text.sim * 100) + '%' : null });
    if (this.history.length > 30) this.history.shift();
    const first = o.run[0];
    this._blog(
      `bubble  ${m.name || '?'}: "${m.ru.slice(0, 90)}"  read "${o.run.map((t) => t.txt || '').join(' / ').slice(0, 90)}"` +
        (o.text ? ` (${Math.round(o.text.sim * 100)}% alike)` : ' (not readable: matched by shape, colour and place)') +
        `  score ${o.s.toFixed(1)}  at ${first.x},${first.y}  ${Math.round(now - m.t)} ms after chat` +
        ` (bubble seen ${Math.round(Math.min(...o.run.map((t) => t.born)) - m.t)}, read ${o.run.every((t) => t.readAt) ? Math.round(Math.max(...o.run.map((t) => t.readAt)) - m.t) : '-'}, English ${m.en ? 'ready' : 'not yet'})`
    );
    this._refreshAnchors(now);
  }

  /** Diagnostics for the map overlay: logs/overlay/bubbles.log (what was matched, and hover names). */
  /**
   * A spoken chat line whose bubble was never found: save what the overlay saw at that moment
   * (logs/overlay/missed/), so the cause can be looked at. At most one every 15 s, the last 30 kept.
   */
  _checkMissed(now) {
    if (this.cfg.mapOverlayMissedSnapshots === false || !this.proc || this.status !== 'running') return;
    for (const m of this.msgs.values()) {
      if (m.lines || m.radio || m.far || m.missChecked || now - m.t < 2500 || now - m.t > 4000) continue;
      m.missChecked = true;
      if (now - (this._lastMissSnap || 0) < 15000) continue;
      this._lastMissSnap = now;
      const d = new Date();
      const name = 'missed_' + [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');
      this._write('D' + name + '\n');
      this.tm.count('spoken lines whose bubble was never found (picture saved)');
      this.tm.event('missed', { key: m.key, name: m.name, it: m.italic ? 1 : 0, n: m.n, pic: name });
      this._blog(`missed  ${m.name || '?'}: "${m.ru.slice(0, 90)}"${m.italic ? ' (quiet/small font)' : ''}  no bubble found in 2.5 s -> picture saved as missed/${name}.png`);
      try {
        const dir = path.join(this.logDir, 'overlay', 'missed');
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^missed_/.test(f)).sort() : [];
        while (files.length > 60) fs.unlinkSync(path.join(dir, files.shift()));
      } catch (e) {}
    }
  }

  _blog(line) {
    try {
      const dir = path.join(this.logDir, 'overlay');
      if (!this._blogReady) {
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, 'bubbles.log');
        if (fs.existsSync(f) && fs.statSync(f).size > 2000000) fs.writeFileSync(f, '');
        this._blogReady = true;
      }
      fs.appendFile(path.join(dir, 'bubbles.log'), new Date().toTimeString().slice(0, 8) + '  ' + line.replace(/[\r\n]+/g, ' ') + '\n', () => {});
    } catch (e) {}
  }

  // ---------------------------------------------------------------- hover names
  /** The host read a new hover name at the top of the map (empty = none). */
  _onTip(raw) {
    this.tipRu = raw;
    this.tipEn = '';
    if (!raw) return;
    const text = mixedWords(repairRead(cleanRead(raw), (w) => this._knownWord(w)));
    if (!text) return; // English already (read with look-alike letters)
    const send = (en) => {
      if (!en || this.tipRu !== raw) return;
      if (en !== this._lastTipLogged) {
        this._lastTipLogged = en;
        this._blog(`hover   "${text}" -> "${en}"`);
        this.tm.count('hover names translated');
        this.tm.event('hover', { ru: text, en, raw });
      }
      this.tipEn = en;
      this.tipHistory.unshift({ ru: text, en });
      if (this.tipHistory.length > 12) this.tipHistory.pop();
      if (this.proc) this._write('H' + raw.replace(/[\u001d-\u001f\r\n]/g, ' ') + '\u001f' + String(en).replace(/[\u001d-\u001f\r\n]/g, ' ') + '\n');
    };
    const local = this._lookupName(text);
    if (local) return send(local);
    if (!this.translator) return;
    this.translator
      .toEnglish([text], 'live')
      .then((r) => send(r && r[text]))
      .catch(() => {});
  }

  /** A Russian word (small letters) that is a real word, a game word or part of a name we have seen. */
  _knownWord(w) {
    const tr = this.translator;
    if (!tr) return false;
    const ruw = tr._ruWords ? tr._ruWords() : null;
    if (ruw && ruw.has(w)) return true;
    const f = w.replace(/ё/g, 'е');
    if (tr.lex && tr.lex.ru2en && tr.lex.ru2en.first.has(f)) return true;
    if (!this._nameWords || this._nameWordsAt !== this.knownNames.size + ':' + (tr.names ? tr.names.size : 0)) {
      this._nameWordsAt = this.knownNames.size + ':' + (tr.names ? tr.names.size : 0);
      this._nameWords = new Set();
      const add = (s) => {
        for (const x of String(s).toLowerCase().split(/[^а-яё]+/)) if (x.length >= 3) this._nameWords.add(x.replace(/ё/g, 'е'));
      };
      for (const k of this.knownNames.keys()) add(k);
      if (tr.names) for (const k of tr.names.keys()) add(k);
    }
    return this._nameWords.has(f);
  }

  /** A hover name we already know: a speaker from chat (same English as in chat), or a game object. */
  _lookupName(text) {
    const tr = this.translator;
    if (!tr) return null;
    const key = normRu(text);
    const said = this.knownNames.get(key);
    if (said) {
      const en = tr.lookupLocal(said);
      if (en) return en;
    }
    const direct = tr.lookupLocal(text);
    if (direct) return direct;
    if (!this.nameIndex && tr.names) {
      this.nameIndex = new Map();
      for (const [ru, en] of tr.names) this.nameIndex.set(normRu(ru), en);
    }
    const en = this.nameIndex && this.nameIndex.get(key);
    if (en) return /^[А-ЯЁ]/.test(text) ? en.charAt(0).toUpperCase() + en.slice(1) : en;
    return null;
  }

  // ---------------------------------------------------------------- output
  _english(m) {
    if (!m.en) return ['…'];
    let en = m.en;
    if (m.layout && m.layout.cut) {
      // the bubble was cut off at 110 letters: cut the English at the same point
      const keep = Math.max(10, Math.round(([...en].length * MAX_CHARS) / Math.max(MAX_CHARS, [...m.ru].length)));
      if ([...en].length > keep) en = [...en].slice(0, keep).join('').replace(/\s+\S*$/, '') + '...';
    }
    const width = (m.layout && m.layout.width) || 112;
    if (!this.font) return [en];
    let lines = this.font.layoutEnglish(en, width);
    // English is often shorter than the Russian: spread it over as many lines as the Russian bubble has
    // (narrower lines), so the box over the Russian is filled instead of leaving an empty bar on top.
    const target = m.layout ? m.layout.lines.filter((g) => !g.empty).length : 1;
    const words = en.trim().split(/\s+/).length;
    if (lines.length < target && words > 1) {
      for (let w = width - 4; w >= 20; w -= 4) {
        const l2 = this.font.layoutEnglish(en, w);
        if (l2.length > Math.min(target, words)) break;
        lines = l2;
      }
    }
    return lines;
  }

  labels() {
    const out = [];
    for (const m of this.msgs.values()) {
      if (!m.lines || !m.lines.some((id) => id && this.tracks.has(id))) continue;
      if (m.readOnly && !m.en) continue;
      const russian = m.layout.lines.map((g, i) => {
        const cx = g.W / 2;
        return {
          idx: i,
          track: m.lines[i] && this.tracks.has(m.lines[i]) ? m.lines[i] : 0,
          ax: g.empty ? 0 : cx - g.x0,
          bd: g.empty ? 0 : g.bottom,
          fx0: g.fx0 - cx,
          fx1: g.fx1 - cx,
          ftop: g.ftop,
          fbot: g.fbot,
        };
      });
      out.push({
        key: m.key,
        group: m.name ? 'n:' + m.name : 'k:' + m.key,
        order: m.order,
        z: m.z,
        color: toInt(m.color2 || [255, 255, 255]),
        lines: m.layout.lines.length,
        russian,
        english: this._english(m),
      });
    }
    return out;
  }

  _sendLabels() {
    const labels = this.labels();
    this.labelsShown = labels.map((l) => l.english.join(' ')).slice(0, 10);
    const clean = (s) => String(s).replace(/[\u001d-\u001f\r\n]/g, ' ');
    const f = (v) => (Math.round(v * 100) / 100).toString();
    const recs = labels.map((lb) =>
      [
        clean(lb.key),
        clean(lb.group),
        lb.order,
        lb.z.toFixed(4),
        lb.color,
        lb.lines,
        lb.russian.map((r) => [r.idx, r.track, f(r.ax), f(r.bd), f(r.fx0), f(r.fx1), f(r.ftop), f(r.fbot)].join(':')).join(';'),
        lb.english.map(clean).join('\u001d'),
      ].join('\u001f')
    );
    const now = Date.now();
    for (const lb of labels) {
      const m = this.msgs.get(lb.key);
      if (m && !m.labelAt && lb.english.some((e) => e && e.trim())) {
        m.labelAt = now;
        this.tm.sample('bubble: English label shown after chat (ms)', now - m.t);
        this.tm.event('label', { key: m.key, ms: now - m.t, lines: lb.lines, en_lines: lb.english.length });
      }
    }
    const line = 'L' + recs.join('\u001e') + '\n';
    if (line === this._lastLabels) return;
    this._lastLabels = line;
    if (this.proc) this._write(line);
  }

  /** While a chat line waits for its bubble, the host watches the speaker's last spot closely. */
  _updateWatch(now) {
    // the host looks for small-font lines only while one is expected or labelled (it costs time)
    let small = false;
    for (const m of this.msgs.values()) {
      if (m.italic && !m.lines && !m.far && now - m.t < 4500) small = true;
      else if (m.lines && m.lines.some((id) => id && this.tracks.has(id) && this.tracks.get(id).small)) small = true;
      if (small) break;
    }
    if (small !== this._smallSent && this.proc) {
      this._smallSent = small;
      this._write(small ? 'Y1\n' : 'Y0\n');
    }
    const regions = [];
    const z = this.zEst;
    if (z && this.rect) {
      for (const m of this.msgs.values()) {
        if (m.lines || m.far || now - m.t > 3000 || !m.name) continue;
        const a = this.anchors.get(m.name);
        if (!a || now - a.t > 15000) continue;
        const half = (112 / 2 + 24) * z;
        const x0 = Math.max(this.rect[0], Math.round((a.x - half) / 8) * 8);
        const x1 = Math.min(this.rect[0] + this.rect[2], Math.round((a.x + half) / 8) * 8);
        const y0 = Math.max(this.rect[1], Math.round((a.y - 7 * LINE_PITCH * z) / 8) * 8);
        const y1 = Math.min(this.rect[1] + this.rect[3], Math.round((a.y + 2 * LINE_PITCH * z) / 8) * 8);
        if (x1 - x0 > 16 && y1 - y0 > 16) regions.push([x0, y0, x1 - x0, y1 - y0].join(','));
      }
    }
    // speakers with a new line on the way whose earlier bubble is still up (it is about to slide up)
    const expect = new Set();
    for (const m of this.msgs.values()) {
      if (!m.lines && m.name && now - m.t <= 4500) {
        const a = this.anchors.get(m.name);
        if (a && a.live) expect.add('n:' + m.name);
      }
    }
    const line = 'W' + regions.join(';') + '\n' + 'X' + [...expect].map((g) => g.replace(/[\u001d-\u001f\r\n]/g, ' ')).join('\u001e') + '\n';
    if (line === this._lastWatch) return;
    this._lastWatch = line;
    if (this.proc) this._write(line);
  }

  info() {
    return {
      status: this.status,
      problem: this.problem,
      flicker: !this.excluded && this.captureMode !== 1,
      frames: this.frames,
      frameMs: this.lastFrameMs,
      chatLines: this.stats.chatLines,
      matched: this.stats.matched,
      unsure: this.stats.unsure,
      zoom: this.zEst ? Math.round(this.zEst * 100) / 100 : null,
      labels: this.labelsShown,
      recent: this.history.slice(-12).reverse(),
      tips: this.tipHistory.slice(0, 8),
    };
  }
}

module.exports = { repairRead, mixedWords, MapOverlay, parseColor, variants, colorGap };
