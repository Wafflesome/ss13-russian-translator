// Minimal Chrome DevTools Protocol client (flattened sessions).
'use strict';

class CDP {
  constructor(url, origin, log) {
    this.url = url;
    this.origin = origin;
    this.log = log || (() => {});
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
  }
  open() {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        // Only this program's own origin is allowed to connect to the (localhost-only) debug port.
        ws = new WebSocket(this.url, { headers: { Origin: this.origin } });
      } catch (e) {
        ws = new WebSocket(this.url);
      }
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('websocket error'));
      ws.onclose = () => {
        this.closed = true;
        for (const [, p] of this.pending) p.reject(new Error('closed'));
        this.pending.clear();
        this.emit('close', {});
      };
      ws.onmessage = (m) => {
        let msg;
        try {
          msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
        } catch (e) {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        } else if (msg.method) {
          this.emit(msg.method, msg.params || {}, msg.sessionId);
        }
      };
    });
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('closed'));
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout: ' + method));
        }
      }, 15000);
    });
  }
  on(ev, fn) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, []);
    this.handlers.get(ev).push(fn);
  }
  emit(ev, params, sessionId) {
    for (const fn of this.handlers.get(ev) || []) {
      try {
        fn(params, sessionId);
      } catch (e) {
        this.log('handler error ' + ev + ': ' + e.message);
      }
    }
  }
  close() {
    try {
      this.ws.close();
    } catch (e) {}
  }
}

module.exports = { CDP };
