/**
 * Online 1v1 end-to-end test: two headless Chromes (host + guest), PeerJS public cloud,
 * lobby with room code, READY, selected-map match, damage, kill, respawn and rematch.
 *
 * Must run outside the DSH Windows file/pipe sandbox.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const artifacts = path.join(__dirname, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const PORT = 8098;
const LOCAL_URL = `http://127.0.0.1:${PORT}/`;
const TARGET_URL = process.env.CS16_BASE_URL || LOCAL_URL;
const USE_LOCAL_SERVER = !process.env.CS16_BASE_URL;
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TEST_MAP = process.env.CS16_E2E_MAP || 'aim_1v1';
if (!['aim_1v1', 'aim_redline', 'cs_assault'].includes(TEST_MAP))
  throw new Error('Invalid CS16_E2E_MAP: ' + TEST_MAP);

const errors = [];
const serverProcesses = [];
const chomes = [];
let server;

function log(...args) {
  console.log(...args);
}

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/__health`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('Server did not start');
}

class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      for (const cb of this.handlers.get(msg.method) || []) cb(msg.params);
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  on(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(cb);
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        'Evaluation failed: ' +
          (res.exceptionDetails.exception?.description || res.exceptionDetails.text),
      );
    }
    return res.result?.value;
  }

  async waitFor(expression, timeoutMs = 25000, interval = 180) {
    const start = Date.now();
    let last;
    while (Date.now() - start < timeoutMs) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (err) {
        last = err.message;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`waitFor timeout: ${expression} (last=${JSON.stringify(last)})`);
  }

  async screenshot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' }, 60000);
    const file = path.join(artifacts, name);
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    log('  screenshot:', file);
    return file;
  }

  async click(selector) {
    const rect = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height};
    })()`);
    if (!rect) throw new Error('Missing selector: ' + selector);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    });
  }

  async fill(selector, value) {
    await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  }
}

async function findChromePort(profile, timeoutMs = 20000) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(portFile)) {
      try {
        const raw = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        if (raw[0]) return Number(raw[0]);
      } catch {
        /* Chrome still writing the file */
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Chrome DevToolsActivePort not found: ' + profile);
}

async function launchPage(name) {
  const profile = path.join(root, '.tmp', `online-${name}-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-crash-reporter',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1440,810',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  chomes.push(chrome);
  const port = await findChromePort(profile);
  let tab;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    tab = list.find((t) => t.type === 'page');
    if (tab) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!tab) throw new Error('No page target for ' + name);
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  cdp.on('Runtime.exceptionThrown', (p) => {
    const text = p.exceptionDetails?.exception?.description || p.exceptionDetails?.text;
    errors.push(`[${name}] ${text}`);
    log(`  [${name} exception]`, text);
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (p.type === 'error') {
      errors.push(`[${name}] console.error: ${text}`);
      log(`  [${name} console.error]`, text);
    } else if (/error|failed|closed/i.test(text)) {
      log(`  [${name} console.${p.type}]`, text);
    }
  });
  cdp.on('Log.entryAdded', (p) => {
    const t = p.entry;
    if (t.level === 'error' && !/favicon/i.test(t.text)) {
      errors.push(`[${name}] ${t.source}: ${t.text}`);
      log(`  [${name} log]`, t.level, t.text);
    }
  });
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await cdp.waitFor(`!!window.__CS16__`, 60000);
  await cdp.waitFor(`window.__CS16__.state === 'menu'`, 60000);
  // Headless tabs cannot hold pointer lock reliably; the online logic doesn't require it.
  await cdp.eval(`window.__CS16__.input.requestPointerLock = () => {}; true`);
  log(`  ${name} ready`);
  return cdp;
}

async function main() {
  log('Starting server...');
  if (USE_LOCAL_SERVER) {
    server = spawn(process.execPath, ['server.mjs'], {
      cwd: root,
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'ignore',
    });
    serverProcesses.push(server);
    await waitForHealth();
  } else {
    log('Using deployed URL:', TARGET_URL);
  }

  log('Launching two browsers...');
  const host = await launchPage('host');
  const guest = await launchPage('guest');

  // Clean old localStorage names is fine. Open the online home in both.
  await host.eval(`window.__CS16__.openOnlineHome(); true`);
  await guest.eval(`window.__CS16__.openOnlineHome(); true`);
  await host.waitFor(`!!document.querySelector('[data-view="home"]:not(.online-hidden)')`, 12000);
  await guest.waitFor(`!!document.querySelector('[data-view="home"]:not(.online-hidden)')`, 12000);
  await host.waitFor(`getComputedStyle(document.getElementById('classic-menu')).opacity === '0'`, 8000);
  await guest.waitFor(`getComputedStyle(document.getElementById('classic-menu')).opacity === '0'`, 8000);

  await host.fill('[data-online-ref="nameInput"]', 'HostE2E');
  await host.click('[data-online-action="create"]');
  await host.waitFor(
    `!!window.__CS16__.onlineSession && window.__CS16__.onlineSession.role === 'host' && !!window.__CS16__.onlineSession.code`,
    40000,
  );
  const code = await host.eval(`window.__CS16__.onlineSession.code`);
  log('Room code:', code);

  await guest.fill('[data-online-ref="nameInputJoin"]', 'GuestE2E');
  await guest.fill('[data-online-ref="codeInput"]', code);
  await guest.click('[data-online-action="join"]');
  try {
    await guest.waitFor(
      `!!window.__CS16__.onlineSession && window.__CS16__.onlineSession.role === 'guest' && !!window.__CS16__.onlineSession.connected`,
      40000,
    );
  } catch (err) {
    const dbg = await guest.eval(`(() => {
      const g = window.__CS16__;
      const s = g.onlineSession;
      return {
        screen: g.onlineUI && g.onlineUI._screen,
        error: document.querySelector('[data-view="error"]:not(.online-hidden)')?.innerText?.slice(0,500),
        status: document.querySelector('[data-view="home"]:not(.online-hidden) .online-status')?.innerText,
        session: s ? {role:s.role, code:s.code, connected:s.connected, closed:s.closed, started:s.started, status:s._lastStatus} : null,
        codeInput: document.querySelector('[data-online-ref="codeInput"]')?.value,
        nameInput: document.querySelector('[data-online-ref="nameInputJoin"]')?.value,
      };
    })()`);
    const hostDbg = await host.eval(`(() => {
      const g = window.__CS16__; const s = g.onlineSession;
      return s ? {role:s.role, code:s.code, connected:s.connected, closed:s.closed, started:s.started, status:s._lastStatus, lobby:s.lobby} : null;
    })()`);
    log('GUEST DEBUG:', JSON.stringify(dbg, null, 2));
    log('HOST DEBUG:', JSON.stringify(hostDbg, null, 2));
    await guest.screenshot('25-online-join-failure.png');
    throw err;
  }
  await host.waitFor(
    `!!(window.__CS16__.onlineSession.lobby && window.__CS16__.onlineSession.lobby.guest)`,
    25000,
  );
  log('Lobby connected');
  await host.waitFor(`!!document.querySelector('[data-view="lobby"]:not(.online-hidden)')`, 12000);
  await guest.waitFor(`!!document.querySelector('[data-view="lobby"]:not(.online-hidden)')`, 12000);
  const guestSelectDisabled = await guest.eval(`document.querySelector('[data-online-ref="mapSelect"]')?.disabled`);
  if (!guestSelectDisabled) throw new Error('Guest must not control the map selector');
  await host.eval(`(() => {
    const select = document.querySelector('[data-online-ref="mapSelect"]');
    select.value = ${JSON.stringify(TEST_MAP)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await guest.waitFor(`window.__CS16__.onlineSession.lobby.map === ${JSON.stringify(TEST_MAP)}`, 10000);
  // A late host map change must revoke READY on both peers before starting.
  await host.click('[data-online-action="ready"]');
  await host.waitFor(`window.__CS16__.onlineSession.lobby.host.ready === true`, 10000);
  const alternateMap = TEST_MAP === 'aim_1v1' ? 'aim_redline' : 'aim_1v1';
  await host.eval(`(() => {
    const select = document.querySelector('[data-online-ref="mapSelect"]');
    select.value = ${JSON.stringify(alternateMap)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await host.waitFor(`window.__CS16__.onlineSession.lobby.host.ready === false`, 10000);
  await guest.waitFor(`window.__CS16__.onlineSession.lobby.map === ${JSON.stringify(alternateMap)}`, 10000);
  await host.eval(`(() => {
    const select = document.querySelector('[data-online-ref="mapSelect"]');
    select.value = ${JSON.stringify(TEST_MAP)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await host.waitFor(`window.__CS16__.onlineSession.lobby.map === ${JSON.stringify(TEST_MAP)}`, 10000);
  await guest.waitFor(`window.__CS16__.onlineSession.lobby.map === ${JSON.stringify(TEST_MAP)}`, 10000);
  await host.screenshot('20-online-host-lobby.png');
  await guest.screenshot('21-online-guest-lobby.png');

  // READY on both.
  await host.click('[data-online-action="ready"]');
  await host.waitFor(`window.__CS16__.onlineSession.lobby.host.ready === true`, 10000);
  await guest.click('[data-online-action="ready"]');
  await host.waitFor(`window.__CS16__.state === 'playing'`, 50000);
  await guest.waitFor(`window.__CS16__.state === 'playing'`, 50000);
  await host.waitFor(`window.__CS16__.map && window.__CS16__.map.id === ${JSON.stringify(TEST_MAP)}`, 30000);
  await guest.waitFor(`window.__CS16__.map && window.__CS16__.map.id === ${JSON.stringify(TEST_MAP)}`, 30000);
  await host.waitFor(`!!window.__CS16__.online`, 15000);
  await guest.waitFor(`!!window.__CS16__.online`, 15000);
  for (const [peer, team] of [[host, 'CT'], [guest, 'T']]) {
    const spawnCheck = await peer.eval(`(() => {
      const g = window.__CS16__;
      const team = ${JSON.stringify(team)};
      const roll = g.online.startPayload.spawnRolls[team];
      const expected = g.map.spawns[team][Math.floor(roll * g.map.spawns[team].length)];
      return {team:g.player.team, expected, actual:{x:g.player.pos.x,z:g.player.pos.z}};
    })()`);
    if (spawnCheck.team !== team || Math.abs(spawnCheck.actual.x - spawnCheck.expected.x) > .01 ||
      Math.abs(spawnCheck.actual.z - spawnCheck.expected.z) > .01)
      throw new Error('Wrong initial spawn: ' + JSON.stringify(spawnCheck));
  }
  log('Both in', TEST_MAP);

  // Regression: remote pose/equipment must replicate, not just position/yaw.
  // Send one real protocol state explicitly; headless Chrome cannot retain
  // pointer-lock reliably enough to exercise held Ctrl through Player.update().
  await host.waitFor("window.__CS16__.online.phase === 'live'", 15000);
  await host.eval("(() => { const g=window.__CS16__; const prev={c:g.player.crouching,o:g.player.onGround,s:g.player.speed,w:g.weapons.currentId}; g.online._stateAccum=-999; g.player.crouching=true; g.player.onGround=false; g.player.speed=4.2; g.weapons.currentId='awp'; g.online._sendState(); g.player.crouching=prev.c; g.player.onGround=prev.o; g.player.speed=prev.s; g.weapons.currentId=prev.w; return true; })()");
  await guest.waitFor("(() => { const a=window.__CS16__.online?.avatar; return !!a && a.crouchAmount > 0.45 && a.weaponId === 'awp' && a.onGround === false; })()", 10000);
  await guest.waitFor("(() => { const c=window.__CS16__.online?.avatar?._kenney; return !!c && c.state === 'duck' && c.gunMeshes?.Sniper?.visible === true; })()", 10000);
  const replicatedPose = await guest.eval("(() => { const a=window.__CS16__.online.avatar; const c=a._kenney; return { crouch:a.crouchAmount, weaponId:a.weaponId, onGround:a.onGround, anim:c?.state || null, sniperVisible:!!c?.gunMeshes?.Sniper?.visible }; })()");
  if (!(replicatedPose.crouch > 0.45) || replicatedPose.weaponId !== 'awp' || replicatedPose.onGround !== false ||
      replicatedPose.anim !== 'duck' || replicatedPose.sniperVisible !== true) {
    throw new Error('Remote pose/equipment replication failed: ' + JSON.stringify(replicatedPose));
  }
  log('Remote pose/equipment:', replicatedPose);
  await host.eval("(() => { window.__CS16__.online._stateAccum=1; return true; })()");
  await new Promise((r) => setTimeout(r, 2200));
  await host.screenshot('22-online-host-match.png');
  await guest.screenshot('23-online-guest-match.png');

  const matchInfo = await host.eval(`(() => {
    const g = window.__CS16__;
    return {
      map: g.map.id, phase: g.online.phase, role: g.online.role,
      team: g.player.team, health: g.player.health, weapon: g.weapons.getHudState().name,
      remote: g.online.getRemoteEntity()?.name, players: g.getAliveCounts(),
      score: g.online.getHudState(),
    };
  })()`);
  log('Host match:', JSON.stringify(matchInfo, null, 2));

  // Wait for live and force a headshot from the host to the guest through the real protocol.
  await host.waitFor(`window.__CS16__.online.phase === 'live'`, 15000);
  const beforeGuest = await guest.eval(`({health:window.__CS16__.player.health, alive:window.__CS16__.player.alive})`);
  await host.eval(`(() => {
    const g = window.__CS16__;
    const remote = g.online.getRemoteEntity();
    const p = g.player.pos;
    g.online.notifyLocalShot({
      origin: {x:p.x, y:p.y + 1.62, z:p.z},
      dir: {x:0, y:-0.02, z:1},
      weaponId: 'm4a1',
      hit: { entity: remote, part: 'head', point: {x:remote.pos.x, y:remote.pos.y+1.7, z:remote.pos.z} }
    });
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 1400));
  const afterGuest = await guest.eval(`({health:window.__CS16__.player.health, alive:window.__CS16__.player.alive})`);
  const hostScore = await host.eval(`({scores:window.__CS16__.online.scores, phase:window.__CS16__.online.phase})`);
  log('Damage test:', { beforeGuest, afterGuest, hostScore });

  await new Promise((r) => setTimeout(r, 5200));
  const respawnedGuest = await guest.eval(`({health:window.__CS16__.player.health, alive:window.__CS16__.player.alive, pos:{x:window.__CS16__.player.pos.x,z:window.__CS16__.player.pos.z}})`);
  log('Guest respawn:', respawnedGuest);

  // Force the score to 10 to verify the match-end overlay on both clients.
  await host.eval(`(() => {
    const o = window.__CS16__.online;
    o.scores.host = o.targetKills;
    o._checkMatchEnd();
    return true;
  })()`);
  await host.waitFor(`!!document.querySelector('[data-view="matchEnd"]:not(.online-hidden)')`, 15000);
  await guest.waitFor(`!!document.querySelector('[data-view="matchEnd"]:not(.online-hidden)')`, 15000);
  const endInfo = await host.eval(`({phase:window.__CS16__.online.phase, hostScore:window.__CS16__.online.scores.host, guestScore:window.__CS16__.online.scores.guest, endText:document.querySelector('[data-view="matchEnd"]:not(.online-hidden)')?.innerText?.slice(0,300)})`);
  log('Match end:', JSON.stringify(endInfo));
  await host.screenshot('25-online-match-end.png');

  // Rematch: host resets lobby, both should leave the match and show the lobby.
  await host.eval(`window.__CS16__.online.requestRematch(); true`);
  await host.waitFor(`!!document.querySelector('[data-view="lobby"]:not(.online-hidden)')`, 30000);
  await guest.waitFor(`!!document.querySelector('[data-view="lobby"]:not(.online-hidden)')`, 30000);
  const rematchInfo = await host.eval(`({state:window.__CS16__.state, online:!!window.__CS16__.online, screen:window.__CS16__.onlineUI._screen, role:window.__CS16__.onlineSession.role, code:window.__CS16__.onlineSession.code})`);
  log('Rematch/lobby:', JSON.stringify(rematchInfo));
  await host.screenshot('26-online-rematch-lobby.png');

  log('Closing guest to test disconnect...');
  try {
    guest.ws.close();
  } catch {
    /* ignore */
  }
  chomes[1]?.kill();
  await new Promise((r) => setTimeout(r, 2500));
  const afterClose = await host.eval(`({state:window.__CS16__.state, online:!!window.__CS16__.online, session:!!window.__CS16__.onlineSession, mainVisible:!document.querySelector('[data-screen="main"]')?.classList.contains('u-hidden')})`);
  log('Host after guest close:', afterClose);

  if (errors.length) {
    log('\nERRORS (' + errors.length + '):');
    for (const e of errors) log(' -', e);
    process.exitCode = 1;
  } else {
    log('\nNo browser errors.');
  }
}

async function cleanup() {
  for (const cdp of []) cdp?.ws?.close();
  for (const c of chomes) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  for (const s of serverProcesses) {
    try {
      s.kill();
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 400));
}

main()
  .catch((err) => {
    console.error('ONLINE E2E FAILED:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    setTimeout(() => process.exit(process.exitCode || 0), 800);
  });
