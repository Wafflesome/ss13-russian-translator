// The control panel's Dictionary page: every saved translation, searchable, and your own fixes.
//
// Game text (Russian -> English) comes from the translation cache plus data/overrides.json (your fixes);
// what you type (English -> Russian) from the cache plus data/overrides_outgoing.json. A fix always wins
// over the machine translation and survives "Forget all translations".
'use strict';
const fs = require('fs');
const path = require('path');
const { isTemplateKey } = require('./translator.js');

const CYR = /[а-яё]/i;
const LAT = /[a-z]/i;

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е');
// alphabetical order ignores quotes, dashes and other marks in front ("Херасебе." and "«Херасебе»" sort together)
const sortKey = (s) => norm(s).replace(/^[^a-zа-я0-9]+/, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NOT_WORD = '[^a-zа-я0-9]';

// ------------------------------------------------------------------ numbers in saved texts
// "Осталось 15 секунд" is saved as "Осталось 701 секунд" so every number shares one translation. The page
// shows such markers as {1}, {2} ... in both languages.
function showMarkers(text) {
  return String(text).replace(/(?<!\d)7(\d\d)(?!\d)/g, (m, d) => '{' + Number(d) + '}');
}
function markerCount(key) {
  return (String(key).match(/\d+/g) || []).length;
}
function hideMarkers(text) {
  return String(text).replace(/\{(\d{1,2})\}/g, (m, d) => String(700 + Number(d)));
}

// ------------------------------------------------------------------ spelling helpers
const RU_LAT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const toLatin = (s) => norm(s).replace(/[а-я]/g, (c) => (c in RU_LAT ? RU_LAT[c] : c));
const LAT_RU = [
  ['shch', 'щ'], ['sch', 'щ'], ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц'], ['ch', 'ч'], ['sh', 'ш'], ['yu', 'ю'], ['ya', 'я'], ['yo', 'е'], ['ye', 'е'],
  ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'], ['z', 'з'], ['i', 'и'], ['y', 'ы'], ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'],
  ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'к'], ['w', 'в'], ['x', 'кс'], ['j', 'й'], ['q', 'к'],
];
function toCyrillic(s) {
  let out = '';
  const t = norm(s);
  for (let i = 0; i < t.length; ) {
    let hit = null;
    for (const [l, r] of LAT_RU) if (t.startsWith(l, i)) { hit = [l, r]; break; }
    if (hit) { out += hit[1]; i += hit[0].length; } else { out += t[i]; i++; }
  }
  return out;
}
// the same keys on an English and a Russian keyboard ("ghbdtn" typed meaning "привет")
const KB_EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const KB_RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';
function swapLayout(s) {
  let out = '';
  for (const c of norm(s)) {
    const i = KB_EN.indexOf(c);
    const j = KB_RU.indexOf(c);
    out += i >= 0 ? KB_RU[i] : j >= 0 ? KB_EN[j] : c;
  }
  return out;
}

/** Edit distance (with swapped neighbours counting once), giving up above max. */
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length, m = b.length;
  let prev2 = null, prev = new Array(m + 1), cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    const t = prev2 || new Array(m + 1);
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return prev[m];
}
const lettersOf = (s) => norm(s).replace(/[^a-zа-я]/g, '');

/**
 * Looks untranslated: the "English" still has Russian letters, or is just the Russian spelled in Latin
 * letters ("Херасебе." -> "Herasebe.") and isn't an English word. People's names (every word capitalised,
 * no sentence ending) are spelled out on purpose and are not counted. Only a hint.
 */
let ENGLISH = null;
function englishWords(dataDir) {
  if (ENGLISH) return ENGLISH;
  ENGLISH = new Set();
  try {
    for (const w of fs.readFileSync(path.join(dataDir, 'english_words.txt'), 'utf8').split(/\r?\n/)) if (w) ENGLISH.add(w);
  } catch (e) {}
  return ENGLISH;
}
function looksUntranslated(src, tr, english) {
  if (tr == null || tr === '') return true;
  if (CYR.test(tr)) return true;
  const ru = lettersOf(src).replace(/[a-z]/g, '');
  if (ru.length < 3 || src.length > 60) return false;
  const lat = lettersOf(tr);
  if (!lat) return false;
  const t = toLatin(ru);
  const max = Math.max(1, Math.floor(Math.max(t.length, lat.length) * 0.25));
  if (distance(t, lat, max) > max) return false;
  // a name: every Russian word starts with a capital, and it isn't a sentence
  const words = String(src).match(/[А-Яа-яЁё]+/g) || [];
  if (words.length && words.every((w) => /^[А-ЯЁ]/.test(w)) && !/[.!?…]\s*$/.test(src) && !/^[А-ЯЁ]+$/.test(words.join(''))) return false;
  // the same word in both languages (детектив / detective): fine
  if (english && english.size) {
    const out = String(tr).toLowerCase().match(/[a-z]+/g) || [];
    if (out.length && out.every((w) => english.has(w) || english.has(w.replace(/(?:s|es|ed|ing)$/, '')))) return false;
  }
  return true;
}

// ------------------------------------------------------------------ the dictionary
class Dictionary {
  constructor(translator, dataDir, log) {
    this.t = translator;
    this.dataDir = dataDir;
    this.log = log || (() => {});
    this.snaps = {};
    const out = path.join(dataDir, 'overrides_outgoing.json');
    if (!fs.existsSync(out)) {
      try {
        fs.writeFileSync(out, JSON.stringify({ _help: 'Your fixes for what you type: exact English text -> the Russian to send instead. Made on the Dictionary page of the control panel.' }, null, 1));
      } catch (e) {}
    }
  }

  _files(dir) {
    return dir === 'en-ru'
      ? { cache: this.t.en2ru, fixes: this.t.outOverrides, file: path.join(this.dataDir, 'overrides_outgoing.json') }
      : { cache: this.t.ru2en, fixes: this.t.overrides, file: path.join(this.dataDir, 'overrides.json') };
  }

  /** All entries of one direction, rebuilt when translations change (at most every 3 s while you browse). */
  _snapshot(dir, force) {
    const ver = this.t.cacheVersion;
    let snap = this.snaps[dir];
    if (snap && !force && (snap.ver === ver || Date.now() - snap.at < 3000)) return snap;
    const { cache, fixes } = this._files(dir);
    const items = [];
    const byKey = new Map();
    let order = 0;
    for (const [key, machine] of cache) {
      const it = { key, machine, fix: undefined, order: order++ };
      items.push(it);
      byKey.set(key, it);
    }
    let fixOrder = 0;
    for (const [key, fix] of fixes) {
      let it = byKey.get(key);
      if (!it) {
        it = { key, machine: undefined, fix: undefined, order: order++ };
        items.push(it);
        byKey.set(key, it);
      }
      it.fix = fix;
      it.recent = 1e9 + fixOrder++;
    }
    let fixed = 0, sus = 0, nums = 0;
    const english = englishWords(this.dataDir);
    for (const it of items) {
      it.tr = it.fix !== undefined ? it.fix : it.machine;
      it.tpl = dir === 'ru-en' && isTemplateKey(it.key);
      it.nk = norm(it.tpl ? showMarkers(it.key) : it.key);
      it.nt = norm(it.tpl ? showMarkers(it.tr || '') : it.tr || '');
      it.sk = sortKey(it.nk);
      if (it.recent === undefined) it.recent = it.order;
      it.sus = dir === 'ru-en' ? looksUntranslated(it.key, it.tr, english) : it.tr != null && !CYR.test(it.tr) && LAT.test(it.key);
      if (it.fix !== undefined) fixed++;
      if (it.sus) sus++;
      if (/\d/.test(it.key)) nums++;
    }
    snap = { ver, at: Date.now(), items, byKey, sorted: {}, words: null, counts: { all: items.length, fixed, sus, nums } };
    this.snaps[dir] = snap;
    return snap;
  }

  _sorted(snap, sort) {
    if (snap.sorted[sort]) return snap.sorted[sort];
    const arr = snap.items.slice();
    if (sort === 'tr') {
      for (const it of arr) if (it.st === undefined) it.st = sortKey(it.nt);
      arr.sort((a, b) => (a.st < b.st ? -1 : a.st > b.st ? 1 : a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
    } else if (sort === 'newest') arr.sort((a, b) => b.recent - a.recent);
    else arr.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    snap.sorted[sort] = arr;
    return arr;
  }

  /** Words used in the saved texts, for "did you mean". */
  _words(snap) {
    if (snap.words) return snap.words;
    const count = new Map();
    const re = /[a-zа-я]{2,}/g;
    for (const it of snap.items) {
      for (const s of [it.nk, it.nt]) {
        const m = s.match(re);
        if (m) for (const w of m) count.set(w, (count.get(w) || 0) + 1);
      }
    }
    const tri = new Map();
    for (const w of count.keys()) {
      const p = '^' + w + '$';
      const seen = new Set();
      for (let i = 0; i + 3 <= p.length; i++) {
        const g = p.slice(i, i + 3);
        if (seen.has(g)) continue;
        seen.add(g);
        let l = tri.get(g);
        if (!l) tri.set(g, (l = []));
        l.push(w);
      }
    }
    snap.words = { count, tri };
    return snap.words;
  }

  _similarWords(snap, word, limit) {
    const { count, tri } = this._words(snap);
    const p = '^' + word + '$';
    const hits = new Map();
    for (let i = 0; i + 3 <= p.length; i++) for (const w of tri.get(p.slice(i, i + 3)) || []) hits.set(w, (hits.get(w) || 0) + 1);
    const max = word.length <= 4 ? 1 : word.length <= 8 ? 2 : 3;
    const out = [];
    for (const [w, shared] of hits) {
      if (w === word || shared < 1) continue;
      const d = distance(word, w, max);
      const stem = word.length >= 4 && w.length >= 4 && w.slice(0, Math.max(4, word.length - 2)) === word.slice(0, Math.max(4, word.length - 2));
      if (d <= max || stem) out.push({ w, d: stem ? Math.min(d, 1) : d, n: count.get(w) || 0, stem });
    }
    out.sort((a, b) => a.d - b.d || b.n - a.n);
    return out.slice(0, limit);
  }

  _matcher(q, field, match) {
    const text = norm(q).trim().replace(/\s+/g, ' ');
    if (!text) return null;
    if (match === 'exact') {
      const want = text.replace(/^[^a-zа-я0-9{}]+|[^a-zа-я0-9{}]+$/g, '');
      const strip = (s) => s.trim().replace(/^[^a-zа-я0-9{}]+|[^a-zа-я0-9{}]+$/g, '');
      return { text, test: (it) => (field !== 'tr' && strip(it.nk) === want) || (field !== 'src' && strip(it.nt) === want) };
    }
    // words and "quoted phrases"; every one must be found (in any order)
    const toks = [];
    text.replace(/"([^"]+)"|(\S+)/g, (m, a, b) => {
      const t = (a || b).trim();
      if (t) toks.push(t);
      return m;
    });
    const tests = toks.map((t) => {
      if (match === 'start') {
        const re = new RegExp('(^|' + NOT_WORD + ')' + esc(t));
        return (s) => re.test(s);
      }
      if (match === 'word') {
        const re = new RegExp('(^|' + NOT_WORD + ')' + esc(t) + '($|' + NOT_WORD + ')');
        return (s) => re.test(s);
      }
      return (s) => s.includes(t);
    });
    return {
      text,
      toks,
      test: (it) => tests.every((f) => (field !== 'tr' && f(it.nk)) || (field !== 'src' && f(it.nt))),
    };
  }

  _rank(it, text, field) {
    const fields = field === 'src' ? [it.nk] : field === 'tr' ? [it.nt] : [it.nk, it.nt];
    let best = 4;
    for (const s of fields) {
      const bare = s.trim().replace(/^[^a-zа-я0-9{}]+|[^a-zа-я0-9{}]+$/g, '');
      if (bare === text) best = Math.min(best, 0);
      else if (bare.startsWith(text)) best = Math.min(best, 1);
      else if (new RegExp('(^|' + NOT_WORD + ')' + esc(text) + '($|' + NOT_WORD + ')').test(s)) best = Math.min(best, 2);
      else if (s.includes(text)) best = Math.min(best, 3);
    }
    return best;
  }

  _view(it) {
    const show = (s) => (s == null ? null : it.tpl ? showMarkers(s) : s);
    return { key: it.key, src: show(it.key), tr: show(it.tr), machine: show(it.machine), fixed: it.fix !== undefined, tpl: it.tpl, markers: it.tpl ? markerCount(it.key) : 0, sus: !!it.sus };
  }

  /**
   * One page of entries. opts: dir ('ru-en'|'en-ru'), q, field ('both'|'src'|'tr'), match
   * ('contains'|'start'|'word'|'exact'), filter ('all'|'fixed'|'sus'|'nums'), sort ('auto'|'src'|'tr'|
   * 'newest'), offset, limit, letter (jump to the first entry starting with it), key (find this entry).
   */
  list(opts) {
    const dir = opts.dir === 'en-ru' ? 'en-ru' : 'ru-en';
    const snap = this._snapshot(dir, !!opts.fresh);
    const field = ['src', 'tr'].includes(opts.field) ? opts.field : 'both';
    const match = ['start', 'word', 'exact'].includes(opts.match) ? opts.match : 'contains';
    const q = String(opts.q || '').slice(0, 200);
    let sort = ['src', 'tr', 'newest'].includes(opts.sort) ? opts.sort : 'auto';
    const m = this._matcher(q, field, match);
    if (sort === 'auto') sort = m ? 'best' : 'src';
    const filt = (it) =>
      opts.filter === 'fixed' ? it.fix !== undefined : opts.filter === 'sus' ? it.sus : opts.filter === 'nums' ? /\d/.test(it.key) : true;
    const run = (matcher) => {
      let arr = this._sorted(snap, sort === 'best' ? 'src' : sort).filter((it) => filt(it) && (!matcher || matcher.test(it)));
      if (sort === 'best' && matcher) {
        const r = new Map(arr.map((it) => [it, this._rank(it, matcher.text, field)]));
        arr = arr.slice().sort((a, b) => r.get(a) - r.get(b) || a.nk.length - b.nk.length || (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
      }
      return arr;
    };
    const arr = run(m);
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 150));
    let offset = Math.max(0, Number(opts.offset) || 0);
    if (opts.letter && (sort === 'src' || sort === 'tr')) {
      const L = norm(opts.letter);
      const keyOf = (it) => (sort === 'tr' ? it.st : it.sk);
      let lo = 0, hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (keyOf(arr[mid]) < L) lo = mid + 1;
        else hi = mid;
      }
      offset = lo;
    }
    if (opts.key != null) {
      const i = arr.findIndex((it) => it.key === opts.key);
      if (i >= 0) offset = Math.max(0, i - 3);
    }
    const res = {
      ok: true,
      dir,
      total: arr.length,
      offset,
      items: arr.slice(offset, offset + limit).map((it) => this._view(it)),
      counts: snap.counts,
      sort,
      suggestions: [],
      closest: null,
    };
    if (m && q.length >= 2 && arr.length < 5) {
      res.suggestions = this._suggest(snap, q, field, match, filt);
      if (!arr.length && res.suggestions.length) {
        const s = res.suggestions[0];
        const alt = run(this._matcher(s.text, field, 'contains'));
        res.closest = { q: s.text, why: s.why, total: alt.length, items: alt.slice(0, 60).map((it) => this._view(it)) };
      }
    }
    return res;
  }

  _suggest(snap, q, field, match, filt) {
    const out = [];
    const seen = new Set([norm(q).trim()]);
    const found = (text) => {
      const mm = this._matcher(text, field, 'contains');
      if (!mm) return 0;
      let n = 0;
      for (const it of snap.items) if (filt(it) && mm.test(it)) n++;
      return n;
    };
    const add = (text, why) => {
      text = norm(text).trim();
      if (!text || seen.has(text) || out.length >= 8) return;
      seen.add(text);
      const n = found(text);
      if (n) out.push({ text, why, n });
    };
    const qn = norm(q).trim();
    // typed with the other keyboard layout
    add(swapLayout(qn), 'typed with the other keyboard layout');
    // Russian written in Latin letters ("herasebe")
    if (LAT.test(qn) && !CYR.test(qn)) add(toCyrillic(qn), 'Russian spelling');
    // similar words (spelling mistakes, other endings: "блобом" for "блоб")
    const words = qn.match(/[a-zа-я]{2,}/g) || [];
    const last = words[words.length - 1];
    if (last) {
      const variants = [last];
      if (LAT.test(last) && !CYR.test(last)) variants.push(toCyrillic(last));
      for (const v of variants) {
        for (const s of this._similarWords(snap, v, 10)) {
          const text = words.length > 1 ? qn.slice(0, qn.lastIndexOf(last)) + s.w : s.w;
          add(text, s.stem ? 'another form of the word' : 'similar spelling');
        }
      }
    }
    out.sort((a, b) => (a.why === 'typed with the other keyboard layout' ? -1 : 0) - (b.why === 'typed with the other keyboard layout' ? -1 : 0));
    return out;
  }

  // ---------------------------------------------------------------- changes
  _writeFixes(dir) {
    const { fixes, file } = this._files(dir);
    let doc = {};
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {}
    const out = {};
    for (const k in doc) if (k.startsWith('_')) out[k] = doc[k];
    if (!out._help)
      out._help = dir === 'en-ru' ? 'Your fixes for what you type: exact English text -> the Russian to send instead.' : 'Exact Russian text -> the English you want shown. Saved changes apply to the running game.';
    for (const [k, v] of fixes) out[k] = v;
    // written in place (not replaced): the file watcher keeps working for your own edits of the file
    this.t.selfWriteAt = Date.now();
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
    this.t.selfWriteAt = Date.now();
  }

  _changed(dir) {
    this.t.cacheVersion++;
    this.t.dirty = true;
    this.snaps[dir] = null;
  }

  _entry(dir, key) {
    const snap = this._snapshot(dir, true);
    const it = snap.byKey.get(key);
    return it ? this._view(it) : null;
  }

  /** What the game windows need to do after a change of this entry. */
  _pageUpdate(dir, key) {
    if (dir !== 'ru-en') return null;
    if (isTemplateKey(key)) return { refresh: true };
    const { cache, fixes } = this._files(dir);
    const en = fixes.has(key) ? fixes.get(key) : cache.get(key);
    return en == null ? { forget: [key] } : { fixes: { [key]: en } };
  }

  _cleanKey(dir, key) {
    const k = String(key == null ? '' : key);
    // the game windows ask for texts with single spaces and no spaces around them
    return dir === 'ru-en' ? k.trim().replace(/\s+/g, ' ') : k.trim();
  }

  /** Saves your translation of one entry (or a new one). gameWord: {from, to} also teaches the word everywhere. */
  save(opts) {
    const dir = opts.dir === 'en-ru' ? 'en-ru' : 'ru-en';
    const key = opts.isNew ? this._cleanKey(dir, opts.key) : String(opts.key == null ? '' : opts.key);
    let text = String(opts.text == null ? '' : opts.text).trim();
    if (!key) return { ok: false, error: dir === 'ru-en' ? 'Enter the Russian text.' : 'Enter the English text.' };
    if (!text) return { ok: false, error: 'The translation is empty. To go back to the machine translation, use "Undo my fix".' };
    if (text.length > 5000 || key.length > 5000) return { ok: false, error: 'That text is too long.' };
    if (dir === 'ru-en' && opts.isNew && !CYR.test(key)) return { ok: false, error: 'The Russian text has no Russian letters.' };
    const { cache, fixes } = this._files(dir);
    if (!opts.isNew && !cache.has(key) && !fixes.has(key)) return { ok: false, error: 'This entry is no longer saved (the list was out of date). Search for it again.' };
    if (dir === 'ru-en' && isTemplateKey(key)) {
      const n = markerCount(key);
      const used = new Set((text.match(/\{(\d{1,2})\}/g) || []).map((x) => Number(x.slice(1, -1))));
      for (let i = 1; i <= n; i++) if (!used.has(i)) return { ok: false, error: `Keep {${i}} in the translation: it stands for a number that changes.` };
      for (const u of used) if (u < 1 || u > n) return { ok: false, error: `{${u}} doesn't exist in this text (there ${n === 1 ? 'is only {1}' : 'are {1} to {' + n + '}'}).` };
      text = hideMarkers(text);
    }
    const before = { fix: fixes.get(key), machine: cache.get(key) };
    fixes.delete(key); // a changed fix moves to the end (newest)
    fixes.set(key, text);
    try {
      this._writeFixes(dir);
    } catch (e) {
      return { ok: false, error: 'Could not save: ' + e.message };
    }
    this._changed(dir);
    let game = null;
    if (opts.gameWord && opts.gameWord.from && opts.gameWord.to) {
      game = this._saveGameWord(dir, String(opts.gameWord.from), String(opts.gameWord.to));
      if (!game.ok) return { ok: false, error: game.error };
    }
    this.log(`Dictionary: "${String(key).slice(0, 60)}" -> "${text.slice(0, 60)}" (your fix${game ? ', also as a game word' : ''}).`);
    return { ok: true, entry: this._entry(dir, key), before, page: game && dir === 'ru-en' ? { refresh: true } : this._pageUpdate(dir, key), game };
  }

  _saveGameWord(dir, from, to) {
    from = from.trim().replace(/\s+/g, ' ');
    to = to.trim();
    if (!from || !to) return { ok: false, error: 'Fill in both words for the game dictionary.' };
    if (from.split(' ').length > 4) return { ok: false, error: 'A game word can be at most 4 words long.' };
    if (dir === 'ru-en' && !CYR.test(from)) return { ok: false, error: 'The game word needs Russian letters.' };
    const file = path.join(this.dataDir, 'lexicon_game.json');
    let doc = {};
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return { ok: false, error: 'Could not read lexicon_game.json: ' + e.message };
    }
    const side = dir === 'ru-en' ? 'ru2en' : 'en2ru';
    doc[side] = doc[side] || {};
    const k = dir === 'ru-en' ? from.toLowerCase() : from;
    doc[side][k] = to;
    doc._yours = doc._yours && typeof doc._yours === 'object' ? doc._yours : {};
    doc._yours[side + ':' + k] = true;
    try {
      this.t.selfWriteAt = Date.now();
      fs.writeFileSync(file, JSON.stringify(doc, null, 1));
      this.t.selfWriteAt = Date.now();
    } catch (e) {
      return { ok: false, error: 'Could not save the game word: ' + e.message };
    }
    // reload the dictionaries now; saved texts that got this word wrong are translated again
    this.t.reloadData();
    this.snaps = {};
    return { ok: true, from: k, to };
  }

  // ---------------------------------------------------------------- single words
  /** Every Russian word in the saved game texts, with how often it appears and how it is translated. */
  _wordList(snap) {
    if (snap.wordList) return snap.wordList;
    const n = new Map();
    const re = /[а-я]+(?:-[а-я]+)*/g;
    for (const it of snap.items) {
      const m = it.nk.match(re);
      if (!m) continue;
      const seen = new Set();
      for (const w of m) {
        if (w.length < 2 || seen.has(w)) continue;
        seen.add(w);
        n.set(w, (n.get(w) || 0) + 1);
      }
    }
    const list = [...n].map(([w, c]) => ({ w, n: c, sk: w }));
    list.sort((a, b) => (a.w < b.w ? -1 : a.w > b.w ? 1 : 0));
    snap.wordList = list;
    return list;
  }

  _gameDoc() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dataDir, 'lexicon_game.json'), 'utf8'));
    } catch (e) {
      return {};
    }
  }

  /** How one Russian word is translated now: your game word, the game dictionary, or the service. */
  _wordInfo(w, game) {
    const mine = !!(game._yours && game._yours['ru2en:' + w]);
    let gameEn = null;
    if (this.t.lex) {
      const f = this.t.lex.ru2en.find(w);
      if (f.length === 1 && f[0].start === 0 && f[0].end === w.length) gameEn = f[0].to;
    }
    const cap = w.charAt(0).toUpperCase() + w.slice(1);
    let machine = this.t.ru2en.get(w);
    if (machine === undefined) machine = this.t.ru2en.get(cap);
    if (machine === undefined) machine = this.t.ru2en.get(cap + '.');
    const fix = this.t.overrides.get(w) !== undefined ? this.t.overrides.get(w) : this.t.overrides.get(cap);
    return { word: w, mine, game: gameEn, machine: machine === undefined ? null : machine, fix: fix === undefined ? null : fix };
  }

  words(opts) {
    const snap = this._snapshot('ru-en', !!opts.fresh);
    const list = this._wordList(snap);
    const q = norm(opts.q || '').trim();
    const game = this._gameDoc();
    let arr = list;
    if (q) {
      const qs = [q];
      if (LAT.test(q) && !CYR.test(q)) qs.push(toCyrillic(q));
      const sw = swapLayout(q);
      if (CYR.test(sw) && !LAT.test(sw)) qs.push(sw);
      arr = list.filter((x) => qs.some((v) => (opts.match === 'start' ? x.w.startsWith(v) : opts.match === 'exact' ? x.w === v : x.w.includes(v))));
      arr = arr.slice().sort((a, b) => {
        const ra = qs.includes(a.w) ? 0 : qs.some((v) => a.w.startsWith(v)) ? 1 : 2;
        const rb = qs.includes(b.w) ? 0 : qs.some((v) => b.w.startsWith(v)) ? 1 : 2;
        return ra - rb || b.n - a.n || (a.w < b.w ? -1 : 1);
      });
    }
    if (opts.filter === 'game') arr = arr.filter((x) => this._wordInfo(x.w, game).game);
    else if (opts.filter === 'mine') arr = arr.filter((x) => game._yours && game._yours['ru2en:' + x.w]);
    if (!q && opts.sort === 'count') arr = arr.slice().sort((a, b) => b.n - a.n || (a.w < b.w ? -1 : 1));
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 150));
    let offset = Math.max(0, Number(opts.offset) || 0);
    if (opts.letter && !q && opts.sort !== 'count') {
      const L = norm(opts.letter);
      let lo = 0, hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].w < L) lo = mid + 1;
        else hi = mid;
      }
      offset = lo;
    }
    const res = {
      ok: true,
      total: arr.length,
      all: list.length,
      offset,
      items: arr.slice(offset, offset + limit).map((x) => Object.assign(this._wordInfo(x.w, game), { n: x.n })),
      suggestions: [],
    };
    if (q && arr.length < 3 && q.length >= 2) {
      const seen = new Set(arr.map((x) => x.w));
      const vars = [q];
      if (LAT.test(q) && !CYR.test(q)) vars.push(toCyrillic(q));
      const sw = swapLayout(q);
      if (CYR.test(sw)) vars.push(sw);
      const sug = [];
      for (const v of vars) {
        const max = v.length <= 4 ? 1 : v.length <= 8 ? 2 : 3;
        for (const x of list) {
          if (seen.has(x.w) || Math.abs(x.w.length - v.length) > max + 2) continue;
          const stem = v.length >= 4 && x.w.startsWith(v.slice(0, Math.max(3, v.length - 2)));
          const d = distance(v, x.w, max);
          if (d <= max || stem) {
            seen.add(x.w);
            sug.push({ x, d: stem ? Math.min(d, 1) : d });
          }
        }
      }
      sug.sort((a, b) => a.d - b.d || b.x.n - a.x.n);
      res.suggestions = sug.slice(0, 12).map((s) => Object.assign(this._wordInfo(s.x.w, game), { n: s.x.n }));
    }
    return res;
  }

  /** Asks the translation service for one word on its own. */
  async translateWord(opts) {
    const w = String(opts.word || '').trim();
    if (!w || !CYR.test(w)) return { ok: false, error: 'No Russian word given.' };
    const r = await this.t.toEnglish([w], 'live');
    if (r[w] == null) return { ok: false, error: 'The translation service did not answer. Try again in a moment.' };
    this._changed('ru-en');
    return { ok: true, word: w, en: r[w] };
  }

  /** Teaches (or changes) one game word: used inside every text from now on. */
  saveWord(opts) {
    const dir = opts.dir === 'en-ru' ? 'en-ru' : 'ru-en';
    const r = this._saveGameWord(dir, String(opts.word || ''), String(opts.text || ''));
    if (!r.ok) return r;
    this.log(`Dictionary: game word "${r.from}" -> "${r.to}".`);
    return { ok: true, word: r.from, to: r.to, page: dir === 'ru-en' ? { refresh: true } : null };
  }

  /** Removes one of your game words (the built-in dictionaries and the service take over again). */
  removeWord(opts) {
    const dir = opts.dir === 'en-ru' ? 'en-ru' : 'ru-en';
    const side = dir === 'ru-en' ? 'ru2en' : 'en2ru';
    const w = String(opts.word || '').trim();
    const k = dir === 'ru-en' ? w.toLowerCase() : w;
    const doc = this._gameDoc();
    if (!doc._yours || !doc._yours[side + ':' + k]) return { ok: false, error: 'Only words you added yourself can be removed here (the others are in data/lexicon_game.json).' };
    delete doc._yours[side + ':' + k];
    if (doc[side]) delete doc[side][k];
    try {
      this.t.selfWriteAt = Date.now();
      fs.writeFileSync(path.join(this.dataDir, 'lexicon_game.json'), JSON.stringify(doc, null, 1));
      this.t.selfWriteAt = Date.now();
    } catch (e) {
      return { ok: false, error: 'Could not save: ' + e.message };
    }
    this.t.reloadData();
    this.snaps = {};
    this.log(`Dictionary: your game word "${k}" removed.`);
    return { ok: true, page: dir === 'ru-en' ? { refresh: true } : null };
  }

  /** Your own fixes and game words, to keep or share (and to load back). */
  exportFixes() {
    const game = this._gameDoc();
    const words = { ru2en: {}, en2ru: {} };
    for (const k in game._yours || {}) {
      const [side, w] = [k.slice(0, 5), k.slice(6)];
      if (game[side] && game[side][w] != null) words[side][w] = game[side][w];
    }
    return {
      ok: true,
      data: {
        _what: 'SS13 Russian Translator - your fixes. Load them on the Dictionary page (Import).',
        exported: new Date().toISOString(),
        gameText: Object.fromEntries(this.t.overrides),
        youType: Object.fromEntries(this.t.outOverrides),
        gameWords: words,
      },
    };
  }

  importFixes(opts) {
    const d = opts.data;
    if (!d || typeof d !== 'object') return { ok: false, error: 'That file is not an export from this page.' };
    let n = 0;
    const take = (obj, map, keyOk) => {
      for (const k in obj || {}) {
        if (k.startsWith('_') || typeof obj[k] !== 'string' || !obj[k].trim() || k.length > 5000 || obj[k].length > 5000 || !keyOk(k)) continue;
        map.set(k, obj[k]);
        n++;
      }
    };
    take(d.gameText, this.t.overrides, (k) => CYR.test(k));
    take(d.youType, this.t.outOverrides, () => true);
    this._writeFixes('ru-en');
    this._writeFixes('en-ru');
    let words = 0;
    if (d.gameWords) {
      const doc = this._gameDoc();
      doc._yours = doc._yours && typeof doc._yours === 'object' ? doc._yours : {};
      for (const side of ['ru2en', 'en2ru']) {
        for (const k in d.gameWords[side] || {}) {
          const v = d.gameWords[side][k];
          if (typeof v !== 'string' || !v.trim() || k.split(' ').length > 4) continue;
          doc[side] = doc[side] || {};
          doc[side][k] = v;
          doc._yours[side + ':' + k] = true;
          words++;
        }
      }
      if (words) {
        this.t.selfWriteAt = Date.now();
        fs.writeFileSync(path.join(this.dataDir, 'lexicon_game.json'), JSON.stringify(doc, null, 1));
        this.t.selfWriteAt = Date.now();
        this.t.reloadData();
      }
    }
    this._changed('ru-en');
    this._changed('en-ru');
    this.snaps = {};
    this.log(`Dictionary: imported ${n} fixes and ${words} game words.`);
    return { ok: true, fixes: n, words, page: { refresh: true } };
  }

  /** Puts an entry back exactly as it was (for Undo). */
  put(opts) {
    const dir = opts.dir === 'en-ru' ? 'en-ru' : 'ru-en';
    const key = String(opts.key == null ? '' : opts.key);
    if (!key) return { ok: false, error: 'Nothing to undo.' };
    const { cache, fixes } = this._files(dir);
    const hadFix = fixes.has(key);
    if (typeof opts.machine === 'string') cache.set(key, opts.machine);
    if (typeof opts.fix === 'string') fixes.set(key, opts.fix);
    else fixes.delete(key);
    if (hadFix || typeof opts.fix === 'string') this._writeFixes(dir);
    this._changed(dir);
    return { ok: true, entry: this._entry(dir, key), page: this._pageUpdate(dir, key) };
  }

  /** Removes your fix: the machine translation is used again (asked for again if there is none). */
  async revert(opts) {
    const dir = opts.dir === 'en-ru' ? 'en-ru' : 'ru-en';
    const key = String(opts.key == null ? '' : opts.key);
    const { cache, fixes } = this._files(dir);
    const before = { fix: fixes.get(key), machine: cache.get(key) };
    if (!fixes.has(key)) return { ok: false, error: 'There is no fix of yours for this entry.' };
    fixes.delete(key);
    this._writeFixes(dir);
    this._changed(dir);
    if (!cache.has(key)) await this.t.retranslate(key, dir).catch(() => null);
    this._changed(dir);
    this.log(`Dictionary: your fix for "${key.slice(0, 60)}" removed.`);
    return { ok: true, entry: this._entry(dir, key), before, page: this._pageUpdate(dir, key) };
  }

  /** Asks the translation service again (your fix, if any, stays in use). */
  async retranslate(opts) {
    const dir = opts.dir === 'en-ru' ? 'en-ru' : 'ru-en';
    const key = String(opts.key == null ? '' : opts.key);
    const { cache, fixes } = this._files(dir);
    const before = { fix: fixes.get(key), machine: cache.get(key) };
    const tr = await this.t.retranslate(key, dir).catch(() => null);
    if (tr == null) return { ok: false, error: 'The translation service did not answer. Try again in a moment.' };
    this._changed(dir);
    return { ok: true, entry: this._entry(dir, key), before, page: this._pageUpdate(dir, key) };
  }

  /** Forgets an entry completely (machine translation and your fix). */
  remove(opts) {
    const dir = opts.dir === 'en-ru' ? 'en-ru' : 'ru-en';
    const key = String(opts.key == null ? '' : opts.key);
    const { cache, fixes } = this._files(dir);
    const before = { fix: fixes.get(key), machine: cache.get(key) };
    if (before.fix === undefined && before.machine === undefined) return { ok: false, error: 'This entry is no longer saved.' };
    cache.delete(key);
    if (fixes.delete(key)) this._writeFixes(dir);
    this._changed(dir);
    return { ok: true, before, page: dir === 'ru-en' ? (isTemplateKey(key) ? { refresh: true } : { forget: [key] }) : null };
  }

  /** The suggested game word for an entry: the text without quotes and punctuation around it. */
  static bareWord(s) {
    return String(s || '').trim().replace(/^[^A-Za-zА-Яа-яЁё0-9]+|[^A-Za-zА-Яа-яЁё0-9]+$/g, '');
  }

  async handle(body) {
    const op = body && body.op;
    try {
      if (op === 'list') return this.list(body);
      if (op === 'save') return this.save(body);
      if (op === 'put') return this.put(body);
      if (op === 'revert') return await this.revert(body);
      if (op === 'retranslate') return await this.retranslate(body);
      if (op === 'remove') return this.remove(body);
      if (op === 'words') return this.words(body);
      if (op === 'translateWord') return await this.translateWord(body);
      if (op === 'saveWord') return this.saveWord(body);
      if (op === 'removeWord') return this.removeWord(body);
      if (op === 'export') return this.exportFixes();
      if (op === 'import') return this.importFixes(body);
      return { ok: false, error: 'Unknown dictionary operation' };
    } catch (e) {
      this.log('Dictionary error: ' + e.message);
      return { ok: false, error: 'Something went wrong: ' + e.message };
    }
  }
}

module.exports = { Dictionary, looksUntranslated, toCyrillic, toLatin, swapLayout, distance, showMarkers, hideMarkers };
