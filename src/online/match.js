/**
 * OnlineMatch Ã¢â‚¬â€ partida 1v1 host-autoritativa sobre OnlineSession (PeerJS).
 *
 * Responsabilidades:
 *  - countdown/phase, score a 10 kills, respawn 2 s, health/armor del rival y del jugador;
 *  - sincronizaciÃƒÂ³n: state 20 Hz, snapshot 10 Hz (solo host), ping/pong 1 Hz;
 *  - disparos: el host es la ÃƒÂºnica autoridad de daÃƒÂ±o. El guest manda `shot` {origin,dir,weaponId},
 *    el host recalcula el impacto contra su propio jugador y aplica `game.damagePlayer`; el host
 *    daÃƒÂ±a al guest con su propio cÃƒÂ¡lculo de zonas/armadura y difunde `hit`/`kill`/`shotFx`;
 *  - avatar remoto procedural (`RemoteAvatar`) interpolado;
 *  - fin de partida y revancha (vÃƒÂ­a `session.resetToLobby()`).
 *
 * Mensajes de partida (sobre session.send/onMatchMessage):
 *   state {pos:{x,y,z}, yaw, pitch, crouch, alive}                 20 Hz (ambos)
 *   snapshot {hostHealth, guestHealth, scoreHost, scoreGuest, phase,
 *             respawnHost, respawnGuest}                           10 Hz (host -> guest)
 *   shot {origin, dir, weaponId}                                   guest -> host
 *   shotFx {origin, dir, weaponId, point}                          host -> guest
 *   hit {target:'host'|'guest', health, armor, damage, part, headshot, point, miss?}
 *   kill {victim, killer, weapon, headshot, scoreHost, scoreGuest}
 *   respawn {who, pos, yaw, health}
 *   matchEnd {winner, scoreHost, scoreGuest, targetKills, names, role, youWon, winnerName}
 *   ping/pong {t}
 *
 * `hit.target` es una extensiÃƒÂ³n necesaria: el mensaje se usa en las dos direcciones (resultado
 * de mi disparo vs. daÃƒÂ±o que recibÃƒÂ­) y sin `target` serÃƒÂ­a ambiguo.
 */
import * as THREE from '../../vendor/three.module.js';
import { clamp } from '../core/utils.js';
import { WEAPONS } from '../weapons.js';
import { RemoteAvatar } from './avatar.js';
import { onlineMapLabel } from '../world/online_map_pool.js';

const RESPAWN_MS = 4000;
const COUNTDOWN_MS = 1500;
const STATE_INTERVAL = 1 / 20;
const SNAPSHOT_INTERVAL = 0.1;
const PING_INTERVAL = 1;
const HIT_MULT = { head: 4.0, chest: 1.0, stomach: 1.25, legs: 0.75 };
const VALID_PARTS = ['head', 'chest', 'stomach', 'legs'];
const DEFAULT_TARGET_KILLS = 13;
const SHOT_ORIGIN_TOLERANCE = 2.0;
const SHOT_ORIGIN_TOLERANCE_AVATAR = 2.6;
const MAX_REMOTE_DT = 0.1;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function isVecLike(v) {
  return (
    !!v &&
    Number.isFinite(Number(v.x)) &&
    Number.isFinite(Number(v.y)) &&
    Number.isFinite(Number(v.z))
  );
}

function toVec3(v, out = new THREE.Vector3()) {
  if (!isVecLike(v)) return null;
  return out.set(Number(v.x), Number(v.y), Number(v.z));
}

function vecToPlain(v) {
  if (!v) return null;
  return { x: round3(Number(v.x)), y: round3(Number(v.y)), z: round3(Number(v.z)) };
}

/** Devuelve `t` de la intersecciÃƒÂ³n rayo-caja o null (mismo algoritmo que game.raycastShot). */
function rayBoxT(origin, dir, box, maxDist) {
  let tmin = 0;
  let tmax = maxDist;
  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? origin.x : axis === 1 ? origin.y : origin.z;
    const d = axis === 0 ? dir.x : axis === 1 ? dir.y : dir.z;
    const min = axis === 0 ? box.min.x : axis === 1 ? box.min.y : box.min.z;
    const max = axis === 0 ? box.max.x : axis === 1 ? box.max.y : box.max.z;
    if (Math.abs(d) < 1e-9) {
      if (o < min || o > max) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (min - o) * inv;
    let t2 = (max - o) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmin < 0 || tmin > maxDist) return null;
  return tmin;
}

function partOrDefault(part) {
  return VALID_PARTS.includes(part) ? part : 'chest';
}

function weaponInfo(weaponId) {
  return (weaponId && WEAPONS[weaponId]) || null;
}

export class OnlineMatch {
  /**
   * @param {object} game
   * @param {object} session OnlineSession
   * @param {object} startPayload payload de `start` (role, code, names, hostTeam, guestTeam, startAt, targetKills)
   */
  constructor(game, session, startPayload = {}) {
    const payload = startPayload && typeof startPayload === 'object' ? startPayload : {};
    this.game = game || null;
    this.session = session || null;
    this.startPayload = payload;

    this.role = payload.role === 'host' || payload.role === 'guest'
      ? payload.role
      : (session && session.role) || 'guest';
    this.isHost = this.role === 'host';
    this.remoteRole = this.isHost ? 'guest' : 'host';
    this.code = typeof payload.code === 'string' ? payload.code : (session && session.code) || '';

    const sessionLobby = session && session.lobby ? session.lobby : null;
    const names = payload.names && typeof payload.names === 'object' ? payload.names : {};
    this.names = {
      host: names.host || (sessionLobby && sessionLobby.host && sessionLobby.host.name) || 'Host',
      guest:
        names.guest || (sessionLobby && sessionLobby.guest && sessionLobby.guest.name) || 'Invitado',
    };
    this.localName = this.names[this.role] || 'Jugador';
    this.remoteName = this.names[this.remoteRole] || 'Rival';

    this.hostTeam = payload.hostTeam === 'T' ? 'T' : 'CT';
    this.guestTeam = payload.guestTeam === 'CT' ? 'CT' : 'T';
    this.myTeam = this.isHost ? this.hostTeam : this.guestTeam;
    this.remoteTeam = this.isHost ? this.guestTeam : this.hostTeam;

    const rawTarget = Math.round(num(payload.targetKills, DEFAULT_TARGET_KILLS));
    this.targetKills = clamp(rawTarget || DEFAULT_TARGET_KILLS, 1, 99);

    this.phase = 'countdown';
    this.startAt = 0;
    this.scores = { host: 0, guest: 0 };
    this.deaths = { host: 0, guest: 0 };
    this.ping = 0;

    // Salud autoritativa del guest (solo el host la modifica).
    this._guestHealth = 100;
    this._guestArmor = 100;
    this._guestHelmet = false;
    this._guestAlive = true;
    this._guestRespawnAt = 0;
    this._guestSpawnProtectionUntil = 0;
    // Espejo del host en el cliente guest (llega por snapshot/state).
    this._hostHealth = 100;
    this._hostAlive = true;
    this._hostRespawnAt = 0;
    this._guestRespawnIn = 0;

    this._started = false;
    this._disposed = false;
    this._over = false;
    this._rematchRequested = false;
    this._lastRespawnAt = 0;

    this._rtt = 0;
    this._stateAccum = STATE_INTERVAL;
    this._snapshotAccum = SNAPSHOT_INTERVAL;
    this._pingAccum = PING_INTERVAL;

    this.avatar = null;
    this._remoteEntity = null;
    this._lastRemoteState = null;

    this._tmpOrigin = new THREE.Vector3();
    this._tmpDir = new THREE.Vector3();
    this._tmpPoint = new THREE.Vector3();
    this._tmpUp = new THREE.Vector3(0, 1, 0);
    this._lastMatchEndData = null;
  }

  /* ====================================================================== */
  /* Ciclo de vida                                                          */
  /* ====================================================================== */

  /** Llamado por Game despuÃƒÂ©s de spawnear jugador/armas. Debe ser sÃƒÂ­ncrono. */
  start() {
    if (this._started || this._disposed) return;
    this._started = true;

    const now = Date.now();
    // startAt viene del reloj del host. Si los relojes de ambas mÃƒÂ¡quinas difieren mucho,
    // ignoramos el valor absoluto y usamos un countdown local de 1.5 s.
    let remaining = COUNTDOWN_MS;
    const rawStart = Number(this.startPayload.startAt);
    if (Number.isFinite(rawStart)) {
      const delta = rawStart - now;
      if (Math.abs(delta) < 60000) remaining = clamp(delta, 60, 5000);
    }
    this.startAt = now + remaining;
    this.phase = now < this.startAt ? 'countdown' : 'live';

    const player = this.game && this.game.player;
    if (player) {
      player.team = this.myTeam;
      player.name = this.localName;
    }
    this._hostAlive = this.isHost ? !!(player && player.alive) : true;
    this._guestAlive = this.isHost ? true : !!(player && player.alive);
    this._guestHealth = 100;
    this._guestArmor = 100;
    this._guestHelmet = false;
    this._guestSpawnProtectionUntil = now + 1000;
    this._hostHealth = this.isHost ? Math.ceil(num(player && player.health, 100)) : 100;

    this._createAvatar();
    this._sendState();
    if (this.isHost) this._sendSnapshot(now);
  }

  update(dt) {
    if (this._disposed) return;
    const step = clamp(num(dt, 0), 0, MAX_REMOTE_DT);
    const now = Date.now();

    if (this.phase === 'countdown' && now >= this.startAt) {
      this.phase = 'live';
      this._onLive();
    }

    if (this.phase !== 'over') {
      this._tickRespawns(now);
      this._sendNetwork(step, now);
    }

    if (this.avatar) this.avatar.update(step);

    if (!this.isHost) this._maybeFallbackRespawn(now);
  }

  /** false en countdown / muerto / fin de partida. */
  canControl() {
    if (this._disposed || this._over || !this._started) return false;
    if (this.phase !== 'live') return false;
    const player = this.game && this.game.player;
    return !!player && player.alive === true;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._started = false;
    if (this.avatar) {
      try {
        this.avatar.dispose();
      } catch (err) {
        console.warn('[CS16 online] avatar.dispose', err);
      }
      this.avatar = null;
    }
    this._remoteEntity = null;
    this._lastRemoteState = null;
  }

  /* ====================================================================== */
  /* Entidades / hitboxes                                                   */
  /* ====================================================================== */

  _createAvatar() {
    const spawn = this._spawnFor(this.remoteTeam, this.startPayload.spawnRolls?.[this.remoteTeam]);
    try {
      this.avatar = new RemoteAvatar(this.game, { name: this.remoteName, team: this.remoteTeam });
    } catch (err) {
      console.warn('[CS16 online] no se pudo crear el avatar remoto', err);
      this.avatar = null;
    }
    if (this.avatar) {
      this.avatar.setTarget(spawn, spawn.yawRad, 0, false, true);
      this.avatar.snapToTarget();
    }
    this._remoteEntity = this._makeRemoteEntity();
  }

  _makeRemoteEntity() {
    const match = this;
    return {
      get pos() {
        return match.avatar ? match.avatar.pos : match._tmpOrigin;
      },
      get height() {
        return match.avatar ? match.avatar.height : 1.8;
      },
      get radius() {
        return match.avatar ? match.avatar.radius : 0.38;
      },
      get alive() {
        return match.avatar ? match.avatar.alive : false;
      },
      get yaw() {
        return match.avatar ? match.avatar.yaw : 0;
      },
      get pitch() {
        return match.avatar ? match.avatar.pitch : 0;
      },
      get crouching() {
        return match.avatar ? match.avatar.crouchAmount > 0.5 : false;
      },
      get velocity() {
        return match.avatar ? match.avatar._speed || 0 : 0;
      },
      get weaponId() {
        return match.avatar ? match.avatar.weaponId : 'knife';
      },
      get onGround() {
        return match.avatar ? match.avatar.onGround : true;
      },
      name: this.remoteName,
      team: this.remoteTeam,
      isRemote: true,
      isPlayer: false,
      isBot: false,
      health: 0,
      armor: 0,
      kills: 0,
      deaths: 0,
      hasBomb: false,
      hasDefuseKit: false,
    };
  }

  /** Entidad que `game.getPlayerHitboxes()` / `raycastShot` pueden usar para el rival. */
  getRemoteEntity() {
    return this._remoteEntity;
  }

  /** @returns {Array<{part:string,box:THREE.Box3,damageMult:number}>} */
  getRemoteHitboxes() {
    if (this._disposed || !this._remoteEntity || !this.avatar || !this.avatar.alive) return [];
    try {
      if (typeof this.game.getPlayerHitboxes !== 'function') return [];
      const boxes = this.game.getPlayerHitboxes(this._remoteEntity);
      return Array.isArray(boxes) ? boxes : [];
    } catch (err) {
      console.warn('[CS16 online] getRemoteHitboxes', err);
      return [];
    }
  }

  /* ====================================================================== */
  /* Disparos                                                               */
  /* ====================================================================== */

  /**
   * Llamado por WeaponSystem._fire despuÃƒÂ©s de cada disparo local.
   * @param {{origin:THREE.Vector3, dir:THREE.Vector3, weaponId:string,
   *          hit:null|{entity?:object, part?:string, point?:THREE.Vector3, dir?:THREE.Vector3, damage?:number}}} shot
   */
  notifyLocalShot(shot) {
    if (this._disposed || this._over || !shot) return;
    if (!this._started || this.phase !== 'live') return;

    const weaponId = typeof shot.weaponId === 'string' ? shot.weaponId : 'ak47';
    const w = weaponInfo(weaponId);
    const player = this.game && this.game.player;
    const origin =
      shot.origin && isVecLike(shot.origin)
        ? new THREE.Vector3(Number(shot.origin.x), Number(shot.origin.y), Number(shot.origin.z))
        : player && typeof player.getEyePosition === 'function'
          ? player.getEyePosition(new THREE.Vector3())
          : null;
    if (!origin) return;
    let dir;
    if (isVecLike(shot.dir)) {
      dir = new THREE.Vector3(Number(shot.dir.x), Number(shot.dir.y), Number(shot.dir.z));
    } else if (player && typeof player.getAimDirection === 'function') {
      dir = player.getAimDirection(new THREE.Vector3());
    } else {
      return;
    }
    if (dir.lengthSq() < 1e-8) return;
    dir.normalize();

    if (this.isHost) this._hostShot(shot, origin, dir, weaponId, w);
    else this._guestShot(origin, dir, weaponId, !!shot.hit);
  }

  _guestShot(origin, dir, weaponId, predictedHit) {
    // El guest no aplica daÃƒÂ±o: sÃƒÂ³lo informa el disparo; el host recalcula.
    // `predictedHit` sÃƒÂ³lo se usa para no duplicar el hitmarker local cuando el host
    // confirme el impacto (WeaponSystem ya lo mostrÃƒÂ³ con el raycast local).
    this._guestShotPredictedAt = predictedHit ? Date.now() : 0;
    this.session.send('shot', {
      origin: vecToPlain(origin),
      dir: vecToPlain(dir),
      weaponId,
    });
  }

  _hostShot(shot, origin, dir, weaponId, weapon) {
    // FX para el guest siempre (aunque no haya impacto).
    this.session.send('shotFx', {
      origin: vecToPlain(origin),
      dir: vecToPlain(dir),
      weaponId,
      point: shot.hit && isVecLike(shot.hit.point) ? vecToPlain(shot.hit.point) : null,
    });

    if (this.phase !== 'live' || !this._guestAlive) return;
    const hit = shot.hit;
    if (!hit || typeof hit !== 'object') return;
    if (hit.entity && hit.entity !== this._remoteEntity && !hit.entity.isRemote) return;

    const part = partOrDefault(hit.part);
    const mult = Number.isFinite(Number(hit.damageMult))
      ? Math.max(0.1, Number(hit.damageMult))
      : HIT_MULT[part] ?? 1;
    // El host es el tirador: su cÃƒÂ¡lculo local (incluye bonus de cuchillo por la espalda)
    // sÃƒÂ­ es confiable. El daÃƒÂ±o que manda el guest en `shot` nunca se usa.
    const base =
      Number.isFinite(Number(hit.damage)) && Number(hit.damage) > 0
        ? Number(hit.damage)
        : num(weapon && weapon.damage, 0);
    if (base <= 0) return;

    const result = this._damageGuest(base, mult, part);
    const headshot = part === 'head';
    this.session.send('hit', {
      target: 'guest',
      health: result.health,
      armor: result.armor,
      damage: result.damage,
      part,
      headshot,
      point: hit.point && isVecLike(hit.point) ? vecToPlain(hit.point) : null,
    });
    if (result.dead) this._killGuest(weaponId, headshot);
  }

  /** DaÃƒÂ±o autoritativo al guest con zonas + armadura/casco (espejo de Player.takeDamage). */
  _damageGuest(baseDamage, zoneMult, part) {
    let damage = Math.max(0, baseDamage) * zoneMult;
    let armorDamage = 0;
    if (this._guestArmor > 0) {
      const blocked = part === 'head' ? (this._guestHelmet ? 0.5 : 0) : 0.5;
      const healthPortion = damage * (1 - blocked);
      armorDamage = part === 'head' && !this._guestHelmet ? 0 : Math.min(this._guestArmor, damage * 0.5);
      this._guestArmor = Math.max(0, this._guestArmor - armorDamage);
      damage = healthPortion;
    }
    damage = Math.max(1, Math.round(damage));
    // ProtecciÃƒÂ³n de spawn (1 s) equivalente a Player.spawnProtection del host.
    if (Date.now() < (this._guestSpawnProtectionUntil || 0)) {
      damage = Math.max(1, Math.round(damage * 0.5));
    }
    this._guestHealth = Math.max(0, this._guestHealth - damage);
    const dead = this._guestHealth <= 0;
    if (dead) this._guestHealth = 0;
    return {
      health: this._guestHealth,
      armor: Math.round(this._guestArmor),
      damage,
      dead,
    };
  }

  _killGuest(weaponId, headshot) {
    if (this._disposed || this._over) return;
    if (!this._guestAlive) return;
    this._guestAlive = false;
    this._guestHealth = 0;
    this._guestArmor = 0;
    this._guestHelmet = false;
    this._guestRespawnAt = Date.now() + RESPAWN_MS;
    this.scores.host += 1;
    this.deaths.guest += 1;
    const roundNo = this.scores.host + this.scores.guest;
    this.game.showClassicBanner?.(`RONDA ${roundNo}`, `HOST ${this.scores.host} Â· GUEST ${this.scores.guest}`, this.game.player?.team, 3600);
    this.game.audio?.play?.('round_win', { volume: 0.7 });
    if (this.avatar) this.avatar.playDeath();
    this._addKillFeed('host', 'guest', weaponId, headshot);
    this.game.ui?.showKillConfirm?.(!!headshot);
    this.game.audio?.play?.('bodyfall', { volume: 0.6 });
    this.session.send('kill', this._killPayload('guest', 'host', weaponId, headshot));
    this._checkMatchEnd();
  }

  /** Disparo del guest recibido por el host: recalcula contra el jugador local. */
  _handleRemoteShot(payload) {
    if (!this.isHost || this._disposed || this.phase !== 'live') return;
    const origin = toVec3(payload && payload.origin, this._tmpOrigin);
    const dir = toVec3(payload && payload.dir, this._tmpDir);
    if (!origin || !dir) return;
    if (dir.lengthSq() < 1e-8) return;
    dir.normalize();

    const weaponId = typeof payload.weaponId === 'string' ? payload.weaponId : 'ak47';
    const weapon = weaponInfo(weaponId);
    if (!weapon) return;
    const range = Math.max(5, num(weapon.range, 120));

    // Anti-cheat bÃƒÂ¡sico: el origen debe estar cerca del ÃƒÂºltimo state del guest.
    if (!this._validRemoteShotOrigin(origin)) return;

    const hit = this._raycastLocalPlayer(origin, dir, range);

    let endPoint;
    let worldPoint = false;
    if (hit && hit.type === 'world') {
      endPoint = hit.point;
      worldPoint = true;
    } else if (hit) {
      endPoint = hit.point;
    } else {
      endPoint = new THREE.Vector3().copy(origin).addScaledVector(dir, range);
    }
    this._remoteShotFx(origin, dir, weaponId, endPoint, worldPoint);

    if (!hit || !hit.entity) {
      this.session.send('hit', { target: 'host', miss: true });
      return;
    }

    const player = this.game && this.game.player;
    const part = partOrDefault(hit.part);
    const base = num(weapon.damage, 0);
    if (!player || base <= 0 || typeof this.game.damagePlayer !== 'function') {
      this.session.send('hit', { target: 'host', miss: true });
      return;
    }

    const dealt = this.game.damagePlayer(base, this._remoteEntity, part, weaponId);
    if (dealt > 0) {
      this.session.send('hit', {
        target: 'host',
        health: Math.max(0, Math.ceil(num(player.health, 0))),
        armor: Math.max(0, Math.ceil(num(player.armor, 0))),
        damage: Math.round(dealt),
        part,
        headshot: part === 'head',
        point: hit.point ? vecToPlain(hit.point) : null,
      });
    } else {
      this.session.send('hit', { target: 'host', miss: true });
    }
  }

  _validRemoteShotOrigin(origin) {
    const state = this._lastRemoteState;
    if (state && Date.now() - state.at < 2500) {
      const eye = new THREE.Vector3(
        state.pos.x,
        state.pos.y + (state.crouch ? 1.12 : 1.62),
        state.pos.z,
      );
      if (origin.distanceTo(eye) <= SHOT_ORIGIN_TOLERANCE) return true;
    }
    if (this.avatar) {
      const eye = new THREE.Vector3(
        this.avatar.pos.x,
        this.avatar.pos.y + this.avatar.eyeHeight,
        this.avatar.pos.z,
      );
      if (origin.distanceTo(eye) <= SHOT_ORIGIN_TOLERANCE_AVATAR) return true;
    }
    return false;
  }

  /**
   * Raycast contra el jugador local (hitboxes de game.getPlayerHitboxes) respetando el mundo.
   * @returns {null | {type:'player'|'world', t:number, point:THREE.Vector3, part?:string, damageMult?:number, entity?:object}}
   */
  _raycastLocalPlayer(origin, dir, maxDist) {
    const game = this.game;
    const player = game && game.player;
    if (!player || player.alive === false) return null;

    const world =
      typeof game.raycastWorld === 'function'
        ? game.raycastWorld(origin, dir, maxDist)
        : game.physics && typeof game.physics.raycast === 'function'
          ? game.physics.raycast(origin, dir, maxDist)
          : null;
    let bestT = world && Number.isFinite(Number(world.t)) ? Number(world.t) : maxDist;
    let best = null;

    let boxes = [];
    try {
      boxes = typeof game.getPlayerHitboxes === 'function' ? game.getPlayerHitboxes(player) : [];
    } catch {
      boxes = [];
    }
    for (const hb of boxes || []) {
      if (!hb || !hb.box) continue;
      const t = rayBoxT(origin, dir, hb.box, bestT);
      if (t != null && t < bestT) {
        bestT = t;
        best = {
          type: 'player',
          t,
          point: new THREE.Vector3().copy(origin).addScaledVector(dir, t),
          part: hb.part,
          damageMult: hb.damageMult ?? 1,
          entity: player,
        };
      }
    }
    if (best) return best;
    if (world) {
      return {
        type: 'world',
        t: Number(world.t),
        point:
          world.point && isVecLike(world.point)
            ? new THREE.Vector3(Number(world.point.x), Number(world.point.y), Number(world.point.z))
            : new THREE.Vector3().copy(origin).addScaledVector(dir, Number(world.t)),
      };
    }
    return null;
  }

  /** FX de un disparo remoto (sonido con paneo, muzzle flash, trazadora). */
  _remoteShotFx(origin, dir, weaponId, endPoint, worldPoint) {
    const w = weaponInfo(weaponId);
    try {
      this.game.audio?.play?.(w && w.sound ? w.sound : 'gun_rifle', {
        volume: (w && w.volume ? w.volume : 1) * 0.85,
        pan: this._panFor(origin),
      });
      this.game.effects?.muzzleFlash?.(
        origin,
        dir,
        w && w.flashScale ? w.flashScale : 1,
      );
      if (endPoint) this.game.effects?.tracer?.(origin, endPoint);
      if (worldPoint && endPoint) {
        this.game.effects?.bulletImpact?.(endPoint, this._tmpUp, 'concrete');
      }
    } catch (err) {
      console.warn('[CS16 online] fx remoto', err);
    }
  }

  _panFor(position) {
    const player = this.game && this.game.player;
    if (!player || !player.pos || !position) return 0;
    const dx = position.x - player.pos.x;
    const dz = position.z - player.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const rightX = Math.cos(num(player.yaw));
    const rightZ = -Math.sin(num(player.yaw));
    return clamp(((dx * rightX + dz * rightZ) / len) * 0.75, -1, 1);
  }

  /* ====================================================================== */
  /* Muerte / respawn                                                       */
  /* ====================================================================== */

  /** Game.notifyKill en online. SÃƒÂ³lo se espera victim = jugador local del host. */
  onKill(killer, victim, weaponId = 'unknown', headshot = false) {
    if (this._disposed || this._over) return;
    const player = this.game && this.game.player;
    if (!victim || !player) return;

    if (victim === player) {
      if (!this.isHost) {
        // Camino defensivo: el guest normalmente muere vÃƒÂ­a `hit` (sin notifyKill).
        this._localDeath();
        return;
      }
      if (!this._hostAlive) return;
      this._hostAlive = false;
      this._hostHealth = 0;
      this._hostRespawnAt = Date.now() + RESPAWN_MS;
      this.scores.guest += 1;
      this.deaths.host += 1;
      const roundNo = this.scores.host + this.scores.guest;
      this.game.showClassicBanner?.(`RONDA ${roundNo}`, `HOST ${this.scores.host} Â· GUEST ${this.scores.guest}`, this.game.player?.team, 3600);
      this.game.audio?.play?.('round_lose', { volume: 0.7 });
      this._addKillFeed('guest', 'host', weaponId, headshot);
      this.session.send('kill', this._killPayload('host', 'guest', weaponId, headshot));
      this.game.ui?.showCenterMessage?.('HAS MUERTO', 2200);
      this.game.ui?.toast?.('ReaparecÃƒÂ©s en 2 segundos');
      this.game.audio?.play?.('bodyfall', { volume: 0.6 });
      this._checkMatchEnd();
      return;
    }

    // Defensivo: si algo daÃƒÂ±ÃƒÂ³ directamente a la entidad remota, lo tratamos como kill del guest.
    if (this.isHost && victim && victim.isRemote) this._killGuest(weaponId, headshot);
  }

  /** Muerte local del guest aplicada desde un mensaje `hit` (sin notifyKill). */
  _localDeath() {
    const player = this.game && this.game.player;
    if (!player || !player.alive) return;
    player.alive = false;
    player.deathTime = 0;
    player.health = 0;
    player.armor = 0;
    player.helmet = false;
    if (player.vel) {
      player.vel.x *= 0.2;
      player.vel.z *= 0.2;
    }
    this._guestAlive = false;
    this._guestHealth = 0;
    this._guestRespawnAt = Date.now() + RESPAWN_MS;
    this.game.audio?.play?.('death');
    try {
      this.game.weapons?.dropAll?.();
    } catch {
      /* ignore */
    }
    this.game.ui?.showCenterMessage?.('HAS MUERTO', 2200);
    this.game.ui?.toast?.('ReaparecÃƒÂ©s en 2 segundos');
  }

  _tickRespawns(now) {
    const player = this.game && this.game.player;
    if (this.isHost) {
      if (player && !player.alive) {
        if (!this._hostRespawnAt) this._hostRespawnAt = now + RESPAWN_MS;
        else if (now >= this._hostRespawnAt) this._respawnLocal('host');
      }
      if (!this._guestAlive) {
        if (!this._guestRespawnAt) this._guestRespawnAt = now + RESPAWN_MS;
        else if (now >= this._guestRespawnAt) this._respawnGuest();
      }
      return;
    }
    if (player && !player.alive && !this._guestRespawnAt) {
      this._guestRespawnAt = now + RESPAWN_MS;
    }
  }

  /** Respawn del jugador local (host: local; guest: por mensaje del host o fallback). */
  _respawnLocal(who) {
    const now = Date.now();
    const player = this.game && this.game.player;
    if (!player) return;
    const spawn = this._spawnFor(this.myTeam);
    try {
      if (typeof this.game.spawnOnlinePlayer === 'function') {
        this.game.spawnOnlinePlayer(this.myTeam, {
          x: spawn.x,
          y: spawn.y,
          z: spawn.z,
          yaw: spawn.yaw,
        });
      } else if (typeof this.game.spawnPlayer === 'function') {
        this.game.spawnPlayer(this.myTeam, {
          x: spawn.x,
          y: spawn.y,
          z: spawn.z,
          yaw: spawn.yaw,
        });
      } else {
        player.reset(this.myTeam, { x: spawn.x, y: spawn.y, z: spawn.z });
      }
    } catch (err) {
      console.warn('[CS16 online] respawn local', err);
    }
    player.yaw = spawn.yawRad;
    player.pitch = 0;
    player.recoilPitch = 0;
    player.recoilYaw = 0;
    if (typeof player.updateCamera === 'function') player.updateCamera(0, true);
    this._lastRespawnAt = now;

    if (who === 'host') {
      this._hostRespawnAt = 0;
      this._hostAlive = true;
      this._hostHealth = 100;
      this.session.send('respawn', {
        who: 'host',
        pos: { x: round3(spawn.x), y: round3(spawn.y), z: round3(spawn.z) },
        yaw: round3(spawn.yawRad),
        health: 100,
      });
    } else {
      this._guestRespawnAt = 0;
      this._guestRespawnIn = 0;
      this._guestAlive = true;
      this._guestHealth = 100;
      this._guestArmor = 100;
      this._guestHelmet = false;
      this._guestSpawnProtectionUntil = now + 1000;
      if (this.isHost) {
        this.session.send('respawn', {
          who: 'guest',
          pos: { x: round3(spawn.x), y: round3(spawn.y), z: round3(spawn.z) },
          yaw: round3(spawn.yawRad),
          health: 100,
        });
      }
    }
    this.game.ui?.showCenterMessage?.('HAS REAPARECIDO', 900);
  }

  /** Host: respawn autoritativo del guest (sin entidad local, sÃƒÂ³lo avatar + mensaje). */
  _respawnGuest() {
    const spawn = this._spawnFor(this.guestTeam);
    this._guestRespawnAt = 0;
    this._guestAlive = true;
    this._guestHealth = 100;
    this._guestArmor = 100;
    this._guestHelmet = false;
    this._guestSpawnProtectionUntil = Date.now() + 1000;
    if (this.avatar) {
      this.avatar.setTarget(spawn, spawn.yawRad, 0, false, true);
      this.avatar.snapToTarget();
      this.avatar.respawn();
    }
    this.session.send('respawn', {
      who: 'guest',
      pos: { x: round3(spawn.x), y: round3(spawn.y), z: round3(spawn.z) },
      yaw: round3(spawn.yawRad),
      health: 100,
    });
  }

  /** Fallback del guest si el mensaje `respawn` del host se perdiÃƒÂ³. */
  _maybeFallbackRespawn(now) {
    if (this.isHost || this._over) return;
    const player = this.game && this.game.player;
    if (!player || player.alive) return;
    if (!this._guestRespawnAt) return;
    if (now < this._guestRespawnAt + 700) return;
    this._respawnLocal('guest');
  }

  _handleRespawn(payload) {
    if (!payload || !payload.who) return;
    const who = payload.who === 'host' ? 'host' : 'guest';
    const pos = payload.pos && isVecLike(payload.pos) ? payload.pos : null;
    const yaw = num(payload.yaw, 0);
    const now = Date.now();

    if (who === this.role) {
      if (this.isHost) return;
      const player = this.game && this.game.player;
      if (player && player.alive && now - this._lastRespawnAt < 700) return;
      const spawn = pos
        ? { x: num(pos.x), y: num(pos.y), z: num(pos.z), yaw: yaw * (180 / Math.PI), yawRad: yaw }
        : this._spawnFor(this.myTeam);
      const player2 = this.game && this.game.player;
      if (player2) {
        try {
          if (typeof this.game.spawnOnlinePlayer === 'function') {
            this.game.spawnOnlinePlayer(this.myTeam, {
              x: spawn.x,
              y: spawn.y,
              z: spawn.z,
              yaw: spawn.yaw,
            });
          } else if (typeof this.game.spawnPlayer === 'function') {
            this.game.spawnPlayer(this.myTeam, {
              x: spawn.x,
              y: spawn.y,
              z: spawn.z,
              yaw: spawn.yaw,
            });
          } else {
            player2.reset(this.myTeam, { x: spawn.x, y: spawn.y, z: spawn.z });
          }
        } catch (err) {
          console.warn('[CS16 online] respawn guest', err);
        }
        player2.yaw = spawn.yawRad;
        player2.pitch = 0;
        if (typeof player2.updateCamera === 'function') player2.updateCamera(0, true);
      }
      this._lastRespawnAt = now;
      this._guestRespawnAt = 0;
      this._guestRespawnIn = 0;
      this._guestAlive = true;
      this._guestHealth = 100;
      this._guestArmor = 100;
      this._guestHelmet = false;
      this.game.ui?.showCenterMessage?.('HAS REAPARECIDO', 900);
      return;
    }

    // Respawn del rival (host). El guest actualiza el avatar y el espejo del host.
    if (this.isHost) {
      this._respawnGuest();
      return;
    }
    this._hostAlive = true;
    this._hostHealth = Math.max(1, Math.round(num(payload.health, 100)));
    if (this.avatar) {
      const target = pos
        ? new THREE.Vector3(num(pos.x), num(pos.y), num(pos.z))
        : this._spawnFor(this.remoteTeam);
      this.avatar.setTarget(target, yaw, 0, false, true);
      this.avatar.snapToTarget();
      this.avatar.respawn();
    }
  }

  _onLive() {
    try {
      this.game.audio?.play?.('round_start', { volume: 0.85 });
      this.game.ui?.showCenterMessage?.('Ã‚Â¡A JUGAR!', 1200);
    } catch (err) {
      console.warn('[CS16 online] _onLive', err);
    }
  }

  _checkMatchEnd() {
    if (this._over) return;
    if (this.scores.host < this.targetKills && this.scores.guest < this.targetKills) return;
    const winner = this.scores.host >= this.targetKills ? 'host' : 'guest';
    this._finish(winner, false);
  }

  _finish(winner, remote) {
    if (this._over) return;
    this._over = true;
    this.phase = 'over';
    const data = {
      winner,
      scoreHost: this.scores.host,
      scoreGuest: this.scores.guest,
      targetKills: this.targetKills,
      names: { ...this.names },
      role: this.role,
      youWon: winner === this.role,
      winnerName: this.names[winner] || winner,
      matchOver: true,
      reason: 'kills',
    };
    this._lastMatchEndData = data;
    if (this.isHost && !remote) {
      this.session.send('matchEnd', data);
    }
    try {
      this.game.releasePointerLock?.();
    } catch {
      /* ignore */
    }
    try {
      this.game.audio?.play?.(winner === this.role ? 'round_win' : 'round_lose', { volume: 0.9 });
    } catch {
      /* ignore */
    }
    this._notifyGameMatchEnd(data);
  }

  _notifyGameMatchEnd(data) {
    const game = this.game;
    if (!game) return;
    if (typeof game.onOnlineMatchEnd === 'function') {
      try {
        game.onOnlineMatchEnd(data);
        return;
      } catch (err) {
        console.warn('[CS16 online] onOnlineMatchEnd', err);
      }
    }
    if (typeof game.showOnlineMatchEnd === 'function') {
      try {
        game.showOnlineMatchEnd(data);
        return;
      } catch (err) {
        console.warn('[CS16 online] showOnlineMatchEnd', err);
      }
    }
    // Fallback defensivo mientras Game no exponga el hook.
    try {
      game.onlineUI?.showMatchEnd?.(data);
    } catch (err) {
      console.warn('[CS16 online] showMatchEnd', err);
    }
  }

  /** Host: desmonta la partida y vuelve al lobby (Game recibe onLobby y limpia). */
  requestRematch() {
    if (!this.isHost) {
      this.game?.toast?.('Solo el host puede pedir revancha');
      return false;
    }
    if (this._disposed) return false;
    if (this._rematchRequested) return true;
    this._rematchRequested = true;
    let ok = false;
    try {
      ok = this.session ? !!this.session.resetToLobby() : false;
    } catch (err) {
      console.warn('[CS16 online] resetToLobby', err);
      ok = false;
    }
    if (!ok) {
      this._rematchRequested = false;
      return false;
    }
    return true;
  }

  /* ====================================================================== */
  /* Red                                                                    */
  /* ====================================================================== */

  _sendNetwork(step, now) {
    this._stateAccum += step;
    if (this._stateAccum >= STATE_INTERVAL) {
      this._stateAccum = 0;
      this._sendState();
    }
    if (this.isHost) {
      this._snapshotAccum += step;
      if (this._snapshotAccum >= SNAPSHOT_INTERVAL) {
        this._snapshotAccum = 0;
        this._sendSnapshot(now);
      }
    }
    this._pingAccum += step;
    if (this._pingAccum >= PING_INTERVAL) {
      this._pingAccum = 0;
      this.session.send('ping', { t: now });
    }
  }

  _sendState() {
    const player = this.game && this.game.player;
    if (!player || !player.pos) return;
    this.session.send('state', {
      pos: { x: round3(player.pos.x), y: round3(player.pos.y), z: round3(player.pos.z) },
      yaw: round3(num(player.yaw)),
      pitch: round3(num(player.pitch)),
      crouch: !!player.crouching,
      onGround: player.onGround !== false,
      moveSpeed: round3(player.getVelocity2D?.() ?? player.speed ?? 0),
      weaponId: this.game?.weapons?.currentId || 'knife',
      alive: player.alive !== false,
    });
  }

  _sendSnapshot(now) {
    const player = this.game && this.game.player;
    const hostHealth = player && player.alive ? Math.max(0, Math.ceil(num(player.health))) : 0;
    const guestHealth = this._guestAlive ? Math.max(0, Math.ceil(this._guestHealth)) : 0;
    this.session.send('snapshot', {
      hostHealth,
      guestHealth,
      scoreHost: this.scores.host,
      scoreGuest: this.scores.guest,
      phase: this.phase,
      respawnHost: this._hostAlive
        ? 0
        : round1(Math.max(0, (this._hostRespawnAt - now) / 1000)),
      respawnGuest: this._guestAlive
        ? 0
        : round1(Math.max(0, (this._guestRespawnAt - now) / 1000)),
    });
  }

  /* ====================================================================== */
  /* Mensajes entrantes                                                     */
  /* ====================================================================== */

  handleMessage(type, payload) {
    if (this._disposed || !this._started) return;
    try {
      switch (type) {
        case 'state':
          this._handleState(payload);
          break;
        case 'snapshot':
          this._handleSnapshot(payload);
          break;
        case 'shot':
          this._handleRemoteShot(payload);
          break;
        case 'shotFx':
          this._handleShotFx(payload);
          break;
        case 'hit':
          this._handleHit(payload);
          break;
        case 'kill':
          this._handleKill(payload);
          break;
        case 'respawn':
          this._handleRespawn(payload);
          break;
        case 'matchEnd':
          this._handleMatchEnd(payload);
          break;
        case 'ping':
          if (payload && payload.t != null) {
            this.session.send('pong', { t: num(payload.t) });
          }
          break;
        case 'pong':
          if (payload && Number.isFinite(Number(payload.t))) {
            const rtt = Date.now() - Number(payload.t);
            if (rtt >= 0 && rtt < 5000) {
              this._rtt = this._rtt > 0 ? this._rtt * 0.7 + rtt * 0.3 : rtt;
              this.ping = Math.round(this._rtt);
            }
          }
          break;
        default:
          break;
      }
    } catch (err) {
      console.warn('[CS16 online] handleMessage', type, err);
    }
  }

  _handleState(payload) {
    if (!payload || !this.avatar) return;
    const pos = payload.pos;
    if (!isVecLike(pos)) return;
    const alive = payload.alive !== false;
    this.avatar.setTarget(
      pos,
      num(payload.yaw, this.avatar.yaw),
      num(payload.pitch, 0),
      !!payload.crouch,
      alive,
      typeof payload.weaponId === 'string' ? payload.weaponId : null,
      payload.onGround !== false,
      num(payload.moveSpeed, 0),
    );
    if (this.isHost) {
      this._lastRemoteState = {
        pos: { x: num(pos.x), y: num(pos.y), z: num(pos.z) },
        crouch: !!payload.crouch,
        weaponId: typeof payload.weaponId === 'string' ? payload.weaponId : null,
        onGround: payload.onGround !== false,
        moveSpeed: num(payload.moveSpeed, 0),
        at: Date.now(),
      };
    } else if (!alive) {
      this._hostAlive = false;
    } else if (this._hostAlive === false && this.phase === 'live') {
      // ResurrecciÃƒÂ³n detectada por state (si se perdiÃƒÂ³ `respawn`).
      this._hostAlive = true;
      this._hostHealth = Math.max(1, this._hostHealth);
    }
  }

  _handleSnapshot(payload) {
    if (!payload || this.isHost) return;
    if (Number.isFinite(Number(payload.scoreHost))) {
      this.scores.host = Math.max(0, Math.round(Number(payload.scoreHost)));
    }
    if (Number.isFinite(Number(payload.scoreGuest))) {
      this.scores.guest = Math.max(0, Math.round(Number(payload.scoreGuest)));
    }
    if (Number.isFinite(Number(payload.hostHealth))) {
      this._hostHealth = clamp(Number(payload.hostHealth), 0, 100);
      this._hostAlive = this._hostHealth > 0;
    }
    if (payload.phase === 'live' && this.phase === 'countdown') {
      this.phase = 'live';
    }
    const respawnGuest = Number(payload.respawnGuest);
    if (Number.isFinite(respawnGuest)) {
      this._guestRespawnIn = Math.max(0, respawnGuest);
      if (!this._guestAlive && respawnGuest > 0) {
        this._guestRespawnAt = Date.now() + respawnGuest * 1000;
      }
    }
    if (payload.phase === 'over' && !this._over) {
      const winner = this.scores.host >= this.targetKills ? 'host' : 'guest';
      if (this.scores.host >= this.targetKills || this.scores.guest >= this.targetKills) {
        this._finish(winner, true);
      }
    }
  }

  _handleShotFx(payload) {
    if (!this.isHost) {
      if (!payload) return;
      const origin = toVec3(payload.origin, this._tmpOrigin);
      const dir = toVec3(payload.dir, this._tmpDir);
      if (!origin || !dir) return;
      if (dir.lengthSq() < 1e-8) return;
      dir.normalize();
      const weaponId = typeof payload.weaponId === 'string' ? payload.weaponId : 'ak47';
      const range = num((weaponInfo(weaponId) || {}).range, 120);
      const point = payload.point && isVecLike(payload.point)
        ? new THREE.Vector3(
            Number(payload.point.x),
            Number(payload.point.y),
            Number(payload.point.z),
          )
        : new THREE.Vector3().copy(origin).addScaledVector(dir, range);
      this._remoteShotFx(origin, dir, weaponId, point, false);
      return;
    }
    // El host no recibe `shotFx` (es el emisor); ignorar por seguridad.
  }

  _handleHit(payload) {
    if (!payload) return;
    if (payload.target === 'guest') {
      if (this.isHost) return;
      this._applyLocalDamage(payload);
      return;
    }
    // Resultado del disparo propio contra el host (o formato viejo sin target).
    if (this.isHost) return;
    if (payload.miss) return;
    if (Number.isFinite(Number(payload.health))) {
      this._hostHealth = clamp(Number(payload.health), 0, 100);
      this._hostAlive = this._hostHealth > 0;
    }
    const headshot = !!payload.headshot;
    // Si el raycast local ya impactÃƒÂ³ (WeaponSystem mostrÃƒÂ³ hitmarker/sonido/blood),
    // no duplicamos el feedback al recibir la confirmaciÃƒÂ³n autoritativa del host.
    const predicted =
      !!this._guestShotPredictedAt && Date.now() - this._guestShotPredictedAt < 1500;
    if (!predicted) {
      this.game.ui?.showHitmarker?.(headshot);
      this.game.audio?.play?.('hit', { volume: headshot ? 0.9 : 0.6 });
      if (payload.point && isVecLike(payload.point)) {
        const point = new THREE.Vector3(
          Number(payload.point.x),
          Number(payload.point.y),
          Number(payload.point.z),
        );
        const player = this.game && this.game.player;
        if (player && player.pos) {
          const dir = new THREE.Vector3().subVectors(point, player.pos);
          this.game.effects?.blood?.(point, dir);
        }
      }
    }
    if (payload.point && isVecLike(payload.point) && this.avatar) this.avatar.playHit();
  }

  _applyLocalDamage(payload) {
    if (this._disposed || this._over) return;
    const player = this.game && this.game.player;
    if (!player || !player.alive) return;
    const health = Number(payload.health);
    const armor = Number(payload.armor);
    const damage = Math.max(0, num(payload.damage));
    if (Number.isFinite(health)) player.health = clamp(health, 0, 100);
    if (Number.isFinite(armor)) player.armor = clamp(armor, 0, 100);
    if (payload.helmet !== undefined) player.helmet = !!payload.helmet;
    player.damageFlash = 1;
    player.lastDamageTime = num(this.game.time);
    try {
      player.addShake?.(clamp(damage / 45, 0.08, 0.6));
    } catch {
      /* ignore */
    }
    if (this.avatar) {
      const angle =
        Math.atan2(this.avatar.pos.x - player.pos.x, this.avatar.pos.z - player.pos.z) *
        (180 / Math.PI);
      this.game.ui?.showDamage?.(angle);
    }
    this.game.audio?.play?.('hurt', { volume: clamp(damage / 45, 0.35, 1) });
    this.game.ui?.flashDamage?.(clamp(damage / 80, 0.05, 0.35));
    if (player.health <= 0) this._localDeath();
  }

  _handleKill(payload) {
    if (!payload || this.isHost) return;
    const victim = payload.victim === 'host' ? 'host' : 'guest';
    const killer = payload.killer === 'guest' ? 'guest' : 'host';
    if (Number.isFinite(Number(payload.scoreHost))) {
      this.scores.host = Math.max(0, Math.round(Number(payload.scoreHost)));
    }
    if (Number.isFinite(Number(payload.scoreGuest))) {
      this.scores.guest = Math.max(0, Math.round(Number(payload.scoreGuest)));
    }
    if (victim === 'guest') {
      this.deaths.guest += 1;
      this._guestAlive = false;
      this._guestHealth = 0;
      this._guestRespawnAt = Date.now() + RESPAWN_MS;
      const player = this.game && this.game.player;
      if (player && player.alive) this._localDeath();
    } else {
      this.deaths.host += 1;
      this._hostAlive = false;
      this._hostHealth = 0;
      if (this.avatar) this.avatar.playDeath();
      if (killer === 'guest') this.game.ui?.showKillConfirm?.(!!payload.headshot);
    }
    this._addKillFeed(killer, victim, payload.weapon, payload.headshot);
    this.game.audio?.play?.('bodyfall', { volume: 0.55 });
  }

  _handleMatchEnd(payload) {
    if (!payload || this.isHost) return;
    if (this._over) return;
    if (Number.isFinite(Number(payload.scoreHost))) {
      this.scores.host = Math.max(0, Math.round(Number(payload.scoreHost)));
    }
    if (Number.isFinite(Number(payload.scoreGuest))) {
      this.scores.guest = Math.max(0, Math.round(Number(payload.scoreGuest)));
    }
    const winner = payload.winner === 'guest' ? 'guest' : 'host';
    this._finish(winner, true);
  }

  _killPayload(victim, killer, weaponId, headshot) {
    return {
      victim,
      killer,
      weapon: weaponId || 'unknown',
      headshot: !!headshot,
      scoreHost: this.scores.host,
      scoreGuest: this.scores.guest,
    };
  }

  _addKillFeed(killerRole, victimRole, weaponId, headshot) {
    const weaponName =
      (this.game && this.game.weapons && typeof this.game.weapons.getName === 'function'
        ? this.game.weapons.getName(weaponId)
        : null) ||
      (weaponInfo(weaponId) && weaponInfo(weaponId).name) ||
      weaponId ||
      'mundo';
    const killerTeam = killerRole === 'host' ? this.hostTeam : this.guestTeam;
    const victimTeam = victimRole === 'host' ? this.hostTeam : this.guestTeam;
    const entry = {
      killer: this.names[killerRole] || killerRole,
      victim: this.names[victimRole] || victimRole,
      weapon: weaponName,
      headshot: !!headshot,
      teamKill: false,
      killerTeam,
      victimTeam,
      isPlayerKiller: killerRole === this.role,
      isPlayerVictim: victimRole === this.role,
    };
    try {
      if (typeof this.game.addKillFeed === 'function') this.game.addKillFeed(entry);
      else this.game.ui?.addKillFeed?.(entry);
    } catch (err) {
      console.warn('[CS16 online] killfeed', err);
    }
  }

  /* ====================================================================== */
  /* HUD / scoreboard                                                       */
  /* ====================================================================== */

  _spawnFor(team, roll = Math.random()) {
    const fallback = {
      x: 0,
      y: 0.05,
      z: 0,
      yaw: 0,
      yawRad: 0,
    };
    const spawns = this.game && this.game.map && this.game.map.spawns
      ? this.game.map.spawns[team]
      : null;
    if (!Array.isArray(spawns) || spawns.length === 0) return fallback;
    const random = Number.isFinite(roll) && roll >= 0 && roll < 1 ? roll : Math.random();
    const spawn = spawns[Math.floor(random * spawns.length)] || fallback;
    const yawDeg = num(spawn.yaw, 0);
    return {
      x: num(spawn.x),
      y: num(spawn.y, 0.05),
      z: num(spawn.z),
      yaw: yawDeg,
      yawRad: yawDeg * (Math.PI / 180),
    };
  }

  _respawnLeft(now) {
    if (this.isHost) {
      return this._hostAlive ? 0 : Math.max(0, (this._hostRespawnAt - now) / 1000);
    }
    return this._guestAlive ? 0 : Math.max(0, (this._guestRespawnAt - now) / 1000);
  }

  /** Contrato exacto de ONLINE_API.md. */
  getHudState() {
    const player = this.game && this.game.player;
    const now = Date.now();
    const alive = !!(player && player.alive);
    const remoteAlive = this.isHost ? this._guestAlive : this._hostAlive;
    const remoteHealth = this.isHost ? this._guestHealth : this._hostHealth;
    return {
      phase: this.phase,
      scoreHost: this.scores.host,
      scoreGuest: this.scores.guest,
      scoreYou: this.isHost ? this.scores.host : this.scores.guest,
      scoreThem: this.isHost ? this.scores.guest : this.scores.host,
      targetKills: this.targetKills,
      health: Math.max(0, Math.ceil(num(player && player.health, 0))),
      armor: Math.max(0, Math.ceil(num(player && player.armor, 0))),
      alive,
      respawnIn: alive ? 0 : round1(this._respawnLeft(now)),
      ping: Math.round(this._rtt) || 0,
      names: { ...this.names },
      role: this.role,
      remote: {
        health: Math.max(0, Math.round(num(remoteHealth, 0))),
        alive: !!remoteAlive,
        name: this.remoteName,
        team: this.remoteTeam,
      },
    };
  }

  getScoreboardData() {
    const player = this.game && this.game.player;
    const localAlive = !!(player && player.alive);
    const hostRow = {
      name: this.names.host,
      team: this.hostTeam,
      isPlayer: this.isHost,
      alive: this.isHost ? localAlive : !!this._hostAlive,
      kills: this.scores.host,
      deaths: this.deaths.host,
      money: 0,
      ping: this.isHost ? 0 : Math.round(this._rtt) || 0,
      hasBomb: false,
      hasKit: false,
    };
    const guestRow = {
      name: this.names.guest,
      team: this.guestTeam,
      isPlayer: !this.isHost,
      alive: this.isHost ? !!this._guestAlive : localAlive,
      kills: this.scores.guest,
      deaths: this.deaths.guest,
      money: 0,
      ping: this.isHost ? Math.round(this._rtt) || 0 : 0,
      hasBomb: false,
      hasKit: false,
    };
    const teams = { CT: [], T: [] };
    (teams[this.hostTeam] || []).push(hostRow);
    (teams[this.guestTeam] || []).push(guestRow);
    const scoreCT = this.hostTeam === 'CT' ? this.scores.host : this.scores.guest;
    const scoreT = this.guestTeam === 'T' ? this.scores.guest : this.scores.host;
    return {
      online: true,
      mode: '1v1',
      mapName: onlineMapLabel(this.game?.map?.id || this.startPayload.map),
      phase: this.phase,
      round: 1,
      scoreCT,
      scoreT,
      targetKills: this.targetKills,
      scores: { host: this.scores.host, guest: this.scores.guest },
      names: { ...this.names },
      role: this.role,
      teams,
    };
  }
}




