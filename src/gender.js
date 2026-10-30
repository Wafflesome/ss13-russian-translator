'use strict';
// What you write about yourself gets your character's gender in Russian.
//
// Russian shows the speaker's gender in the past tense ("я устал" / "я устала"), in short forms
// ("я готов" / "я готова") and in words describing the speaker ("я такой толстый" / "я такая толстая").
// The translation service has to guess, and often guesses wrong. This changes the words that are
// about "я" (I) to the gender set in the control panel, and leaves everything about other people alone:
// only the part of a sentence that belongs to "я" is touched (it stops at commas, full stops and at
// another person: он, она, ты, вы ...).
//
// Whether a word really is a verb or an adjective is checked against the Russian word list, so a noun
// that happens to end the same way ("стол", "сила", "инженер") is never changed.

// another person (or a new part of the sentence) starts here
const STOP = new Set(
  ('он она оно они ты вы мы тот та те что чтобы если когда где куда откуда пока потому ' +
    'который которая которое которые которого которой кто его её ее их ему ей им нему ней ним ' +
    'но а или либо зато однако хотя будто словно поэтому значит').split(' ')
);
// small words that can sit between "я" and the words describing me
const GLUE = new Set(
  ('не ни же ведь так очень совсем слишком уже ещё еще тоже также просто вообще сейчас теперь сегодня ' +
    'вчера завтра всегда никогда иногда бы правда действительно абсолютно полностью вполне немного чуть ' +
    'капец реально наверное точно ли тут здесь там вот прям прямо такой такая настолько всё все пока ' +
    'снова опять вроде уж даже лишь только наконец почти довольно крайне жутко ужасно ' +
    'страшно дико безумно немножко слегка жуть типа как-то это').split(' ')
);
// "был / стал / оказался / чувствую себя ..." + how I am
const COPULA = /^(был|была|было|буду|будешь|стал|стала|становлюсь|оказался|оказалась|казался|казалась|кажусь|остался|осталась|остаюсь|выгляжу|выглядел|выглядела|являюсь|чувствую|чувствовал|чувствовала|себя)$/;
// what may follow a describing word without it describing a noun instead ("я новый капитан")
const AFTER_OK = new Set(
  ('и как в на с со у от до из за по к ко для без при про о об после перед из-за ' +
    'да').split(' ')
);

// short forms that change their spelling, masculine -> feminine
const SHORT = {
  должен: 'должна', болен: 'больна', голоден: 'голодна', согласен: 'согласна', свободен: 'свободна',
  нужен: 'нужна', способен: 'способна', доволен: 'довольна', недоволен: 'недовольна', спокоен: 'спокойна',
  благодарен: 'благодарна', умён: 'умна', умен: 'умна', силён: 'сильна', силен: 'сильна', зол: 'зла',
  полон: 'полна', смешон: 'смешна', честен: 'честна', виновен: 'виновна', невиновен: 'невиновна',
  одинок: 'одинока', близок: 'близка', далёк: 'далека', далек: 'далека', похож: 'похожа', рад: 'рада',
  прав: 'права', неправ: 'неправа', сыт: 'сыта', пьян: 'пьяна', жив: 'жива', мёртв: 'мертва',
  мертв: 'мертва', здоров: 'здорова', готов: 'готова', занят: 'занята', уверен: 'уверена', обязан: 'обязана',
  удивлён: 'удивлена', удивлен: 'удивлена', влюблён: 'влюблена', влюблен: 'влюблена', ранен: 'ранена',
  счастлив: 'счастлива', несчастлив: 'несчастлива', красив: 'красива', ленив: 'ленива', стар: 'стара',
  молод: 'молода', глуп: 'глупа', слаб: 'слаба', хорош: 'хороша', плох: 'плоха', знаком: 'знакома',
  вынужден: 'вынуждена', обречён: 'обречена', обречен: 'обречена', один: 'одна', сам: 'сама',
  заинтересован: 'заинтересована', расстроен: 'расстроена', напуган: 'напугана', растерян: 'растеряна',
  измотан: 'измотана', потерян: 'потеряна', смущён: 'смущена', смущен: 'смущена',
};
const SHORT_F = {};
for (const [m, f] of Object.entries(SHORT)) if (!SHORT_F[f]) SHORT_F[f] = m;

const HUSH = /[жшчщ]$/;
const VELAR = /[гкх]$/;

function matchCase(src, out) {
  if (!out || out === src) return src;
  if (src.length > 1 && src === src.toUpperCase() && src !== src.toLowerCase()) return out.toUpperCase();
  if (src[0] !== src[0].toLowerCase()) return out[0].toUpperCase() + out.slice(1);
  return out;
}

class Gender {
  /** words: a Map or Set of known Russian words (lower case). */
  constructor(words) {
    this.words = words;
  }
  has(w) {
    const s = this.words;
    if (!s || !w) return false;
    return s.has(w) || s.has(w.replace(/ё/g, 'е'));
  }
  /** first of the candidates that is a real word (ё preferred when the list knows it) */
  pick(...c) {
    for (const w of c) if (w && this.has(w)) return w;
    return null;
  }

  // ------------------------------------------------------------ past tense: устал <-> устала
  pastTo(w, g) {
    if (g === 'f') {
      if (/лся$/.test(w)) return this.pick(w.slice(0, -3) + 'лась');
      if (/[гкзсрбпт]ся$/.test(w)) {
        // ошибся -> ошиблась
        const b = w.slice(0, -2);
        return this.has(b + 'лась') && this.has(b + 'лись') ? b.replace(/ё(?=[^ё]*$)/, 'е') + 'лась' : null;
      }
      if (/ш[её]л$/.test(w)) return this.pick(w.slice(0, -3) + 'шла');
      // a verb's past ends in a vowel + л (сказал, был, ел); "стол", "пол", "угол" are nouns
      if (/[аеёиыуяю]л$/.test(w) || /^(колол|полол|молол|порол|боролся)$/.test(w)) return this.has(w + 'а') && this.has(w + 'и') ? w + 'а' : null;
      if (/[гкзсрбпт]$/.test(w) && w.length >= 3) {
        const e = w.replace(/ё(?=[^ё]*$)/, 'е');
        if (this.has(e + 'ла') && this.has(e + 'ли')) return e + 'ла';
      }
      return null;
    }
    if (/лась$/.test(w)) {
      const b = w.slice(0, -4);
      if (this.has(b + 'лся')) return b + 'лся';
      if (/[гкзсрбпт]$/.test(b) && this.has(b + 'ся') && this.has(b + 'лись')) return b + 'ся'; // ошиблась -> ошибся
      return null;
    }
    if (/шла$/.test(w) && w.length >= 4) {
      const b = w.slice(0, -3);
      return /^вы/.test(b) ? this.pick(b + 'шел') : this.pick(b + 'шёл', b + 'шел');
    }
    if (/ла$/.test(w) && w.length >= 4) {
      const m = w.slice(0, -1); // сказала -> сказал
      if (this.has(m) && this.has(m + 'и')) return m;
      const b = w.slice(0, -2); // могла -> мог, легла -> лёг
      if (/[гкзсрбпт]$/.test(b) && this.has(b + 'ли')) {
        const yo = b.replace(/е(?=[^е]*$)/, 'ё');
        if (yo !== b && this.words.has(yo)) return yo; // лёг, принёс (only when the word list spells it so)
        return this.has(b) ? b : null;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ short forms: готов <-> готова
  shortTo(w, g) {
    if (g === 'f') {
      if (SHORT[w]) return SHORT[w];
      if (/(ан|ян|ен|ён|ит|ыт|ут|ат|ов|ив)$/.test(w) && this.has(w + 'а') && this.has(w + 'ы') && this.has(w + 'о')) return w + 'а';
      return null;
    }
    if (SHORT_F[w]) return SHORT_F[w];
    if (/а$/.test(w)) {
      const m = w.slice(0, -1);
      if (/(ан|ян|ен|ён|ит|ыт|ут|ат|ов|ив)$/.test(m) && this.has(m) && this.has(m + 'ы') && this.has(m + 'о')) return m;
    }
    return null;
  }

  // ------------------------------------------------------------ describing words: такой толстый <-> такая толстая
  /** kind: 'nom' (такой), 'instr' (таким), or null when it isn't one */
  adjKind(w) {
    const st = w.replace(/(ый|ий|ой|ая|яя|ым|им|ей)$/, '');
    if (st === w || st.length < 2) return null;
    if (!(this.has(st + 'ые') || this.has(st + 'ие'))) return null; // a real adjective has a plural
    return /(ым|им)$/.test(w) ? 'instr' : 'nom';
  }
  adjTo(w, g, femInstr) {
    const end = w.slice(-2);
    const st = w.slice(0, -2);
    if (g === 'f') {
      if (end === 'ый' || end === 'ой') return end === 'ой' && femInstr ? null : this.pick(st + 'ая');
      if (end === 'ий') return this.pick(HUSH.test(st) || VELAR.test(st) ? st + 'ая' : st + 'яя');
      if (end === 'ым') return this.pick(st + 'ой');
      if (end === 'им') return VELAR.test(st) ? this.pick(st + 'ой') : HUSH.test(st) ? this.pick(st + 'ей', st + 'ой') : this.pick(st + 'ей');
      return null;
    }
    if (end === 'яя') return this.pick(st + 'ий');
    if (end === 'ая') {
      if (VELAR.test(st)) return this.pick(st + 'ий', st + 'ой');
      if (HUSH.test(st)) return /^(больш|чуж|небольш)$/.test(st) ? this.pick(st + 'ой') : this.pick(st + 'ий');
      return this.pick(st + 'ый', st + 'ой');
    }
    if (femInstr && end === 'ой') return this.pick(VELAR.test(st) || HUSH.test(st) ? st + 'им' : st + 'ым');
    if (femInstr && end === 'ей') return this.pick(st + 'им');
    return null;
  }

  /**
   * ru: the Russian that will be sent; en: the English it came from; g: 'm' or 'f'.
   * Returns the Russian with the words about "я" in that gender.
   */
  fix(ru, en, g) {
    if (!ru || (g !== 'm' && g !== 'f') || !/(^|[^а-яё])я([^а-яё]|$)/i.test(ru)) return ru;
    if (en && !/(^|[^a-z'])(i|i'm|im|i've|ive|i'll|ill|i'd|me|my|myself|mine)(?![a-z])/i.test(en)) return ru;
    // words and what is between them; a clause ends at punctuation
    const parts = ru.split(/([А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*)/);
    const clauses = [];
    let cur = [];
    for (let i = 0; i < parts.length; i++) {
      if (i % 2) cur.push(i);
      else if (/[.,!?;:…—()"«»\n]/.test(parts[i]) || / - /.test(parts[i])) {
        clauses.push(cur);
        cur = [];
      }
    }
    clauses.push(cur);
    for (const c of clauses) this._clause(parts, c, g);
    return parts.join('');
  }

  _clause(parts, idx, g) {
    const low = idx.map((i) => parts[i].toLowerCase());
    low.forEach((w, at) => {
      if (w === 'я') this._me(parts, idx, low, at, g);
    });
  }

  _me(parts, idx, low, at, g) {
    // the words that belong to "я": back to the start and forward to another person
    let from = at;
    while (from > 0 && !STOP.has(low[from - 1]) && low[from - 1] !== 'я') from--;
    let to = at;
    while (to + 1 < low.length && !STOP.has(low[to + 1]) && low[to + 1] !== 'я') to++;
    // was it written as a woman or as a man? (decides what "толстой" after "была" is)
    let femCopula = false;
    const set = (k, w) => {
      if (w && w !== low[k]) parts[idx[k]] = matchCase(parts[idx[k]], w);
    };
    // 1) past tense anywhere in my part ("вчера я устала и ушла")
    for (let k = from; k <= to; k++) {
      if (k === at) continue;
      if (/^(была|стала|казалась|оказалась|осталась|выглядела|чувствовала)$/.test(low[k])) femCopula = true;
      set(k, this.pastTo(low[k], g));
    }
    // 2) the words describing me: right after "я" (and its small words), or right before it
    const slot = (k, step) => {
      const chain = [];
      let seenCopula = false;
      for (; k >= from && k <= to && k !== at; k += step) {
        const w = low[k];
        if (COPULA.test(w)) {
          seenCopula = true;
          continue;
        }
        if (GLUE.has(w) && w !== 'такой' && w !== 'такая') continue;
        if (w === 'и' && chain.length) continue;
        const sh = this.shortTo(w, g);
        if (sh) {
          set(k, sh);
          continue;
        }
        if (this.shortTo(w, g === 'f' ? 'm' : 'f')) continue; // already right ("готова" for a woman)
        const kind = this.adjKind(w);
        if (kind) {
          chain.push([k, kind, seenCopula]);
          continue;
        }
        break; // a noun, a verb ... : the describing part is over
      }
      // a describing word followed by a noun describes the noun ("я новый капитан"): leave it
      const next = low[k];
      const ends = k > to || k < from || k === at || next === undefined || AFTER_OK.has(next) || GLUE.has(next) || /(ть|ться|ти|чь)$/.test(next);
      if (step > 0 && !ends) return;
      for (const [j, kind, cop] of chain) {
        if (kind === 'instr' || /(ой|ей)$/.test(low[j])) {
          // "была толстой" / "был толстым"
          if (cop) set(j, this.adjTo(low[j], g, g === 'm' ? femCopula : true));
          else if (kind === 'nom') set(j, this.adjTo(low[j], g, false));
        } else set(j, this.adjTo(low[j], g, false));
      }
    };
    slot(at + 1, 1);
    slot(at - 1, -1);
  }
}

module.exports = { Gender };
