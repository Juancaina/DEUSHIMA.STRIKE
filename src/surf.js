/** Modo Surf: timer, checkpoints y respawn. La física vive en Player.updateSurf(). */
export class SurfManager {
  constructor(game) {
    this.game = game;
    this.phase = 'live';
    this.roundNumber = 1;
    this.time = 0;
    this.running = false;
    this.finished = false;
    this.best = Number(localStorage.getItem('deushima-surf-best') || 0) || 0;
    this.checkpoint = 0;
    this._bannerTimer = null;
  }

  startMatch() {
    this.phase = 'live';
    this.time = 0;
    this.running = false;
    this.finished = false;
    this.checkpoint = 0;
    const s = this.game.map?.surfStart;
    if (s) {
      this.game.player.pos.set(s.x, s.y + 0.05, s.z);
      this.game.player.vel.set(0, 0, 0);
      this.game.player.yaw = 0;
      this.game.player.alive = true;
    }
    this._showBanner('SURF', 'R para reiniciar · mantené velocidad', 2200);
  }

  update(dt) {
    const p = this.game.player;
    if (this.game.input?.wasPressed?.('KeyR')) {
      this.time = 0;
      this.running = false;
      this.finished = false;
      this.phase = 'live';
      this.checkpoint = 0;
      this.respawn(true);
      this._showBanner('RESTART', 'RUN REINICIADO', 1100);
      return;
    }
    if (!p.alive) {
      p.alive = true;
      this.respawn();
      return;
    }
    if (!this.finished && (Math.abs(p.vel.x) + Math.abs(p.vel.z) > 0.8 || p.pos.z < 30)) this.running = true;
    if (this.running && !this.finished) this.time += dt;
    if (p.pos.z < 3) this.checkpoint = 1;
    if (p.pos.y < -18 || p.pos.z < -60 || p.pos.z > 55 || Math.abs(p.pos.x) > 40) this.respawn();

    const finish = this.game.map?.surfFinish;
    if (finish && !this.finished && p.pos.z < finish.z + finish.r && Math.abs(p.pos.x - finish.x) < finish.r && Math.abs(p.pos.y - finish.y) < 3) {
      this.finished = true;
      this.phase = 'over';
      const t = this.time;
      const isBest = !this.best || t < this.best;
      if (isBest) {
        this.best = t;
        try { localStorage.setItem('deushima-surf-best', String(t)); } catch { /* ignore */ }
      }
      this._showBanner('FINISH', `${t.toFixed(2)}s${isBest ? ' · NUEVO RÉCORD' : ''}`, 2600);
      this.game.audio?.play?.('round_win', { volume: 0.8 });
      this._bannerTimer = setTimeout(() => {
        this.finished = false;
        this.phase = 'live';
        this.running = false;
        this.time = 0;
        this.checkpoint = 0;
        this.respawn(true);
      }, 2600);
    }
  }

  canControlPlayer() {
    return !this.finished;
  }

  respawn(toStart = false) {
    const map = this.game.map;
    const cp = toStart ? map?.surfStart : map?.checkpoints?.[Math.min(this.checkpoint, (map?.checkpoints?.length || 1) - 1)] || map?.surfStart;
    if (!cp) return;
    const p = this.game.player;
    p.pos.set(cp.x, cp.y + 0.05, cp.z);
    p.vel.set(0, 0, 0);
    p.yaw = (cp.yaw || 0) * Math.PI / 180;
    p.alive = true;
    p.health = 100;
    this.game.audio?.play?.('land', { volume: 0.5 });
  }

  onPlayerKilled() { this.respawn(); }
  onBotKilled() {}

  getHudState() {
    return {
      phase: this.phase,
      round: 1,
      roundNumber: 1,
      timeLeft: this.time,
      freezeLeft: 0,
      buyTimeLeft: 0,
      scoreCT: 0,
      scoreT: 0,
      objective: this.best ? `SURF · RÉCORD ${this.best.toFixed(2)}s` : 'SURF · LLEGÁ AL FINISH',
      teamAlive: { CT: 1, T: 0 },
      bomb: { planted: false },
      hostages: { total: 0, rescued: 0, carrying: 0 },
      message: this.finished ? 'FINISH' : '',
    };
  }

  getScoreboardData() { return { teams: { CT: [], T: [] }, mapName: 'SURF_DEUSHIMA' }; }

  _showBanner(title, sub, ms) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('classic-banner');
    if (!el) return;
    clearTimeout(this._bannerTimer);
    el.innerHTML = `<div class="cb-kicker">DEUSHIMA STRIKE · SURF</div><div class="cb-title">${title}</div><div class="cb-sub">${sub}</div>`;
    el.classList.add('show');
    this._bannerTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  dispose() {
    clearTimeout(this._bannerTimer);
  }
}
