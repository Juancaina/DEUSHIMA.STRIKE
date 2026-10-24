import * as THREE from '../../vendor/three.module.js';
import { clamp, lerp, expDamp, DEG, distance2D } from './utils.js';

const UP = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _eye = new THREE.Vector3();

const GROUND_ACCEL = 10;
const AIR_ACCEL = 10;
const AIR_WISH_CAP = 0.76;
const GROUND_FRICTION = 4;
const STOP_SPEED = 1.9;
const JUMP_BUFFER = 0.1;

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
    this._jumpBuffer = 0;
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
    this._jumpBuffer = 0;
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

  applyFriction(dt, friction = GROUND_FRICTION) {
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed < 0.05) {
      this.vel.x = 0;
      this.vel.z = 0;
      return;
    }
    const control = Math.max(speed, STOP_SPEED);
    const drop = control * friction * dt;
    const newSpeed = Math.max(0, speed - drop);
    const scale = newSpeed / speed;
    this.vel.x *= scale;
    this.vel.z *= scale;
  }

  airAccelerate(wishDir, wishSpeed, dt) {
    if (wishDir.lengthSq() < 1e-8 || wishSpeed <= 0) return;
    const cappedWish = Math.min(wishSpeed, AIR_WISH_CAP);
    const current = this.vel.x * wishDir.x + this.vel.z * wishDir.z;
    const add = cappedWish - current;
    if (add <= 0) return;
    const accelSpeed = Math.min(AIR_ACCEL * wishSpeed * dt, add);
    this.vel.x += wishDir.x * accelSpeed;
    this.vel.z += wishDir.z * accelSpeed;
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

    if (input.wasPressed('Space')) this._jumpBuffer = JUMP_BUFFER;
    if (game.settings.autoBhop && input.isDown('Space')) this._jumpBuffer = JUMP_BUFFER;

    const wish = this.wishDirection();
    if (canMove) {
      if (this.onGround) {
        // A jump taken on the landing frame keeps horizontal momentum. This is
        // the key GoldSrc/Quake behavior that makes timed bunnyhops possible.
        if (this._jumpBuffer > 0) {
          this.vel.y = 5.0;
          this.onGround = false;
          this._jumpBuffer = 0;
          game.audio.play('jump');
        } else {
          this.applyFriction(dt);
          this.accelerate(wish, this.moveSpeed, GROUND_ACCEL, dt);
        }
      } else {
        // GoldSrc-style projection cap: total horizontal speed may grow while
        // only the component along the new wish direction is capped.
        this.airAccelerate(wish, this.moveSpeed, dt);
      }
    } else if (this.onGround) {
      this.applyFriction(dt, 10);
    }

    this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);
    this.vel.y -= 18 * dt;

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
