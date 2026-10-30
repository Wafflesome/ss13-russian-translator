// Builds data/wiki_lexicon.json from the SS220 wiki (https://wiki.ss220.space), so game words are
// translated the way the server's own community names them.
//
// The wiki is a MediaWiki site. Its pages have Russian titles, and almost every English name of a page
// is a redirect to it ("Blob" -> "Блоб"); item tables use the template {{Название|Russian|English}}, and
// texts often write "Русское (English)". All three are collected, page by page, through the wiki's
// public API (a few dozen requests, one at a time, so the wiki isn't strained).
'use strict';
const fs = require('fs');
const path = require('path');

const API = process.env.SS13TR_WIKI_API || 'https://wiki.ss220.space/api.php';
const UA = 'SS13RussianTranslator/1.0 (personal dictionary for a player; one request at a time)';
const CYR = /[А-Яа-яЁё]/;
const LAT = /[A-Za-z]/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(params) {
  const url = API + '?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.code + ': ' + j.error.info);
      return j;
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

/** Every page of a namespace (titles), following the API's continuation. */
async function allPages(ns, filter, onPage) {
  let cont = {};
  for (;;) {
    const j = await api({ action: 'query', list: 'allpages', apnamespace: String(ns), apfilterredir: filter, aplimit: 'max', ...cont });
    for (const p of (j.query && j.query.allpages) || []) onPage(p.title);
    if (!j.continue) break;
    cont = j.continue;
    await sleep(250);
  }
}

/** Wiki markup -> plain words. */
function plain(s) {
  return String(s || '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s.,:;!?«»"'()-]+|[\s.,:;!?«»"'()-]+$/g, '');
}

const RU_STOP = new Set(['и', 'в', 'на', 'с', 'со', 'к', 'по', 'из', 'от', 'до', 'для', 'а', 'но', 'или', 'же', 'не', 'это', 'как', 'что', 'при', 'под', 'над', 'за', 'о', 'об', 'у']);

function extract(title, text, add) {
  // {{Название|Русское|English|картинка}}
  const tpl = /\{\{\s*Название\s*\|([^|}]+)\|([^|}]+)/g;
  let m;
  while ((m = tpl.exec(text))) add(plain(m[1]), plain(m[2]), 'template', title);
  // Русское (English) / Русское (англ. English)
  const par = /((?:[А-ЯЁа-яё][А-ЯЁа-яё-]*\s+){0,3}[А-ЯЁа-яё][А-ЯЁа-яё-]*)\s*\(\s*(?:англ\.?\s*)?(?:''|«)?([A-Z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,3})(?:''|»)?\s*\)/g;
  const flat = text.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1').replace(/'{2,}/g, '');
  while ((m = par.exec(flat))) {
    const en = plain(m[2]);
    const enWords = en.split(' ').length;
    let ruWords = plain(m[1]).split(' ').filter(Boolean);
    // as many Russian words as English ones (Russian adjectives come first, like English)
    ruWords = ruWords.slice(Math.max(0, ruWords.length - enWords));
    while (ruWords.length && RU_STOP.has(ruWords[0].toLowerCase())) ruWords.shift();
    if (!ruWords.length) continue;
    add(ruWords.join(' '), en, 'text', title);
  }
}

/**
 * Crawls the wiki and writes the dictionary. `log` gets progress lines. Returns {pairs, pages}.
 */
async function buildWikiLexicon({ dataDir, log }) {
  log = log || (() => {});
  const pairs = new Map(); // ru|en -> {ru, en, src, n, page}
  const add = (ru, en, src, page) => {
    ru = String(ru || '').trim();
    en = String(en || '').trim();
    if (!ru || !en || !CYR.test(ru) || CYR.test(en) || !LAT.test(en)) return;
    if (/\.php|[\/\\]/i.test(en)) return; // a page address, not a name
    if (ru.length > 60 || en.length > 60 || ru.split(' ').length > 6 || en.split(' ').length > 6) return;
    const key = ru.toLowerCase() + '|' + en.toLowerCase();
    const e = pairs.get(key);
    if (e) {
      e.n++;
      if (src !== 'text' && e.src === 'text') e.src = src;
    } else pairs.set(key, { ru, en, src, n: 1, page });
  };

  // 1) English page names that lead to the Russian pages
  const redirects = [];
  for (const ns of [0, 10, 14]) await allPages(ns, 'redirects', (t) => redirects.push(t));
  log(`Wiki: ${redirects.length} page names to resolve...`);
  for (let i = 0; i < redirects.length; i += 50) {
    const batch = redirects.slice(i, i + 50);
    const j = await api({ action: 'query', titles: batch.join('|'), redirects: '1' });
    for (const r of (j.query && j.query.redirects) || []) {
      const from = r.from.replace(/^(Template|Шаблон|Category|Категория):/, '');
      const to = r.to.replace(/^(Template|Шаблон|Category|Категория):/, '');
      if (LAT.test(from) && !CYR.test(from) && CYR.test(to)) add(to, from, 'redirect', to);
      else if (CYR.test(from) && LAT.test(to) && !CYR.test(to)) add(from, to, 'redirect', to);
    }
    await sleep(250);
  }

  // 2) The text of every page (articles and templates: the item tables live in both)
  const pages = [];
  for (const ns of [0, 10]) await allPages(ns, 'nonredirects', (t) => pages.push(t));
  log(`Wiki: reading ${pages.length} pages...`);
  let done = 0;
  for (let i = 0; i < pages.length; i += 25) {
    const batch = pages.slice(i, i + 25);
    let j;
    try {
      j = await api({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: batch.join('|') });
    } catch (e) {
      log('Wiki: skipped some pages (' + e.message + ')');
      continue;
    }
    for (const p of (j.query && j.query.pages) || []) {
      const rev = p.revisions && p.revisions[0];
      const text = rev && ((rev.slots && rev.slots.main && rev.slots.main.content) || rev.content);
      if (text) extract(p.title, text, add);
      done++;
    }
    if (i % 250 === 0 && i) log(`Wiki: ${done} of ${pages.length} pages read, ${pairs.size} word pairs so far`);
    await sleep(300);
  }

  const list = [...pairs.values()].sort((a, b) => (a.ru < b.ru ? -1 : 1));
  const out = {
    _help: 'Built automatically from https://wiki.ss220.space (Russian -> English game words). Rebuilt every two weeks, or from the control panel.',
    built: new Date().toISOString(),
    pages: pages.length + redirects.length,
    pairs: list,
  };
  const file = path.join(dataDir, 'wiki_lexicon.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(out, null, 0));
  fs.renameSync(file + '.tmp', file);
  log(`Wiki dictionary ready: ${list.length} word pairs from ${out.pages} wiki pages.`);
  return { pairs: list.length, pages: out.pages };
}

module.exports = { buildWikiLexicon, extract, plain };
