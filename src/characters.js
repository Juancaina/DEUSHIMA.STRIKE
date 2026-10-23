/**
 * Personajes Kenney "Animated Characters Protagonists" (CC0).
 *
 * Los FBX originales estÃƒÂ¡n en assets/characters/. Se cargan una sola vez y se
 * clonan con SkeletonUtils para cada bot/avatar. La piel (skin PNG) se asigna
 * al material del mesh; las animaciones idle/run/jump vienen de los FBX
 * separados del pack.
 */
import * as THREE from '../vendor/three.module.js';
import { FBXLoader } from '../vendor/loaders/FBXLoader.js';
import { clone as skeletonClone } from '../vendor/utils/SkeletonUtils.js';

const ASSET_ROOT = '/assets/characters';
const MODEL_SCALE = 0.0047;
const BODY_STRETCH = 1.25; // personajes altos, sin silueta "chibi" baja
const SKINS = {
  CT: ['cyborgFemaleA', 'skaterMaleA'],
  T: ['criminalMaleA', 'skaterFemaleA'],
};

const _aimQ = new THREE.Quaternion();
const _aimWQ = new THREE.Quaternion();
const _aimPQ = new THREE.Quaternion();
const _aimA = new THREE.Vector3();
const _aimB = new THREE.Vector3();

const _aimTmpQ = new THREE.Quaternion();
const _aimTarget = new THREE.Vector3();
/** Orienta un hueso para que su hijo directo apunte a `target` local del modelo. */
function aimBone(bone, target, model) {
  if (!bone) return;
  const child = bone.children.find((c) => c.isBone);
  if (!child) return;
  bone.updateWorldMatrix(true, false);
  child.updateWorldMatrix(true, false);
  bone.getWorldPosition(_aimA);
  child.getWorldPosition(_aimB);
  const dir = _aimB.sub(_aimA).normalize();
  if (dir.lengthSq() < 0.5) return;
  model.getWorldQuaternion(_aimTmpQ);
  _aimTarget.copy(target).applyQuaternion(_aimTmpQ).normalize();
  _aimQ.setFromUnitVectors(dir, _aimTarget);
  bone.getWorldQuaternion(_aimWQ);
  bone.parent.getWorldQuaternion(_aimPQ);
  bone.quaternion.copy(_aimPQ.invert().multiply(_aimQ.multiply(_aimWQ)));
  bone.updateMatrixWorld(true);
}

let loader = null;

function getLoader() {
  if (!loader) loader = new FBXLoader();
  return loader;
}

export class CharacterLibrary {
  constructor(game) {
    this.game = game;
    this.ready = false;
    this.loading = null;
    this.base = null;
    this.animations = {};
    this.textures = new Map();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._skinsPromise = this._loadSkins();
  }

  async _loadSkins() {
    const tex = new THREE.TextureLoader();
    const uniq = [...new Set(Object.values(SKINS).flat())];
    await Promise.all(uniq.map(async (name) => {
      try {
        const texture = await tex.loadAsync(`${ASSET_ROOT}/${name}.png`);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.flipY = true;
        this.textures.set(name, texture);
      } catch (err) {
        console.warn('[characters] skin', name, err);
      }
    }));
  }

  async load() {
    if (this.ready) return this;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      await this._skinsPromise;
      const fbx = getLoader();
      const [base, idle, run, jump] = await Promise.all([
        fbx.loadAsync(`${ASSET_ROOT}/characterMedium.fbx`),
        fbx.loadAsync(`${ASSET_ROOT}/idle.fbx`),
        fbx.loadAsync(`${ASSET_ROOT}/run.fbx`),
        fbx.loadAsync(`${ASSET_ROOT}/jump.fbx`),
      ]);
      base.scale.setScalar(MODEL_SCALE);
      base.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(base);
      base.position.y -= bb.min.y;
      base.rotation.y = Math.PI; // el modelo de Kenney mira +Z; el juego usa -Z
      base.updateMatrixWorld(true);
      this.base = base;
      const pick = (gltf, key) => gltf.animations.find((a) => a.name.toLowerCase().includes(key)) || gltf.animations[0];
      this.animations.idle = pick(idle, 'idle') || null;
      this.animations.run = pick(run, 'run') || null;
      this.animations.jump = pick(jump, 'jump') || null;
      this.ready = true;
      return this;
    })();
    try {
      return await this.loading;
    } catch (err) {
      console.error('[characters] no se pudieron cargar los modelos Kenney', err);
      this.loading = null;
      return this;
    }
  }

  _skinFor(team, seed) {
    const list = SKINS[team] || SKINS.CT;
    const n = Math.abs(Math.floor((Number(seed) || 0) * 10000));
    return list[n % list.length];
  }

  _applySkin(model, skinName) {
    const texture = this.textures.get(skinName);
    model.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      o.frustumCulled = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const next = mats.map((m) => {
        const mat = m?.clone ? m.clone() : new THREE.MeshStandardMaterial();
        if (texture) {
          mat.map = texture;
          mat.color?.set(0xffffff);
        }
        if ('roughness' in mat) mat.roughness = 0.82;
        if ('metalness' in mat) mat.metalness = 0.02;
        mat.needsUpdate = true;
        return mat;
      });
      o.material = Array.isArray(o.material) ? next : next[0];
    });
  }

  _makeWeapon() {
    const group = new THREE.Group();
    group.name = 'kenneyWeapon';
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1e20, roughness: 0.55, metalness: 0.35 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x3b4145, roughness: 0.4, metalness: 0.55 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x252a2e, roughness: 0.65, metalness: 0.25 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.09, 0.48), dark);
    body.position.set(0, 0, -0.17);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.48, 8), metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.012, -0.53);
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.15, 0.09), metal);
    mag.position.set(0, -0.1, -0.18);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.075, 0.24), wood);
    stock.position.set(0, -0.015, 0.13);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.07), dark);
    grip.position.set(0, -0.09, 0.02);
    group.add(body, barrel, mag, stock, grip);
    group.scale.setScalar(1.15);
    return group;
  }

  create(team, seed = 0) {
    if (!this.ready || !this.base) return null;
    const skin = this._skinFor(team, seed);
    const model = skeletonClone(this.base);
    model.rotation.y = Math.PI;
    model.scale.set(MODEL_SCALE * 0.9, MODEL_SCALE * BODY_STRETCH, MODEL_SCALE * 0.9);
    model.updateMatrixWorld(true);
    const modelBox = new THREE.Box3().setFromObject(model);
    model.position.y -= modelBox.min.y;
    this._applySkin(model, skin);

    const root = new THREE.Group();
    root.name = `kenney:${team}:${skin}`;
    root.add(model);
    const weapon = this._makeWeapon();
    root.add(weapon);

    const rightArm = model.getObjectByName('RightArm');
    const leftArm = model.getObjectByName('LeftArm');
    const rightForeArm = model.getObjectByName('RightForeArm');
    const leftForeArm = model.getObjectByName('LeftForeArm');
    const headBone = model.getObjectByName('Head');
    if (headBone) headBone.scale.setScalar(0.62);
    const aimPose = () => {
      // Pose de disparo: brazos delante, codos flexionados, arma a la altura del pecho.
      if (rightArm) aimBone(rightArm, new THREE.Vector3(0.3, -0.45, 1), model);
      if (leftArm) aimBone(leftArm, new THREE.Vector3(-0.3, -0.45, 1), model);
      if (rightForeArm) aimBone(rightForeArm, new THREE.Vector3(0.08, 0.45, 1), model);
      if (leftForeArm) aimBone(leftForeArm, new THREE.Vector3(-0.08, 0.45, 1), model);
      if (headBone) headBone.scale.setScalar(0.62);
    };
    aimPose();

    const mixer = new THREE.AnimationMixer(model);
    const handTmp = new THREE.Vector3();
    const actions = {};
    for (const name of ['idle', 'run', 'jump']) {
      const clip = this.animations[name];
      if (!clip) continue;
      const action = mixer.clipAction(clip);
      action.enabled = false;
      action.setEffectiveWeight(0);
      actions[name] = action;
    }
    let currentName = null;
    const play = (name) => {
      const action = actions[name];
      if (!action || currentName === name) return;
      for (const other of Object.values(actions)) {
        other.stop();
        other.enabled = false;
        other.setEffectiveWeight(0);
      }
      action.reset();
      action.enabled = true;
      action.setEffectiveWeight(1);
      action.setLoop(THREE.LoopRepeat, Infinity);
      if (name === 'jump') action.setLoop(THREE.LoopOnce, 1);
      action.play();
      currentName = name;
    };
    play('idle');

    const rightHand = model.getObjectByName('RightHand');
    return {
      root, model, mixer, actions, weapon, rightHand, skin, aimPose,
      state: 'idle',
      setState(name) {
        play(name === 'run' ? 'run' : name === 'jump' ? 'jump' : 'idle');
        this.state = name;
      },
      update(dt, bot, moving) {
        this.mixer.update(dt);
        if (moving) this.setState('run');
        else if (bot.onGround) this.setState('idle');
        this.aimPose();
        this.root.updateMatrixWorld(true);
        if (this.rightHand) {
          this.rightHand.getWorldPosition(handTmp);
          this.root.worldToLocal(handTmp);
          this.weapon.position.copy(handTmp);
          this.weapon.position.y -= 0.02;
          this.weapon.position.z += 0.02;
        }
        this.weapon.rotation.set(
          THREE.MathUtils.clamp(-(bot.pitch || 0) * 0.9, -0.9, 0.9),
          0,
          0,
        );
      },
    };
  }
}





