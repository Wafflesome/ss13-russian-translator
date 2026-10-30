// Detailed logs for improving the translator later (logs/events.tsv and logs/summary.txt).
//
// Everything is kept in memory and written once a second in the background (one small file append),
// so logging never holds up translating or the map overlay. Files are capped: at 25 MB the old one is
// renamed to *.old.tsv and a new one is started.
//
// events.tsv: one line per event: local time, milliseconds since start, event type, then fields
// (name=value, separated by tabs). summary.txt: the most useful numbers of this run, rewritten every
// five minutes and when the translator is closed.
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 25e6;

class Telemetry {
  constructor(logDir, opts = {}) {
    this.dir = logDir;
    this.enabled = opts.enabled !== false;
    this.file = path.join(logDir, 'events.tsv');
    this.summaryFile = path.join(logDir, 'summary.txt');
    this.t0 = Date.now();
    this.buf = [];
    this.bytes = 0;
    this.writing = false;
    this.counters = new Map(); // name -> number
    this.samples = new Map(); // name -> array of numbers (last 2000)
    this.summaryParts = new Map(); // name -> () => text lines
    try {
      fs.mkdirSync(logDir, { recursive: true });
      if (fs.existsSync(this.file)) this.bytes = fs.statSync(this.file).size;
    } catch (e) {}
    this.event('start', { pid: process.pid });
    const t = setInterval(() => this.flush(), 1000);
    if (t.unref) t.unref();
    const s = setInterval(() => this.writeSummary(), 5 * 60000);
    if (s.unref) s.unref();
  }

  /** One event: type plus fields. Cheap: just remembered until the next flush. */
  event(type, fields) {
    if (!this.enabled) return;
    const d = new Date();
    let line = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}\t${Date.now() - this.t0}\t${type}`;
    if (fields) {
      for (const k in fields) {
        const v = fields[k];
        if (v === undefined || v === null) continue;
        line += '\t' + k + '=' + (typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v).replace(/[\t\r\n]+/g, ' ').slice(0, 300));
      }
    }
    this.buf.push(line);
    if (this.buf.length > 20000) this.buf.splice(0, this.buf.length - 20000); // never grow without end
  }

  /** Counts something (shown in the summary). */
  count(name, n = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + n);
  }

  /** Remembers a measurement (the summary shows its median, 90th percentile and maximum). */
  sample(name, value) {
    if (!Number.isFinite(value)) return;
    let a = this.samples.get(name);
    if (!a) this.samples.set(name, (a = []));
    a.push(value);
    if (a.length > 2000) a.splice(0, a.length - 2000);
  }

  /** Extra lines for the summary, from another part of the program. */
  addSummary(name, fn) {
    this.summaryParts.set(name, fn);
  }

  flush() {
    if (!this.enabled || this.writing || !this.buf.length) return;
    const data = this.buf.join('\n') + '\n';
    this.buf = [];
    this.writing = true;
    const done = () => {
      this.writing = false;
    };
    try {
      if (this.bytes + data.length > MAX_BYTES) {
        try {
          fs.renameSync(this.file, this.file.replace(/\.tsv$/, '.old.tsv'));
        } catch (e) {}
        this.bytes = 0;
      }
      this.bytes += Buffer.byteLength(data);
      fs.appendFile(this.file, data, done);
    } catch (e) {
      done();
    }
  }

  /** Synchronous last write (when the program closes). */
  flushNow() {
    if (!this.enabled) return;
    try {
      if (this.buf.length) fs.appendFileSync(this.file, this.buf.join('\n') + '\n');
      this.buf = [];
    } catch (e) {}
    this.writeSummary(true);
  }

  static stats(a) {
    if (!a || !a.length) return null;
    const s = a.slice().sort((x, y) => x - y);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: s.length, p50: q(0.5), p90: q(0.9), max: s[s.length - 1] };
  }

  summaryText() {
    const lines = [];
    const mins = Math.round((Date.now() - this.t0) / 60000);
    lines.push(`SS13 Russian Translator - summary of this run (${new Date().toLocaleString()}, running ${mins} min)`);
    lines.push('');
    if (this.counters.size) {
      lines.push('Counts');
      for (const [k, v] of [...this.counters].sort()) lines.push(`  ${k.padEnd(62)} ${v}`);
      lines.push('');
    }
    if (this.samples.size) {
      lines.push('Measurements (last 2000 of each)'.padEnd(64) + ' count   median      90%      max');
      for (const [k, a] of [...this.samples].sort()) {
        const s = Telemetry.stats(a);
        if (!s) continue;
        const f = (x) => String(Math.round(x * 10) / 10).padStart(8);
        lines.push(`  ${k.padEnd(62)} ${String(s.n).padStart(6)} ${f(s.p50)} ${f(s.p90)} ${f(s.max)}`);
      }
      lines.push('');
    }
    for (const [k, fn] of this.summaryParts) {
      try {
        const extra = fn();
        if (extra && extra.length) {
          lines.push(k);
          for (const l of extra) lines.push('  ' + l);
          lines.push('');
        }
      } catch (e) {}
    }
    return lines.join('\n');
  }

  writeSummary(sync) {
    if (!this.enabled) return;
    try {
      const text = this.summaryText();
      if (sync) fs.writeFileSync(this.summaryFile, text);
      else fs.writeFile(this.summaryFile, text, () => {});
    } catch (e) {}
  }
}

module.exports = { Telemetry };
