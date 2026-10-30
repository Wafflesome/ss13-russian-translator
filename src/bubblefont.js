// The speech-bubble font: Grand9K Pixel at 8 px (6pt), the exact font the server's bubbles use
// (interface/fonts/Grand9K_Pixel_modif.ttf, turned into pixel patterns by tools/build_font.py).
//
// It lets the overlay work out, without reading the screen, what a chat line's bubble must look like:
// how BYOND wraps it at the bubble width, how wide and tall every line is, how many separate letter
// shapes it has. The same pixel patterns are used to draw the English (overlay/OverlayHost.cs).
'use strict';
const fs = require('fs');

const BUBBLE_WIDTH = 112; // CHAT_MESSAGE_WIDTH
const MAX_CHARS = 110; // CHAT_MESSAGE_MAX_LENGTH
const ICON_W = 9; // CHAT_MESSAGE_ICON_SIZE: radio/emote icon in front of the text
const LINE_PITCH = 13; // px between baselines of consecutive bubble lines

class BubbleFont {
  constructor(file) {
    this.glyphs = new Map();
    this.ascent = 7;
    this.descent = 1;
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!raw || raw[0] === '#') continue;
      const p = raw.split(' ');
      if (p[0] === 'ascent') {
        this.ascent = +p[1];
        this.descent = +p[3];
        continue;
      }
      const g = { a: +p[1], x: 0, y: 0, w: 0, h: 0, rows: null, comps: [] };
      if (p.length >= 5) {
        g.x = +p[2];
        g.y = +p[3];
        g.rows = p[4].split('/');
        g.h = g.rows.length;
        g.w = g.rows[0].length;
        g.comps = components(g.rows);
      }
      this.glyphs.set(+p[0], g);
    }
    this.fallback = this.glyphs.get(63) || { a: 5, x: 0, y: 0, w: 0, h: 0, rows: null, comps: [] }; // '?'
  }

  glyph(ch) {
    return this.glyphs.get(ch.codePointAt(0)) || this.fallback;
  }

  /** Width of a run of text the way BYOND measures it (no blank column after the last letter). */
  width(text) {
    let w = 0;
    let last = null;
    for (const ch of text) {
      const g = this.glyph(ch);
      w += g.a;
      last = g;
    }
    if (last && last.rows) w -= Math.max(0, last.a - (last.x + last.w));
    return Math.max(0, w);
  }

  /** Greedy word wrap at `maxW` px, breaking over-long words by letters. */
  wrap(text, maxW, firstIndent) {
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    let indent = firstIndent || 0;
    const fits = (s) => this.width(s) + indent <= maxW;
    for (let word of words) {
      const next = cur ? cur + ' ' + word : word;
      if (fits(next) || (!cur && !word)) {
        cur = next;
        continue;
      }
      if (cur) {
        lines.push(cur);
        indent = 0;
        cur = '';
      }
      // a single word wider than the bubble is cut letter by letter
      while (word && !fits(word)) {
        let k = word.length - 1;
        while (k > 1 && !fits(word.slice(0, k))) k--;
        lines.push(word.slice(0, k));
        indent = 0;
        word = word.slice(k);
      }
      cur = word;
    }
    if (cur || !lines.length) lines.push(cur);
    return lines;
  }

  /**
   * Pixel geometry of one bubble line (x from the line's left edge, y up from the baseline).
   * "Big" parts are letter shapes at least `minH` px tall - the ones the screen detector can see
   * (dots, commas and accents are too small at normal zoom).
   */
  lineGeometry(text, indent, minH) {
    let x = indent || 0;
    let bx0 = Infinity;
    let bx1 = -Infinity;
    let top = -Infinity;
    let bottom = Infinity;
    let comps = 0;
    let fx0 = Infinity;
    let fx1 = -Infinity;
    let ftop = -Infinity;
    let fbot = Infinity;
    for (const ch of text) {
      const g = this.glyph(ch);
      for (const c of g.comps) {
        fx0 = Math.min(fx0, x + g.x + c.x0);
        fx1 = Math.max(fx1, x + g.x + c.x1 + 1);
        ftop = Math.max(ftop, g.y - c.y0);
        fbot = Math.min(fbot, g.y - c.y1 - 1);
        if (c.h < minH) continue;
        comps++;
        bx0 = Math.min(bx0, x + g.x + c.x0);
        bx1 = Math.max(bx1, x + g.x + c.x1 + 1);
        top = Math.max(top, g.y - c.y0);
        bottom = Math.min(bottom, g.y - c.y1 - 1);
      }
      x += g.a;
    }
    const W = (indent || 0) + this.width(text);
    const full = fx0 === Infinity ? { fx0: 0, fx1: 0, ftop: 0, fbot: 0 } : { fx0, fx1, ftop, fbot };
    if (!comps) return { text, W, indent: indent || 0, comps: 0, empty: true, ...full };
    return { text, W, indent: indent || 0, x0: bx0, x1: bx1, top, bottom, comps, ...full };
  }

  /**
   * Predicted bubble for a spoken line: one entry per screen line, top to bottom.
   * `icon` adds the radio/emote icon BYOND puts in front of some bubbles.
   */
  bubble(ru, icon, minH, width) {
    const maxW = width || BUBBLE_WIDTH;
    let text = String(ru).replace(/\s+/g, ' ').trim();
    const chars = [...text];
    const cut = chars.length > MAX_CHARS;
    if (cut) text = chars.slice(0, MAX_CHARS).join('') + '...';
    const indent = icon ? ICON_W : 0;
    const texts = this.wrap(text, maxW, indent);
    const lines = texts.map((t, i) => this.lineGeometry(t, i === 0 ? indent : 0, minH));
    // What this wrap tells about the bubble width if it turns out to be right: every line fits,
    // and each line plus the next word would not have.
    let lo = 0;
    let hi = Infinity;
    for (let i = 0; i < texts.length; i++) {
      lo = Math.max(lo, lines[i].W);
      if (i + 1 < texts.length) {
        const nextWord = texts[i + 1].split(' ')[0];
        hi = Math.min(hi, lines[i].indent + this.width(texts[i] + ' ' + nextWord));
      }
    }
    return { lines, cut, icon: !!icon, width: maxW, lo, hi, key: texts.join('\n') + (icon ? '|i' : '') };
  }

  /** English laid out like a bubble: wrapped at the bubble width. */
  layoutEnglish(en, width) {
    const text = String(en).replace(/\s+/g, ' ').trim();
    return this.wrap(text, width || BUBBLE_WIDTH, 0);
  }
}

/** 8-connected pieces of a glyph, with their bounding boxes (row 0 = top). */
function components(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const seen = rows.map((r) => new Array(r.length).fill(false));
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rows[y][x] !== '1' || seen[y][x]) continue;
      const st = [[x, y]];
      seen[y][x] = true;
      let x0 = x;
      let x1 = x;
      let y0 = y;
      let y1 = y;
      let n = 0;
      while (st.length) {
        const [cx, cy] = st.pop();
        n++;
        x0 = Math.min(x0, cx);
        x1 = Math.max(x1, cx);
        y0 = Math.min(y0, cy);
        y1 = Math.max(y1, cy);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny][nx] || rows[ny][nx] !== '1') continue;
            seen[ny][nx] = true;
            st.push([nx, ny]);
          }
        }
      }
      out.push({ x0, x1, y0, y1, h: y1 - y0 + 1, w: x1 - x0 + 1, n });
    }
  }
  return out;
}

module.exports = { BubbleFont, BUBBLE_WIDTH, MAX_CHARS, ICON_W, LINE_PITCH };
