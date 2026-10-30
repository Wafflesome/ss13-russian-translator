// Translation engines + batching queue + persistent cache.
'use strict';
const fs = require('fs');
const path = require('path');

const { EnglishPrep } = require('./english.js');
const translit = require('./translit.js');
const { Gender } = require('./gender.js');

const CYR = /[А-Яа-яЁё]/;
const TIDY_VERSION = 4; // raise when _tidyRu changes (4: the ghost's (СЛЕД) link is FOLLOW)

/** "&#39" and friends that the server left in its text (sometimes without the ";"). */
function decodeEntities(s) {
  if (!/&/.test(s)) return s;
  return s
    .replace(/&#(\d{2,5});?/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]{2,5});?/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;?/g, '"')
    .replace(/&apos;?/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;?/g, ' ')
    .replace(/&amp;/g, '&');
}
/**
 * Shouting: (nearly) all the Russian letters are capitals. Google reads words in capitals as names and
 * spells them out in Latin letters ("СУКА ВЕРНИ АЕГ" -> "CYKA VERNI AEG"), so such lines are translated in
 * small letters and the English is put back in capitals.
 */
function isShout(s) {
  const letters = String(s).match(/[А-Яа-яЁё]/g);
  if (!letters || letters.length < 4) return false;
  let up = 0;
  for (const c of letters) if (c !== c.toLowerCase()) up++;
  return up / letters.length >= 0.8 && /[А-ЯЁ]{3}/.test(s);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Does an English translation contain a game term the way the game names it? Every word of the term
 * counts ("Head of Personnel" is not "Head of Staff", "Chief Medical Officer" is not "Chief physician"),
 * and long words most of the way ("shadowling" is not "shadowmorph"). Endings may differ.
 */
const STOP = new Set(['of', 'the', 'and', 'for', 'with', 'a', 'an', 'to', 'in', 'on']);
function hasEnglishTerm(tr, term) {
  const t = String(tr || '').toLowerCase();
  for (const w0 of String(term).toLowerCase().split(/[\s'’.-]+/)) {
    const w = w0.replace(/[^a-z0-9&]/g, '');
    if (!w || STOP.has(w)) continue;
    const stem = w.length <= 4 ? w : w.slice(0, Math.max(4, Math.min(w.length - 1, 7)));
    if (!t.includes(stem)) return false;
  }
  return true;
}

// ------------------------------------------------------------------------------- game dictionaries
const WORD = /[A-Za-zА-Яа-яЁё0-9&'+-]+/g;
const fold = (w) => w.toLowerCase().replace(/ё/g, 'е');

/**
 * Whole-word phrase replacement (any capitals): "the blob is in medbay" -> "the блоб is in медбей".
 * Longest phrase wins. Much faster than one regular expression per phrase with thousands of phrases.
 */
class PhraseMap {
  constructor() {
    this.first = new Map(); // first word -> [{words, to}] (longest first)
    this.keys = new Set();
    this.unsorted = new Set();
    this.size = 0;
  }
  add(from, to) {
    const words = (String(from).match(WORD) || []).map(fold);
    if (!words.length || !to) return;
    const key = words.join(' ');
    if (this.keys.has(key)) return; // first one added wins
    this.keys.add(key);
    let list = this.first.get(words[0]);
    if (!list) this.first.set(words[0], (list = []));
    list.push({ words, to });
    if (list.length > 1) this.unsorted.add(list);
    this.size++;
  }
  _sort() {
    for (const list of this.unsorted) list.sort((a, b) => b.words.length - a.words.length);
    this.unsorted.clear();
  }
  /** Calls fn(match) for each phrase found: {start, end, to}. */
  find(text) {
    if (this.unsorted.size) this._sort();
    const toks = [];
    let m;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(text))) toks.push({ w: fold(m[0]), start: m.index, end: m.index + m[0].length });
    const found = [];
    for (let i = 0; i < toks.length; i++) {
      const list = this.first.get(toks[i].w);
      if (!list) continue;
      for (const e of list) {
        if (i + e.words.length > toks.length) continue;
        let ok = true;
        for (let k = 1; k < e.words.length && ok; k++) {
          // the words of a phrase must be separated by spaces only
          if (toks[i + k].w !== e.words[k] || !/^ +$/.test(text.slice(toks[i + k - 1].end, toks[i + k].start))) ok = false;
        }
        if (!ok) continue;
        found.push({ start: toks[i].start, end: toks[i + e.words.length - 1].end, to: e.to });
        i += e.words.length - 1;
        break;
      }
    }
    return found;
  }
  apply(text, found) {
    const f = found || this.find(text);
    if (!f.length) return text;
    let out = '';
    let pos = 0;
    for (const x of f) {
      const c0 = text[x.start];
      const src = text.slice(x.start, x.end);
      let to = c0 !== c0.toLowerCase() && x.to[0] === x.to[0].toLowerCase() ? x.to[0].toUpperCase() + x.to.slice(1) : x.to;
      // a shouted word stays shouted ("СУКА" -> "CYKA"), abbreviations as they are
      if (src.length >= 3 && src === src.toUpperCase() && /[А-ЯЁ]{3}/.test(src) && /[a-z]/.test(to) && !/[A-Z]{2}/.test(to)) to = to.toUpperCase();
      out += text.slice(pos, x.start) + to;
      pos = x.end;
    }
    return out + text.slice(pos);
  }
}

/**
 * The usual forms of a Russian noun (case and number), so "блобом", "блобы" and "блобов" are all
 * recognised. Returns [[form, plural]].
 */
function nounForms(word) {
  const w = fold(word);
  const out = [[w, false]];
  const add = (f, pl) => out.push([f, pl]);
  if (/[бвгджзклмнпрстфхцчшщ]$/.test(w)) {
    const y = /[гкхжчшщ]$/.test(w) ? 'и' : 'ы';
    ['а', 'у', 'ом', 'е'].forEach((e) => add(w + e, false));
    [y, 'ов', 'ам', 'ами', 'ах'].forEach((e) => add(w + e, true));
    if (/[жчшщц]$/.test(w)) {
      add(w + 'ем', false);
      add(w + 'ей', true);
    }
  } else if (/ь$/.test(w)) {
    const st = w.slice(0, -1);
    ['я', 'ю', 'ем', 'е', 'ью'].forEach((e) => add(st + e, false));
    ['и', 'ей', 'ям', 'ями', 'ях'].forEach((e) => add(st + e, true));
  } else if (/а$/.test(w)) {
    const st = w.slice(0, -1);
    const y = /[гкхжчшщ]$/.test(st) ? 'и' : 'ы';
    ['е', 'у', 'ой', 'ою'].forEach((e) => add(st + e, false));
    [y, 'ам', 'ами', 'ах'].forEach((e) => add(st + e, true));
  } else if (/я$/.test(w)) {
    const st = w.slice(0, -1);
    ['и', 'е', 'ю', 'ей'].forEach((e) => add(st + e, false));
    ['ям', 'ями', 'ях'].forEach((e) => add(st + e, true));
  } else if (/й$/.test(w)) {
    const st = w.slice(0, -1);
    ['я', 'ю', 'ем', 'е'].forEach((e) => add(st + e, false));
    ['и', 'ев', 'ям', 'ями', 'ях'].forEach((e) => add(st + e, true));
  }
  return out;
}
const MASS = /(?:steel|glass|plasma|metal|water|blood|gold|silver|iron|brass|wood|cloth|leather|ammo|juice|milk|beer|wine|vodka|coffee|tea|meat|cheese|fuel|oil|acid|charcoal|salt|sugar|flour|rice|plastic|uranium|diamond|titanium|bluespace|equipment|clothing|armor|armour|gear|food|ice|smoke|foam|gauze|tape|tobacco|ash|dust|goo|gel|cream|paint|ink|honey|soda|cola|rum|gin|whiskey|tequila|absinthe|venom|toxin|space lube|lube|cash|money)$/i;
/** A short fingerprint of a text (to notice that a dictionary file changed). */
function hashOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
const pluralWord = (en) => {
  if (/'s$|s$|x$|ch$|sh$/i.test(en) || MASS.test(en) || !/[a-z]$/i.test(en)) return en.replace(/'s$/, 's');
  if (/(?:kni|li|wi)fe$/i.test(en)) return en.slice(0, -2) + 'ves';
  if (/(?:lea|hal|wol|shel|thie)f$/i.test(en)) return en.slice(0, -1) + 'ves';
  if (/[^aeiou]y$/i.test(en)) return en.slice(0, -1) + 'ies';
  return en + 's';
};
/** "health analyzer" -> "health analyzers", "roll of gauze" -> "rolls of gauze". */
const pluralEn = (en) => {
  const m = /^(.*?\S)( (?:of|for|with|from) .*)$/i.exec(en);
  if (m) return pluralWord(m[1]) + m[2];
  return pluralWord(en);
};

/**
 * The case forms of a Russian name of several words: adjectives in front agree with the noun after them
 * ("мозговой червь" -> "мозгового червя", "мозговым червём", "мозговые черви"...); words after the
 * noun ("ящик для инструментов", "рапира капитана") stay as they are. Returns [[form, plural]].
 * Not every form is a real word; the unreal ones simply never match anything.
 */
const SIB = /[жшчщ]$/;
const VEL = /[гкх]$/;
function adjForms(w, gender, plural) {
  const st = w.slice(0, -2);
  const end = w.slice(-2);
  const soft = end === 'ий' || end === 'яя' || end === 'ее' || end === 'ие';
  const i = soft || VEL.test(st) || SIB.test(st) ? 'и' : 'ы'; // ые/ие, ым/им, ыми/ими
  const softE = soft && !VEL.test(st); // его/ему/ем (синий, свежий)
  const o = softE ? 'е' : 'о';
  if (plural) return [[st + i + 'е'], [st + i + 'х'], [st + i + 'м'], [st + i + 'е', st + i + 'х'], [st + i + 'ми'], [st + i + 'х']];
  if (gender === 'f') {
    const sfx = softE || SIB.test(st) ? ['ей', 'юю'] : ['ой', 'ую'];
    const nom = soft ? st + 'яя' : st + 'ая';
    return [[nom], [st + sfx[0], st + 'ой'], [st + sfx[0], st + 'ой'], [st + sfx[1], st + 'ую'], [st + sfx[0], st + 'ой', st + 'ою'], [st + sfx[0], st + 'ой']];
  }
  const nomM = end === 'ой' || end === 'ый' || end === 'ий' ? w : st + (soft ? 'ий' : i === 'и' ? 'ий' : 'ый');
  const nom = gender === 'n' ? st + (softE ? 'ее' : 'ое') : nomM;
  return [[nom], [st + o + 'го'], [st + o + 'му'], [nom, st + o + 'го'], [st + i + 'м'], [st + o + 'м']];
}
function nounCases(w, gender, plural) {
  // [nom, gen, dat, acc, ins, prep], each a list
  if (plural) {
    const st = w.replace(/[ыиа]$/, '');
    return [[w], [st + 'ов', st + 'ей', st, st + 'ев'], [st + 'ам', st + 'ям'], [w, st + 'ов', st + 'ей', st], [st + 'ами', st + 'ями'], [st + 'ах', st + 'ях']];
  }
  const st = w.slice(0, -1);
  const last = w.slice(-1);
  if (/[бвгджзклмнпрстфхцчшщ]/.test(last)) {
    const stems = [w];
    if (/[^аеёиоуыэюя](?:о|е|ё)[кц]$/.test(w) && w.length > 4) stems.push(w.slice(0, -2) + w.slice(-1)); // молоток -> молотка
    const f = (e) => stems.map((x) => x + e);
    return [[w], f('а'), f('у'), [w, ...f('а')], [...f('ом'), ...f('ем')], f('е')];
  }
  if (last === 'й') return [[w], [st + 'я'], [st + 'ю'], [w, st + 'я'], [st + 'ем'], [st + 'е', st + 'и']];
  if (last === 'ь' && gender !== 'f') return [[w], [st + 'я'], [st + 'ю'], [w, st + 'я'], [st + 'ем', st + 'ём'], [st + 'е']];
  if (last === 'ь') return [[w], [st + 'и'], [st + 'и'], [w], [w + 'ю'], [st + 'и']];
  if (last === 'а') {
    const y = VEL.test(st) || SIB.test(st) ? 'и' : 'ы';
    return [[w], [st + y], [st + 'е'], [st + 'у'], [st + 'ой', st + 'ей', st + 'ою'], [st + 'е']];
  }
  if (last === 'я') {
    const ii = /и$/.test(st);
    return [[w], [st + 'и'], [st + (ii ? 'и' : 'е')], [st + 'ю'], [st + 'ей'], [st + (ii ? 'и' : 'е')]];
  }
  if (last === 'о') return [[w], [st + 'а'], [st + 'у'], [w], [st + 'ом'], [st + 'е']];
  if (last === 'е') return [[w], [st + 'я'], [st + 'ю'], [w], [st + 'ем'], [st + (/и$/.test(st) ? 'и' : 'е')]];
  return [[w], [w], [w], [w], [w], [w]];
}
function nounPlural(w, gender) {
  const st = w.slice(0, -1);
  const last = w.slice(-1);
  if (/[бвгджзклмнпрстфхцчшщ]/.test(last)) {
    const bases = [w];
    if (/[^аеёиоуыэюя](?:о|е|ё)[кц]$/.test(w) && w.length > 4) bases.push(w.slice(0, -2) + w.slice(-1));
    const out = [[], [], [], [], [], []];
    for (const base of bases) {
      const y = VEL.test(base) || SIB.test(base) ? 'и' : 'ы';
      const gen = base + (SIB.test(base) || /ц$/.test(base) ? 'ей' : 'ов');
      out[0].push(base + y);
      out[1].push(gen);
      out[2].push(base + 'ам');
      out[3].push(base + y, gen);
      out[4].push(base + 'ами');
      out[5].push(base + 'ах');
    }
    return out;
  }
  if (last === 'й') return [[st + 'и'], [st + 'ев'], [st + 'ям'], [st + 'и', st + 'ев'], [st + 'ями'], [st + 'ях']];
  if (last === 'ь') return [[st + 'и'], [st + 'ей'], [st + 'ям'], [st + 'и', st + 'ей'], [st + 'ями'], [st + 'ях']];
  if (last === 'а') {
    const y = VEL.test(st) || SIB.test(st) ? 'и' : 'ы';
    return [[st + y], [st], [st + 'ам'], [st + y, st], [st + 'ами'], [st + 'ах']];
  }
  if (last === 'я') return [[st + 'и'], [st + 'ь', st + 'й'], [st + 'ям'], [st + 'и'], [st + 'ями'], [st + 'ях']];
  if (last === 'о') return [[st + 'а'], [st], [st + 'ам'], [st + 'а'], [st + 'ами'], [st + 'ах']];
  if (last === 'е') return [[st + 'я'], [st + 'ей', st + 'й'], [st + 'ям'], [st + 'я'], [st + 'ями'], [st + 'ях']];
  return null;
}
const ADJ = /^[а-яё-]{2,}(?:ый|ий|ой|ая|яя|ое|ее|ые|ие)$/;
function phraseForms(phrase) {
  const words = fold(phrase).split(/\s+/).filter(Boolean);
  const out = [[words.join(' '), false]];
  let k = 0;
  while (k < words.length && ADJ.test(words[k])) k++;
  if (k >= words.length) return out; // only adjectives: leave it
  const head = words[k];
  if (!/^[а-яё-]{3,}$/.test(head) || /(?:ть|ться|ти)$/.test(head) || k > 2) return out;
  const rest = words.slice(k + 1).join(' ');
  const adjs = words.slice(0, k);
  const a0 = adjs[0] || '';
  const adjPlural = /(?:ые|ие)$/.test(a0);
  let genders;
  if (a0) genders = [/(?:ая|яя)$/.test(a0) ? 'f' : /(?:ое|ее)$/.test(a0) ? 'n' : 'm'];
  else genders = /а$|я$/.test(head) ? ['f'] : /[ое]$/.test(head) ? ['n'] : /ь$/.test(head) ? ['m', 'f'] : ['m'];
  const plural0 = adjPlural || (!a0 && /[ыи]$/.test(head) && head.length > 4);
  const seen = new Set(out.map((x) => x[0]));
  const push = (f, pl) => {
    if (!seen.has(f)) {
      seen.add(f);
      out.push([f, pl]);
    }
  };
  for (const g of genders) {
    const sets = plural0 ? [[nounCases(head, g, true), true]] : [[nounCases(head, g, false), false]];
    if (!plural0) {
      const pl = nounPlural(head, g);
      if (pl) sets.push([pl, true]);
    }
    for (const [cases, pl] of sets) {
      for (let c = 0; c < 6; c++) {
        let combos = [''];
        for (const a of adjs) {
          const af = adjForms(a, g, pl)[c];
          const next = [];
          for (const pre of combos) for (const x of af) next.push(pre ? pre + ' ' + x : x);
          combos = next;
        }
        for (const pre of combos) for (const n of cases[c]) push([pre, n, rest].filter(Boolean).join(' '), pl);
      }
    }
  }
  return out;
}

class Translator {
  constructor(cfg, dataDir, cacheDir, log) {
    this.cfg = cfg;
    this.log = log;
    this.cacheFile = path.join(cacheDir, 'translations.json');
    this.ru2en = new Map();
    this.en2ru = new Map();
    this.names = new Map();
    this.myNames = new Map(); // your characters' names (data/my_names.json): Russian (folded) -> English
    this.glossary = { ru2en: [], en2ru: [] };
    // what you type is cleaned up first (src/english.js); game words and names it must leave as typed
    this.enPrep = new EnglishPrep(dataDir, (w, abbr) => this._enKnown(w, abbr));
    this.inflight = new Map(); // dir|text -> promise
    this.queues = { live: [], warm: [] };
    this.active = 0;
    this.pausedUntil = 0;
    this.dirty = false;
    this.stats = { engineCalls: 0, engineStrings: 0, cacheHits: 0, errors: 0 };
    // detailed logs (src/telemetry.js), set by the bridge; a stand-in that does nothing until then
    this.tm = { event() {}, count() {}, sample() {}, addSummary() {} };
    this.googleMode = 'batch';
    // Google has several free ways in; the website's ones translate noticeably better than the old one.
    // Each is tried in turn and switched off for a while if it stops answering properly.
    this.gHealth = { web: { fails: 0, offUntil: 0, used: false }, html: { fails: 0, offUntil: 0, used: false } };
    fs.mkdirSync(cacheDir, { recursive: true });
    this.dataDir = dataDir;
    this.overrides = new Map(); // your fixes for game text: Russian -> English (data/overrides.json)
    this.outOverrides = new Map(); // your fixes for what you type: English -> Russian (data/overrides_outgoing.json)
    this.cacheVersion = 0; // goes up whenever a translation is added or changed (the dictionary page uses it)
    this.corrKeys = new Set(); // saved translations checked by hand (data/corrections.json)
    this.selfWriteAt = 0; // when this program last wrote a fixes file itself (so the file watcher ignores it)
    this._loadJson(path.join(dataDir, 'names.json'), (obj) => {
      for (const k in obj) this.names.set(k, obj[k]);
    });
    this.reloadData();
    this._loadJson(this.cacheFile, (obj) => {
      for (const k in obj.ru2en || {}) this.ru2en.set(k, obj.ru2en[k]);
      for (const k in obj.en2ru || {}) this.en2ru.set(k, obj.en2ru[k]);
      this.cacheLexVersion = obj.lexVersion || '';
      this.cacheTidyVersion = obj.tidyVersion || 1;
      this.cacheCorrVersion = obj.correctionsVersion || '';
      // what you typed was translated with the older Google translator: translate it again (better sentences)
      // (version 3: chat English is cleaned up first, see src/english.js)
      if ((obj.engineVersion || 1) < 3) {
        this.en2ru.clear();
        this.dirty = true;
      }
    });
    this._cacheLoaded = true;
    this._applyCorrections();
    this._refreshCacheForLexicon();
    // Speech with stutters, hissing or an accent is now cleaned up better before translating: saved
    // translations of such lines are made again (in the background, a few seconds after the start).
    if ((this.cacheTidyVersion || 1) < TIDY_VERSION) {
      const tm = setTimeout(() => {
        let n = 0;
        for (const k of [...this.ru2en.keys()]) {
          if (this.overrides.has(k) || this.corrKeys.has(k)) continue;
          // cleaned-up speech, server text with "&#39", shouting (now translated in small letters)
          if (this._tidyRu(k) !== k || /&#?[a-z0-9]{2,6};?/i.test(k) || isShout(k) || /\((?:СЛЕД|ТЕЛО)/.test(k)) {
            this.ru2en.delete(k);
            n++;
          }
        }
        this.cacheTidyVersion = TIDY_VERSION;
        this.dirty = true;
        this.cacheVersion++;
        if (n) this.log(`${n} saved translations of stuttered, accented or shouted speech will be translated again (cleaned up first now).`);
      }, 4000);
      if (tm.unref) tm.unref();
    } else {
      const tw = setTimeout(() => this._ruWords(), 3000); // the word lists, ready before they are needed
      if (tw.unref) tw.unref();
    }
    this.log(`Loaded ${this.names.size} object names, ${this.lex.ru2en.size} game word forms (${this.lexMs} ms), ${this.overrides.size} fixed translations, ${this.ru2en.size} cached translations.`);
    setInterval(() => this.save(), 10000);
  }

  /** (Re)load the hand-editable data files: glossary.json and overrides.json. */
  reloadData() {
    const dataDir = this.dataDir;
    this.overrides = new Map();
    this._loadJson(path.join(dataDir, 'overrides.json'), (obj) => {
      for (const k in obj) if (!k.startsWith('_') && typeof obj[k] === 'string') this.overrides.set(k, obj[k]);
    });
    this.outOverrides = new Map();
    this._loadJson(path.join(dataDir, 'overrides_outgoing.json'), (obj) => {
      for (const k in obj) if (!k.startsWith('_') && typeof obj[k] === 'string') this.outOverrides.set(k, obj[k]);
    });
    this.cacheVersion++;
    this._loadLexicons();
    this.glossary = { ru2en: [], en2ru: [] };
    this._loadJson(path.join(dataDir, 'glossary.json'), (obj) => {
      for (const dir of ['ru2en', 'en2ru']) {
        const list = Object.entries(obj[dir] || {}).sort((a, b) => b[0].length - a[0].length);
        // abbreviations written in capitals also match other capitals ("Сб" is "СБ"), except a few that
        // are ordinary words in small letters (км = km, см = cm, мг = mg, дм = dm)
        // ... and slang written in small letters also at the start of a sentence ("Техи", "Ассистуха")
        const anyCase = (f) => dir === 'en2ru' || (/^[А-ЯЁ]{2,4}$/.test(f) && !/^(КМ|СМ|МГ|ДМ|ПГ|ОК|ТП|СЛЕД|ТЕЛО|КА)$/.test(f)) || /^[а-яё][а-яё -]*$/.test(f);
        this.glossary[dir] = list.map(([from, to]) => ({
          re: new RegExp('(^|[^А-Яа-яЁёA-Za-z0-9])(' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?=$|[^А-Яа-яЁёA-Za-z0-9])', anyCase(from) ? 'gi' : 'g'),
          to,
        }));
      }
    });
    // a changed glossary also renews saved translations it now applies to (see _refreshCacheForLexicon)
    this.lexVersion = (this.lexVersion || '') + ':g' + hashOf(JSON.stringify(this.glossary.ru2en.map((g) => [g.re.source, g.to])));
    this._loadCorrections();
    if (this._cacheLoaded) this._applyCorrections();
    if (this.ru2en) this._refreshCacheForLexicon();
  }

  /**
   * Game words, most trusted first (for the same phrase the first one wins):
   *   lexicon_game.json  - hand-made (antagonists, species, jobs, places), names as the SS220 wiki uses them
   *   names.json / names_en_ru.json - object names from the server's source code (what the game shows)
   *   wiki_offline.json  - item, chemical, drink and role names taken from the SS220 wiki pages (bundled)
   *   wiki_lexicon.json  - the same, built from the live wiki (control panel, every two weeks)
   * Russian names are recognised in every case form ("мозговым червём", "анализатором здоровья").
   */
  _loadLexicons() {
    const t0 = Date.now();
    const ru2en = new PhraseMap();
    const en2ru = new PhraseMap();
    const exact = new Map(); // whole text (folded) -> English
    const addRu = (ru, en, mine) => {
      if (!ru || !en) return;
      if (!mine && !ru.trim().includes(' ') && /(?:ать|ять|ить|уть|ыть|ться)$/i.test(ru.trim())) return; // verbs: the translator knows them better
      const forms = ru.trim().includes(' ') ? phraseForms(ru) : nounForms(ru);
      for (const [f, pl] of forms) ru2en.add(f, pl ? pluralEn(en) : en);
      if (!exact.has(fold(ru.trim()))) exact.set(fold(ru.trim()), en);
    };
    let game = {};
    this._loadJson(path.join(this.dataDir, 'lexicon_game.json'), (o) => (game = o));
    // words you taught on the Dictionary page come first, so they win over everything else
    for (const k in game._yours || {}) {
      const side = k.slice(0, 5);
      const w = k.slice(6);
      const v = game[side] && game[side][w];
      if (typeof v !== 'string' || !v) continue;
      if (side === 'ru2en') addRu(w, v, true);
      else if (side === 'en2ru') en2ru.add(w, v);
    }
    for (const [ru, en] of Object.entries(game.ru2en || {})) if (!ru.startsWith('_')) addRu(ru, en);
    // your characters' names, written in the other alphabet ("Иван Петров" <-> "Ivan Petrov")
    let mine = {};
    this._loadJson(path.join(this.dataDir, 'my_names.json'), (o) => (mine = o));
    this.myNames = new Map();
    for (const [ru, en] of Object.entries(mine)) {
      if (ru.startsWith('_') || typeof en !== 'string' || !en) continue;
      this.myNames.set(fold(ru.trim()), en);
      addRu(ru, en, true);
      en2ru.add(en, ru);
    }
    // whole chat lines the translation services get wrong ("Пошли." is "Let's go.", not "Went.")
    let phrases = {};
    this._loadJson(path.join(this.dataDir, 'phrases.json'), (o) => (phrases = o));
    const phraseMap = new Map();
    // ("А?" is "Huh?" but "А." is "Ah.": a phrase written with its question mark is kept apart too)
    for (const [ru, en] of Object.entries(phrases.ru2en || {})) {
      if (ru.startsWith('_') || !en) continue;
      const bare = fold(ru.replace(/[.!?…]+$/, ''));
      if (bare !== fold(ru)) phraseMap.set(fold(ru), en);
      if (bare === fold(ru) || !phraseMap.has(bare)) phraseMap.set(bare, en);
    }
    // and short English chat replies that are slang through and through ("rip", "gg", "lol")
    this.enPhrases = new Map();
    for (const [en, ru] of Object.entries(phrases.en2ru || {})) if (!en.startsWith('_') && ru) this.enPhrases.set(en.toLowerCase().replace(/[.!?…]+$/, '').trim(), ru);
    // chat slang and swearing that translation services spell out in Latin letters ("Херасебе" -> "Herasebe")
    let slang = {};
    this._loadJson(path.join(this.dataDir, 'slang.json'), (o) => (slang = o));
    for (const [ru, en] of Object.entries(slang.ru2en || {})) {
      if (ru.startsWith('_') || !en) continue;
      ru2en.add(ru, en);
      if (!exact.has(fold(ru))) exact.set(fold(ru), en);
    }
    for (const [en, ru] of Object.entries(game.en2ru || {})) if (!en.startsWith('_')) en2ru.add(en, ru);
    // object names from the source: every case form of names of two or more words
    for (const [ru, en] of this.names) if (ru.includes(' ')) ru2en.add(ru, en);
    let nom = {};
    this._loadJson(path.join(this.dataDir, 'names_en_ru.json'), (o) => (nom = o));
    for (const [en, ru] of Object.entries(nom)) if (en.includes(' ') && en.length >= 6) en2ru.add(en, ru);
    // the SS220 wiki, as downloaded with the mod
    let off = {};
    this._loadJson(path.join(this.dataDir, 'wiki_offline.json'), (o) => (off = o));
    let offUsed = 0;
    for (const [ru, en] of Object.entries(off.ru2en || {})) {
      if (ru.startsWith('_')) continue;
      addRu(ru, en);
      offUsed++;
    }
    for (const [en, ru] of Object.entries(off.en2ru || {})) if (!en.startsWith('_')) en2ru.add(en, ru);
    // the live wiki: page names (redirects) and item tables are reliable; words picked from running text
    // only serve the Russian->English side, and single words only when they are a page's own name
    let wiki = { pairs: [] };
    this._loadJson(path.join(this.dataDir, 'wiki_lexicon.json'), (o) => (wiki = o));
    let wikiUsed = 0;
    const redirectPick = this._wikiRedirectPick(wiki.pairs || []);
    // a page many names lead to (Nanotrasen: "АБОТЧ", "ИСН Кибериада", "Селестия" ...): only names that sound
    // like the page's own name are used
    const hubCount = new Map();
    for (const p of wiki.pairs || []) if (p.src === 'redirect') hubCount.set(p.en, (hubCount.get(p.en) || 0) + 1);
    const latin1 = (w) => w.toLowerCase().replace(/[а-яё]/g, (c) => ({ а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'z', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', ш: 's', щ: 's', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'u', я: 'a' })[c]);
    const redirectHub = (p) => (hubCount.get(p.en) || 0) >= 4 && !p.ru.split(/\s+/).some((w) => latin1(w).slice(0, 3) === p.en.toLowerCase().slice(0, 3));
    const dropped = []; // wiki page names no longer used (saved translations made with them are made again)
    for (const p of wiki.pairs || []) {
      // page addresses that slipped in as names ("Index.php/Job Selection and Assignment")
      if (/\.php|[\/\\]/i.test(p.en)) {
        dropped.push([p.ru.toLowerCase(), p.en]);
        continue;
      }
      const ruWords = p.ru.split(' ').length;
      const enWords = p.en.split(' ').length;
      if (p.src === 'redirect' && ruWords >= 2 && redirectHub(p)) {
        dropped.push([p.ru.toLowerCase(), p.en]);
        continue;
      }
      if (p.src === 'redirect' && ruWords === 1) {
        const pick = redirectPick.get(p.ru.toLowerCase());
        if (pick !== p.en) {
          if (p.ru.length >= 5) dropped.push([p.ru.toLowerCase(), p.en]);
          continue;
        }
      }
      if (ruWords >= 2 || (p.src === 'redirect' && p.ru.length >= 5)) {
        addRu(p.ru, p.en);
        wikiUsed++;
      }
      if (p.src !== 'text' && enWords >= 2 && ruWords >= 1) en2ru.add(p.en, p.ru);
    }
    this._droppedRedirects = dropped;
    this.lex = { ru2en, en2ru, exact, phrases: phraseMap, wikiPairs: (wiki.pairs || []).length, wikiUsed, wikiBuilt: wiki.built || null, offline: offUsed };
    this.lexVersion = [hashOf(JSON.stringify([game, slang, phrases, mine])), wiki.built || '', (wiki.pairs || []).length, Object.keys(nom).length, Object.keys(off.ru2en || {}).length, Object.keys(off.en2ru || {}).length, 5].join(':');
    this.lexMs = Date.now() - t0;
  }

  /**
   * One-word wiki page names that redirect to an English page are only trusted when they clearly name that
   * thing: not when one word leads to several pages ("Кухня" -> Kitchen / Freezer, unless one is just
   * part of the others: "Шахтёр" -> Miner / Shaft Miner gives Miner), not nicknames of a page with many
   * ("Керберос", "Кибериада" -> Nanotrasen) and not everyday words ("Человек" -> Humans).
   * Returns Russian (small letters) -> the English to use.
   */
  _wikiRedirectPick(pairs) {
    const byRu = new Map();
    const byEn = new Map();
    for (const p of pairs) {
      if (p.src !== 'redirect' || p.ru.includes(' ')) continue;
      const ru = p.ru.toLowerCase();
      if (!byRu.has(ru)) byRu.set(ru, new Set());
      byRu.get(ru).add(p.en);
      if (!byEn.has(p.en)) byEn.set(p.en, new Set());
      byEn.get(p.en).add(ru);
    }
    let common = new Set();
    try {
      const txt = fs.readFileSync(path.join(this.dataDir, 'russian_words.txt'), 'utf8');
      let at = 0;
      for (let i = 0; i < 3000 && at < txt.length; i++) {
        let nl = txt.indexOf('\n', at);
        if (nl < 0) nl = txt.length;
        common.add(txt.slice(at, nl).trim());
        at = nl + 1;
      }
    } catch (e) {}
    const LAT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
    const latin = (w) => w.replace(/./g, (c) => (LAT[c] !== undefined ? LAT[c] : c));
    const out = new Map();
    for (const [ru, ens] of byRu) {
      const list = [...ens].sort((a, b) => a.length - b.length);
      let en = list[0];
      if (list.length > 1 && !list.every((x) => x.toLowerCase().includes(en.toLowerCase()))) continue;
      if (byEn.get(en).size >= 3 && latin(ru).slice(0, 3) !== en.toLowerCase().slice(0, 3)) continue;
      if (common.has(ru)) continue;
      out.set(ru, en);
    }
    return out;
  }

  /**
   * Cached translations made before a game word was known are translated again - but only those
   * where the game word's translation is missing from the cached text ("blob" cached as "пятно").
   */
  _refreshCacheForLexicon() {
    if (!this.lex || this.cacheLexVersion === this.lexVersion) return;
    let dropped = 0;
    const stem = (s) => fold(String(s).split(/[\s-]+/)[0]).slice(0, Math.max(3, Math.min(5, String(s).split(/[\s-]+/)[0].length - 2)));
    for (const [src, tr] of this.en2ru) {
      const f = this.lex.en2ru.find(src);
      if (f.some((x) => !fold(tr).includes(stem(x.to)))) {
        this.en2ru.delete(src);
        dropped++;
      }
    }
    // made with a wiki page name that is no longer trusted ("человек" -> "Humans")
    const bad = (this._droppedRedirects || []).map(([ru, en]) => [fold(ru).slice(0, Math.max(4, ru.length - 2)), en]);
    for (const [src, tr] of this.ru2en) {
      if (this.overrides.has(src) || this.corrKeys.has(src)) continue;
      if (bad.length) {
        const fs2 = fold(src);
        if (bad.some(([stem, en]) => fs2.includes(stem) && tr.includes(en))) {
          this.ru2en.delete(src);
          dropped++;
          continue;
        }
      }
      const f = this.lex.ru2en.find(src);
      if (f.some((x) => !/[А-Яа-яЁё]/.test(x.to) && !hasEnglishTerm(tr, x.to))) {
        this.ru2en.delete(src);
        dropped++;
        continue;
      }
      // slang and abbreviations from glossary.json ("СЕ" -> CE, "БМ" -> brig physician)
      for (const g of this.glossary.ru2en) {
        g.re.lastIndex = 0;
        if (g.re.test(src) && !/[А-Яа-яЁё]/.test(g.to) && !hasEnglishTerm(tr, g.to)) {
          this.ru2en.delete(src);
          dropped++;
          break;
        }
      }
    }
    this.cacheLexVersion = this.lexVersion;
    this.dirty = true;
    this.cacheVersion++;
    if (dropped) this.log(`Game dictionary updated: ${dropped} saved translations that got a game word wrong will be translated again.`);
  }

  /**
   * data/corrections.json: hand-checked fixes for saved translations (see the file's own help text).
   *   set       - Russian (as saved, numbers as 701, 702 ...) -> the right English
   *   prefix    - the start of a long Russian text -> the right English
   *   delete    - saved translations to drop (they are translated again when they show up)
   *   purgeOnce - [Russian pattern, English pattern]: saved translations matching both are dropped, once
   *   replace   - [English pattern, replacement]: applied to every saved and new translation (names spelled one way)
   *   replaceWhere - [Russian pattern, English pattern, replacement]: the same, only for matching Russian texts
   */
  _loadCorrections() {
    const rx = (p, extra = '') => {
      let f = extra;
      if (p.startsWith('(?i)')) {
        p = p.slice(4);
        f += 'i';
      }
      try {
        return new RegExp(p, f);
      } catch (e) {
        this.log(`corrections.json: bad pattern ${p}: ${e.message}`);
        return null;
      }
    };
    const c = { set: new Map(), prefix: [], del: [], delEn: [], purge: [], rep: [], repWhere: [], version: '' };
    this._loadJson(path.join(this.dataDir, 'corrections.json'), (o) => {
      for (const k in o.set || {}) if (!k.startsWith('_') && typeof o.set[k] === 'string') c.set.set(k, o.set[k]);
      for (const k in o.prefix || {}) if (typeof o.prefix[k] === 'string' && k.length >= 20) c.prefix.push([k, o.prefix[k]]);
      for (const k of o.delete || []) if (typeof k === 'string') c.del.push(k);
      c.delEn = (o.deleteTyped || []).filter((k) => typeof k === 'string');
      for (const [a, b] of o.purgeOnce || []) {
        const ra = rx(a);
        const rb = b ? rx(b) : null;
        if (ra && (rb || !b)) c.purge.push([ra, rb]);
      }
      for (const [a, b] of o.replace || []) {
        const ra = rx(a, 'g');
        if (ra) c.rep.push([ra, b]);
      }
      for (const [w, a, b] of o.replaceWhere || []) {
        const rw = rx(w);
        const ra = rx(a, 'g');
        if (rw && ra) c.repWhere.push([rw, ra, b]);
      }
      c.version = hashOf(JSON.stringify([o.delete || [], o.purgeOnce || [], o.deleteTyped || []]));
      c.rulesHash = hashOf(JSON.stringify([o.replace || [], o.replaceWhere || [], Object.keys(o.set || {}).length]));
    });
    this.corr = c;
    this.corrKeys = new Set(c.set.keys());
  }

  /** The "replace" fixes of corrections.json for one translation (src: the Russian it came from). */
  _postFix(src, tr) {
    const c = this.corr;
    if (!c || typeof tr !== 'string') return tr;
    let out = tr;
    for (const [re, to] of c.rep) {
      re.lastIndex = 0;
      out = out.replace(re, to);
    }
    for (const [where, re, to] of c.repWhere) {
      if (!where.test(src)) continue;
      re.lastIndex = 0;
      out = out.replace(re, to);
    }
    return out;
  }

  /** Puts corrections.json into the saved translations (at the start, and when the file changes). */
  _applyCorrections() {
    const c = this.corr;
    if (!c) return;
    let fixed = 0;
    let dropped = 0;
    const once = (this.cacheCorrVersion || '') !== c.version;
    // the replace rules only need running over every saved translation when they changed (new
    // translations get them as they come in); reloading for another file (your name, a dictionary fix)
    // then takes a few milliseconds instead of half a second
    const rules = once || this._corrRulesDone !== c.rulesHash;
    for (const [src, tr] of rules ? [...this.ru2en] : []) {
      if (this.overrides.has(src)) continue;
      if (once && !c.set.has(src)) {
        if (c.purge.some(([a, b]) => a.test(src) && (!b || b.test(tr)))) {
          this.ru2en.delete(src);
          dropped++;
          continue;
        }
      }
      if (c.set.has(src)) continue; // checked by hand: kept exactly as written
      const t2 = this._postFix(src, tr);
      if (t2 !== tr) {
        this.ru2en.set(src, t2);
        fixed++;
      }
    }
    this._corrRulesDone = c.rulesHash;
    if (once) {
      for (const k of c.del) if (!c.set.has(k) && this.ru2en.delete(k)) dropped++;
      for (const k of c.delEn) if (this.en2ru.delete(k)) dropped++;
      this.cacheCorrVersion = c.version;
    }
    for (const [k, v] of c.set) {
      if (this.ru2en.get(k) !== v) {
        this.ru2en.set(k, v);
        fixed++;
      }
    }
    if (c.prefix.length) {
      for (const k of this.ru2en.keys()) {
        if (c.set.has(k)) continue;
        const hit = c.prefix.find(([p]) => k.startsWith(p));
        if (hit && this.ru2en.get(k) !== hit[1]) {
          this.ru2en.set(k, hit[1]);
          this.corrKeys.add(k);
          fixed++;
        }
      }
    }
    if (fixed || dropped) {
      this.dirty = true;
      this.cacheVersion++;
      this.log(`Checked translations (corrections.json): ${fixed} saved translations fixed${dropped ? `, ${dropped} will be translated again` : ''}.`);
    }
  }

  /**
   * Russian phrasings the translation service turns around, written the way it understands them:
   * "Иван прошибает лазером в грудь!" (Ivan is hit) reads as "Ivan shoots a laser", "Иван схватил Олега!"
   * becomes "captured by Oleg", the game's verb forms "кива%(ет,ют)%" and the text-to-speech stress marks
   * ("Ид+и") confuse it.
   */
  _rewriteRu(t) {
    if (!t) return t;
    t = t.replace(/%\(([^,()%]*),[^()%]*\)%/g, '$1');
    t = t.replace(/(^|[\sА-Яа-яЁё"«(])\+(?=[А-Яа-яЁё])/g, '$1');
    t = t.replace(/^(.+?) прошибает (.+) в ([^!]+)!$/, '$1 поражён $2 в $3!');
    t = t.replace(/^(.+?) схватил[аио]? (.+)!$/, '$1 хватает $2!');
    return t;
  }

  _loadJson(file, fn) {
    try {
      if (fs.existsSync(file)) fn(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      this.log(`Could not read ${file}: ${e.message}`);
    }
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      let ru2en = [...this.ru2en];
      const max = this.cfg.maxCacheEntries || 300000;
      if (ru2en.length > max) ru2en = ru2en.slice(ru2en.length - max);
      const tmp = this.cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ lexVersion: this.cacheLexVersion || '', engineVersion: 3, tidyVersion: this.cacheTidyVersion || 1, correctionsVersion: this.cacheCorrVersion || '', ru2en: Object.fromEntries(ru2en), en2ru: Object.fromEntries(this.en2ru) }));
      fs.renameSync(tmp, this.cacheFile);
    } catch (e) {
      this.log('Cache save failed: ' + e.message);
    }
  }

  // ---------------------------------------------------------------- public API
  /** Russian -> English for many strings. Returns {text: english}. */
  async toEnglish(texts, priority = 'live') {
    const out = {};
    await Promise.all(
      texts.map(async (t) => {
        try {
          out[t] = await this._one(t, 'ru-en', priority);
        } catch (e) {
          out[t] = null;
        }
      })
    );
    return out;
  }

  /**
   * Asks the translation service again for one saved text, ignoring the saved translation (your fix,
   * if any, stays). Saved texts with numbers use markers (701 ...). Returns the new translation or null.
   */
  async retranslate(key, dir) {
    let tr = await this._engine(key, dir === 'en-ru' ? 'en-ru' : 'ru-en', 'live');
    if (tr == null) return null;
    if (dir !== 'en-ru') tr = this._postFix(key, tr);
    (dir === 'en-ru' ? this.en2ru : this.ru2en).set(key, tr);
    this.dirty = true;
    this.cacheVersion++;
    return tr;
  }

  /**
   * A name you typed for your character (or a pet, a borg ...): written in Russian letters, not translated
   * by meaning ("John Smith" -> "Джон Смит", not "Джон Кузнец"). Remembered, so the game shows
   * it back to you as you wrote it.
   */
  nameToRussian(en) {
    const t = String(en || '').trim().replace(/\s+/g, ' ');
    if (!t) return t;
    const ru = translit.enToRu(t);
    this.rememberMyName(ru, t);
    return ru;
  }
  /** A name you typed in Russian: shown to you in Latin letters ("Иван Петров" -> "Ivan Petrov"). */
  nameFromRussian(ru) {
    const t = String(ru || '').trim().replace(/\s+/g, ' ');
    if (!CYR.test(t) || t.length > 60) return;
    if (this.myNames.has(fold(t))) return;
    this.rememberMyName(t, translit.ruToEn(t));
  }
  rememberMyName(ru, en) {
    if (!ru || !en || this.myNames.get(fold(ru)) === en) return;
    const file = path.join(this.dataDir, 'my_names.json');
    let doc = { _help: 'Names you gave your characters (and pets, borgs ...) in the game: Russian -> how the game shows them to you. Added automatically when you type a name; edit or delete freely.' };
    this._loadJson(file, (o) => (doc = o));
    doc[ru] = en;
    try {
      this.selfWriteAt = Date.now();
      fs.writeFileSync(file, JSON.stringify(doc, null, 1));
      this.selfWriteAt = Date.now();
    } catch (e) {
      this.log('Could not save the name: ' + e.message);
    }
    this.log(`Your name "${ru}" is shown to you as "${en}" (data/my_names.json).`);
    // (after the answer has gone back to the game window)
    setTimeout(() => this.reloadData(), 0);
  }

  /** English -> Russian for one message. */
  async toRussian(text) {
    return this._one(text, 'en-ru', 'live');
  }

  lookupLocal(text) {
    const o = this.overrides.get(text);
    if (o !== undefined) return o;
    const mn = this.myNames.size ? this.myNames.get(fold(String(text).trim())) : undefined;
    if (mn !== undefined) return mn;
    if (this.lex && this.lex.phrases.size && text.length < 60) {
      const m = /^(.*?)([.!?…]*)$/.exec(this._tidyRu(text.trim()));
      // (a long scream "А-а-а-а-а" tidies down to "А", which is not the reply "А?")
      const scream = fold(m[1]).length <= 1 && text.replace(/[^А-Яа-яЁё]/g, '').length > 2;
      let x = scream ? undefined : this.lex.phrases.get(fold(m[1] + m[2].slice(0, 1)));
      if (x === undefined && !scream) x = this.lex.phrases.get(fold(m[1]));
      if (x !== undefined) {
        const out = (/^[А-ЯЁ]/.test(text.trim()) ? x.charAt(0).toUpperCase() + x.slice(1) : x) + (/[.!?…]$/.test(x) ? '' : m[2]);
        return isShout(text) && text.trim().length > 1 ? out.toUpperCase() : out;
      }
    }
    const r = this.ru2en.get(text);
    if (r !== undefined) return r;
    const n = this._nameLookup(text);
    if (n !== undefined) return n;
    if (this.lex) {
      // the whole text is a known word or chat phrase; the full stop / question mark is kept
      const m = /^(.*?)([.!?…]*)$/.exec(text.trim());
      let x = this.lex.exact.get(fold(text.trim()));
      let tail = '';
      if (x === undefined && m[2]) {
        x = this.lex.exact.get(fold(m[1]));
        if (x !== undefined && !/[.!?…]$/.test(x)) tail = m[2];
      }
      if (x !== undefined) {
        const out = (/^[А-ЯЁ]/.test(text.trim()) ? x.charAt(0).toUpperCase() + x.slice(1) : x) + tail;
        return out;
      }
    }
    if (/\d/.test(text)) {
      const { template, nums } = this._template(text);
      const fixed = this.overrides.get(template);
      if (fixed !== undefined) {
        const r = this._untemplate(fixed, nums);
        if (r != null) return r;
      }
      const t = this.ru2en.get(template);
      if (t !== undefined) return this._untemplate(t, nums);
    }
    return undefined;
  }

  /**
   * What you write about yourself in your character's gender (control panel: Play -> "Your character is").
   * "I'm so fat" -> "Я такой толстый" for a man, "Я такая толстая" for a woman. See gender.js.
   */
  myGender(en, ru) {
    const g = this.cfg.myGender;
    if ((g !== 'm' && g !== 'f') || typeof ru !== 'string') return ru;
    try {
      if (!this._gender) this._gender = new Gender(this._ruWords());
      return this._gender.fix(ru, en, g);
    } catch (e) {
      return ru;
    }
  }

  /** Your own fix for what you type, if there is one (exact text, or the same text in other capitals). */
  outgoingFix(text) {
    const t = String(text || '').trim();
    if (!t || !this.outOverrides.size) return undefined;
    const o = this.outOverrides.get(t);
    if (o !== undefined) return o;
    const low = t.toLowerCase();
    for (const [k, v] of this.outOverrides) if (k.toLowerCase() === low) return v;
    return undefined;
  }

  // ---------------------------------------------------------------- internals
  _nameLookup(text) {
    const en = this.names.get(text.toLowerCase());
    if (en === undefined) return undefined;
    return /^[А-ЯЁ]/.test(text) ? en.charAt(0).toUpperCase() + en.slice(1) : en;
  }

  // Numbers are replaced with stable markers so "Осталось 12 сек" and "Осталось 11 сек" share one translation.
  _template(text) {
    const nums = [];
    const template = text.replace(/\d+(?:[.,]\d+)?/g, (m) => {
      nums.push(m);
      return String(701 + nums.length - 1);
    });
    return { template, nums };
  }
  _untemplate(tr, nums) {
    let ok = true;
    const used = new Set();
    const res = tr.replace(/(?<!\d)7(\d\d)(?!\d)/g, (m, d) => {
      const i = parseInt(d, 10) - 1;
      if (i >= 0 && i < nums.length) {
        used.add(i);
        return nums[i];
      }
      ok = false;
      return m;
    });
    // Every number must come back exactly once, otherwise translate the literal text.
    return ok && used.size === nums.length ? res : null;
  }

  /**
   * Speech quirks the game adds make machine translation stumble: a lizard's hiss ("ссссказал"), a
   * cat's or fox's purr ("пррррошу"), shouting ("аааа"), a stutter ("П-п-привет"). They are tidied away
   * before translating; the meaning is what matters in English.
   */
  _tidyRu(text) {
    // old spelling some characters use ("Инжѣнѣръ, тамъ уранъ" = "Инженер, там уран"): today's letters
    if (/[ѣѢіІѳѲѵѴ]|[ъЪ](?![А-Яа-яЁё])|Iи/.test(text)) {
      text = text
        .replace(/ѣ/g, 'е').replace(/Ѣ/g, 'Е').replace(/і/g, 'и').replace(/І/g, 'И')
        .replace(/ѳ/g, 'ф').replace(/Ѳ/g, 'Ф').replace(/ѵ/g, 'и').replace(/Ѵ/g, 'И')
        .replace(/([бвгджзклмнпрстфхцчшщБВГДЖЗКЛМНПРСТФХЦЧШЩ])[ъЪ](?![А-Яа-яЁё])/g, '$1')
        .replace(/(^|[^A-Za-z])Iи(?=[^А-Яа-яЁё]|$)/g, '$1И');
    }
    // stretched letters ("Зрррря", "ссссказал") once; but a scream or laugh made of one or two letters
    // ("ААААА", "ахахаха") stays as it is
    let t = text.replace(/[А-Яа-яЁё]+/g, (w) => (new Set(w.toLowerCase()).size <= 2 ? w : w.replace(/([А-Яа-яЁё])\1{2,}/g, '$1')));
    t = t.replace(/(р)\1/gi, '$1');
    // a hissing speaker doubles every "с" ("ссобралссся"): when there are "ссс" in the text, "сс" is one "с"
    if (/с{3,}/i.test(text)) t = t.replace(/(с)\1+/gi, '$1');
    for (let i = 0; i < 4; i++) {
      // "П-привет" -> "Привет" (but "то-то", "ну-ну" are words of their own)
      const next = t.replace(/(^|[^А-Яа-яЁё])([А-Яа-яЁё]{1,2})-(\2)(?=[А-Яа-яЁё-])/gi, (m, pre, s1, s2) =>
        pre + (s1[0] !== s1[0].toLowerCase() ? s2[0].toUpperCase() + s2.slice(1) : s2)
      );
      if (next === t) break;
      t = next;
    }
    // stutters inside words: "п-пер-р-рч-ч-чат-тках-х" -> "перчатках", "тог-гд-да" -> "тогда"
    // (only from a stuttering speaker; "мини-игры", "ДНК-код", "из-за" are real words)
    const stutterer = /(?:^|[^А-Яа-яЁё])([А-Яа-яЁё]{1,2})-\1/i.test(text) || /[А-Яа-яЁё]+-[А-Яа-яЁё]+-[А-Яа-яЁё]+-/.test(text);
    if (stutterer) t = t.replace(/[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)+/g, (w) => {
      if (/^(?:из-за|еле-еле|по-о|во-о)/i.test(w)) return w;
      let x = w;
      for (let i = 0; i < 12; i++) {
        const y = x.replace(/([А-Яа-яЁё])-(\1)/i, '$1');
        if (y === x) break;
        x = y;
      }
      return x;
    });
    return this._fixAccent(t);
  }

  /**
   * Species accents and lisps change letters ("Щмотрю" = "смотрю", "Фто" = "что", "ефть" = "есть",
   * "умеешшь" = "умеешь"). A word that isn't Russian is tried with the usual swaps; when one gives a
   * common Russian word, that word is used (names and unknown words stay as they are).
   */
  _ruWords() {
    if (this._ruw !== undefined) return this._ruw;
    this._ruw = null;
    try {
      // common words (ranked: the first is the most frequent), and rarer real words that only tell
      // "this is a real word, leave it alone"
      const m = new Map();
      fs.readFileSync(path.join(this.dataDir, 'russian_words.txt'), 'utf8').split(/\r?\n/).forEach((w, i) => {
        if (w && !m.has(w)) m.set(w, i);
      });
      try {
        for (const w of fs.readFileSync(path.join(this.dataDir, 'russian_known.txt'), 'utf8').split(/\r?\n/)) if (w && !m.has(w)) m.set(w, 1e9);
      } catch (e) {}
      this._ruw = m;
    } catch (e) {}
    return this._ruw;
  }
  _fixAccent(text) {
    if (this.cfg.fixAccents === false) return text;
    const words = this._ruWords();
    if (!words) return text;
    const ruWords = text.match(/[А-Яа-яЁё]+/g) || [];
    // a lone capitalised word without a full stop is a name or a label, not speech
    if (ruWords.length < 2 && !(/[.!?…]\s*$/.test(text) || /^[а-яё]/.test(ruWords[0] || ''))) return text;
    const SWAPS = [[], [['щ', 'с']], [['ш', 'с']], [['ф', 'с']], [['щ', 'ч']], [['ф', 'ч']], [['щ', 'с'], ['ш', 'с']], [['ф', 'с'], ['щ', 'с']], [['ж', 'з']], [['ш', 'ж']], [['щ', 'з']], [['ш', 'з']]];
    const game = this.lex ? this.lex.ru2en : null;
    return text.replace(/[А-Яа-яЁё]{3,}/g, (w, at) => {
      const lw = w.toLowerCase().replace(/ё/g, 'е');
      if (words.has(lw) || words.has(w.toLowerCase())) return w;
      if (!/[щшфж]|([бвгджзйклмнпрстфхцчшщ])\1/.test(lw)) return w;
      // part of something else: an alien word (Та'гх), a stress mark (шокол+ад), a compound
      const prev = text[at - 1] || '';
      const next = text[at + w.length] || '';
      if (/['’+\-]/.test(prev) || /['’+\-]/.test(next)) return w;
      // a capitalised word inside a sentence is probably a name; game words stay
      const before = text.slice(0, at);
      if (/^[А-ЯЁ]/.test(w) && /[А-Яа-яЁё,]\s*$/.test(before)) return w;
      if (game && game.first.has(lw)) return w;
      let best = null;
      for (const base of [lw, lw.replace(/([бвгджзйклмнпрстфхцчшщ])\1+/g, '$1')]) {
        for (const sw of SWAPS) {
          let c = base;
          for (const [a, b] of sw) c = c.split(a).join(b);
          if (c === lw || c.length < 3 || c.length < lw.length * 0.6) continue;
          const r = words.get(c);
          if (r !== undefined && r < 60000 && (!best || r < best.r)) best = { c, r };
        }
      }
      if (!best) return w;
      const c = best.c;
      if (w === w.toUpperCase()) return c.toUpperCase();
      if (/^[А-ЯЁ]/.test(w)) return c[0].toUpperCase() + c.slice(1);
      return c;
    });
  }

  _applyGlossary(text, dir) {
    text = this._applyJargon(text, dir);
    if (this.lex) text = (dir === 'ru-en' ? this.lex.ru2en : this.lex.en2ru).apply(text);
    return text;
  }
  /** Slang and abbreviations (data/glossary.json): always swapped, translation services don't know them. */
  _applyJargon(text, dir) {
    for (const g of this.glossary[dir === 'ru-en' ? 'ru2en' : 'en2ru']) {
      text = text.replace(g.re, (m, pre, w) => {
        // "Техи" at the start of a sentence -> "Maints"
        const cap = dir === 'ru-en' && /^[А-ЯЁ][а-яё]/.test(w) && /^[a-z]/.test(g.to);
        return pre + (cap ? g.to[0].toUpperCase() + g.to.slice(1) : g.to);
      });
    }
    return text;
  }
  /**
   * What is sent to the translation service for one text: the text itself (slang and abbreviations
   * swapped) and, when it has game words, a second version with the game words swapped too. Google
   * writes better sentences from clean text, so the game-word version is used only when Google gets a
   * game word wrong ("blob" -> "пятно").
   */
  _prepare(text, dir) {
    if (dir === 'en-ru') return this._prepareEn(text);
    // a scream written with hyphens ("А-а-а-а-а!") stays a scream, not "А!"
    const scream = /^\s*([А-Яа-яЁё])(?:-?\1)+([.!?…]*)\s*$/i.test(text) ? text.trim().replace(/-/g, '') : null;
    let base = this._applyJargon(scream || (dir === 'ru-en' ? this._rewriteRu(this._tidyRu(decodeEntities(text))) : text), dir);
    // shouting is translated in small letters (abbreviations were already swapped above) and put back in capitals
    const caps = dir === 'ru-en' && isShout(base);
    // (and the slang is looked at once more in small letters: "ТЕХИ МЕДА" -> "техи меда" -> maints medbay)
    if (caps) base = this._applyJargon(base.replace(/[А-ЯЁ]+/g, (w) => w.toLowerCase()), dir).replace(/^([^A-Za-zА-Яа-яЁё]*)([а-яё])/, (m, a, c) => a + c.toUpperCase());
    if (!this.lex) return { plain: base, sub: null, found: [], caps };
    const map = dir === 'ru-en' ? this.lex.ru2en : this.lex.en2ru;
    const found = map.find(base);
    if (!found.length) return { plain: base, sub: null, found, caps };
    const sub = map.apply(base, found);
    return { plain: base, sub: sub === base ? null : sub, found, caps };
  }
  /**
   * English you typed: chat English made plain (src/english.js) for the clean version; the game-word
   * version has the game's Russian words put in (slang/abbreviations from glossary.json, then names).
   */
  _prepareEn(text) {
    const e = this.enPrep.prepare(decodeEntities(String(text)));
    const base = e.text;
    const found = [];
    for (const g of this.glossary.en2ru) {
      g.re.lastIndex = 0;
      if (g.re.test(base)) found.push({ to: g.to });
      g.re.lastIndex = 0;
    }
    let sub = this._applyJargon(base, 'en-ru');
    if (this.lex) {
      const f = this.lex.en2ru.find(sub);
      for (const x of f) found.push(x);
      sub = this.lex.en2ru.apply(sub, f);
    }
    return { plain: base, sub: sub === base ? null : sub, found, caps: e.caps };
  }
  /** For src/english.js: a game word, slang or abbreviation that is not a typing mistake (abbr: one kept in capitals). */
  _enKnown(w, abbr) {
    const lw = w.toLowerCase();
    if (!this._glossKeys || this._glossKeysFor !== this.glossary) {
      this._glossKeysFor = this.glossary;
      this._glossKeys = new Set();
      try {
        const g = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'glossary.json'), 'utf8'));
        for (const k in g.en2ru || {}) this._glossKeys.add(k.toLowerCase());
      } catch (e) {}
    }
    if (abbr) return w.length <= 4 && (this._glossKeys.has(lw) || /^(gg|rip|afk|ooc|ic|ssd|pda|id|ert|cc|ai|smes|apc|ntr|iaa)$/.test(lw));
    if (this._glossKeys.has(lw)) return true;
    if (this.enPhrases && this.enPhrases.has(lw)) return true;
    return !!(this.lex && this.lex.en2ru.first.has(fold(w)) && w.length >= 4);
  }
  /** A short reply that is slang through and through: answered from phrases.json ("en2ru"), or undefined. */
  englishPhrase(text) {
    if (!this.enPhrases || !this.enPhrases.size) return undefined;
    const t = String(text || '').trim();
    if (!t || t.length > 40) return undefined;
    const m = /^(.*?)([.!?…]*)$/.exec(t);
    let key = m[1].toLowerCase().replace(/\s+/g, ' ').trim();
    if (/^(?:a?h+a+)+h*$/.test(key) && key.length >= 4) key = 'haha';
    let ru = this.enPhrases.get(key);
    if (ru === undefined) ru = this.enPhrases.get(key.replace(/(.)\1{2,}/g, '$1'));
    if (ru === undefined) return undefined;
    const tail = /[.!?…]$/.test(ru) ? '' : m[2];
    let out = ru + tail;
    if (/^[A-Z]/.test(t) && /^[а-яё]/.test(out)) out = out[0].toUpperCase() + out.slice(1);
    if (/[A-Za-z]/.test(m[1]) && m[1] === m[1].toUpperCase() && m[1].replace(/[^A-Za-z]/g, '').length >= 2) out = out.toUpperCase();
    return out;
  }
  /** Does the translation contain every game word the way the game names it? */
  _hasGameWords(tr, found) {
    if (!tr) return false;
    const t = fold(tr);
    for (const x of found) {
      if (!/[А-Яа-яЁё]/.test(x.to)) {
        if (!hasEnglishTerm(tr, x.to)) return false;
        continue;
      }
      const w = String(x.to).split(/[\s-]+/)[0];
      const stem = fold(w).slice(0, Math.max(3, Math.min(5, w.length - 2)));
      if (stem && !t.includes(stem)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- translation log
  /**
   * logs/translations.log: every text translated, both ways, with where the translation came from
   * (the translation service, saved, your fix, the game dictionary). Saved/dictionary ones are written
   * once per run; background pre-translation is left out. Tab-separated, so it opens in a spreadsheet.
   */
  logTr(dir, src, out, how, priority) {
    if (this.cfg.translationLog === false || priority === 'warm' || out == null) return;
    if (!this._trLog) {
      this._trLog = { lines: [], file: path.join(this.cfg._logDir || path.join(path.dirname(this.cacheFile), '..', 'logs'), 'translations.log'), seen: new Set() };
      try {
        fs.mkdirSync(path.dirname(this._trLog.file), { recursive: true });
        if (fs.existsSync(this._trLog.file) && fs.statSync(this._trLog.file).size > 20e6) fs.renameSync(this._trLog.file, this._trLog.file.replace(/\.log$/, '.old.log'));
        if (!fs.existsSync(this._trLog.file)) fs.writeFileSync(this._trLog.file, 'time\tdirection\tfrom\toriginal\ttranslation\n');
      } catch (e) {}
      const t = setInterval(() => this._flushTrLog(), 1000);
      if (t.unref) t.unref();
    }
    const L = this._trLog;
    if (how === 'saved' || how === 'dictionary' || how === 'your fix') {
      const k = dir + '|' + src;
      if (L.seen.has(k)) return;
      if (L.seen.size > 200000) L.seen.clear();
      L.seen.add(k);
    }
    const clean = (x) => String(x).replace(/[\t\r\n]+/g, ' ');
    const d = new Date();
    const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 8)}`;
    L.lines.push(`${ts}\t${dir === 'ru-en' ? 'RU>EN' : 'EN>RU'}\t${how}\t${clean(src)}\t${clean(out)}`);
    if (L.lines.length > 500) this._flushTrLog();
  }
  _flushTrLog() {
    const L = this._trLog;
    if (!L || !L.lines.length) return;
    const data = L.lines.join('\n') + '\n';
    L.lines = [];
    try {
      fs.appendFileSync(L.file, data);
    } catch (e) {}
  }
  /** A translation found without asking a service (your fix, saved before, game dictionary). */
  logLocal(text, out, priority) {
    const how = this.overrides.has(text) ? 'your fix' : this.ru2en.has(text) || /\d/.test(text) ? 'saved' : 'dictionary';
    this.logTr('ru-en', text, out, how, priority);
  }
  _engineName(dir) {
    const e = dir === 'ru-en' ? this.cfg.engine || 'google' : this.cfg.outgoingEngine || this.cfg.engine || 'google';
    if (e !== 'google') return e;
    if (this.cfg.googleQuality === 'classic') return 'google classic';
    return 'google';
  }

  async _one(text, dir, priority) {
    if (!text) return text;
    if (dir === 'ru-en') {
      if (!CYR.test(text)) return text;
      const local = this.lookupLocal(text);
      if (local !== undefined && local !== null) {
        this.stats.cacheHits++;
        this.logLocal(text, local, priority);
        if (priority !== 'warm') this.tm.count('RU>EN texts answered from memory (no service needed)');
        return local;
      }
      let source = text;
      let nums = null;
      if (/\d/.test(text)) {
        const t = this._template(text);
        if (t.nums.length <= 90) {
          source = t.template;
          nums = t.nums;
        }
      }
      let tr = await this._engine(source, dir, priority);
      if (tr == null) return null;
      tr = this._postFix(source, tr);
      this.ru2en.set(source, tr);
      this.dirty = true;
      this.cacheVersion++;
      if (nums) {
        const back = this._untemplate(tr, nums);
        if (back != null) {
          this.logTr('ru-en', text, back, this._engineName('ru-en'), priority);
          return back;
        }
        // Marker got mangled: translate the literal text instead.
        let lit = await this._engine(text, dir, priority);
        if (lit != null) {
          lit = this._postFix(text, lit);
          this.ru2en.set(text, lit);
          this.cacheVersion++;
          this.logTr('ru-en', text, lit, this._engineName('ru-en'), priority);
          return lit;
        }
        return null;
      }
      this.logTr('ru-en', text, tr, this._engineName('ru-en'), priority);
      return tr;
    } else {
      const fix = this.outgoingFix(text);
      if (fix !== undefined) {
        this.logTr('en-ru', text, fix, 'your fix', priority);
        return fix;
      }
      let ph = this.englishPhrase(text);
      if (ph !== undefined) {
        ph = this.myGender(text, ph);
        this.logTr('en-ru', text, ph, 'dictionary', priority);
        if (priority !== 'warm') this.tm.count('EN>RU chat slang answered from the phrase list');
        return ph;
      }
      let c = this.en2ru.get(text);
      if (c !== undefined) {
        c = this.myGender(text, c);
        this.logTr('en-ru', text, c, 'saved', priority);
        return c;
      }
      let tr = await this._engine(text, dir, priority);
      if (tr != null) {
        // saved as the service gave it; your gender is applied every time it is sent
        this.en2ru.set(text, tr);
        this.dirty = true;
        this.cacheVersion++;
        tr = this.myGender(text, tr);
        this.logTr('en-ru', text, tr, this._engineName('en-ru'), priority);
      }
      return tr;
    }
  }

  _engine(text, dir, priority) {
    // Very long texts (books, paper, guides) are split at sentence boundaries.
    if (text.length > 3500) return this._engineLong(text, dir, priority);
    // Verb names like "Заказать-музыку" translate better with spaces.
    if (dir === 'ru-en' && /^[А-Яа-яЁё]+(-[А-Яа-яЁё]+)+$/.test(text)) {
      return this._engineRaw(text.replace(/-/g, ' '), dir, priority).then((r) => (r ? r.replace(/\s+/g, '-') : r));
    }
    return this._engineRaw(text, dir, priority);
  }

  async _engineLong(text, dir, priority) {
    const parts = [];
    let rest = text;
    while (rest.length > 3000) {
      let cut = -1;
      for (const sep of ['\n', '. ', '! ', '? ', '; ', ', ', ' ']) {
        cut = rest.lastIndexOf(sep, 3000);
        if (cut > 1000) {
          cut += sep.length;
          break;
        }
        cut = -1;
      }
      if (cut === -1) cut = 3000;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) parts.push(rest);
    const out = await Promise.all(parts.map((p) => this._engineRaw(p, dir, priority)));
    if (out.some((x) => x == null)) return null;
    return out.join(' ').replace(/ {2,}/g, ' ');
  }

  _engineRaw(text, dir, priority) {
    const k = dir + '|' + text;
    let p = this.inflight.get(k);
    if (p) return p;
    p = new Promise((resolve) => {
      this.queues[priority === 'warm' ? 'warm' : 'live'].push({ text, dir, resolve, at: Date.now(), warm: priority === 'warm' });
      this._pump();
    }).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  _pump() {
    if (this._pumpTimer) return;
    // a short wait collects what arrives together into one request
    this._pumpTimer = setTimeout(() => {
      this._pumpTimer = null;
      this._dispatch();
    }, this.queues.live.length ? 8 : 20);
  }

  _dispatch() {
    const maxActive = this.cfg.maxConcurrentRequests || 3;
    const now = Date.now();
    if (now < this.pausedUntil) {
      setTimeout(() => this._pump(), this.pausedUntil - now);
      return;
    }
    while (this.active < maxActive) {
      let q = this.queues.live;
      if (!q.length) {
        // Warm-up only uses one slot and only when nothing live is waiting.
        if (this.active > 0 || !this.queues.warm.length) break;
        q = this.queues.warm;
      }
      // Group by direction, cap batch size.
      const dir = q[0].dir;
      const batch = [];
      let chars = 0;
      for (let i = 0; i < q.length && batch.length < 50; ) {
        const it = q[i];
        if (it.dir === dir && (batch.length === 0 || chars + it.text.length < 4500)) {
          batch.push(it);
          chars += it.text.length;
          q.splice(i, 1);
        } else i++;
        if (chars >= 4500) break;
      }
      if (!batch.length) break;
      this.active++;
      const isWarm = q === this.queues.warm;
      this._runBatch(batch, dir)
        .catch((e) => {
          this.stats.errors++;
          this.log(`Translation error (${dir}): ${String(e.message).slice(0, 120)}`);
          this.tm.count('translation service errors');
          this.tm.event('service-error', { dir, n: batch.length, why: String(e.message).slice(0, 160), limited: e.rateLimited ? 1 : 0 });
          if (e.rateLimited) {
            this.pausedUntil = Date.now() + 30000;
            this.log('Translation service is rate limiting - pausing 30s.');
            for (const it of batch) (isWarm ? this.queues.warm : this.queues.live).unshift(it);
            return;
          }
          // Temporary server errors (HTTP 5xx, network): try again a couple of times before giving up.
          const q = isWarm ? this.queues.warm : this.queues.live;
          for (const it of batch) {
            it.tries = (it.tries || 0) + 1;
            if (it.tries <= 3) setTimeout(() => { q.push(it); this._pump(); }, 1500 * it.tries);
            else it.resolve(null);
          }
        })
        .finally(async () => {
          if (isWarm) await sleep(this.cfg.warmupDelayMs == null ? 300 : this.cfg.warmupDelayMs);
          this.active--;
          this._pump();
        });
    }
  }

  async _runBatch(batch, dir) {
    const engine = dir === 'ru-en' ? this.cfg.engine || 'google' : this.cfg.outgoingEngine || this.cfg.engine || 'google';
    const [sl, tl] = dir === 'ru-en' ? ['ru', this.cfg.targetLanguage || 'en'] : [this.cfg.targetLanguage || 'en', 'ru'];
    // Google and the offline test engine get both versions of texts with game words (see _prepare);
    // paid services get the game-word version only (their quota counts characters).
    const both = engine === 'google' || engine === 'mock';
    const sources = [];
    const plans = batch.map((b) => {
      const p = this._prepare(b.text, dir);
      if (!both && p.sub) return { i: sources.push(p.sub) - 1, j: -1, found: [], caps: p.caps };
      const plan = { i: sources.push(p.plain) - 1, j: -1, found: p.found, caps: p.caps };
      if (p.sub) plan.j = sources.push(p.sub) - 1;
      return plan;
    });
    let results;
    this.stats.engineCalls++;
    this.stats.engineStrings += batch.length;
    const t0 = Date.now();
    const waited = t0 - Math.min(...batch.map((b) => b.at || t0));
    if (engine === 'mock') results = await this._mock(sources, sl, tl);
    else if (engine === 'deepl') results = await this._deepl(sources, sl, tl);
    else if (engine === 'anthropic' || engine === 'claude') results = await this._anthropic(sources, sl, tl);
    else results = await this._google(sources, sl, tl, dir === 'en-ru' && batch.length === 1);
    const clean = (r) => (typeof r === 'string' ? r.replace(/\u200b/g, '') : r);
    const ms = Date.now() - t0;
    const warm = batch.every((b) => b.warm);
    const way = engine === 'google' ? (results && results.way) || 'google' : engine;
    let usedSub = 0;
    let usedPlain = 0;
    batch.forEach((b, k) => {
      const p = plans[k];
      let r = clean(results[p.i]);
      if (p.j >= 0) {
        const alt = clean(results[p.j]);
        // (what you type: the game-word version is no good if English was left in it: "карго is op")
        const leftEn = (x) => dir === 'en-ru' && typeof x === 'string' && /(^|[^A-Za-z])(?![A-Z]{2,}\b)[A-Za-z]{3,}/.test(x.replace(/\b(?:RIP|GG|OK|LOL|AFK|PDA|ID|AI|ERT|CC|ok|lol|afk)\b/g, ''));
        if (!this._hasGameWords(r, p.found) && typeof alt === 'string' && alt.length && !(leftEn(alt) && !leftEn(r))) {
          r = alt;
          usedSub++;
        } else usedPlain++;
      }
      if (p.caps && typeof r === 'string') r = r.toUpperCase();
      b.resolve(typeof r === 'string' && r.length ? r : null);
    });
    if (!warm) {
      const name = `translation service ${dir === 'ru-en' ? 'RU>EN' : 'EN>RU'} via ${way}`;
      this.tm.sample(name + ' (ms)', ms);
      this.tm.sample(`translation ${dir === 'ru-en' ? 'RU>EN' : 'EN>RU'}: waited in queue (ms)`, waited);
      this.tm.count(name + ': requests');
      this.tm.count(name + ': texts', batch.length);
      if (usedSub) this.tm.count('game words: Google got one wrong, swapped version used', usedSub);
      if (usedPlain) this.tm.count('game words: Google got them right, clean version used', usedPlain);
      this.tm.event('service', { dir, way, n: batch.length, sent: sources.length, chars: sources.reduce((a, x) => a + x.length, 0), ms, waited, sub: usedSub, plain: usedPlain, failed: batch.filter((b, k) => results[plans[k].i] == null).length });
    } else this.tm.count('background pre-translation texts', batch.length);
  }

  // ---------------------------------------------------------------- Google (free web endpoint)
  async _fetch(url, opts, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || 15000);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      if (r.status === 429 || r.status === 503) {
        const e = new Error('HTTP ' + r.status);
        e.rateLimited = true;
        throw e;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
      return r;
    } finally {
      clearTimeout(t);
    }
  }

  async _googleSingle(text, sl, tl) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t`;
    let r;
    const q = encodeURIComponent(text);
    if (this.googleGet || q.length < 1500) {
      r = await this._fetch(url + '&q=' + q, { method: 'GET' });
    } else {
      try {
        r = await this._fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: 'q=' + q,
        });
      } catch (e) {
        if (e.rateLimited) throw e;
        this.googleGet = true;
        r = await this._fetch(url + '&q=' + q, { method: 'GET' });
      }
    }
    const j = await r.json();
    if (!Array.isArray(j) || !Array.isArray(j[0])) throw new Error('Unexpected Google response');
    return j[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
  }

  async _googleBatch(texts, sl, tl) {
    const url = `https://translate.googleapis.com/translate_a/t?client=gtx&sl=${sl}&tl=${tl}&dt=t`;
    const body = texts.map((t) => 'q=' + encodeURIComponent(t)).join('&');
    const r = await this._fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
    });
    const j = await r.json();
    if (!Array.isArray(j) || j.length !== texts.length) throw new Error('batch shape');
    return j.map((x) => (typeof x === 'string' ? x : Array.isArray(x) && typeof x[0] === 'string' ? x[0] : null));
  }

  async _google(texts, sl, tl, single) {
    const best = this.cfg.googleQuality !== 'classic';
    // what you type: the website's own translator (best sentences), with the others as backup if it is slow
    if (best && single && texts.length <= 2) {
      const r = await this._googleBest(texts, sl, tl);
      if (r) return r;
    } else if (best && this._gOk('html')) {
      const r = await this._googleTry('html', () => this._googleHtml(texts, sl, tl), texts, tl);
      if (r) return r;
    }
    return this._googleClassic(texts, sl, tl);
  }

  /**
   * You started typing: open the connections to Google's translators now, so the message itself is
   * translated without the extra time a first connection takes. At most once every 20 s.
   */
  warmTyping() {
    const now = Date.now();
    if (now - (this._warmTypingAt || 0) < 20000) return;
    this._warmTypingAt = now;
    const engine = this.cfg.outgoingEngine || this.cfg.engine || 'google';
    if (engine !== 'google' || this.cfg.googleQuality === 'classic') return;
    const t0 = Date.now();
    const quiet = (p) => p.then(() => Date.now() - t0, () => -1);
    Promise.all([this._gOk('web') ? quiet(this._googleWeb('ok', 'en', 'ru')) : -2, this._gOk('html') ? quiet(this._googleHtml(['ok'], 'en', 'ru')) : -2]).then(([w, h]) =>
      this.tm.event('typing-warm', { web: w, html: h })
    );
  }

  _gOk(name) {
    return Date.now() >= this.gHealth[name].offUntil;
  }
  /** Runs one Google way in; checks the answer; switches that way off for 10 minutes after 3 failures. */
  async _googleTry(name, fn, texts, tl) {
    const h = this.gHealth[name];
    try {
      const r = await fn();
      if (!Array.isArray(r) || r.length !== texts.length) throw new Error('wrong number of answers');
      r.forEach((x, i) => {
        if (!this._answerOk(texts[i], x, tl)) throw new Error('unusable answer');
      });
      h.fails = 0;
      r.way = name === 'web' ? 'google website' : 'google browser';
      if (!h.used) {
        h.used = true;
        this.log(`Google: using the ${name === 'web' ? "website's translator" : "browser translator (website quality)"}.`);
      }
      return r;
    } catch (e) {
      if (e.rateLimited || ++h.fails >= 3) {
        h.offUntil = Date.now() + 10 * 60000;
        h.fails = 0;
        this.log(`Google ${name === 'web' ? 'website' : 'browser'} translator not available right now (${String(e.message).slice(0, 80)}); using the classic one for 10 minutes.`);
        this.tm.event('google-off', { way: name, why: String(e.message).slice(0, 120) });
      }
      return null;
    }
  }
  /** A translation that is really a translation (not empty, not the input sent back). */
  _answerOk(src, tr, tl) {
    if (typeof tr !== 'string' || !tr.trim()) return false;
    const letters = tl === 'ru' ? /[A-Za-z]{3}/ : /[А-Яа-яЁё]{3}/;
    // a whole sentence sent back untranslated (short words like "ok" or names may stay the same)
    if (letters.test(src) && src.trim().length >= 12 && /\s/.test(src.trim()) && tr.trim() === src.trim()) return false;
    return true;
  }

  /**
   * Best quality for one message: the website's translator, raced against the browser translator and the
   * classic one, so a slow answer never holds the message up for long.
   */
  async _googleBest(texts, sl, tl) {
    const wait = (ms) => new Promise((r) => setTimeout(() => r(undefined), ms));
    const settle = (p) => p.then((x) => x || null, () => null);
    const viaWeb = this._gOk('web') ? settle(this._googleTry('web', () => Promise.all(texts.map((t) => this._googleWeb(t, sl, tl))), texts, tl)) : Promise.resolve(null);
    const viaHtml = this._gOk('html') ? settle(this._googleTry('html', () => this._googleHtml(texts, sl, tl), texts, tl)) : Promise.resolve(null);
    const viaClassic = settle(this._googleClassic(texts, sl, tl));
    // all three start at once; the website's answer is used if it comes within 1.5 s, but once the browser
    // translator (same quality) has answered, the website gets only a short moment more
    const t0 = Date.now();
    const htmlThenGrace = Promise.race([viaHtml, wait(1500)]).then(() => wait(Math.max(0, Math.min(250, 1500 - (Date.now() - t0)))));
    const w = await Promise.race([viaWeb, htmlThenGrace]);
    if (w) return w;
    const h = await Promise.race([viaHtml, wait(500)]);
    if (h) return h;
    const c = await Promise.race([viaClassic, wait(3000)]);
    if (c) return c;
    return (await viaWeb) || (await viaHtml) || null;
  }

  /** translate.google.com's own translator (one text per request). */
  async _googleWeb(text, sl, tl) {
    if (/\n/.test(text) || text.length > 4500) throw new Error('not for this text');
    const freq = JSON.stringify([[['MkEWBc', JSON.stringify([[text, sl, tl, 1], []]), null, 'generic']]]);
    const r = await this._fetch(
      'https://translate.google.com/_/TranslateWebserverUi/data/batchexecute?rpcids=MkEWBc&source-path=%2F&hl=en&rt=c',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'f.req=' + encodeURIComponent(freq) + '&' },
      5000
    );
    const body = await r.text();
    let inner = null;
    for (const line of body.split('\n')) {
      if (!line.includes('MkEWBc')) continue;
      try {
        const arr = JSON.parse(line);
        for (const e of arr) if (Array.isArray(e) && e[0] === 'wrb.fr' && e[1] === 'MkEWBc' && typeof e[2] === 'string') inner = JSON.parse(e[2]);
      } catch (e) {}
      if (inner) break;
    }
    const d = inner && inner[1] && inner[1][0];
    if (!d) throw new Error('website answer not understood');
    let out = null;
    const parts = d[0] && d[0][5];
    if (Array.isArray(parts)) out = parts.map((p) => (Array.isArray(p) && typeof p[0] === 'string' ? p[0] : '')).filter(Boolean).join(' ');
    if (!out && d[0] && typeof d[0][0] === 'string') out = d[0][0];
    if (!out) throw new Error('website answer not understood');
    return out.replace(/ {2,}/g, ' ').trim();
  }

  /** The translator Chrome uses for whole pages (many texts per request, website quality). */
  async _googleHtml(texts, sl, tl) {
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const unesc = (t) =>
      String(t)
        .replace(/<[^>]+>/g, '')
        .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
    // line breaks and runs of spaces would be lost in HTML: such texts go the classic way
    const idx = [];
    const send = [];
    texts.forEach((t, i) => {
      if (!/\n|\s{2,}/.test(t) && t.length <= 4500) {
        idx.push(i);
        send.push(esc(t));
      }
    });
    const out = new Array(texts.length).fill(null);
    if (send.length) {
      const r = await this._fetch(
        'https://translate-pa.googleapis.com/v1/translateHtml',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json+protobuf', 'X-Goog-API-Key': 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520' },
          body: JSON.stringify([[send, sl, tl], 'te_lib']),
        },
        8000
      );
      const j = await r.json();
      const list = Array.isArray(j) && Array.isArray(j[0]) ? j[0] : null;
      if (!list || list.length !== send.length) throw new Error('browser translator answer not understood');
      list.forEach((x, k) => (out[idx[k]] = typeof x === 'string' ? unesc(x) : null));
    }
    const rest = texts.map((t, i) => (out[i] == null ? i : -1)).filter((i) => i >= 0);
    if (rest.length) {
      const r2 = await this._googleClassic(rest.map((i) => texts[i]), sl, tl);
      rest.forEach((i, k) => (out[i] = r2[k]));
    }
    return out;
  }

  async _googleClassic(texts, sl, tl) {
    if (texts.length > 1 && this.googleMode === 'batch') {
      try {
        const res = await this._googleBatch(texts, sl, tl);
        res.way = 'google classic';
        if (res.every((x) => typeof x === 'string')) return res;
        throw new Error('batch content');
      } catch (e) {
        if (e.rateLimited || /^HTTP|abort|fetch|network|timed? ?out/i.test(e.message)) throw e;
        this.googleMode = 'single';
        this.log(`Google batch mode unavailable (${e.message}); using one request per string.`);
      }
    }
    const out = new Array(texts.length).fill(null);
    let idx = 0;
    const workers = Array.from({ length: Math.min(4, texts.length) }, async () => {
      while (idx < texts.length) {
        const i = idx++;
        out[i] = await this._googleSingle(texts[i], sl, tl);
      }
    });
    await Promise.all(workers);
    out.way = 'google classic';
    return out;
  }

  // ---------------------------------------------------------------- DeepL (API key)
  async _deepl(texts, sl, tl) {
    const key = this.cfg.deeplKey;
    if (!key) throw new Error('deeplKey missing in config.json');
    const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const r = await this._fetch(host + '/v2/translate', {
      method: 'POST',
      headers: { Authorization: 'DeepL-Auth-Key ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: texts,
        source_lang: sl.toUpperCase(),
        target_lang: tl === 'en' ? 'EN-US' : tl.toUpperCase(),
      }),
    });
    const j = await r.json();
    return j.translations.map((t) => t.text);
  }

  // ---------------------------------------------------------------- Claude (API key)
  async _anthropic(texts, sl, tl) {
    const key = this.cfg.anthropicKey;
    if (!key) throw new Error('anthropicKey missing in config.json');
    const names = { ru: 'Russian', en: 'English' };
    const sys =
      `You translate text from the multiplayer game Space Station 13 (Russian server SS1984 / Paradise) from ${names[sl] || sl} to ${names[tl] || tl}. ` +
      'Keep SS13 jargon (sec, HoS, CE, borg, AI, singulo, toolbox...) as players use it, keep names, numbers, punctuation and tone. ' +
      (tl === 'ru' ? 'Write natural, grammatically correct Russian as a native player would type in chat. ' : '') +
      'Input is a JSON array of strings. Reply with ONLY a JSON array of the translated strings, same length and order.';
    const r = await this._fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.anthropicModel || 'claude-haiku-5-5',
        max_tokens: 4096,
        system: sys,
        messages: [{ role: 'user', content: JSON.stringify(texts) }],
      }),
    });
    const j = await r.json();
    const txt = (j.content || []).map((c) => c.text || '').join('');
    const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
    if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('Claude returned wrong length');
    return arr;
  }

  // Offline engine used only for testing the mod without internet.
  async _mock(texts, sl, tl) {
    await sleep(120);
    return texts.map((t) => (tl === 'ru' ? 'РУ<' + t + '>' : 'EN<' + t.replace(/[А-Яа-яЁё]/g, 'x') + '>'));
  }

  clearCache() {
    this.ru2en.clear();
    this.en2ru.clear();
    this.dirty = true;
    this.cacheVersion++;
    this.save();
  }

  queueSize() {
    return this.queues.live.length + this.queues.warm.length;
  }
}

/** A saved text whose numbers are markers (701, 702 ... in order): "Осталось 701 секунд". */
function isTemplateKey(key) {
  const nums = String(key).match(/\d+/g);
  if (!nums) return false;
  return nums.every((n, i) => n === String(701 + i));
}

module.exports = { Translator, PhraseMap, nounForms, phraseForms, pluralEn, isTemplateKey, fold, hashOf };
