// Starting/stopping BYOND with the WebView2 DevTools port enabled.
//
// BYOND's hub (byond.exe) and game client (dreamseeker.exe) share ONE embedded browser engine
// (Documents\BYOND\cache\WebView2). WebView2 refuses to start a second program on a running engine
// unless both asked for exactly the same settings (error 0x8007139f -> "Failed to load fancy chat").
// So the debug setting is applied through ONE mechanism that covers both programs identically:
// the per-program WebView2 policy in the registry (HKCU, no admin rights needed).
'use strict';
const fs = require('fs');
const path = require('path');

const REG_KEY = 'HKCU\\Software\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
const BYOND_EXES = ['dreamseeker.exe', 'byond.exe'];

function run(cmd) {
  try {
    const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
    return { ok: r.exitCode === 0, out: r.stdout ? r.stdout.toString() : '' };
  } catch (e) {
    return { ok: false, out: '' };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function byondDocs() {
  const home = process.env.USERPROFILE || '';
  const candidates = [path.join(home, 'Documents', 'BYOND'), path.join(home, 'OneDrive', 'Documents', 'BYOND')];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

class Launcher {
  constructor(cfg, stateDir, log) {
    this.cfg = cfg;
    this.log = log;
    this.stateFile = path.join(stateDir, 'launch_state.json');
    this.state = { strategy: 'registry' };
    try {
      this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) };
    } catch (e) {}
    this.debugArgs = '';
    this.watchToken = 0;
    this.lastTarget = '';
    this.status = 'idle'; // idle | starting | running | failed
    this.problem = '';
  }

  setDebugArgs(args) {
    this.debugArgs = args;
  }

  saveState() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state));
    } catch (e) {}
  }

  setRegistry(on) {
    for (const exe of BYOND_EXES) {
      if (on) run(['reg', 'add', REG_KEY, '/v', exe, '/t', 'REG_SZ', '/d', this.debugArgs, '/f']);
      else run(['reg', 'delete', REG_KEY, '/v', exe, '/f']);
    }
  }

  isByondRunning() {
    const r = run(['tasklist', '/fo', 'csv', '/nh']);
    if (!r.out) return false;
    const low = r.out.toLowerCase();
    return BYOND_EXES.some((e) => low.includes('"' + e + '"'));
  }

  async closeByond() {
    run(['taskkill', '/f', '/im', 'dreamseeker.exe']);
    run(['taskkill', '/f', '/im', 'byond.exe']);
    await sleep(1200);
    // The shared browser engine can linger for a moment after BYOND closes. Only BYOND's own
    // msedgewebview2 processes are closed; other programs' are not touched.
    run([
      'powershell',
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -like '*BYOND*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ]);
    await sleep(1200);
  }

  webviewDebugFile() {
    return path.join(byondDocs(), 'cfg', 'webview-debug.txt');
  }
  webviewStamp() {
    try {
      const st = fs.statSync(this.webviewDebugFile());
      return st.mtimeMs + ':' + st.size;
    } catch (e) {
      return 'none';
    }
  }

  /** Recent servers from the BYOND hub's history. */
  recentServers() {
    try {
      const txt = fs.readFileSync(path.join(byondDocs(), 'cfg', 'pager.txt'), 'utf8');
      const get = (k) => {
        const m = new RegExp('^' + k + ' (.*)$', 'm').exec(txt);
        return m ? m[1].split('|') : [];
      };
      const urls = get('recent-url');
      const names = get('recent-name');
      const seen = new Set();
      const out = [];
      urls.forEach((u, i) => {
        if (!u || seen.has(u)) return;
        seen.add(u);
        out.push({ url: u, name: names[i] || u });
      });
      return out.slice(0, 12);
    } catch (e) {
      return [];
    }
  }

  /**
   * Close BYOND and start it again with the debug port.
   * target: '' opens the BYOND hub, or a byond:// address joins that server directly.
   */
  async launch(target, isConnected) {
    this.lastTarget = target || '';
    const token = ++this.watchToken;
    this.status = 'starting';
    this.problem = '';
    if (this.cfg.closeRunningByond !== false) {
      this.log('Closing BYOND windows that are already open...');
      await this.closeByond();
    }
    const strategy = this.state.strategy === 'env' ? 'env' : 'registry';
    const env = { ...process.env };
    delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
    if (strategy === 'registry') {
      this.setRegistry(true);
    } else {
      this.setRegistry(false);
      env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = this.debugArgs;
    }
    const dir = this.cfg.byondDir;
    const exe = target ? path.join(dir, 'dreamseeker.exe') : path.join(dir, 'byond.exe');
    const args = ['cmd', '/c', 'start', '', exe];
    if (target) args.push(target);
    this.log(target ? `Joining ${target} ...` : 'Starting BYOND - join a server from the BYOND window as usual.');
    const stampBefore = this.webviewStamp();
    try {
      Bun.spawn(args, { env, stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    } catch (e) {
      this.log('Could not start BYOND: ' + e.message);
      this.status = 'failed';
      this.problem = 'Could not start BYOND. Check "BYOND folder" in the control panel settings.';
      return;
    }
    this.watch(token, stampBefore, target, isConnected, strategy);
  }

  async watch(token, stampBefore, target, isConnected, strategy) {
    const started = Date.now();
    let switched = false;
    while (token === this.watchToken && Date.now() - started < 150000) {
      await sleep(2000);
      if (token !== this.watchToken) return;
      // 1) BYOND reported that its browser engine refused to start (settings mismatch).
      const stamp = this.webviewStamp();
      if (stamp !== stampBefore) {
        let txt = '';
        try {
          txt = fs.readFileSync(this.webviewDebugFile(), 'utf8');
        } catch (e) {}
        if (/failed to create/i.test(txt)) {
          this.status = 'failed';
          this.problem =
            'BYOND could not start its chat/menu panels (browser engine mismatch). The translator restarted BYOND to fix it.';
          this.log('PROBLEM: BYOND reported "' + txt.trim() + '". Restarting BYOND cleanly...');
          if (!this._retried) {
            this._retried = true;
            setTimeout(() => this.launch(target, isConnected), 500);
          } else {
            this.problem =
              'BYOND still cannot start its panels. Close BYOND and the translator, then run SS13 Russian Translator.cmd again.';
            this.log(this.problem);
          }
          return;
        }
        stampBefore = stamp;
      }
      // 2) The debug port never opened: this Windows/WebView2 ignores the registry setting.
      if (!isConnected() && Date.now() - started > 45000 && !switched && strategy === 'registry') {
        switched = true;
        this.state.strategy = 'env';
        this.saveState();
        this.log('The game did not open the translation port with the registry method - switching to the environment method and restarting BYOND.');
        setTimeout(() => this.launch(target, isConnected), 500);
        return;
      }
      if (isConnected()) {
        this.status = 'running';
        this._retried = false;
      }
    }
  }

  /** Called when the translator exits. */
  cleanup() {
    // Removing the setting while BYOND is still open would make the next game window started
    // from the hub mismatch the running engine, so it stays until BYOND is closed.
    if (this.isByondRunning()) {
      this.log('BYOND is still open, so the debug setting stays until BYOND closes (harmless, local only).');
      return;
    }
    this.setRegistry(false);
  }
}

module.exports = { Launcher, byondDocs };
