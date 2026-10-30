// SS13 Translator - main program.
// Starts BYOND with the WebView2 DevTools port enabled (localhost only), attaches to every game
// browser window, injects the page translator, and serves the control panel.
'use strict';
const fs = require('fs');
const path = require('path');
const { Translator } = require('./translator.js');
const { CDP } = require('./cdp.js');
const { Launcher } = require('./launcher.js');
const { MapOverlay } = require('./overlay.js');
const { buildWikiLexicon } = require('./wiki.js');
const { Dictionary } = require('./dictionary.js');
const { Telemetry } = require('./telemetry.js');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const CACHE_DIR = path.join(ROOT, 'cache');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ------------------------------------------------------------------ config
const DEFAULT_CFG = {
  enabled: true,
  connect: '',
  launchGame: true,
  closeRunningByond: true,
  byondDir: 'C:\\Program Files (x86)\\BYOND\\bin',
  debugPort: 9222,
  panelPort: 9230,
  openPanelOnStart: true,
  engine: 'google',
  outgoingEngine: 'google',
  googleQuality: 'best', // 'best': the Google Translate website's translator (falls back to 'classic' by itself)
  targetLanguage: 'en',
  deeplKey: '',
  anthropicKey: '',
  anthropicModel: 'claude-haiku-5-5',
  myGender: 'm', // your character's gender: 'm' or 'f' - what you write about yourself uses it ("я устал" / "я устала")
  typeInRussian: true, // translate what you type (say box, input bar, other one-line boxes) into Russian
  sayConfirm: false,
  mapOverlay: true,
  mapOverlayFont: 'game',
  mapOverlayBoxColor: '#0b0d12',
  mapOverlayBoxOpacity: 100,
  mapOverlayBoxFit: 'tight', // 'tight': behind the Russian and the English letters only; 'english': the English letters only; 'cover': the whole bubble
  mapOverlayFollowMs: 33,
  mapOverlayShowInScreenshots: false, // true: screenshots show the English boxes (the overlay then reads the game window, a little slower)
  detailedLogs: true, // logs/events.tsv, logs/summary.txt, logs/overlay/trace.tsv (for improving the translator)
  nativeInputDelayMs: 1000,
  translateSkin: true,
  warmup: true,
  wikiDictionary: true, // build the game dictionary from wiki.ss220.space (every two weeks)
  warmupDelayMs: 300,
  maxConcurrentRequests: 3,
  maxHideMs: 6000,
};
// Options the control panel may change, and how each is applied.
const EDITABLE = {
  enabled: 'page', connect: 'save', launchGame: 'save', closeRunningByond: 'save', byondDir: 'save',
  openPanelOnStart: 'save', engine: 'live', outgoingEngine: 'live', googleQuality: 'live', targetLanguage: 'live', deeplKey: 'live',
  anthropicKey: 'live', anthropicModel: 'live', typeInRussian: 'typing', sayConfirm: 'page', myGender: 'gender',
  mapOverlay: 'overlay',
  mapOverlayFont: 'overlayFont',
  mapOverlayBoxColor: 'overlayFont',
  mapOverlayBoxOpacity: 'overlayFont',
  mapOverlayBoxFit: 'overlayFont',
  mapOverlayShowInScreenshots: 'overlayRestart',
  nativeInputDelayMs: 'controller', translateSkin: 'controller',
  warmup: 'save', wikiDictionary: 'save', detailedLogs: 'save', maxConcurrentRequests: 'live', maxHideMs: 'page',
};
const CONFIG_FILE = path.join(ROOT, 'config.json');
function loadConfig() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.log('config.json missing or invalid (' + e.message + '), using defaults.');
  }
  const cfg = { ...DEFAULT_CFG, ...user };
  // Older config files used a slow warm-up delay.
  if (user.warmupDelayMs === 1500) cfg.warmupDelayMs = DEFAULT_CFG.warmupDelayMs;
  // "english" was the default box size: Russian letters showed next to short English lines
  if (user.mapOverlayBoxFit === 'english' && !user.boxFitChecked) cfg.mapOverlayBoxFit = 'tight';
  cfg.boxFitChecked = true;
  return cfg;
}
function saveConfig() {
  const out = { _help: 'Change these from the control panel (http://127.0.0.1:' + cfg.panelPort + ') or here. See README.md.' };
  for (const k of Object.keys(DEFAULT_CFG)) out[k] = cfg[k];
  for (const k of Object.keys(cfg)) if (!(k in out) && !k.startsWith('_')) out[k] = cfg[k];
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2));
  } catch (e) {
    log('Could not save config.json: ' + e.message);
  }
}
const cfg = loadConfig();
{
  const i = process.argv.indexOf('--connect');
  if (i !== -1 && process.argv[i + 1]) cfg.connect = process.argv[i + 1];
  if (process.argv.includes('--mock')) cfg.engine = cfg.outgoingEngine = 'mock';
  if (process.argv.includes('--no-launch')) cfg.launchGame = false;
  if (process.argv.includes('--no-panel')) cfg.openPanelOnStart = false;
}

// ------------------------------------------------------------------ logging + state
const logFile = path.join(LOG_DIR, 'bridge.log');
fs.writeFileSync(logFile, '');
const state = {
  startedAt: Date.now(),
  connected: false,
  browser: '',
  translatedStrings: 0,
  showOriginal: false,
  logTail: [],
  outgoing: [],
  warmup: { total: 0, done: 0 },
};
function log(msg) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
  console.log(line);
  state.logTail.push(line);
  if (state.logTail.length > 300) state.logTail.splice(0, state.logTail.length - 300);
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch (e) {}
}
function appendFile(name, line) {
  try {
    fs.appendFileSync(path.join(LOG_DIR, name), line + '\n');
  } catch (e) {}
}

cfg._logDir = LOG_DIR;
const translator = new Translator(cfg, path.join(ROOT, 'data'), CACHE_DIR, log);
const dictionary = new Dictionary(translator, path.join(ROOT, 'data'), log);
// detailed logs for improving the translator (logs/events.tsv, logs/summary.txt, logs/overlay/trace.tsv)
const tm = new Telemetry(LOG_DIR, { enabled: cfg.detailedLogs !== false });
translator.tm = tm;
const overlay = new MapOverlay({ root: ROOT, logDir: LOG_DIR, cfg, translator, log, tm });
{
  // how busy this program is: if it ever stalls, translations and bubbles are late
  let expect = Date.now() + 1000;
  const lag = setInterval(() => {
    const now = Date.now();
    tm.sample('translator program: delay of its own timer (ms, 0 = never busy)', Math.max(0, now - expect));
    expect = now + 1000;
  }, 1000);
  if (lag.unref) lag.unref();
  const mem = setInterval(() => {
    const m = process.memoryUsage();
    tm.event('process', { rss_mb: Math.round(m.rss / 1e6), heap_mb: Math.round(m.heapUsed / 1e6), cache: translator.ru2en.size, queue: translator.queueSize(), windows: [...sessions.values()].filter((x) => isGameUrl(x.url)).length });
  }, 60000);
  if (mem.unref) mem.unref();
  tm.addSummary('Translator', () => [
    `engine ${cfg.engine} / typing ${cfg.outgoingEngine}, Google quality ${cfg.googleQuality}, box size ${cfg.mapOverlayBoxFit}, follow every ${cfg.mapOverlayFollowMs} ms`,
    `saved translations ${translator.ru2en.size} (typed ${translator.en2ru.size}), your fixes ${translator.overrides.size} + ${translator.outOverrides.size}, game word forms ${translator.lex ? translator.lex.ru2en.size : 0}`,
    `service requests ${translator.stats.engineCalls} (${translator.stats.engineStrings} texts), errors ${translator.stats.errors}, answered from memory ${translator.stats.cacheHits}`,
    `Google ways: website ${translator.gHealth.web.used ? 'used' : 'not used'}${translator.gHealth.web.offUntil > Date.now() ? ' (switched off now)' : ''}, browser ${translator.gHealth.html.used ? 'used' : 'not used'}${translator.gHealth.html.offUntil > Date.now() ? ' (switched off now)' : ''}`,
    `game windows ${[...sessions.values()].filter((x) => isGameUrl(x.url)).length}, connected ${state.connected}`,
  ]);
}
const ORIGIN = `http://127.0.0.1:${cfg.debugPort}`;
const launcher = new Launcher(cfg, CACHE_DIR, log);
launcher.setDebugArgs(`--remote-debugging-port=${cfg.debugPort} --remote-allow-origins=${ORIGIN}`);

const INJECT_FILE = path.join(__dirname, 'inject.js');
let INJECT_SRC = fs.readFileSync(INJECT_FILE, 'utf8');
function srcVersion(src) {
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16) + '-' + src.length;
}
let INJECT_VERSION = srcVersion(INJECT_SRC);
function pageConfig() {
  return {
    enabled: cfg.enabled !== false && !state.showOriginal,
    sayAutoTranslate: cfg.typeInRussian !== false,
    sayConfirm: cfg.sayConfirm,
    inputsAutoTranslate: cfg.typeInRussian !== false,
    maxHideMs: cfg.maxHideMs,
    mapOverlay: !!cfg.mapOverlay && cfg.enabled !== false && !state.showOriginal,
    panelPort: cfg.panelPort,
    version: INJECT_VERSION,
  };
}
function injectSource() {
  return `window.__ss13tr_cfg=${JSON.stringify(pageConfig())};\n${INJECT_SRC}`;
}
const SKIN_CONTROLS = [
  ['options', 'text'],
  ['hotkeys', 'text'],
  ['emotes', 'text'],
  ['fullscreen-toggle', 'text'],
  ['reconnect', 'text'],
  ['chat', 'text'],
  ['saybutton', 'text'],
  ['whisperbutton', 'text'],
  ['mebutton', 'text'],
  ['oocbutton', 'text'],
  ['mainwindow', 'title'],
  ['popupwindow', 'title'],
].concat(cfg.extraSkinControls || []);

// ------------------------------------------------------------------ sessions
let cdpRef = null;
const sessions = new Map(); // sessionId -> {targetId, url, title, scriptId}
const attachedTargets = new Set();
let controllerSession = null;
const leftovers = new Map();
let leftoversDirty = false;
let warmStarted = false;

const isGameUrl = (u) => /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(u || '') && !new RegExp(':' + cfg.panelPort + '/').test(u);
function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.pathname.split('/').pop() + x.search.slice(0, 40);
  } catch (e) {
    return String(u).slice(0, 80);
  }
}
function evalIn(sessionId, expression) {
  if (!cdpRef) return Promise.resolve();
  return cdpRef.send('Runtime.evaluate', { expression }, sessionId).catch(() => {});
}
function broadcast(expression) {
  for (const sid of sessions.keys()) evalIn(sid, expression);
}

async function reply(cdp, sessionId, contextId, msg) {
  const expression = `window.__ss13tr_recv && window.__ss13tr_recv(${JSON.stringify(msg)})`;
  try {
    await cdp.send('Runtime.evaluate', contextId ? { expression, contextId } : { expression }, sessionId);
  } catch (e) {
    if (contextId) await cdp.send('Runtime.evaluate', { expression }, sessionId).catch(() => {});
  }
}

async function onBinding(cdp, params, sessionId) {
  if (params.name !== '__ss13tr_send') return;
  let msg;
  try {
    msg = JSON.parse(params.payload);
  } catch (e) {
    return;
  }
  const ctx = params.executionContextId;
  if (msg.type === 'chatMsg') {
    overlay.noteChatLine(sessionId + ':' + msg.id, msg);
  } else if (msg.type === 'chatMsgEn') {
    overlay.noteChatEnglish(sessionId + ':' + msg.id, msg.en);
  } else if (msg.type === 'tr') {
    const texts = msg.texts || [];
    const local = {};
    const remote = [];
    for (const t of texts) {
      const r = translator.lookupLocal(t);
      if (r != null) {
        local[t] = r;
        translator.logLocal(t, r, 'live');
      } else remote.push(t);
    }
    state.translatedStrings += texts.length;
    if (Object.keys(local).length) reply(cdp, sessionId, ctx, { type: 'tr', results: local });
    tm.count('game window texts asked for', texts.length);
    tm.count('game window texts known already', texts.length - remote.length);
    if (remote.length) {
      const t0 = Date.now();
      // results go back as soon as they are ready (a few at a time), so one slow batch doesn't hold up
      // everything else that was asked for together with it
      let ready = {};
      let timer = null;
      const send = () => {
        timer = null;
        const r = ready;
        ready = {};
        if (Object.keys(r).length) reply(cdp, sessionId, ctx, { type: 'tr', results: r });
      };
      await Promise.all(
        remote.map((t) =>
          translator
            .toEnglish([t], 'live')
            .then((res) => {
              ready[t] = res[t];
              if (!timer) timer = setTimeout(send, 25);
            })
        )
      );
      if (timer) {
        clearTimeout(timer);
        send();
      }
      tm.sample('game window: new texts translated after (ms)', Date.now() - t0);
      tm.event('page-tr', { page: shortUrl((sessions.get(sessionId) || {}).url || ''), n: texts.length, new: remote.length, ms: Date.now() - t0 });
    }
  } else if (msg.type === 'perf') {
    // a game window's own measurements (every 30 s)
    tm.event('page-perf', { page: msg.url, n: msg.n, p50: msg.p50, p90: msg.p90, max: msg.max, hidden: msg.hidden, memo: msg.memo, unanswered: msg.unanswered });
    if (typeof msg.p50 === 'number') tm.sample('game window: waited for a translation, median (ms)', msg.p50);
    if (typeof msg.p90 === 'number') tm.sample('game window: waited for a translation, 90% (ms)', msg.p90);
    if (msg.unanswered) tm.count('game window texts never answered (15 s)', msg.unanswered);
  } else if (msg.type === 'typing') {
    // you started typing: open the translator's connections so the message is translated sooner
    if (cfg.typeInRussian !== false) translator.warmTyping();
  } else if (msg.type === 'out') {
    let ru = null;
    const t0 = Date.now();
    try {
      // a name box ("Please enter your name"): written in Russian letters, not translated by meaning
      ru = msg.mode === 'name' ? translator.nameToRussian(msg.text) : await translator.toRussian(msg.text);
    } catch (e) {
      log('Outgoing translation error: ' + e.message);
    }
    tm.sample('what you type: translated after (ms)', Date.now() - t0);
    tm.event('typed', { ms: Date.now() - t0, en: msg.text, ru });
    reply(cdp, sessionId, ctx, { type: 'out', id: msg.id, text: ru });
  } else if (msg.type === 'sent') {
    log(`You wrote: "${msg.from}"  ->  "${msg.to}"${msg.native ? ' (input bar)' : ''}`);
    state.outgoing.push({ t: Date.now(), from: msg.from, to: msg.to, where: msg.native ? 'Input bar' : msg.submit ? 'Say box' : 'Text box', seen: false });
    if (state.outgoing.length > 40) state.outgoing.shift();
    appendFile('outgoing.log', `${new Date().toISOString()}\t${msg.from}\t${msg.to}`);
    // the chat window marks your line with the Russian that was sent when it comes back
    broadcast(`window.__ss13tr && window.__ss13tr.noteSent && window.__ss13tr.noteSent(${JSON.stringify({ from: msg.from, to: msg.to })})`);
  } else if (msg.type === 'myName') {
    // you typed a name in Russian yourself: shown back to you in Latin letters, not translated by meaning
    translator.nameFromRussian(msg.ru);
  } else if (msg.type === 'sentSeen') {
    for (let i = state.outgoing.length - 1; i >= 0; i--) {
      const o = state.outgoing[i];
      if (o.to === msg.to && !o.seen) {
        o.seen = true;
        log(`Confirmed: your message appeared in chat in Russian ("${String(msg.to).slice(0, 80)}").`);
        break;
      }
    }
  } else if (msg.type === 'searchMatch') {
    log(`Search: "${String(msg.from).slice(0, 40)}" -> "${String(msg.to).slice(0, 60)}" (${(msg.names || []).join(', ').slice(0, 160)})`);
  } else if (msg.type === 'sendFailed') {
    log(`Could not translate "${String(msg.from).slice(0, 80)}" - nothing was sent. Press Enter again to send it in English, or check your internet connection.`);
  } else if (msg.type === 'leftover') {
    for (const t of msg.items || []) {
      const e = leftovers.get(t) || { count: 0, url: shortUrl(msg.url) };
      e.count++;
      if (e.count === 1) {
        tm.count('Russian texts left untranslated on screen');
        tm.event('leftover', { page: e.url, text: t });
      }
      leftovers.set(t, e);
      leftoversDirty = true;
    }
  } else if (msg.type === 'log') {
    log(`[page ${shortUrl(msg.url)}] ${msg.msg}`);
  } else if (msg.type === 'openPanel') {
    openPanel();
  } else if (msg.type === 'toggleOriginal') {
    setShowOriginal(!state.showOriginal);
  }
}

function controllerOptions() {
  return {
    skinControls: cfg.translateSkin && cfg.enabled !== false ? SKIN_CONTROLS : [],
    nativeInputAutoTranslate: cfg.typeInRussian !== false,
    nativeInputDelayMs: cfg.nativeInputDelayMs,
    nativeInputId: cfg.nativeInputId || 'input',
  };
}
function startController(sessionId) {
  controllerSession = sessionId;
  const s = sessions.get(sessionId);
  log(`Button/input-bar helper running in ${s ? shortUrl(s.url) : sessionId}`);
  evalIn(sessionId, `window.__ss13tr && (window.__ss13tr.stopController(), window.__ss13tr.startController(${JSON.stringify(controllerOptions())}))`);
}
function maybePickController() {
  if (controllerSession && sessions.has(controllerSession)) return;
  controllerSession = null;
  // Only pages served by the game client itself, preferring hidden helper windows.
  const list = [...sessions.entries()].filter(([, s]) => isGameUrl(s.url));
  const pick =
    list.find(([, s]) => /typing_indicator/i.test(s.url)) ||
    list.find(([, s]) => /asset_cache|validate_assets/i.test(s.url)) ||
    list.find(([, s]) => /statbrowser/i.test(s.url + s.title)) ||
    list.find(([, s]) => /tgui-panel|browseroutput/i.test(s.url + s.title));
  if (pick) startController(pick[0]);
}

async function setupSession(cdp, sessionId, info, waiting) {
  const entry = { targetId: info.targetId, url: info.url || '', title: info.title || '', scriptId: null };
  sessions.set(sessionId, entry);
  try {
    await cdp.send('Page.enable', {}, sessionId).catch(() => {});
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Runtime.addBinding', { name: '__ss13tr_send' }, sessionId);
    const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injectSource() }, sessionId);
    entry.scriptId = r && r.identifier;
  } catch (e) {
    log(`Setup failed for ${shortUrl(info.url)}: ${e.message}`);
  } finally {
    // Never leave a window paused, even if setup failed.
    if (waiting) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  }
  cdp.send('Runtime.evaluate', { expression: injectSource() }, sessionId).catch(() => {});
  if (isGameUrl(info.url) || info.url === 'about:blank') log(`Attached: ${shortUrl(info.url)} ${info.title ? '(' + info.title + ')' : ''}`);
  appendFile('pages.log', `${new Date().toISOString()}\tattach\t${info.type}\t${info.url}\t${info.title}`);
  setTimeout(() => {
    const cur = sessions.get(controllerSession);
    if (/typing_indicator/i.test(entry.url) && (!cur || !/typing_indicator/i.test(cur.url))) {
      if (controllerSession) evalIn(controllerSession, 'window.__ss13tr && window.__ss13tr.stopController()');
      startController(sessionId);
    } else maybePickController();
  }, 3000);
}

/** Re-register the injected script (new settings) and push settings to open windows. */
function applyPageConfig() {
  const conf = pageConfig();
  broadcast(`window.__ss13tr && window.__ss13tr.setConfig(${JSON.stringify(conf)})`);
  if (!cdpRef) return;
  for (const [sid, s] of sessions) {
    (async () => {
      if (s.scriptId) await cdpRef.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.scriptId }, sid).catch(() => {});
      const r = await cdpRef.send('Page.addScriptToEvaluateOnNewDocument', { source: injectSource() }, sid).catch(() => null);
      s.scriptId = r && r.identifier;
    })();
  }
}
function applyControllerConfig() {
  if (controllerSession && sessions.has(controllerSession)) startController(controllerSession);
}
function setShowOriginal(on) {
  state.showOriginal = !!on;
  log(on ? 'Showing original Russian.' : 'Showing translation.');
  applyPageConfig();
}

async function connectOnce() {
  let version;
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.debugPort}/json/version`);
    version = await r.json();
  } catch (e) {
    return false;
  }
  if (!version.webSocketDebuggerUrl) return false;
  const cdp = new CDP(version.webSocketDebuggerUrl, ORIGIN, log);
  await cdp.open();
  cdpRef = cdp;
  state.connected = true;
  state.browser = version.Browser || 'WebView2';
  log(`Connected to the game's browser engine (${state.browser}).`);
  sessions.clear();
  attachedTargets.clear();
  controllerSession = null;

  cdp.on('Runtime.bindingCalled', (p, sid) => onBinding(cdp, p, sid).catch((e) => log('binding error: ' + e.message)));
  cdp.on('Runtime.executionContextCreated', (p, sid) => {
    if (sid && sid === controllerSession && p.context && p.context.auxData && p.context.auxData.isDefault) {
      setTimeout(() => startController(sid), 1500);
    }
  });
  const isPageType = (t) => ['page', 'iframe', 'webview'].includes(t);
  cdp.on('Target.attachedToTarget', (p) => {
    const info = p.targetInfo;
    if (!isPageType(info.type) || attachedTargets.has(info.targetId)) {
      if (p.waitingForDebugger) cdp.send('Runtime.runIfWaitingForDebugger', {}, p.sessionId).catch(() => {});
      return;
    }
    attachedTargets.add(info.targetId);
    setupSession(cdp, p.sessionId, info, p.waitingForDebugger);
  });
  cdp.on('Target.detachedFromTarget', (p) => {
    const s = sessions.get(p.sessionId);
    if (s) {
      attachedTargets.delete(s.targetId);
      appendFile('pages.log', `${new Date().toISOString()}\tdetach\t\t${s.url}`);
    }
    sessions.delete(p.sessionId);
    if (p.sessionId === controllerSession) {
      controllerSession = null;
      setTimeout(maybePickController, 1000);
    }
  });
  cdp.on('Target.targetInfoChanged', (p) => {
    for (const [, s] of sessions) {
      if (s.targetId === p.targetInfo.targetId) {
        if (s.url !== p.targetInfo.url && isGameUrl(p.targetInfo.url)) {
          appendFile('pages.log', `${new Date().toISOString()}\tnavigate\t\t${p.targetInfo.url}\t${p.targetInfo.title}`);
        }
        s.url = p.targetInfo.url;
        s.title = p.targetInfo.title;
      }
    }
  });
  const attach = async (info) => {
    if (!isPageType(info.type) || attachedTargets.has(info.targetId) || info.attached) return;
    try {
      await cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
    } catch (e) {
      log('attach failed: ' + e.message);
    }
  };
  cdp.on('Target.targetCreated', (p) => setTimeout(() => attach(p.targetInfo), 300));

  try {
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  } catch (e) {
    log('Auto-attach not available (' + e.message + '), using discovery.');
  }
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const { targetInfos } = await cdp.send('Target.getTargets');
  for (const t of targetInfos) attach(t);

  if (cfg.warmup && !warmStarted) {
    warmStarted = true;
    warmUp();
  }
  await new Promise((resolve) => cdp.on('close', resolve));
  state.connected = false;
  cdpRef = null;
  log('Game closed (or reconnecting) - waiting for it to come back.');
  sessions.clear();
  return true;
}

async function connectLoop() {
  let announced = false;
  for (;;) {
    const ok = await connectOnce().catch((e) => {
      log('Connection error: ' + e.message);
      state.connected = false;
      return false;
    });
    if (!ok && !announced) {
      announced = true;
      log(`Waiting for the game on port ${cfg.debugPort}...`);
    }
    if (ok) announced = false;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ------------------------------------------------------------------ warm-up + self test
async function warmUp() {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'warmup.json'), 'utf8'));
  } catch (e) {
    return;
  }
  const todo = list.filter((s) => translator.lookupLocal(s) == null);
  state.warmup = { total: todo.length, done: 0 };
  if (!todo.length) return;
  log(`Pre-translating ${todo.length} interface strings in the background (only on the first runs)...`);
  for (let i = 0; i < todo.length; i += 50) {
    const chunk = todo.slice(i, i + 50);
    await translator.toEnglish(chunk, 'warm');
    state.warmup.done += chunk.length;
  }
  translator.save();
  log('Pre-translation finished.');
}

// ------------------------------------------------------------------ wiki dictionary
const wikiState = { running: false, error: '', last: '' };
async function updateWiki(reason) {
  if (wikiState.running) return;
  wikiState.running = true;
  wikiState.error = '';
  log(`Building the game dictionary from wiki.ss220.space (${reason}) - in the background, about a minute...`);
  try {
    const r = await buildWikiLexicon({ dataDir: path.join(ROOT, 'data'), log });
    translator.reloadData();
    wikiState.last = `${r.pairs} word pairs from ${r.pages} pages`;
  } catch (e) {
    wikiState.error = e.message;
    log('Could not read the wiki (' + e.message + '). The translator works without it; it will try again next start.');
  } finally {
    wikiState.running = false;
  }
}
function maybeUpdateWiki() {
  if (cfg.wikiDictionary === false) return;
  let age = Infinity;
  try {
    age = Date.now() - fs.statSync(path.join(ROOT, 'data', 'wiki_lexicon.json')).mtimeMs;
  } catch (e) {}
  if (age > 14 * 24 * 3600 * 1000) updateWiki(age === Infinity ? 'first run' : 'two weeks old');
}

async function selfTest() {
  try {
    const res = await translator.toEnglish(['Добро пожаловать на станцию!', 'Настройка персонажа', 'Осталось 15 секунд']);
    log('Self-test RU->EN: ' + JSON.stringify(res));
    const ru = await translator.toRussian('Hello, can someone open the door to medbay?');
    log('Self-test EN->RU: ' + JSON.stringify(ru));
    state.engineOk = !!ru && Object.values(res).every((v) => v != null);
    if (!state.engineOk) log('WARNING: the translation service did not answer. Check your internet connection or the engine in the control panel.');
  } catch (e) {
    state.engineOk = false;
    log('Self-test failed: ' + e.message);
  }
}

// ------------------------------------------------------------------ control panel
const PANEL_FILE = path.join(ROOT, 'ui', 'panel.html');
function panelUrl() {
  return `http://127.0.0.1:${cfg.panelPort}/`;
}
let lastPanelRequest = 0; // when the panel last asked for /api/state (it does every second while open)
const BOOT_ID = Date.now().toString(36); // tells panel windows that the translator was restarted
const panelPages = new Map(); // panel window id -> last time it asked for the state
let panelCheck = null;
function openPanel(attempt = 0) {
  const url = panelUrl();
  const edges = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const edge = edges.find((p) => fs.existsSync(p));
  const openedAt = Date.now();
  try {
    // Edge's app window first; the default browser if that didn't show the panel.
    if (edge && attempt < 2) Bun.spawn([edge, `--app=${url}`, '--window-size=540,860'], { stdout: 'ignore', stderr: 'ignore' });
    else Bun.spawn(['cmd', '/c', 'start', '', url], { stdout: 'ignore', stderr: 'ignore' });
  } catch (e) {
    log('Open the control panel in your browser: ' + url);
  }
  // Sometimes the window opens before Windows is ready and stays blank or never appears: if the panel
  // hasn't loaded after a while, open it again.
  clearTimeout(panelCheck);
  panelCheck = setTimeout(() => {
    if (lastPanelRequest >= openedAt) return;
    if (attempt >= 2) {
      log('The control panel did not open by itself. Open it in your browser: ' + url);
      return;
    }
    log('The control panel did not load - opening it again...');
    openPanel(attempt + 1);
  }, attempt === 0 ? 9000 : 7000);
}
function publicConfig() {
  const out = {};
  for (const k of Object.keys(EDITABLE)) out[k] = cfg[k];
  out.deeplKey = cfg.deeplKey ? '••••' + cfg.deeplKey.slice(-4) : '';
  out.anthropicKey = cfg.anthropicKey ? '••••' + cfg.anthropicKey.slice(-4) : '';
  return out;
}
function apiState() {
  const gameWindows = [...sessions.values()].filter((s) => isGameUrl(s.url));
  return {
    connected: state.connected,
    gameWindows: gameWindows.length,
    windows: gameWindows.map((s) => shortUrl(s.url)).slice(0, 30),
    showOriginal: state.showOriginal,
    engineOk: state.engineOk,
    launch: { status: launcher.status, problem: launcher.problem, strategy: launcher.state.strategy },
    cache: translator.ru2en.size,
    translatedStrings: state.translatedStrings,
    queue: translator.queueSize(),
    errors: translator.stats.errors,
    pausedUntil: translator.pausedUntil,
    warmup: state.warmup,
    leftovers: [...leftovers.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 60)
      .map(([text, e]) => ({ text, count: e.count, where: e.url })),
    outgoing: state.outgoing.slice(-20).reverse(),
    log: state.logTail.slice(-120),
    recentServers: launcher.recentServers(),
    config: publicConfig(),
    panelPort: cfg.panelPort,
    overlay: overlay.info(),
    wiki: {
      running: wikiState.running,
      error: wikiState.error,
      built: translator.lex ? translator.lex.wikiBuilt : null,
      pairs: translator.lex ? translator.lex.wikiPairs : 0,
      used: translator.lex ? translator.lex.wikiUsed : 0,
      game: translator.lex ? translator.lex.ru2en.size + translator.lex.en2ru.size : 0,
      offline: translator.lex ? translator.lex.offline : 0,
    },
  };
}
async function applyConfigPatch(patch) {
  const kinds = new Set();
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in EDITABLE)) continue;
    if ((k === 'deeplKey' || k === 'anthropicKey') && typeof v === 'string' && v.startsWith('••••')) continue;
    const def = DEFAULT_CFG[k];
    let val = v;
    if (typeof def === 'boolean') val = !!v;
    else if (typeof def === 'number') {
      val = Number(v);
      if (!Number.isFinite(val)) continue;
    } else val = String(v == null ? '' : v).trim();
    if (k === 'myGender' && val !== 'm' && val !== 'f') continue;
    cfg[k] = val;
    kinds.add(EDITABLE[k]);
  }
  saveConfig();
  if (kinds.has('overlayFont')) overlay.setStyle();
  if (kinds.has('overlayRestart') && !kinds.has('overlay') && cfg.mapOverlay) {
    overlay.stop();
    setTimeout(() => overlay.start(), 1200);
  }
  if (kinds.has('overlay')) {
    if (cfg.mapOverlay) overlay.start();
    else overlay.stop();
    applyPageConfig();
  }
  if (kinds.has('page') || kinds.has('controller') || kinds.has('typing')) applyPageConfig();
  if (kinds.has('controller') || kinds.has('typing') || 'enabled' in (patch || {})) applyControllerConfig();
  if (kinds.has('gender')) log(`Your character is ${cfg.myGender === 'f' ? 'female' : 'male'}: what you write about yourself is sent that way ("${cfg.myGender === 'f' ? 'я устала' : 'я устал'}").`);
  if (kinds.has('typing')) log(cfg.typeInRussian !== false ? 'What you type will be translated into Russian.' : 'What you type is sent as you typed it (no translation).');
  if (kinds.has('live')) {
    translator.googleMode = 'batch';
    if ('googleQuality' in patch) for (const k in translator.gHealth) Object.assign(translator.gHealth[k], { fails: 0, offUntil: 0, used: false });
    log(`Settings saved. Engine: ${cfg.engine}, outgoing: ${cfg.outgoingEngine}.`);
    if ('engine' in patch || 'outgoingEngine' in patch || 'deeplKey' in patch || 'anthropicKey' in patch) selfTest();
  } else log('Settings saved.');
}
async function doAction(body) {
  const a = body.action;
  if (a === 'restart') {
    launcher.launch(cfg.connect, () => state.connected);
  } else if (a === 'join') {
    const url = String(body.url || '').trim();
    if (!/^byond:\/\/[^\s"'&|<>^]+$/i.test(url)) return { ok: false, error: 'Enter an address like byond://game.ss220.space:7721' };
    launcher.launch(url, () => state.connected);
  } else if (a === 'hub') {
    launcher.launch('', () => state.connected);
  } else if (a === 'toggleOriginal') {
    setShowOriginal(!state.showOriginal);
  } else if (a === 'rescan') {
    broadcast('window.__ss13tr && window.__ss13tr.rescan()');
    log('Re-scanning all game windows.');
  } else if (a === 'clearLeftovers') {
    leftovers.clear();
    leftoversDirty = true;
  } else if (a === 'clearCache') {
    translator.clearCache();
    broadcast('window.__ss13tr && window.__ss13tr.clearMemo()');
    log('Translation cache cleared. Text will be translated again as it appears.');
  } else if (a === 'wikiUpdate') {
    updateWiki('asked from the control panel');
  } else if (a === 'restartOverlay') {
    overlay.stop();
    setTimeout(() => overlay.start(), 1200);
  } else if (a === 'snapshot') {
    const n = await takeSnapshots();
    log(`Saved snapshots of ${n} game windows to logs\\snapshots.`);
  } else if (a === 'openLogs') {
    try {
      Bun.spawn(['explorer', LOG_DIR], { stdout: 'ignore', stderr: 'ignore' });
    } catch (e) {}
  } else if (a === 'stop') {
    setTimeout(() => {
      cleanup();
      process.exit(0);
    }, 300);
  } else return { ok: false, error: 'Unknown action' };
  return { ok: true };
}
/**
 * The panel's port is taken: usually by a translator window that is still open from before (maybe
 * minimised). Ask that one to stop, so this one can take over.
 */
async function stopOtherInstance() {
  const base = `http://127.0.0.1:${cfg.panelPort}`;
  try {
    const r = await fetch(base + '/api/state', { signal: AbortSignal.timeout(3000) });
    const st = await r.json();
    if (!st || typeof st.connected !== 'boolean') return false;
    await fetch(base + '/api/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ss13tr': '1' }, body: JSON.stringify({ action: 'stop' }), signal: AbortSignal.timeout(3000) }).catch(() => {});
    log('Another translator window was still running - it has been closed so this one can take over.');
    return true;
  } catch (e) {
    return false;
  }
}
async function startPanelServerRetrying() {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (startPanelServer(attempt < 7)) return true;
    if (attempt === 0) await stopOtherInstance();
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
function startPanelServer(quiet) {
  const allowedHosts = new Set([`127.0.0.1:${cfg.panelPort}`, `localhost:${cfg.panelPort}`]);
  try {
    Bun.serve({
      hostname: '127.0.0.1',
      port: cfg.panelPort,
      async fetch(req) {
        const url = new URL(req.url);
        // Only answer requests addressed to this PC's panel (blocks DNS-rebinding tricks).
        if (!allowedHosts.has(req.headers.get('host') || '')) return new Response('forbidden', { status: 403 });
        const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
          return new Response(fs.readFileSync(PANEL_FILE), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
        }
        if (req.method === 'GET' && url.pathname === '/icon.png') {
          try {
            return new Response(fs.readFileSync(path.join(ROOT, 'ui', 'icon64.png')), { headers: { 'content-type': 'image/png' } });
          } catch (e) {
            return new Response('', { status: 404 });
          }
        }
        if (req.method === 'GET' && url.pathname === '/api/state') {
          lastPanelRequest = Date.now();
          const pid = (url.searchParams.get('pid') || '').slice(0, 40);
          if (pid) panelPages.set(pid, Date.now());
          for (const [k, t] of panelPages) if (Date.now() - t > 4000) panelPages.delete(k);
          const st = apiState();
          st.boot = BOOT_ID;
          st.panels = panelPages.size;
          return json(st);
        }
        if (req.method === 'POST') {
          // Websites in your browser cannot send this custom header to localhost without permission.
          if (req.headers.get('x-ss13tr') !== '1') return json({ ok: false, error: 'forbidden' }, 403);
          let body = {};
          try {
            body = await req.json();
          } catch (e) {}
          if (url.pathname === '/api/config') {
            await applyConfigPatch(body);
            return json({ ok: true, config: publicConfig() });
          }
          if (url.pathname === '/api/action') return json(await doAction(body));
          if (url.pathname === '/api/dict') {
            lastPanelRequest = Date.now();
            const r = await dictionary.handle(body);
            if (r && r.ok && r.page) applyPageUpdate(r.page);
            return json(r);
          }
          if (url.pathname === '/api/translate') {
            const text = String(body.text || '').slice(0, 4000);
            const res = body.dir === 'en-ru' ? await translator.toRussian(text) : (await translator.toEnglish([text]))[text];
            return json({ ok: res != null, result: res });
          }
        }
        return new Response('not found', { status: 404 });
      },
    });
    log(`Control panel: ${panelUrl()}  (opens automatically; in game press Ctrl+Alt+S)`);
    return true;
  } catch (e) {
    if (!quiet) log(`Control panel could not start on port ${cfg.panelPort}: ${e.message}. Close other translator windows and start it again.`);
    return false;
  }
}

// ------------------------------------------------------------------ live reload of fixes
// Editing src/inject.js, data/glossary.json or data/overrides.json applies to the running game
// without restarting anything.
function watchFile(file, fn) {
  let timer = null;
  try {
    fs.watch(file, () => {
      clearTimeout(timer);
      timer = setTimeout(fn, 600);
    });
  } catch (e) {}
}
watchFile(INJECT_FILE, () => {
  try {
    const src = fs.readFileSync(INJECT_FILE, 'utf8');
    const v = srcVersion(src);
    if (v === INJECT_VERSION || src.length < 1000) return;
    INJECT_SRC = src;
    INJECT_VERSION = v;
    log('Page script updated - reloading it in every game window.');
    applyPageConfig();
    broadcast(injectSource());
    setTimeout(applyControllerConfig, 1500);
  } catch (e) {
    log('Page script reload failed: ' + e.message);
  }
});
// After a change on the Dictionary page: show the corrected English in the game windows straight away.
function applyPageUpdate(page) {
  try {
    if (page.refresh) broadcast('window.__ss13tr && window.__ss13tr.refresh && window.__ss13tr.refresh()');
    else if (page.fixes) broadcast(`window.__ss13tr && window.__ss13tr.applyFixes && window.__ss13tr.applyFixes(${JSON.stringify(page.fixes)})`);
    else if (page.forget) broadcast(`window.__ss13tr && window.__ss13tr.forget && window.__ss13tr.forget(${JSON.stringify(page.forget)})`);
  } catch (e) {}
}
function reloadData() {
  // the Dictionary page saved this file itself and already updated everything
  if (Date.now() - translator.selfWriteAt < 2500) return;
  translator.reloadData();
  log(`Fixed translations / glossary reloaded (${translator.overrides.size} fixed translations).`);
  broadcast('window.__ss13tr && window.__ss13tr.refresh && window.__ss13tr.refresh()');
}
const OVERRIDES_FILE = path.join(ROOT, 'data', 'overrides.json');
if (!fs.existsSync(OVERRIDES_FILE)) {
  try {
    fs.writeFileSync(OVERRIDES_FILE, JSON.stringify({ _help: 'Exact Russian text -> the English you want shown. Saved changes apply to the running game.' }, null, 2));
  } catch (e) {}
}
watchFile(OVERRIDES_FILE, reloadData);
watchFile(path.join(ROOT, 'data', 'glossary.json'), reloadData);
watchFile(path.join(ROOT, 'data', 'lexicon_game.json'), reloadData);
watchFile(path.join(ROOT, 'data', 'overrides_outgoing.json'), reloadData);
watchFile(path.join(ROOT, 'data', 'slang.json'), reloadData);

// Snapshots of every game window, for diagnosing text that stays Russian.
const SNAP_DIR = path.join(LOG_DIR, 'snapshots');
try {
  fs.rmSync(SNAP_DIR, { recursive: true, force: true });
} catch (e) {}
async function takeSnapshots() {
  if (!cdpRef || !state.connected) return 0;
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  let n = 0;
  for (const [sid, s] of sessions) {
    if (!isGameUrl(s.url)) continue;
    try {
      const r = await cdpRef.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__ss13tr ? window.__ss13tr.snapshot() : {missing:true, url: location.href, text: document.body ? document.body.innerText.slice(0,5000) : ""})', returnByValue: true }, sid);
      const snap = JSON.parse((r && r.result && r.result.value) || '{}');
      const name = (shortUrl(s.url) || 'page').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60);
      const lines = [`URL: ${s.url}`, `Title: ${s.title}`, `Script: ${snap.missing ? 'NOT INJECTED' : snap.version}  enabled=${snap.enabled}`, ''];
      lines.push(`--- Russian text nodes still on screen (${(snap.russian || []).length}) ---`);
      for (const r2 of snap.russian || []) lines.push(`* ${r2.text}${r2.pending ? '   [waiting for translation]' : ''}\n  HTML: ${r2.html.replace(/\s+/g, ' ')}`);
      lines.push('', '--- Visible text ---', snap.text || '');
      fs.writeFileSync(path.join(SNAP_DIR, `${sid.slice(0, 6)}_${name}.txt`), lines.join('\n'));
      n++;
    } catch (e) {}
  }
  return n;
}
setInterval(() => takeSnapshots().catch(() => {}), 60000);

// ------------------------------------------------------------------ periodic + shutdown
setInterval(() => {
  if (leftoversDirty) {
    leftoversDirty = false;
    const lines = [...leftovers.entries()].sort((a, b) => b[1].count - a[1].count).map(([t, e]) => `${e.count}\t${e.url}\t${t}`);
    try {
      fs.writeFileSync(path.join(LOG_DIR, 'leftovers.txt'), lines.join('\n'));
    } catch (e) {}
  }
}, 15000);
setInterval(() => {
  const st = translator.stats;
  appendFile(
    'status.log',
    `${new Date().toISOString()}\tconnected=${state.connected}\tgameWindows=${[...sessions.values()].filter((s) => isGameUrl(s.url)).length}\tcache=${translator.ru2en.size}\tqueue=${translator.queueSize()}\tengineCalls=${st.engineCalls}\terrors=${st.errors}`
  );
}, 30000);

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    translator.save();
    translator._flushTrLog();
    tm.event('stop', {});
    tm.flushNow();
  } catch (e) {}
  try {
    overlay.stop(true);
  } catch (e) {}
  launcher.cleanup();
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  } catch (e) {}
}

(async () => {
  log('SS13 Translator starting. Keep this window open while you play; close it to stop.');
  log(`Engine: ${cfg.engine} (outgoing: ${cfg.outgoingEngine})${cfg.googleQuality === 'classic' ? ', classic Google' : ', Google at website quality'}.`);
  const panelOk = await startPanelServerRetrying();
  if (panelOk && cfg.openPanelOnStart) openPanel(); // right away: it doesn't wait for BYOND
  selfTest();
  let target = cfg.connect;
  if (process.argv.includes('--join-last')) {
    const last = launcher.recentServers()[0];
    if (last) target = last.url;
    else log('No recently joined server found - opening the BYOND hub instead.');
  }
  if (cfg.launchGame) launcher.launch(target, () => state.connected);
  else {
    launcher.setRegistry(true);
    log('Not starting BYOND (launchGame is off). Start BYOND yourself AFTER this window is open.');
  }
  if (cfg.mapOverlay) setTimeout(() => overlay.start(), 2000);
  setTimeout(maybeUpdateWiki, 45000);
  connectLoop();
})();
