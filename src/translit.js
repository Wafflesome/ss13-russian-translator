'use strict';
// Names are written in the other alphabet, not translated by meaning:
//   "John Smith"  -> "Джон Смит" (not "Джон Кузнец")
//   "Иван Петров" -> "Ivan Petrov"

const RU_EN = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function matchCase(src, out) {
  if (!out) return out;
  if (src.length > 1 && src === src.toUpperCase() && src !== src.toLowerCase()) return out.toUpperCase();
  if (src[0] && src[0] !== src[0].toLowerCase()) return out[0].toUpperCase() + out.slice(1);
  return out;
}

/** Russian letters -> Latin letters ("Иван Петров" -> "Ivan Petrov"). Other characters stay. */
function ruToEn(text) {
  return String(text).replace(/[А-Яа-яЁё]+/g, (w) => {
    const out = w.toLowerCase().split('').map((c) => (RU_EN[c] !== undefined ? RU_EN[c] : c)).join('');
    return matchCase(w, out);
  });
}

const VOWEL = /[aeiouy]/;
// longest first
const MULTI = [
  ['shch', 'щ'], ['sch', 'ш'], ['tch', 'ч'], ['sh', 'ш'], ['ch', 'ч'], ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц'], ['tz', 'ц'],
  ['ph', 'ф'], ['th', 'т'], ['ck', 'к'], ['qu', 'кв'], ['ee', 'и'], ['oo', 'у'], ['ou', 'у'], ['ea', 'и'], ['yu', 'ю'],
  ['ya', 'я'], ['yo', 'ё'], ['igh', 'ай'], ['ay', 'ей'], ['ey', 'ей'], ['oy', 'ой'], ['iy', 'ий'], ['aw', 'о'], ['oh', 'о'],
  ['ew', 'ью'], ['own', 'аун'], ['ow', 'оу'],
];
// "Mike", "Jane", "Rose", "Luke": the e at the end is silent and makes the vowel before it long
const LONG = { a: 'ей', i: 'ай', o: 'оу', u: 'ю', e: 'и' };
const ONE = {
  a: 'а', b: 'б', d: 'д', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п',
  q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', z: 'з',
};

function enWord(w) {
  let s = w.toLowerCase();
  let tail = '';
  const magic = /^(.*[^aeiouy])([aeiou])([bcdfgklmnprstvz])e$/.exec(s);
  if (magic && s.length >= 4) {
    s = magic[1];
    tail = LONG[magic[2]] + (ONE[magic[3]] || (magic[3] === 'c' ? 'с' : ''));
  } else if (/[^aeiou]ie$/.test(s)) {
    s = s.slice(0, -2) + 'i';
  }
  let out = '';
  for (let i = 0; i < s.length; ) {
    const prev = s[i - 1] || '';
    const rest = s.slice(i);
    // a word ending in a consonant + "le" ("Apple", "Bottle"): the e is silent
    if (rest === 'le' && i > 0 && !VOWEL.test(prev)) {
      out += 'л';
      break;
    }
    const m = MULTI.find(([a]) => rest.startsWith(a));
    if (m) {
      out += m[1];
      i += m[0].length;
      continue;
    }
    const c = s[i];
    const next = s[i + 1] || '';
    if (c === 'e') out += i === 0 ? 'э' : 'е';
    else if (c === 'c') out += /[eiy]/.test(next) ? 'с' : 'к';
    else if (c === 'y') out += i === 0 ? 'й' : VOWEL.test(prev) ? 'й' : 'и';
    else out += ONE[c] !== undefined ? ONE[c] : c;
    i++;
  }
  return matchCase(w, out + tail);
}

/** Latin letters -> Russian letters, by sound ("John Smith" -> "Джон Смит"). Other characters stay. */
function enToRu(text) {
  return String(text).replace(/[A-Za-z]+/g, (w) => enWord(w));
}

module.exports = { ruToEn, enToRu };
