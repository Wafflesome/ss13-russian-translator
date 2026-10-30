'use strict';
/**
 * What you type, made ready for the translator (English -> Russian).
 *
 * Translation services are good with clean English and bad with chat English: they translate "rip" as
 * "рвать", "holy zombies" as "святые зомби", leave "op" as it is, and spell a misspelt word out in
 * Russian letters ("Damm" -> "Дамм"). So before a line is sent:
 *   - chat abbreviations and slang are written out ("op" -> "overpowered", "idk" -> "I don't know");
 *   - misspelt words are corrected when the right word is clear ("immidietely" -> "immediately");
 *   - names typed in small letters get a capital ("gg ivan" -> "gg Ivan"), so they stay names;
 *   - shouting is translated in small letters and the Russian is put back in capitals;
 *   - stray characters from another keyboard layout are dropped ("dead???Ž").
 * Short replies that are slang through and through ("rip", "gg", "lol") are answered from a list
 * (data/phrases.json, "en2ru") without asking a translation service.
 */
const fs = require('fs');
const path = require('path');

// chat words written out (whole words, any capitals). Order matters only for phrases sharing words.
const EXPAND = [
  // phrases first
  [/\bfucking (shit|everything|everyone|them|it) up\b/gi, 'wrecking everything'],
  [/\bfucked (shit|everything|everyone|them|it) up\b/gi, 'wrecked everything'],
  [/\bholy (?!shit\b|crap\b|fuck\b|hell\b|moly\b|cow\b|water\b|bible\b|spirit\b|ghost\b|book\b|grail\b|land\b|war\b|see\b|order\b)([a-z]+)/gi, 'wow, $1'],
  [/\bgo go go\b/gi, 'go, go, go'],
  [/\bon my way\b/gi, 'coming'],
  [/\bomw\b/gi, 'coming'],
  [/\boh my god\b/gi, 'oh my god'],
  // abbreviations
  [/\bidk\b/gi, "I don't know"],
  [/\bidc\b/gi, "I don't care"],
  [/\bimo\b/gi, 'in my opinion'],
  [/\bimho\b/gi, 'in my opinion'],
  [/\bbtw\b/gi, 'by the way'],
  [/\btbh\b/gi, 'to be honest'],
  [/\bngl\b/gi, 'not going to lie'],
  [/\brn\b/gi, 'right now'],
  [/\bnvm\b/gi, 'never mind'],
  [/\bomg\b/gi, 'oh my god'],
  [/\bwtf\b/gi, 'what the hell'],
  [/\bwth\b/gi, 'what the hell'],
  [/\bstfu\b/gi, 'shut up'],
  [/\bsmh\b/gi, 'unbelievable'],
  [/\bbrb\b/gi, 'be right back'],
  [/\bafaik\b/gi, 'as far as I know'],
  [/\birl\b/gi, 'in real life'],
  [/\bjk\b/gi, 'just kidding'],
  [/\bty\b/gi, 'thank you'],
  [/\bthx\b/gi, 'thanks'],
  [/\btnx\b/gi, 'thanks'],
  [/\bpls\b/gi, 'please'],
  [/\bplz\b/gi, 'please'],
  [/\bplox\b/gi, 'please'],
  [/\bnp\b/gi, 'no problem'],
  [/\bppl\b/gi, 'people'],
  [/\bsry\b/gi, 'sorry'],
  [/\bmins?\b/gi, (m) => (m.toLowerCase() === 'min' ? 'minute' : 'minutes')],
  [/\bop\b(?![-.]\w)/gi, 'overpowered'],
  [/\bnerf(ed)?\b/gi, (m, ed) => (ed ? 'weakened' : 'weaken')],
  [/\brip\b/gi, 'RIP'],
  [/\bgg\b/gi, 'GG'],
  [/\blol\b/gi, 'haha'],
  [/\blmao\b/gi, 'haha'],
  [/\blmfao\b/gi, 'haha'],
  [/\brofl\b/gi, 'haha'],
  [/\b(?:a?ha){2,}h?\b/gi, 'haha'],
  [/\bk\b(?=\s*$)/gi, 'okay'],
  [/\bkk\b/gi, 'okay'],
  [/\bok\b/gi, 'okay'],
  [/\bur\b/gi, 'your'],
  [/\bu\b/gi, 'you'],
  [/\br\b(?= (?:you|u|we|they|there|those|these)\b)/gi, 'are'],
  [/\bcuz\b/gi, 'because'],
  [/\bcos\b/gi, 'because'],
  [/\btho\b/gi, 'though'],
  [/\bgonna\b/gi, 'going to'],
  [/\bwanna\b/gi, 'want to'],
  [/\bgotta\b/gi, 'have to'],
  [/\bdunno\b/gi, "I don't know"],
  [/\bya\b/gi, 'you'],
  [/\byea\b/gi, 'yeah'],
  [/\bnah\b/gi, 'no'],
  [/\bdamm\b/gi, 'damn'],
  [/\bdam it\b/gi, 'damn it'],
  [/\bdamnit\b/gi, 'damn it'],
  [/\bdammit\b/gi, 'damn it'],
  // apostrophes left out
  [/\b(do|does|did|is|are|was|were|has|have|had|could|would|should|must|ca|wo|ai)nt\b/gi, (m, a) => a + "n't"],
  [/\bim\b/gi, "I'm"],
  [/\bive\b/gi, "I've"],
  [/\b(that|what|there|here|who|where|how|he|she)s\b/gi, (m, a) => a + "'s"],
  [/\b(you|they|we)re\b/gi, (m, a) => a + "'re"],
  [/\b(you|they|we)ll\b/gi, (m, a) => a + "'ll"],
  [/\bits (over|a|an|the|not|so|too|fine|ok|okay|done|here|there|time|me|him|her|them|us|all|going|been|just|very|really|gone|dead|alive)\b/gi, "it's $1"],
];
// typos too short for the general fix
const COMMON_TYPOS = { teh: 'the', hte: 'the', adn: 'and', nad: 'and', taht: 'that', waht: 'what', jsut: 'just', becuase: 'because', becasue: 'because', thier: 'their', recieve: 'receive', wierd: 'weird', definately: 'definitely', alot: 'a lot', untill: 'until', occured: 'occurred', seperate: 'separate', goverment: 'government', knwo: 'know', konw: 'know', dosent: "doesn't", doesnt: "doesn't", ofc: 'of course', prolly: 'probably', probs: 'probably', srsly: 'seriously', tmrw: 'tomorrow', bc: 'because', w: 'with', yall: 'you all', ive: "I've", youve: "you've", theyve: "they've", weve: "we've", whos: "who's", whats: "what's", maintainance: 'maintenance', maintainence: 'maintenance', maintanance: 'maintenance', maintenence: 'maintenance', maintnance: 'maintenance', gambleing: 'gambling', peacefull: 'peaceful', technicall: 'technical' };

// swear words at the start of a line, before the rest of it: a comma, so they are read as an exclamation
const EXCLAIM = /^(\s*)(damn|shit|fuck|crap|wow|oh|ugh|man|dude|bruh|bro|welp|well|yes|no|yeah|ok|okay|guys)\s+(?=[a-z])/i;

/** Shouting: nearly all the Latin letters are capitals. */
function isShoutEn(s) {
  const letters = String(s).match(/[A-Za-z]/g);
  if (!letters || letters.length < 4) return false;
  let up = 0;
  for (const c of letters) if (c !== c.toLowerCase()) up++;
  return up / letters.length >= 0.8 && /[A-Z]{3}/.test(s);
}

class EnglishPrep {
  /**
   * @param dataDir   data folder (english_words.txt: English words, most common first)
   * @param known     () => function(word) -> true for game words, names and slang that must stay as typed
   */
  constructor(dataDir, known) {
    this.dataDir = dataDir;
    this.known = known || (() => false);
    this.rank = null;
  }

  _words() {
    if (this.rank) return this.rank;
    this.rank = new Map();
    try {
      fs.readFileSync(path.join(this.dataDir, 'english_words.txt'), 'utf8')
        .split(/\r?\n/)
        .forEach((w, i) => {
          w = w.trim().toLowerCase();
          if (w && !this.rank.has(w)) this.rank.set(w, i);
        });
    } catch (e) {}
    // chat words the list may not have
    for (const w of ['ok', 'okay', 'yeah', 'yep', 'nope', 'haha', 'gg', 'rip', 'hey', 'hi', 'guys', 'bro', 'dude', 'pls', 'lol', 'medbay', 'brig', 'borg', 'borgs', 'sec', 'ling', 'nukie', 'nukies', 'antag', 'xeno', 'xenos', 'maint', 'maints', 'ahelp', 'emag', 'emagged', 'singulo', 'tesla', 'cargo', 'captain', 'zombie', 'zombies', 'mech', 'pda', 'id', 'clown', 'mime', 'botany', 'chem', 'chemist', 'toxins', 'robotics', 'roboticist', 'janitor', 'hop', 'hos', 'cmo', 'rd', 'ce', 'qm', 'ai', 'ert', 'deathsquad', 'syndie', 'syndicate', 'traitor', 'traitors', 'cult', 'cultist', 'cultists', 'vampire', 'blob', 'slime', 'slimes', 'monkey', 'lizard', 'lizards', 'plasma', 'plasmaman', 'shuttle', 'evac', 'airlock', 'airlocks', 'welder', 'crowbar', 'multitool', 'toolbox', 'stunbaton', 'baton', 'taser', 'flash', 'cuffs', 'handcuffs', 'defib', 'cloner', 'cloning', 'genetics', 'virology', 'xenobio', 'xenobiology', 'perma', 'permabrig', 'gulag', 'admin', 'admins', 'mentor', 'ooc', 'looc', 'ic', 'ssd', 'afk', 'erp', 'metagame', 'powergame', 'grief', 'griefer', 'griefing', 'validhunt', 'valid', 'robust', 'robusted', 'greytide', 'assistant', 'assistants', 'gib', 'gibbed', 'gibbing', 'gibs', 'stun', 'stunned', 'tased', 'flashed', 'cuffed', 'bwoink', 'ahelped', 'nuked', 'borged', 'cloned', 'husk', 'husked', 'dusted', 'spaced', 'stunlock', 'lag', 'laggy', 'tider', 'tiders', 'ghost', 'ghosted', 'ghosting', 'respawn', 'round', 'roundstart', 'midround', 'healthy', 'hypo', 'sleeper', 'cryo', 'brute', 'burn', 'toxin', 'oxy', 'okay', 'shitcurity', 'secoff', 'secoffs', 'warden', 'detective', 'det', 'bartender', 'chef', 'botanist', 'miner', 'miners', 'lavaland', 'engi', 'engineer', 'engineers', 'atmos', 'atmospherics', 'supermatter', 'sm', 'ntr', 'iaa', 'magistrate', 'blueshield', 'bonk', 'bonked', 'bonking', 'bonks', 'smite', 'smited', 'smitten', 'bwoinked', 'banned', 'ban', 'lowpop', 'highpop', 'murderbone', 'murderboning', 'shitsec', 'selfantag', 'validhunting', 'validhunter', 'tiding', 'meta', 'metagaming', 'powergaming', 'rdm', 'rdmed', 'rdming', 'ssd', 'ahelping', 'mhelp', 'mentorhelp', 'dorms', 'bwoinks', 'lmao', 'oof', 'pog', 'poggers', 'cringe', 'based', 'nerfed', 'buffed', 'op']) if (!this.rank.has(w)) this.rank.set(w, 50000);
    return this.rank;
  }

  /** The most common dictionary word one (or, for long words, two) typing mistakes away, or null. */
  correct(word) {
    const rank = this._words();
    const w = word.toLowerCase();
    if (/[^a-z]/.test(w)) return null;
    const common = COMMON_TYPOS[w];
    if (common) return common;
    // a letter held down ("noooo", "yesss", "zombieeee")
    if (/(.)\1\1/.test(w) && w.length >= 3) {
      const two = w.replace(/(.)\1\1+/g, '$1$1');
      const one = w.replace(/(.)\1\1+/g, '$1');
      for (const c of [one, two]) if (rank.has(c) && (c.length > 2 || rank.get(c) < 200)) return c;
      return this.correct(two) || this.correct(one);
    }
    if (rank.has(w) || w.length < 4) return null;
    // plurals and endings of known words are not mistakes
    for (const [suf, rep] of [['s', ''], ['es', ''], ['ed', ''], ['ed', 'e'], ['d', ''], ['ing', ''], ['ing', 'e'], ['ly', ''], ['er', ''], ['ers', ''], ['est', '']]) {
      if (w.endsWith(suf) && rank.has(w.slice(0, w.length - suf.length) + rep)) return null;
    }
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    // (a short word with one wrong letter is too often another real word - "bonk" is not "book" -
    // so for words of five letters or fewer only a missing, extra or swapped letter is fixed)
    const edits1 = (s, wrong = true) => {
      const out = new Set();
      for (let i = 0; i <= s.length; i++) {
        const a = s.slice(0, i);
        const b = s.slice(i);
        if (b) out.add(a + b.slice(1)); // a letter too many
        if (b.length > 1) out.add(a + b[1] + b[0] + b.slice(2)); // two letters swapped
        for (const c of letters) {
          if (b && wrong) out.add(a + c + b.slice(1)); // a wrong letter
          out.add(a + c + b); // a letter left out
        }
      }
      return out;
    };
    // The first letter is rarely the mistake: fixes must keep it (or only swap the first two letters).
    const sameStart = (c) => c[0] === w[0] || (c[0] === w[1] && c[1] === w[0]);
    let best = null;
    const consider = (c, d, maxRank) => {
      const r = rank.get(c);
      if (r === undefined || r > maxRank || c.length < 3 || !sameStart(c)) return;
      if (!best || r < best.r) best = { c, r };
    };
    const e1 = edits1(w, w.length > 5);
    // one mistake: short words only to common words ("ivah" is no fix for the name "ivan")
    for (const c of e1) consider(c, 1, w.length <= 6 ? 12000 : 48000);
    // two mistakes: long words only ("immidietely" -> "immediately")
    if (!best && w.length >= 8) for (const c of e1) for (const c2 of edits1(c)) consider(c2, 2, 30000);
    return best ? best.c : null;
  }

  /**
   * Returns { text, caps }: the English to send, and whether the Russian is to be shouted.
   */
  prepare(input) {
    let text = String(input || '');
    // letters from another keyboard layout or a stray key, standing alone
    text = text.replace(/(^|[^A-Za-zÀ-ɏ])[À-ɏ](?=$|[^A-Za-zÀ-ɏ])/g, '$1');
    text = text.replace(/\s+/g, ' ').trim();
    const caps = isShoutEn(text);
    if (caps) {
      // in small letters, except abbreviations the game uses ("CMO IS DEAD" -> "CMO is dead")
      text = text.replace(/[A-Za-z]+/g, (w) => (w.length <= 4 && this.known(w, true) ? w : w.toLowerCase()));
      text = text.replace(/^([^A-Za-z]*)([a-z])/, (m, a, c) => a + c.toUpperCase());
    }
    for (const [re, to] of EXPAND) text = text.replace(re, to);
    text = text.replace(EXCLAIM, (m, sp, w) => sp + w + ', ');
    // typing mistakes; small-letter names get a capital
    text = text.replace(/[A-Za-z][A-Za-z']*/g, (w) => {
      if (/'/.test(w) || this.known(w, false)) return w;
      const lw = w.toLowerCase();
      const rank = this._words();
      // (the word list is from chat, so it has "teh" and "noooo" too: those are fixed first)
      if (rank.has(lw) && !COMMON_TYPOS[lw] && !/(.)\1\1/.test(lw)) return w;
      const fix = this.correct(w, true);
      if (fix) {
        if (w === w.toUpperCase() && w.length > 1) return fix.toUpperCase();
        if (/^[A-Z]/.test(w)) return fix[0].toUpperCase() + fix.slice(1);
        return fix;
      }
      // not a word and no clear fix: most likely a name
      if (/^[a-z]/.test(w) && w.length >= 3 && /[aeiouy]/.test(lw)) return w[0].toUpperCase() + w.slice(1);
      return w;
    });
    return { text, caps };
  }
}

module.exports = { EnglishPrep, isShoutEn };
