import * as THREE from '../../vendor/three.module.js';
import { clamp, lerp, expDamp, DEG, distance2D } from './utils.js';

const UP = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _eye = new THREE.Vector3();

export class Player {
  constructor(game) {
    this.game = game;
    this.isPlayer = true;
    this.isBot = false;
    this.name = 'Jugador';
    this.team = 'CT';

    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.radius = 0.38;
    this.height = 1.8;
    this.standHeight = 1.8;
    this.crouchHeight = 1.32;
    this.eyeStand = 1.62;
    this.eyeCrouch = 1.12;
    this.stepHeight = 0.5;
    this.onGround = false;
    this.crouching = false;
    this.walking = false;
    this.crouchAmount = 0;

    this.yaw = 0;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.viewRoll = 0;
    this.shake = 0;
    this.bobTime = 0;
    this.bobAmount = 0;
    this.stepDistance = 0;

    this.health = 100;
    this.armor = 0;
    this.helmet = false;
    this.alive = false;
    this.deathTime = 0;
    this.lastDamageTime = -10;
    this.lastAttacker = null;
    this.damageFlash = 0;

    this.money = 800;
    this.kills = 0;
    this.deaths = 0;
    this.assists = 0;
    this.roundKills = 0;
    this.score = 0;
    this.hasDefuseKit = false;
    this.hasBomb = false;
    this.teamKills = 0;
    this.speed = 0;
    this.moveSpeed = 5.6;

    this.spawnProtection = 0;
    this._tmp = new THREE.Vector3();
  }

  reset(team = this.team, spawn = null) {
    this.team = team;
    this.pos.set(spawn?.x ?? 0, spawn?.y ?? 0.05, spawn?.z ?? 0);
    this.vel.set(0, 0, 0);
    this.yaw = (spawn?.yaw ?? 0) * DEG;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.health = 100;
    this.alive = true;
    this.deathTime = 0;
    this.height = this.standHeight;
    this.crouchAmount = 0;
    this.crouching = false;
    this.onGround = false;
    this.damageFlash = 0;
    this.lastDamageTime = -10;
    this.spawnProtection = 1.0;
    this.roundKills = 0;
    this.hasBomb = false;
    this.updateCamera(0, true);
  }

  respawn(team, spawn) {
    this.reset(team, spawn);
  }

  get eyeHeight() {
    return lerp(this.eyeStand, this.eyeCrouch, this.crouchAmount);
  }

  getEyePosition(target = new THREE.Vector3()) {
    return target.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
  }

  getVelocity2D() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  getAimDirection(target = new THREE.Vector3()) {
    const pitch = this.pitch + this.recoilPitch;
    const yaw = this.yaw + this.recoilYaw;
    return target
      .set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
      .normalize();
  }

  addRecoil(pitchKick, yawKick) {
    this.recoilPitch += pitchKick;
    this.recoilYaw += yawKick;
  }

  addShake(amount) {
    this.shake = Math.min(1.6, this.shake + amount);
  }

  addMoney(amount) {
    this.money = clamp(this.money + amount, 0, 16000);
    return this.money;
  }

  applyInputLook(dt) {
    const input = this.game.input;
    if (!input.locked) return;
    const look = input.consumeLook();
    const sens = 0.0021 * (this.game.settings.sensitivity ?? 1);
    const invert = this.game.settings.invertY ? -1 : 1;
    this.yaw -= look.x * sens;
    this.pitch -= look.y * sens * invert;
    this.yaw = ((this.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.pitch = clamp(this.pitch, -89 * DEG, 89 * DEG);
  }

  accelerate(wishDir, wishSpeed, accel, dt) {
    const current = this.vel.x * wishDir.x + this.vel.z * wishDir.z;
    const add = wishSpeed - current;
    if (add <= 0) return;
    let accelSpeed = Math.min(accel * wishSpeed * dt, add);
    this.vel.x += wishDir.x * accelSpeed;
    this.vel.z += wishDir.z * accelSpeed;
  }

  applyFriction(dt, friction = 8.5) {
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed < 0.05) {
      this.vel.x = 0;
      this.vel.z = 0;
      return;
    }
    const control = Math.max(speed, 1.5);
    const drop = control * friction * dt;
    const newSpeed = Math.max(0, speed - drop);
    const scale = newSpeed / speed;
    this.vel.x *= scale;
    this.vel.z *= scale;
  }

  wishDirection() {
    const input = this.game.input;
    const f = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
    const s = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
    _forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _wish.set(0, 0, 0).addScaledVector(_forward, f).addScaledVector(_right, s);
    if (_wish.lengthSq() > 1) _wish.normalize();
    return _wish;
  }

  update(dt) {
    const game = this.game;
    if (!this.alive) {
      this.deathTime += dt;
      this.applyInputLook(dt);
      this.updateCamera(dt);
      return;
    }

    this.applyInputLook(dt);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2);
    this.spawnProtection = Math.max(0, this.spawnProtection - dt);

    if (game.map?.mode === 'surf') {
      this.updateSurf(dt);
      return;
    }

    const input = game.input;
    const canMove = game.canMove();
    this.walking = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    this.crouching = canMove && (input.isDown('ControlLeft') || input.isDown('ControlRight'));

    const targetHeight = this.crouching ? this.crouchHeight : this.standHeight;
    this.height = expDamp(this.height, targetHeight, 18, dt);
    this.crouchAmount = expDamp(this.crouchAmount, this.crouching ? 1 : 0, 16, dt);

    if (this.crouching) this.moveSpeed = 2.35;
    else if (this.walking) this.moveSpeed = 3.1;
    else this.moveSpeed = 5.6;

    const wish = this.wishDirection();
    if (canMove) {
      if (this.onGround) {
        this.applyFriction(dt);
        this.accelerate(wish, this.moveSpeed, 11, dt);
        if (input.wasPressed('Space')) {
          this.vel.y = 5.0;
          this.onGround = false;
          game.audio.play('jump');
        }
      } else {
        this.accelerate(wish, Math.min(this.moveSpeed, 1.9), 3.2, dt);
        // Small air control bonus, CS-like.
        this.accelerate(wish, this.moveSpeed, 1.2, dt);
      }
    } else if (this.onGround) {
      this.applyFriction(dt, 10);
    }

    if (!game.settings.autoBhop) this.vel.y -= 18 * dt;
    else this.vel.y -= 18 * dt;

    const wasOnGround = this.onGround;
    const fallSpeed = this.vel.y;
    game.physics.moveBody(this, dt);
    if (!wasOnGround && this.onGround) {
      if (fallSpeed < -8.2) {
        const dmg = Math.min(90, Math.floor((-fallSpeed - 8.2) * 10));
        if (dmg > 0) this.takeDamage(dmg, null, 'legs', 'fall');
      }
      game.audio.play('land', { volume: clamp(fallSpeed / -12, 0.25, 1) });
      this.addShake(0.08);
    }

    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.updateBobAndSteps(dt);
    this.decayRecoil(dt);
    this.updateCamera(dt);
  }

  updateSurf(dt) {
    const game = this.game;
    const input = game.input;
    if (!game.canMove()) {
      this.updateCamera(dt);
      return;
    }
    const wish = this.wishDirection();
    const ramps = game.map?.surfRamps || [];
    const platforms = game.map?.surfPlatforms || [];

    let surface = null;
    for (const p of platforms) {
      if (this.pos.x >= p.x1 && this.pos.x <= p.x2 && this.pos.z >= p.z1 && this.pos.z <= p.z2 && this.pos.y <= p.y + 0.45) {
        surface = { y: p.y, ramp: null };
        break;
      }
    }
    if (!surface) {
      for (const r of ramps) {
        if (this.pos.x < r.x1 || this.pos.x > r.x2 || this.pos.z < r.z1 || this.pos.z > r.z2) continue;
        const t = (this.pos.z - r.z1) / Math.max(0.001, r.z2 - r.z1);
        const y = r.y1 + (r.y2 - r.y1) * t;
        if (this.pos.y <= y + 0.65 && this.pos.y >= y - 1.4) surface = { y, ramp: r };
        if (surface) break;
      }
    }

    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (surface) {
      this.onGround = true;
      this.pos.y = surface.y + 0.03;
      this.vel.y = 0;
      if (surface.ramp) {
        const r = surface.ramp;
        const slope = (r.y2 - r.y1) / Math.max(0.001, r.z2 - r.z1);
        const downhill = slope > 0 ? -1 : 1;
        this.vel.z += downhill * 22 * dt;
        this.vel.x += wish.x * 9 * dt;
        this.vel.z += wish.z * 5 * dt;
        // fricción muy baja para conservar la velocidad del surf
        const s = Math.hypot(this.vel.x, this.vel.z);
        if (s > 0.01) {
          const drop = Math.max(0.985, 1 - 0.12 * dt);
          this.vel.x *= drop;
          this.vel.z *= drop;
        }
      } else {
        this.applyFriction(dt, 4);
        this.accelerate(wish, Math.max(6.5, Math.min(12, speed + 4)), 14, dt);
      }
      if (input.wasPressed('Space') || (input.isDown('Space') && this._surfLandHop)) {
        this.vel.y = 7.4;
        this.onGround = false;
        this.pos.y += 0.05;
        game.audio?.play?.('jump', { volume: 0.6 });
      }
      this._surfLandHop = input.isDown('Space');
    } else {
      this.onGround = false;
      this.vel.y -= 11 * dt;
      if (wish.lengthSq() > 0) {
        this.vel.x += wish.x * 16 * dt;
        this.vel.z += wish.z * 16 * dt;
      }
      this._surfLandHop = false;
    }

    const max = 38;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs > max) {
      this.vel.x *= max / hs;
      this.vel.z *= max / hs;
    }
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.bobTime += dt * (this.onGround ? 6 : 2);
    this.bobAmount = expDamp(this.bobAmount, this.onGround ? Math.min(1, this.speed / 10) : 0, 8, dt);
    this.decayRecoil(dt);
    this.updateCamera(dt);
  }

  updateBobAndSteps(dt) {
    const game = this.game;
    const moving = this.onGround && this.speed > 0.4;
    if (moving) {
      this.bobTime += dt * (this.walking ? 7 : 10.5);
      this.bobAmount = expDamp(this.bobAmount, this.walking ? 0.25 : 1, 8, dt);
      this.stepDistance += this.speed * dt;
      const interval = this.walking ? 2.15 : 1.75;
      if (this.stepDistance > interval) {
        this.stepDistance = 0;
        game.audio.play('footstep', {
          volume: this.walking ? 0.22 : 0.48,
          pan: (Math.random() - 0.5) * 0.2,
        });
      }
    } else {
      this.bobAmount = expDamp(this.bobAmount, 0, 8, dt);
      this.stepDistance = 0;
    }
  }

  decayRecoil(dt) {
    this.recoilPitch = expDamp(this.recoilPitch, 0, 9, dt);
    this.recoilYaw = expDamp(this.recoilYaw, 0, 9, dt);
    this.shake = Math.max(0, this.shake - dt * 2.4);
  }

  updateCamera(dt, instant = false) {
    const cam = this.game.camera;
    if (!cam) return;
    const bob = this.bobAmount * Math.sin(this.bobTime) * 0.015;
    const bobSide = this.bobAmount * Math.cos(this.bobTime * 0.5) * 0.012;
    const shakeX = (Math.random() - 0.5) * this.shake * 0.026;
    const shakeY = (Math.random() - 0.5) * this.shake * 0.026;
    const crouchOffset = 0;
    if (!this.alive) {
      const t = Math.min(1, this.deathTime / 0.7);
      cam.position.set(this.pos.x, this.pos.y + lerp(this.eyeHeight, 0.28, t), this.pos.z);
      cam.rotation.order = 'YXZ';
      cam.rotation.set(this.pitch + this.recoilPitch - 0.18 * t, this.yaw + this.recoilYaw, 0.42 * t);
      return;
    }
    _eye.set(
      this.pos.x + bobSide + shakeX,
      this.pos.y + this.eyeHeight + bob + crouchOffset + shakeY,
      this.pos.z,
    );
    if (instant) cam.position.copy(_eye);
    else cam.position.lerp(_eye, 1 - Math.exp(-28 * dt));
    cam.rotation.order = 'YXZ';
    cam.rotation.set(this.pitch + this.recoilPitch, this.yaw + this.recoilYaw, this.viewRoll);
  }

  takeDamage(amount, source, part = 'chest', weaponId = 'unknown') {
    if (!this.alive) return 0;
    const game = this.game;
    let dmg = Math.max(0, amount);
    if (dmg <= 0) return 0;

    let armorDamage = 0;
    if (this.armor > 0) {
      const blocked = part === 'head' ? (this.helmet ? 0.5 : 0) : 0.5;
      const healthPortion = dmg * (1 - blocked);
      armorDamage = part === 'head' && !this.helmet ? 0 : Math.min(this.armor, dmg * 0.5);
      this.armor = Math.max(0, this.armor - armorDamage);
      dmg = healthPortion;
    }

    if (this.spawnProtection > 0) dmg *= 0.5;
    dmg = Math.max(1, Math.round(dmg));
    this.health -= dmg;
    this.lastDamageTime = game.time;
    this.lastAttacker = source;
    this.damageFlash = 1;
    this.addShake(clamp(dmg / 45, 0.08, 0.6));

    if (source && source.pos) {
      const ang = Math.atan2(source.pos.x - this.pos.x, source.pos.z - this.pos.z);
      game.ui?.showDamage(ang * (180 / Math.PI));
    }
    game.audio.play('hurt', { volume: clamp(dmg / 45, 0.35, 1) });
    game.ui?.flashDamage?.(clamp(dmg / 80, 0.05, 0.35));

    if (this.health <= 0) {
      this.health = 0;
      this.die(source, weaponId, part === 'head');
    }
    return dmg;
  }

  die(killer, weaponId = 'unknown', headshot = false) {
    if (!this.alive) return;
    this.alive = false;
    this.deathTime = 0;
    this.vel.x *= 0.2;
    this.vel.z *= 0.2;
    this.game.audio.play('death');
    this.armor = 0;
    this.helmet = false;
    this.hasDefuseKit = false;
    this.game.notifyKill(killer, this, weaponId, headshot);
    this.game.weapons?.dropAll?.();
  }
}
