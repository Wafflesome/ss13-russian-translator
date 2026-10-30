/*
 * SS13 Translator - page script.
 * Injected into every BYOND WebView2 page (chat, stat panel, lobby, TGUI windows, popups).
 * It only changes what is DISPLAYED: text nodes and a few display attributes.
 * Game data, links and click handlers are never touched.
 */
(function () {
  'use strict';
  var VERSION = (window.__ss13tr_cfg && window.__ss13tr_cfg.version) || 'dev';
  if (window.__ss13tr && window.__ss13tr.alive) {
    if (window.__ss13tr.version === VERSION) {
      if (window.__ss13tr_cfg) window.__ss13tr.setConfig(window.__ss13tr_cfg);
      window.__ss13tr.rescan();
      return;
    }
    // A newer translator script was installed while the game is running: replace the old one.
    try {
      window.__ss13tr.destroy();
    } catch (e) {}
  }
  // The BYOND hub's own pages are English and are left alone.
  if (location.protocol === 'file:' && /\/BYOND\/pager\//i.test(decodeURIComponent(location.pathname))) return;
  // ...and so is the translator's own control panel.
  if (window.__ss13tr_cfg && window.__ss13tr_cfg.panelPort && location.port === String(window.__ss13tr_cfg.panelPort)) return;
  var CFG = {};
  var initialCfg = window.__ss13tr_cfg || {};
  for (var ck in initialCfg) CFG[ck] = initialCfg[ck];
  var CYR = /[А-Яа-яЁё]/;
  var LAT = /[A-Za-z]/;
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 0 };
  var ATTRS = ['title', 'placeholder', 'alt', 'aria-label', 'data-tooltip', 'value'];
  var HIDE_CLASS = 'ss13tr-hide';
  var MAX_HIDE_MS = CFG.maxHideMs || 6000;

  var memo = new Map(); // russian core text -> english
  var waiting = new Map(); // russian core text -> [callback]
  var outQueue = [];
  var flushTimer = null;
  var reqId = 0;
  var replyWaiters = new Map(); // request id -> callback (for en->ru)
  var nodeState = new WeakMap(); // Text node -> {ru, en}
  var attrState = new WeakMap(); // Element -> {attrName: {ru, en}}
  var labelSeen = new Map(); // russian core text -> when it was last shown in English (for search boxes)
  var enabled = CFG.enabled !== false;
  var timers = [];
  var every = function (fn, ms) {
    var t = setInterval(fn, ms);
    timers.push(t);
    return t;
  };
  var stats = { translated: 0, requested: 0 };
  // how long this window waits for translations (sent to the translator's detailed logs every 30 s)
  var perf = { since: new Map(), ms: [], hidden: 0, memo: 0 };

  function send(msg) {
    try {
      if (typeof window.__ss13tr_send === 'function') {
        window.__ss13tr_send(JSON.stringify(msg));
        return true;
      }
    } catch (e) {}
    return false;
  }
  function log(msg) {
    send({ type: 'log', msg: String(msg), url: location.href });
  }

  // ------------------------------------------------------------ translation
  function request(key, cb) {
    var list = waiting.get(key);
    if (list) {
      list.push(cb);
      return;
    }
    waiting.set(key, [cb]);
    perf.since.set(key, Date.now());
    outQueue.push(key);
    stats.requested++;
    if (!flushTimer) flushTimer = setTimeout(flush, 15);
  }
  function flush() {
    flushTimer = null;
    if (!outQueue.length) return;
    var batch = outQueue.splice(0, 200);
    if (!send({ type: 'tr', dir: 'ru-en', id: ++reqId, texts: batch })) {
      // Bridge binding not ready yet: retry shortly.
      outQueue = batch.concat(outQueue);
      flushTimer = setTimeout(flush, 250);
      return;
    }
    if (outQueue.length) flushTimer = setTimeout(flush, 15);
  }
  function deliver(results) {
    for (var key in results) {
      if (!Object.prototype.hasOwnProperty.call(results, key)) continue;
      var en = results[key];
      if (typeof en === 'string') memo.set(key, en);
      var cbs = waiting.get(key);
      waiting.delete(key);
      var t0 = perf.since.get(key);
      if (t0) {
        perf.since.delete(key);
        if (perf.ms.length < 500) perf.ms.push(Date.now() - t0);
      }
      if (cbs) {
        for (var i = 0; i < cbs.length; i++) {
          try {
            cbs[i](typeof en === 'string' ? en : null);
          } catch (e) {}
        }
      }
    }
  }

  // ------------------------------------------------------------ DOM helpers
  function skipped(node) {
    var el = node.nodeType === 1 ? node : node.parentNode;
    while (el && el.nodeType === 1) {
      if (SKIP_TAGS[el.tagName] === 1) return true;
      if (el.isContentEditable) return true;
      if (el.classList && el.classList.contains('ss13tr-skip')) return true;
      el = el.parentNode;
    }
    return false;
  }
  function splitWs(text) {
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    return { lead: m[1], core: m[2], trail: m[3] };
  }
  function normKey(core) {
    return core.replace(/\s+/g, ' ');
  }
  function hideTarget(node) {
    var el = node.parentElement;
    if (!el) return null;
    var msg = el.closest ? el.closest('.ChatMessage') : null;
    if (msg) return msg;
    if (el === document.body || el === document.documentElement || el.tagName === 'TITLE') return null;
    return el;
  }
  function hide(el) {
    if (!el) return function () {};
    ensureStyle();
    el.__ss13trPending = (el.__ss13trPending || 0) + 1;
    perf.hidden++;
    el.classList.add(HIDE_CLASS);
    var done = false;
    var release = function () {
      if (done) return;
      done = true;
      el.__ss13trPending--;
      if (el.__ss13trPending <= 0) {
        el.__ss13trPending = 0;
        el.classList.remove(HIDE_CLASS);
      }
    };
    setTimeout(release, MAX_HIDE_MS);
    return release;
  }
  // Keep chat glued to the bottom when translated text changes line heights.
  var scroller = null;
  function findScroller(el) {
    while (el && el !== document.body) {
      var s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return document.scrollingElement;
  }
  function withScrollKeep(el, fn) {
    var msg = el && el.closest ? el.closest('.ChatMessage') : null;
    if (!msg) return fn();
    if (!scroller || !scroller.isConnected) scroller = findScroller(msg.parentElement);
    var atBottom = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    fn();
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  }

  // ------------------------------------------------------------ text nodes
  function writeText(node, ru, en) {
    nodeState.set(node, { ru: ru, en: en });
    if (node.data !== en) node.data = en;
    stats.translated++;
  }
  // ------------------------------------------------------------ speech bubbles
  // Chat lines that people say out loud also appear as bubbles above their heads, which BYOND draws on
  // the map where this script can't reach. The map overlay covers each bubble with the English from
  // here, so it is told about every new spoken chat line: speaker colour, how many letters were said
  // (to recognise the bubble) and the English once this line is translated.
  var bubbleInfo = new WeakMap(); // .ChatMessage element -> info
  var bubbleWatch = []; // lines waiting for their English
  var bubbleSeq = 0;
  function letterCount(s) {
    return s.replace(/\s+/g, '').length;
  }
  // A copy of a chat line without the parts that are never in a bubble: the ghost "(TRACK)" link, the
  // "x2" repeat counter and this script's own notes.
  function cleanCopy(msgEl) {
    var c = msgEl.cloneNode(true);
    var rm = c.querySelectorAll('.ss13tr-note, .Chat__badge, a[href*="follow="], a[href*="track"]');
    for (var i = 0; i < rm.length; i++) rm[i].parentNode && rm[i].parentNode.removeChild(rm[i]);
    return c;
  }
  function chatParts(msgEl) {
    var c = cleanCopy(msgEl);
    var nameEl = c.querySelector('.name');
    var bodies = c.querySelectorAll('.body');
    var color = null;
    if (nameEl) {
      var colored = nameEl.querySelector('[style*="color"]') || (nameEl.style && nameEl.style.color ? nameEl : null);
      if (colored) color = colored.style.color || null;
    }
    var text;
    var all = (c.textContent || '').replace(/^\s*\(\s*\)\s*/, ''); // "( )" left over from the TRACK link
    if (bodies.length) {
      text = Array.prototype.map.call(bodies, function (b) { return b.textContent; }).join(' ');
    } else {
      text = all;
      if (nameEl) {
        text = text.replace(nameEl.textContent, '');
        // 'X says, "words"': the bubble shows only the words.
        var q = /["\u00ab\u201c]([^"\u00bb\u201d]{1,400})["\u00bb\u201d]/.exec(text);
        if (q) text = q[1];
      }
    }
    var name = nameEl ? nameEl.textContent.trim() : '';
    var emote = !bodies.length && !nameEl;
    var saidByThing = false;
    if (emote) {
      // Emotes ("<b>Name</b> waves.") show only the action in the bubble, after a small "*" icon.
      var b0 = c.querySelector('b');
      if (b0 && b0.textContent.trim() && text.indexOf(b0.textContent) >= 0 && text.indexOf(b0.textContent) <= 3) {
        name = b0.textContent.trim();
        text = text.slice(text.indexOf(b0.textContent) + b0.textContent.length);
        // '<b>Machine</b> beeps, "words"': something said, not an emote - the bubble shows only the words
        var q2 = /^\s*[^"\u00ab\u201c]{0,40}?["\u00ab\u201c]([^"\u00bb\u201d]{1,400})["\u00bb\u201d]\s*$/.exec(text);
        if (q2) {
          text = q2[1];
          emote = false;
          saidByThing = true;
        }
      } else emote = false;
    }
    var italic;
    // Quiet speech (whispers, talking into a radio, thin air) is wrapped in <i> by the game, in chat and as a
    // small-font bubble on the map. Speech in another language (Siik'tajr, Sinta'unathi ...) has no "body"
    // part but is ordinary speech with an ordinary bubble: only a real <i> around the words counts.
    var words = bodies.length ? bodies[0] : c.querySelector('.message');
    if (words) {
      italic = !!(words.closest && words.closest('i,em'));
    } else italic = saidByThing || (!emote && /["\u00ab]/.test(all)); // a machine: '<name> beeps, "words"'
    return { name: name, color: color, text: text.trim(), italic: italic, emote: emote, icon: emote || /radio/i.test(c.innerHTML.slice(0, 200)) };
  }
  // Could this chat line have a bubble on the map? Speech (a name and words) and emotes ("<b>Name</b> does
  // something"), but not system messages.
  function mayHaveBubble(msgEl) {
    if (msgEl.querySelector('.name, .body')) return true;
    var head = msgEl.innerHTML.slice(0, 300);
    if (/\bemote\b/.test(head)) return true;
    // "<b>Name</b> указывает на ..." (pointing at something) is only a chat line, never a bubble
    if (/\sуказыва(?:ет|ют)\s/.test(msgEl.textContent || '') && !/["\u00ab]/.test(msgEl.textContent || '')) return false;
    if (/\b(?:notice|warning|danger|userdanger|boldannounce|announce|ooc|looc|adminhelp|admin|deadsay|alert|boldwarning)\b/i.test(head)) return false;
    var b = msgEl.querySelector('b');
    return !!b && b.textContent.trim().length > 0 && b.textContent.length <= 60;
  }
  // A ghost with "ghost ears" hears everyone on the station, but only people in view get a bubble on
  // its screen. The game marks those lines: each has a "(TRACK)" link, and the words of a speaker in
  // view are in bold. Once a bold one has been seen, a "(TRACK)" line without bold is out of view.
  // (Emotes of people out of view also come with the link; ones in view come without it.)
  var ghostEars = false;
  function outOfView(msgEl) {
    var link = msgEl.querySelector('a[href*="follow="]');
    if (!link) return false;
    var body = msgEl.querySelector('.body') || msgEl.querySelector('.message');
    if (!body) return true;
    var b = body.closest ? body.closest('b, strong') : null;
    if (b && msgEl.contains(b)) {
      ghostEars = true;
      return false;
    }
    return ghostEars;
  }
  function noteBubble(msgEl, repeat) {
    if (!CFG.mapOverlay) return;
    var info = bubbleInfo.get(msgEl);
    if (!info) {
      if (repeat) return;
      // Only lines with a speaker or spoken words can have a bubble.
      if (!mayHaveBubble(msgEl)) return;
      var p = chatParts(msgEl);
      if (!p.text || !CYR.test(p.text)) return;
      if (!p.name && !msgEl.querySelector('.body')) return;
      if (/\blooc\b/i.test(msgEl.innerHTML.slice(0, 200))) return;
      // a radio line ("[General] Name says") has no bubble of its own (a nearby speaker's local line does)
      var head2 = msgEl.innerHTML.slice(0, 300);
      var radio = /class=["'][^"']*(?:\bradio\b|[a-z]+radio\b)/i.test(head2) || /^\s*(?:\(TRACK\)\s*)?\[[^\]]{2,24}\]/.test(msgEl.textContent || '');
      info = { name: p.name, color: p.color, ru: p.text, n: letterCount(p.text), en: null, it: p.italic, icon: p.icon, rd: radio, far: !radio && outOfView(msgEl) };
      bubbleInfo.set(msgEl, info);
    }
    var id = 'b' + ++bubbleSeq;
    send({ type: 'chatMsg', id: id, name: info.name, color: info.color, n: info.n, ru: info.ru.slice(0, 400), en: info.en, it: info.it, icon: info.icon, rd: info.rd ? 1 : 0, far: info.far ? 1 : 0 });
    if (!info.en) bubbleWatch.push({ el: msgEl, id: id, info: info, since: Date.now() });
  }
  function checkBubbles() {
    if (!bubbleWatch.length) return;
    var now = Date.now();
    bubbleWatch = bubbleWatch.filter(function (w) {
      if (now - w.since > 15000 || !w.el.isConnected) return false;
      if (w.el.classList.contains(HIDE_CLASS)) return true;
      var p = chatParts(w.el);
      if (CYR.test(p.text) && now - w.since < 9000) return true;
      if (CYR.test(p.text)) return false;
      w.info.en = p.text;
      send({ type: 'chatMsgEn', id: w.id, en: p.text });
      return false;
    });
  }
  every(checkBubbles, 120);
  // ------------------------------------------------------------ "sent in Russian" confirmation
  // When something you typed was translated and sent, the bridge tells every window. Your line then
  // comes back in chat (shown in English like everything else); this adds a small green note under it
  // with the exact Russian the server got, so you can see it really went out in Russian.
  var recentSent = [];
  var SPEECH_CMD_RE = /^\s*!?(?:say|me|whisper|ooc|looc|сказать|эмоция|шепот|шёпот)'?\s*"?/i;
  function lettersOnly(s) {
    return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
  }
  function editDistance(a, b) {
    if (a.length > 300 || b.length > 300) return Math.max(a.length, b.length);
    var prev = [];
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      var cur = [i];
      for (var k = 1; k <= b.length; k++) cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  function noteSent(info) {
    var body = String(info.to || '').replace(SPEECH_CMD_RE, '');
    var m = PREFIX_RE.exec(body);
    body = (m ? m[2] : body).replace(/"\s*$/, '').trim();
    var norm = lettersOnly(body);
    if (norm.length < 2) return;
    var now = Date.now();
    recentSent = recentSent.filter(function (s) { return now - s.t < 30000; });
    recentSent.push({ ru: body, full: info.to, from: info.from, norm: norm, t: now, hits: 0 });
    if (recentSent.length > 12) recentSent.shift();
  }
  function sameMessage(sent, said) {
    if (!said) return false;
    if (said.indexOf(sent) >= 0) return true;
    if (sent.indexOf(said) >= 0 && said.length >= sent.length * 0.6) return true;
    // the server may change a few letters (capitals, a full stop, an accent or a stutter)
    return 1 - editDistance(sent, said) / Math.max(sent.length, said.length) >= 0.75;
  }
  function checkOwn(msgEl) {
    if (!recentSent.length || msgEl.querySelector('.ss13tr-note')) return;
    var now = Date.now();
    var p = chatParts(msgEl);
    if (!p.text || !CYR.test(p.text)) return;
    var said = lettersOnly(p.text);
    for (var i = recentSent.length - 1; i >= 0; i--) {
      var s = recentSent[i];
      if (now - s.t > 30000 || s.hits >= 3) continue;
      if (!sameMessage(s.norm, said)) continue;
      s.hits++;
      var d = document.createElement('div');
      d.className = 'ss13tr-skip ss13tr-note';
      d.style.cssText = 'font-size:85%;color:#3fa35a;margin:1px 0 2px 14px;font-style:normal;font-weight:normal;';
      d.textContent = '✓ sent in Russian: ' + s.ru;
      d.title = 'You typed: ' + s.from;
      msgEl.appendChild(d);
      send({ type: 'sentSeen', to: s.full });
      return;
    }
  }
  function noteOwnAdded(node) {
    if (node.nodeType !== 1 || !recentSent.length) return;
    if (node.classList && node.classList.contains('ChatMessage')) return checkOwn(node);
    if (node.querySelectorAll && node.firstElementChild) {
      var list = node.querySelectorAll('.ChatMessage');
      if (list.length > 15) return;
      for (var i = 0; i < list.length; i++) checkOwn(list[i]);
    }
  }

  // Called for nodes added to the page, before their text is translated.
  function noteAdded(node) {
    try {
      noteOwnAdded(node);
    } catch (e) {}
    if (node.nodeType !== 1 || !CFG.mapOverlay) return;
    var cls = node.classList;
    if (cls && cls.contains('Chat__badge')) {
      var m0 = node.closest('.ChatMessage');
      if (m0) noteBubble(m0, true);
      return;
    }
    if (cls && cls.contains('ChatMessage')) {
      noteBubble(node, false);
      return;
    }
    if (node.querySelectorAll && node.firstElementChild) {
      var list = node.querySelectorAll('.ChatMessage');
      // A whole chat history being (re)loaded is not new speech.
      if (list.length > 15) return;
      for (var i = 0; i < list.length; i++) noteBubble(list[i], false);
    }
  }
  function noteBadgeChange(target) {
    var el = target.nodeType === 1 ? target : target.parentElement;
    if (!el || !el.closest || !CFG.mapOverlay) return;
    if (!el.closest('.Chat__badge')) return;
    var m = el.closest('.ChatMessage');
    if (m) noteBubble(m, true);
  }
  function processText(node) {
    if (!enabled) return;
    var data = node.data;
    if (!data) return;
    var st = nodeState.get(node);
    if (st && st.en === data) return; // our own write
    if (!CYR.test(data)) return;
    if (skipped(node)) return;
    var parts = splitWs(data);
    var key = normKey(parts.core);
    if (key.length <= 80) {
      if (labelSeen.size > 4000) labelSeen.clear();
      labelSeen.set(key, Date.now());
    }
    var hit = memo.get(key);
    if (hit !== undefined) {
      perf.memo++;
      writeText(node, data, parts.lead + hit + parts.trail);
      return;
    }
    var target = hideTarget(node);
    var release = hide(target);
    request(key, function (en) {
      if (en != null && node.data === data && enabled) {
        withScrollKeep(target, function () {
          writeText(node, data, parts.lead + en + parts.trail);
          release();
        });
      } else {
        release();
      }
    });
  }

  // ------------------------------------------------------------ attributes
  function processAttr(el, name) {
    if (!enabled) return;
    if (name === 'value') {
      var t = (el.getAttribute('type') || '').toLowerCase();
      if (el.tagName !== 'INPUT' || (t !== 'button' && t !== 'submit' && t !== 'reset')) return;
    }
    var val = el.getAttribute(name);
    if (!val || !CYR.test(val)) return;
    var states = attrState.get(el);
    if (states && states[name] && states[name].en === val) return;
    var key = normKey(val.trim());
    var apply = function (en) {
      if (en == null || el.getAttribute(name) !== val || !enabled) return;
      if (!states) {
        states = {};
        attrState.set(el, states);
      }
      states[name] = { ru: val, en: en };
      el.setAttribute(name, en);
      if (name === 'value' && el.value === val) el.value = en;
    };
    var hit = memo.get(key);
    if (hit !== undefined) apply(hit);
    else request(key, apply);
  }
  function processElement(el) {
    if (!el.hasAttribute) return;
    for (var i = 0; i < ATTRS.length; i++) {
      if (el.hasAttribute(ATTRS[i])) processAttr(el, ATTRS[i]);
    }
  }

  // ------------------------------------------------------------ scanning
  function scan(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      processText(root);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      processElement(root); // attributes (placeholder, title, button labels) are fine even on inputs
      if (SKIP_TAGS[root.tagName] === 1) return;
    }
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 1 && SKIP_TAGS[n.tagName] === 1) {
          processElement(n);
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) processText(n);
      else processElement(n);
    }
  }
  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'characterData') {
        noteBadgeChange(r.target);
        processText(r.target);
      } else if (r.type === 'attributes') processAttr(r.target, r.attributeName);
      else {
        // (a big batch at once is the chat history being re-rendered, not new speech)
        if (r.addedNodes.length <= 15) for (var k = 0; k < r.addedNodes.length; k++) noteAdded(r.addedNodes[k]);
        if (r.addedNodes.length && r.target.nodeType === 1 && r.target.closest && r.target.closest('.Chat__badge')) noteBadgeChange(r.target);
        for (var j = 0; j < r.addedNodes.length; j++) scan(r.addedNodes[j]);
      }
    }
  });
  function ensureStyle() {
    if (!document.documentElement) return;
    if (document.getElementById('ss13tr-style')) return;
    var st = document.createElement('style');
    st.id = 'ss13tr-style';
    st.className = 'ss13tr-skip';
    st.textContent = '.' + HIDE_CLASS + '{visibility:hidden !important}';
    (document.head || document.documentElement).appendChild(st);
  }
  var OBSERVE_OPTS = {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS,
  };
  function start() {
    observer.observe(document, OBSERVE_OPTS);
    // document.open() (used by some BYOND popups) drops mutation observers: re-attach at once.
    try {
      var origOpen = Document.prototype.__ss13trOrigOpen || Document.prototype.open;
      Document.prototype.__ss13trOrigOpen = origOpen;
      Document.prototype.open = function () {
        var r = origOpen.apply(this, arguments);
        if (this === document && window.__ss13tr && window.__ss13tr.reobserve) {
          try {
            window.__ss13tr.reobserve();
          } catch (e) {}
        }
        return r;
      };
    } catch (e) {}
    ensureStyle();
    if (enabled) scan(document.documentElement);
    every(reportPerf, 30000);
  }
  function reportPerf() {
    var now = Date.now();
    var unanswered = 0;
    perf.since.forEach(function (t, k) {
      if (now - t > 15000) {
        unanswered++;
        perf.since.delete(k);
      }
    });
    if (!perf.ms.length && !perf.hidden && !perf.memo && !unanswered) return;
    var a = perf.ms.slice().sort(function (x, y) { return x - y; });
    var q = function (p) { return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null; };
    send({ type: 'perf', url: location.pathname.split('/').pop(), n: a.length, p50: q(0.5), p90: q(0.9), max: a.length ? a[a.length - 1] : null, hidden: perf.hidden, memo: perf.memo, unanswered: unanswered });
    perf.ms = [];
    perf.hidden = 0;
    perf.memo = 0;
  }

  // ------------------------------------------------------------ toggle original text
  function setEnabled(on) {
    enabled = on;
    if (!on) {
      var w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      var n;
      while ((n = w.nextNode())) {
        if (n.nodeType === 3) {
          var st = nodeState.get(n);
          if (st && n.data === st.en) n.data = st.ru;
        } else {
          var states = attrState.get(n);
          if (states) {
            for (var a in states) {
              if (n.getAttribute(a) === states[a].en) n.setAttribute(a, states[a].ru);
            }
          }
          if (n.classList && n.classList.contains(HIDE_CLASS)) n.classList.remove(HIDE_CLASS);
        }
      }
    } else {
      scan(document.documentElement);
    }
  }

  // ------------------------------------------------------------ outgoing (EN -> RU)
  function needsOutgoing(text) {
    if (!text || !LAT.test(text)) return false;
    var lat = (text.match(/[A-Za-z]/g) || []).length;
    var cyr = (text.match(/[А-Яа-яЁё]/g) || []).length;
    return lat > cyr;
  }
  // Keep chat/radio prefixes like "; ", ":h ", ".h ", "#b ", "*" and leading "!" untouched.
  var PREFIX_RE = /^(\s*(?:;\s*|[:.#][^\s]{1,3}\s+|\*\s*|!\s*)?)([\s\S]*)$/;
  function translateOut(text, mode) {
    return new Promise(function (resolve) {
      var id = ++reqId;
      var timer = setTimeout(function () {
        replyWaiters.delete(id);
        resolve(null);
      }, CFG.outgoingTimeoutMs || 8000);
      replyWaiters.set(id, function (res) {
        clearTimeout(timer);
        resolve(res);
      });
      if (!send({ type: 'out', id: id, text: text, mode: mode || '' })) {
        clearTimeout(timer);
        replyWaiters.delete(id);
        resolve(null);
      }
    });
  }
  function translateWithPrefix(text, mode) {
    if (mode === 'name') return needsOutgoing(text) ? translateOut(text.trim(), 'name') : Promise.resolve(null);
    var m = PREFIX_RE.exec(text);
    var prefix = m[1] || '';
    var body = m[2] || '';
    if (!needsOutgoing(body)) return Promise.resolve(null);
    return translateOut(body).then(function (ru) {
      return ru == null ? null : prefix + ru;
    });
  }
  function setFieldValue(el, value) {
    var proto = Object.getPrototypeOf(el);
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      return t === 'text' || t === 'search' || t === '';
    }
    return false;
  }
  function isTguiSay() {
    var id = (window.Byond && window.Byond.windowId) || '';
    if (/say/i.test(id)) return true;
    return /say/i.test(location.pathname) && !!document.querySelector('textarea');
  }
  // Brief outline on the box: green = the text you see now is Russian, red = translation failed.
  function flashField(el, color, ms) {
    if (el.__ss13trFlash) clearTimeout(el.__ss13trFlash);
    else el.__ss13trOldShadow = el.style.boxShadow;
    el.style.boxShadow = 'inset 0 0 0 2px ' + (color || '#6cc79a');
    el.__ss13trFlash = setTimeout(function () {
      el.style.boxShadow = el.__ss13trOldShadow || '';
      el.__ss13trFlash = null;
    }, ms || (CFG.sayConfirm ? 4000 : 700));
  }
  // In the say/radio/OOC box: a thin green line and a small "RU" mark while typing is being translated.
  function updateSayBadge() {
    if (!document.body || !isTguiSay()) return;
    var on = CFG.sayAutoTranslate !== false;
    var b = document.getElementById('ss13tr-ru-badge');
    if (!on) {
      if (b) b.parentNode.removeChild(b);
      return;
    }
    if (b) return;
    b = document.createElement('div');
    b.id = 'ss13tr-ru-badge';
    b.className = 'ss13tr-skip';
    b.title = 'SS13 Translator: what you type here is sent in Russian';
    b.style.cssText = 'position:fixed;right:2px;top:1px;z-index:2147483647;pointer-events:none;font:bold 9px/10px Verdana,sans-serif;color:#7fe0a0;background:rgba(0,0,0,.45);padding:0 3px;border-radius:2px;letter-spacing:.5px;';
    b.textContent = 'EN→RU';
    var line = document.createElement('div');
    line.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:2px;background:#3fa35a;pointer-events:none;';
    b.appendChild(line);
    document.body.appendChild(b);
  }
  every(updateSayBadge, 1000);
  var busy = false;
  function translateField(el, thenSubmit, mode) {
    if (busy) return;
    var original = el.value;
    busy = true;
    var oldOpacity = el.style.opacity;
    el.style.opacity = '0.55';
    translateWithPrefix(original, mode).then(function (ru) {
      busy = false;
      el.style.opacity = oldOpacity;
      if (ru == null) {
        if (needsOutgoing(original)) {
          log('Outgoing translation failed for: ' + original);
          // Red outline; pressing Enter again sends it as it is.
          el.__ss13trFailed = original;
          flashField(el, '#e5666d', 3000);
          send({ type: 'sendFailed', from: original });
        }
        return;
      }
      if (el.value !== original) return; // user kept typing - do not overwrite
      setFieldValue(el, ru);
      send({ type: 'sent', from: original, to: ru, submit: !!thenSubmit });
      if (mode === 'name') {
        // a name is only written in Russian letters: you see it first, the next Accept / Enter sends it
        flashField(el, '#6cc79a', 5000);
        return;
      }
      flashField(el);
      if (thenSubmit && thenSubmit.nodeType === 1) {
        // the Accept button of a text box: pressed again now that the text is Russian
        setTimeout(function () {
          thenSubmit.click();
        }, 120);
        return;
      }
      if (thenSubmit && CFG.sayConfirm) {
        // Two-step mode: the Russian stays in the box; the next Enter sends it.
        return;
      }
      if (thenSubmit) {
        setTimeout(function () {
          var ev = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          });
          ev.__ss13trSynthetic = true;
          el.dispatchEvent(ev);
        }, 60);
      }
    });
  }
  // ------------------------------------------------------------ search boxes
  // A search box (navigation, list pickers, vendors ...) filters the game's Russian names, which you see in
  // English. What you type there is looked up in the English names this window showed you ("grav" ->
  // Gravity Generator -> "Генератор гравитации") instead of being translated ("grav" became "могила").
  var SEARCH_RE = /search|find|filter|поиск|найти|искать|фильтр/i;
  function isSearchField(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    if ((el.getAttribute('type') || '').toLowerCase() === 'search') return true;
    var st = attrState.get(el);
    var hints = [
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('name'),
      el.id,
      st && st.placeholder && st.placeholder.ru,
    ];
    for (var i = 0; i < hints.length; i++) if (hints[i] && SEARCH_RE.test(hints[i])) return true;
    // a magnifier icon right next to the box
    var p = el.parentElement;
    for (var d = 0; p && d < 2; d++, p = p.parentElement) {
      if (p.querySelector && p.querySelector('.fa-search, .fa-magnifying-glass')) return true;
    }
    return false;
  }
  function commonPart(list) {
    // the longest piece of text all the Russian names share ("Ангар механика", "Ангар пилота СБ" -> "Ангар")
    var low = list.map(function (s) { return s.toLowerCase(); });
    var base = list.reduce(function (a, b) { return b.length < a.length ? b : a; });
    var lb = base.toLowerCase();
    for (var len = lb.length; len >= 3; len--) {
      for (var i = 0; i + len <= lb.length; i++) {
        var sub = lb.substr(i, len);
        if (!/[а-яё]{3}/.test(sub)) continue;
        if (low.every(function (s) { return s.indexOf(sub) >= 0; })) {
          var out = base.substr(i, len).trim();
          if (out.length >= 3) return out;
        }
      }
    }
    return null;
  }
  function searchLabels(query) {
    var q = query.trim().toLowerCase().replace(/\s+/g, ' ');
    if (q.length < 2) return null;
    var words = q.split(' ');
    var since = Date.now() - 15 * 60 * 1000;
    var hits = [];
    labelSeen.forEach(function (t, ru) {
      if (t < since) return;
      var en = memo.get(ru);
      if (typeof en !== 'string' || en.length > 60 || en.split(/\s+/).length > 8) return;
      var e = en.toLowerCase();
      var ew = e.split(/[^a-z0-9']+/);
      // every word you typed starts a word of the name ("grav", "grav gen", "sec hangar"), or the whole thing is in it
      var ok = words.every(function (w) {
        return ew.some(function (x) { return x.indexOf(w) === 0; });
      }) || e.indexOf(q) >= 0;
      if (ok) hits.push({ ru: ru, en: en, score: (e.indexOf(q) === 0 ? 0 : 1000) + (t > Date.now() - 120000 ? 0 : 500) + e.length });
    });
    if (!hits.length) return null;
    hits.sort(function (a, b) { return a.score - b.score; });
    if (hits.length === 1) return { ru: hits[0].ru, matches: hits };
    var shared = commonPart(hits.slice(0, 15).map(function (h) { return h.ru; }));
    return { ru: shared || hits[0].ru, matches: hits };
  }
  // Enter in a search box with English in it: the matching Russian name goes in, the list shows it;
  // nothing is chosen for you (Enter again picks the highlighted item, as usual).
  function searchField(el) {
    var typed = el.value;
    var found = searchLabels(typed);
    if (found) {
      setFieldValue(el, found.ru);
      flashField(el, '#6cc79a', 1500);
      send({ type: 'searchMatch', from: typed, to: found.ru, names: found.matches.slice(0, 6).map(function (h) { return h.en; }) });
      return;
    }
    // nothing on screen matches: translated as before, but not sent
    translateField(el, false);
  }

  // The game's text boxes (a name, a description, your records ...): a box with Accept / Cancel buttons.
  var ACCEPT_RE = /^(accept|submit|confirm|ok|okay|done|save|send|подтвердить|принять|отправить|ок|готово|сохранить)$/i;
  function isAcceptButton(btn) {
    if (!btn) return false;
    var t = (btn.innerText || btn.textContent || '').replace(/\s+/g, ' ').trim();
    return ACCEPT_RE.test(t);
  }
  function visibleFields() {
    var out = [];
    var list = document.querySelectorAll('textarea, input');
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!isTextField(f) || f.disabled || f.readOnly) continue;
      var r = f.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push(f);
    }
    return out;
  }
  function modalField() {
    var a = document.activeElement;
    if (isTextField(a)) return a;
    var f = visibleFields();
    return f.length === 1 ? f[0] : null;
  }
  // "Please enter your name", "Name your pet", "Укажите имя" ...: a name is written in Russian letters, not translated
  function isNamePrompt(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    var v = (el.value || '').trim();
    if (!v || v.length > 40 || v.split(/\s+/).length > 4) return false;
    var page = (document.body && (document.body.innerText || document.body.textContent)) || '';
    page = page.replace(v, ' ') + ' ' + (document.title || '');
    return /\b(?:name|nickname|names)\b|\bcall (?:you|it|him|her)\b|имя|имени|назов|кличк|прозвищ/i.test(page);
  }
  // Accept pressed in a text box with English in it: the text is put into Russian first (a name in Russian
  // letters, shown to you before it is sent), then Accept is pressed again.
  var onAcceptClick;
  window.addEventListener(
    'click',
    (onAcceptClick = function (e) {
      if (!e.isTrusted || isTguiSay()) return;
      var btn = e.target && e.target.closest ? e.target.closest('.Button, button, [role="button"]') : null;
      if (!isAcceptButton(btn)) return;
      var el = modalField();
      if (!el || busy || isSearchField(el)) return;
      var nameBox = isNamePrompt(el);
      if (!needsOutgoing(el.value)) {
        if (nameBox && CYR.test(el.value)) send({ type: 'myName', ru: el.value.trim() });
        return;
      }
      if (CFG.inputsAutoTranslate !== true) return;
      if (el.__ss13trFailed && el.__ss13trFailed === el.value) {
        el.__ss13trFailed = null; // translation failed and Accept was pressed again: send as typed
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      translateField(el, nameBox ? false : btn, nameBox ? 'name' : '');
    }),
    true
  );
  var onKeyDown;
  window.addEventListener(
    'keydown',
    (onKeyDown = function (e) {
      if (e.__ss13trSynthetic) return;
      // Ctrl+Alt+T: show original Russian / translated English (all windows)
      if (e.ctrlKey && e.altKey && e.code === 'KeyT') {
        e.preventDefault();
        if (!send({ type: 'toggleOriginal' })) setEnabled(!enabled);
        return;
      }
      // Ctrl+Alt+S: open the translator's control panel
      if (e.ctrlKey && e.altKey && e.code === 'KeyS') {
        e.preventDefault();
        send({ type: 'openPanel' });
        return;
      }
      var el = e.target;
      if (!isTextField(el)) return;
      if (e.key !== 'Enter' || e.altKey || e.isComposing) return;
      if (e.ctrlKey) {
        // Ctrl+Enter: translate the field in place (any window), do not submit.
        e.preventDefault();
        e.stopImmediatePropagation();
        translateField(el, false);
        return;
      }
      if (busy) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      var say = isTguiSay();
      // other boxes: only single-line ones (Enter in a paper or a long text means a new line)
      var auto = say ? CFG.sayAutoTranslate !== false : CFG.inputsAutoTranslate === true && el.tagName === 'INPUT';
      if (el.__ss13trFailed && el.__ss13trFailed === el.value) {
        el.__ss13trFailed = null; // translation failed and Enter was pressed again: send as typed
        return;
      }
      if (!say && auto && !e.shiftKey && isSearchField(el) && needsOutgoing(el.value)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        searchField(el);
        return;
      }
      var nameBox = !say && isNamePrompt(el);
      if (nameBox && !needsOutgoing(el.value) && CYR.test(el.value)) send({ type: 'myName', ru: el.value.trim() });
      if (auto && !e.shiftKey && needsOutgoing(el.value)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (nameBox) translateField(el, false, 'name');
        else translateField(el, true);
      }
    }),
    true
  );
  // You started typing a message that will be translated: the translator opens its connections now, so
  // the message goes out sooner when you press Enter (at most once every 15 s).
  var lastTypingPing = 0;
  var onTypingInput;
  window.addEventListener(
    'input',
    (onTypingInput = function (e) {
      var el = e.target;
      if (!isTextField(el)) return;
      var auto = isTguiSay() ? CFG.sayAutoTranslate !== false : CFG.inputsAutoTranslate === true && el.tagName === 'INPUT';
      if (!auto || !/[A-Za-z]{2}/.test(el.value || '')) return;
      var now = Date.now();
      if (now - lastTypingPing < 15000) return;
      lastTypingPing = now;
      send({ type: 'typing' });
    }),
    true
  );

  // ------------------------------------------------------------ BYOND client calls (skin controller)
  var byondQueue = [];
  var byondTimer = null;
  var cbSeq = 0;
  function byondCall(path, params) {
    var parts = [];
    for (var k in params) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    byondQueue.push('byond://' + path + '?' + parts.join('&'));
    if (!byondTimer) byondTimer = setTimeout(drainByond, 0);
  }
  function drainByond() {
    byondTimer = null;
    var url = byondQueue.shift();
    if (!url) return;
    if (typeof window.__ss13tr_testNav === 'function') window.__ss13tr_testNav(url);
    else location.href = url;
    if (byondQueue.length) byondTimer = setTimeout(drainByond, 40);
  }
  function winget(id, props) {
    return new Promise(function (resolve) {
      var name = '__ss13tr_cb' + ++cbSeq;
      var timer = setTimeout(function () {
        delete window[name];
        resolve(null);
      }, 3000);
      window[name] = function (res) {
        clearTimeout(timer);
        delete window[name];
        if (typeof res === 'string') {
          try {
            res = JSON.parse(res);
          } catch (e) {}
        }
        resolve(res);
      };
      byondCall('winget', { id: id, property: props, callback: name });
    });
  }
  function winset(id, prop, value) {
    var p = { id: id };
    p[prop] = value;
    byondCall('winset', p);
  }
  function getProp(res, id, prop) {
    if (!res) return undefined;
    if (typeof res[prop] !== 'undefined') return res[prop];
    if (res[id] && typeof res[id][prop] !== 'undefined') return res[id][prop];
    var k = id + '.' + prop;
    if (typeof res[k] !== 'undefined') return res[k];
    return undefined;
  }
  function translateOne(text) {
    var key = normKey(text.trim());
    var hit = memo.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise(function (resolve) {
      request(key, resolve);
    });
  }

  var controller = null;
  function startController(opts) {
    if (controller) return;
    controller = { lastInput: '', lastChange: 0, lastOut: '', busy: false };
    var controls = opts.skinControls || [];
    var skinTick = function () {
      if (!enabled) return;
      controls.forEach(function (c) {
        var id = c[0];
        var prop = c[1];
        winget(id, prop).then(function (res) {
          var v = getProp(res, id, prop);
          if (typeof v !== 'string' || !CYR.test(v)) return;
          translateOne(v).then(function (en) {
            if (en && en !== v) winset(id, prop, en);
          });
        });
      });
    };
    controller.timers = [];
    controller.timers.push(setTimeout(skinTick, 500));
    controller.timers.push(setInterval(skinTick, opts.skinIntervalMs || 4000));

    if (opts.nativeInputAutoTranslate) {
      var inputId = opts.nativeInputId || 'input';
      var delay = opts.nativeInputDelayMs || 1200;
      controller.timers.push(setInterval(function () {
        if (!controller || controller.busy || controller.polling || !enabled) return;
        controller.polling = true;
        var endPoll = function () {
          if (controller) controller.polling = false;
        };
        setTimeout(endPoll, 5000); // safety net
        winget(inputId, 'text').then(function (res) {
          if (!controller) return;
          var text = getProp(res, inputId, 'text');
          if (typeof text !== 'string') return endPoll();
          var now = Date.now();
          if (text !== controller.lastInput) {
            controller.lastInput = text;
            controller.lastChange = now;
            return endPoll();
          }
          if (now - controller.lastChange < delay || text === controller.lastOut) return endPoll();
          // Raw commands typed without a say/me/ooc button selected are only translated
          // when they start with a speech verb.
          var m = /^(\s*!?(?:say|me|whisper|ooc|looc|сказать|эмоция|шепот|шёпот)'?\s*"?)([\s\S]*)$/i.exec(text);
          winget(inputId, 'command').then(function (r2) {
            if (!controller) return;
            var cmd = getProp(r2, inputId, 'command') || '';
            var prefix = '';
            var body = text;
            if (m) {
              // "me ...", "say ..." etc: never translate the command word itself.
              prefix = m[1];
              body = m[2];
            } else if (!cmd.trim()) {
              controller.lastOut = text;
              return endPoll();
            }
            if ((body.match(/[A-Za-z]/g) || []).length < 2 || !needsOutgoing(body)) {
              controller.lastOut = text;
              return endPoll();
            }
            controller.busy = true;
            endPoll();
            translateWithPrefix(body).then(function (ru) {
              if (!controller) return;
              if (ru == null) {
                controller.busy = false;
                controller.lastOut = text; // do not retry the same text in a loop
                return;
              }
              winget(inputId, 'text').then(function (r3) {
                if (!controller) return;
                controller.busy = false;
                if (getProp(r3, inputId, 'text') !== text) return; // user kept typing
                var out = prefix + ru;
                controller.lastOut = out;
                controller.lastInput = out;
                winset(inputId, 'text', out);
                send({ type: 'sent', from: text, to: out, native: true });
              });
            });
          });
        });
      }, 400));
    }
  }
  function stopController() {
    if (!controller) return;
    (controller.timers || []).forEach(function (t) {
      clearInterval(t);
      clearTimeout(t);
    });
    controller = null;
  }

  // ------------------------------------------------------------ leftover reporting
  function reportLeftovers() {
    if (!enabled || !document.documentElement) return;
    var found = [];
    var w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = w.nextNode()) && found.length < 60) {
      if (!CYR.test(n.data) || skipped(n)) continue;
      var key = normKey(n.data.trim());
      if (waiting.has(key)) continue;
      found.push(key.slice(0, 300));
    }
    var els = document.querySelectorAll('[title],[placeholder]');
    for (var i = 0; i < els.length && found.length < 80; i++) {
      var t = els[i].getAttribute('title') || els[i].getAttribute('placeholder') || '';
      if (CYR.test(t)) found.push('[attr] ' + t.slice(0, 300));
    }
    if (found.length) send({ type: 'leftover', url: location.href, title: document.title, items: found });
  }
  every(reportLeftovers, 15000);

  // Text whose translation failed (e.g. the service had a hiccup) is retried a few times.
  var retries = new Map();
  function retryUntranslated() {
    if (!enabled || !document.documentElement) return;
    var w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    var n, count = 0;
    while ((n = w.nextNode()) && count < 200) {
      if (!CYR.test(n.data)) continue;
      var st = nodeState.get(n);
      if (st && st.en === n.data) continue;
      var key = normKey(n.data.trim());
      if (waiting.has(key) || skipped(n)) continue;
      var tries = retries.get(key) || 0;
      if (tries >= 4) continue;
      retries.set(key, tries + 1);
      count++;
      processText(n);
    }
    if (retries.size > 5000) retries.clear();
  }
  every(retryUntranslated, 7000);

  // Watchdog: document.open()/write() can replace the document; keep style + scan alive.
  var lastRoot = null;
  every(function () {
    if (document.documentElement !== lastRoot) {
      lastRoot = document.documentElement;
      try {
        observer.observe(document, OBSERVE_OPTS);
      } catch (e) {}
      ensureStyle();
      scan(document.documentElement);
    } else {
      ensureStyle();
    }
  }, 250);

  function snapshot() {
    var out = { url: location.href, title: document.title, version: VERSION, enabled: enabled, text: '', russian: [] };
    try {
      out.text = (document.body ? document.body.innerText : '').slice(0, 30000);
      var w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
      var n;
      while ((n = w.nextNode()) && out.russian.length < 40) {
        if (!CYR.test(n.data) || skipped(n)) continue;
        var el = n.parentElement;
        var box = el && el.closest ? el.closest('.ChatMessage') || el.parentElement || el : el;
        out.russian.push({
          text: n.data.trim().slice(0, 300),
          pending: waiting.has(normKey(n.data.trim())),
          html: box ? box.outerHTML.slice(0, 700) : '',
        });
      }
    } catch (e) {
      out.error = String(e);
    }
    return out;
  }
  function destroy() {
    observer.disconnect();
    timers.forEach(clearInterval);
    stopController();
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('click', onAcceptClick, true);
    window.removeEventListener('input', onTypingInput, true);
    window.__ss13tr.alive = false;
  }

  window.__ss13tr = {
    alive: true,
    version: VERSION,
    snapshot: snapshot,
    destroy: destroy,
    reobserve: function () {
      observer.observe(document, OBSERVE_OPTS);
    },
    rescan: function () {
      ensureStyle();
      scan(document.documentElement);
    },
    recv: function (msg) {
      if (msg.type === 'tr') deliver(msg.results || {});
      else if (msg.type === 'out') {
        var cb = replyWaiters.get(msg.id);
        replyWaiters.delete(msg.id);
        if (cb) cb(msg.text);
      } else if (msg.type === 'seed') {
        var r = msg.results || {};
        for (var k in r) memo.set(k, r[k]);
        scan(document.documentElement);
      }
    },
    setConfig: function (c) {
      for (var k in c) CFG[k] = c[k];
      if ('enabled' in c && !!c.enabled !== enabled) setEnabled(!!c.enabled);
      try {
        updateSayBadge();
      } catch (e) {}
    },
    clearMemo: function () {
      memo.clear();
    },
    // A translation was corrected on the control panel's Dictionary page: show the new English wherever
    // that Russian text is on screen now, and use it from now on. fixes: {russian: english}
    applyFixes: function (fixes) {
      var n = 0;
      var has = function (k) {
        return Object.prototype.hasOwnProperty.call(fixes, k) && typeof fixes[k] === 'string';
      };
      for (var k in fixes) if (has(k)) memo.set(k, fixes[k]);
      if (!enabled || !document.documentElement) return 0;
      var w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      var node;
      while ((node = w.nextNode())) {
        if (node.nodeType === 3) {
          var st = nodeState.get(node);
          if (!st || node.data !== st.en) continue;
          var parts = splitWs(st.ru);
          var key = normKey(parts.core);
          if (has(key)) {
            writeText(node, st.ru, parts.lead + fixes[key] + parts.trail);
            n++;
          }
        } else {
          var states = attrState.get(node);
          if (!states) continue;
          for (var a in states) {
            var s2 = states[a];
            var k2 = normKey(s2.ru.trim());
            if (node.getAttribute(a) === s2.en && has(k2)) {
              s2.en = fixes[k2];
              node.setAttribute(a, s2.en);
              n++;
            }
          }
        }
      }
      return n;
    },
    // Saved translations removed on the Dictionary page: translate them again next time they appear.
    forget: function (keys) {
      for (var i = 0; i < (keys || []).length; i++) memo.delete(keys[i]);
    },
    refresh: function () {
      // Re-translate everything from scratch (after fixed translations changed).
      memo.clear();
      if (enabled) {
        setEnabled(false);
        setEnabled(true);
      }
    },
    startController: startController,
    stopController: stopController,
    noteSent: function (info) {
      try {
        noteSent(info || {});
      } catch (e) {}
    },
    setEnabled: setEnabled,
    stats: stats,
  };
  window.__ss13tr_recv = function (msg) {
    window.__ss13tr.recv(msg);
  };
  start();
})();
