/**
 * Temporary V3 third-person placeholders based on Quaternius
 * "Toon Shooter Game Kit" (CC0).
 *
 * The GLB files are processed assets from TinyStrike and retain the pack clips:
 * Idle, Walk, Run_Gun, Duck, Jump, Death, etc. They are loaded once and cloned
 * with SkeletonUtils for bots and online avatars. They are intentionally NOT
 * presented as the final Leet Krew A / SAS Blue identities; see
 * docs/v3-asset-manifest.json for the legal integration blockers.
 */
import * as THREE from '../vendor/three.module.js';
import { GLTFLoader } from '../vendor/loaders/GLTFLoader.js';
import { clone as skeletonClone } from '../vendor/utils/SkeletonUtils.js';

const ASSET_ROOT = '/assets/characters/quaternius';
const TARGET_HEIGHT = 1.8;
const MODELS = {
  CT: { url: `${ASSET_ROOT}/soldier_ct.glb`, bodyHeight: 2.2699 },
  T: { url: `${ASSET_ROOT}/soldier_t.glb`, bodyHeight: 2.1358 },
};

const GUN_MESH_NAMES = new Set(['AK', 'SMG', 'Sniper', 'Pistol']);
const PISTOLS = new Set(['glock', 'glock18', 'usp', 'p228', 'deagle', 'elite', 'fiveseven']);
const SMGS = new Set(['mp5', 'tmp', 'p90', 'ump45', 'mac10']);
const SNIPERS = new Set(['awp', 'scout', 'sg550', 'g3sg1']);
const HIDDEN_WEAPONS = new Set([
  'knife', 'c4', 'hegrenade', 'flashbang', 'smokegrenade', 'grenade', 'none',
]);

function normalizeTeam(team) {
  return team === 'T' ? 'T' : 'CT';
}

function weaponFamily(id) {
  const key = String(id || '').toLowerCase();
  if (!key || HIDDEN_WEAPONS.has(key)) return null;
  if (PISTOLS.has(key)) return 'Pistol';
  if (SMGS.has(key)) return 'SMG';
  if (SNIPERS.has(key)) return 'Sniper';
  return 'AK';
}

function clipMap(clips = []) {
  const map = new Map();
  for (const clip of clips) {
    if (!clip?.name) continue;
    map.set(clip.name.toLowerCase(), clip);
  }
  return map;
}

function firstClip(map, names) {
  for (const name of names) {
    const clip = map.get(String(name).toLowerCase());
    if (clip) return clip;
  }
  return null;
}

async function loadGltfWithRetry(loader, url, attempts = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await loader.loadAsync(url);
    } catch (err) {
      lastError = err;
      if (attempt + 1 >= attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
  throw lastError || new Error(`Failed to load GLTF: ${url}`);
}

export class CharacterLibrary {
  constructor(game) {
    this.game = game;
    this.ready = false;
    this.loading = null;
    this.sources = new Map();
  }

  async load() {
    if (this.ready) return this;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const loader = new GLTFLoader();
      const loaded = await Promise.all(
        Object.entries(MODELS).map(async ([team, info]) => {
          const gltf = await loadGltfWithRetry(loader, info.url);
          gltf.scene.traverse((obj) => {
            if (!obj.isMesh && !obj.isSkinnedMesh) return;
            obj.frustumCulled = false;
            obj.castShadow = true;
            obj.receiveShadow = true;
          });
          this.sources.set(team, {
            scene: gltf.scene,
            clips: gltf.animations || [],
            bodyHeight: info.bodyHeight,
          });
        }),
      );

      if (loaded.length !== 2) throw new Error('Could not load both Quaternius soldiers');
      this.ready = true;
      return this;
    })();

    try {
      return await this.loading;
    } catch (err) {
      console.error('[characters] Quaternius soldier load failed', err);
      this.loading = null;
      return this;
    }
  }

  create(team, seed = 0) {
    void seed;
    const normalizedTeam = normalizeTeam(team);
    const source = this.sources.get(normalizedTeam);
    if (!this.ready || !source?.scene) return null;

    const model = skeletonClone(source.scene);
    model.name = `operative:${normalizedTeam}`;
    const scale = TARGET_HEIGHT / source.bodyHeight;
    model.scale.setScalar(scale);
    model.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(model);
    if (Number.isFinite(box.min.y)) model.position.y -= box.min.y;
    model.updateMatrixWorld(true);

    const root = new THREE.Group();
    root.name = `character:${normalizedTeam}`;
    root.add(model);

    const gunMeshes = {};
    const aimBones = {};
    model.traverse((obj) => {
      if (GUN_MESH_NAMES.has(obj.name)) gunMeshes[obj.name] = obj;
      if (
        obj.isBone &&
        ['Torso', 'Neck', 'Head', 'Shoulder.L', 'Shoulder.R', 'UpperArm.L', 'UpperArm.R'].includes(obj.name) &&
        !aimBones[obj.name]
      ) {
        aimBones[obj.name] = obj;
      }
    });

    const mixer = new THREE.AnimationMixer(model);
    const clips = clipMap(source.clips);
    const actions = {};
    for (const [name, clip] of clips) {
      actions[name] = mixer.clipAction(clip);
      actions[name].enabled = false;
      actions[name].setEffectiveWeight(0);
    }

    let currentName = '';
    let currentWeapon = '';
    const play = (requested, fade = 0.08) => {
      const name = String(requested || 'Idle').toLowerCase();
      const clip = firstClip(clips, [name, 'idle']);
      if (!clip) return;
      const nextName = clip.name.toLowerCase();
      if (currentName === nextName) return;

      const next = actions[nextName] || mixer.clipAction(clip);
      const prev = currentName ? actions[currentName] : null;
      next.enabled = true;
      next.reset();
      next.setEffectiveWeight(1);
      next.setLoop(THREE.LoopRepeat, Infinity);
      next.fadeIn(fade).play();
      if (prev && prev !== next) prev.fadeOut(fade);
      currentName = nextName;
    };

    const setWeapon = (weaponId) => {
      const key = String(weaponId || '').toLowerCase();
      if (key === currentWeapon) return;
      currentWeapon = key;
      const family = weaponFamily(key);
      for (const [name, obj] of Object.entries(gunMeshes)) {
        obj.visible = !!family && name === family;
      }
    };

    play('Idle', 0);
    setWeapon(normalizedTeam === 'T' ? 'glock' : 'usp');

    return {
      root,
      model,
      mixer,
      actions,
      gunMeshes,
      aimBones,
      yawOffset: 0,
      targetHeight: TARGET_HEIGHT,
      get state() {
        return currentName;
      },
      setState(name) {
        play(name);
      },
      setWeapon,
      update(dt, actor = {}, moving = false) {
        const step = Math.min(0.1, Math.max(0, Number(dt) || 0));
        const speed = Number(actor.speed ?? actor.moveSpeed ?? actor._speed) || 0;
        // `moving` is only a fallback for callers that do not expose a measured
        // velocity. RemoteAvatar always sends speed, so slow Shift movement can
        // correctly use Walk instead of being promoted to Run_Gun.
        const locomotionSpeed = speed > 0 ? speed : moving ? 1.8 : 0;
        const crouching = !!actor.crouching;
        const onGround = actor.onGround !== false;
        const jumpState = actor.jumpState === 'rise' || actor.jumpState === 'fall'
          ? actor.jumpState
          : onGround ? 'ground' : Number(actor.velocity?.y) > 0.12 ? 'rise' : 'fall';
        const shooting = !!actor.shooting;
        const reloading = !!actor.reloading;

        setWeapon(actor.weaponId);

        let state = 'Idle';
        if (crouching) state = 'Duck';
        else if (!onGround && jumpState === 'rise') state = 'Jump';
        else if (!onGround) state = 'Jump_Idle';
        else if (shooting && locomotionSpeed > 3.2) state = 'Run_Shoot';
        else if (shooting) state = 'Idle_Shoot';
        else if (reloading) state = 'Idle';
        else if (locomotionSpeed > 3.2) state = 'Run_Gun';
        else if (locomotionSpeed > 0.45) state = 'Walk';

        play(state);
        const action = currentName ? actions[currentName] : null;
        if (action && currentName === 'run_gun') {
          action.timeScale = Math.max(0.72, Math.min(1.4, locomotionSpeed / 5.6 + 0.2));
        } else if (action && currentName === 'walk') {
          action.timeScale = Math.max(0.72, Math.min(1.2, locomotionSpeed / 2.7 + 0.2));
        } else if (action) {
          action.timeScale = 1;
        }
        mixer.update(step);

        // Lightweight additive aim pose for the temporary Quaternius placeholder.
        // AnimationMixer writes the base locomotion pose first; these small local
        // rotations distribute pitch across the upper body instead of tilting the
        // whole avatar rigidly. Exact Leet/SAS retargeting remains a separate V3 task.
        const pitch = Math.max(-1.35, Math.min(1.35, Number(actor.pitch) || 0));
        const pitchWeights = {
          Torso: 0.18,
          Neck: 0.18,
          Head: 0.16,
          'Shoulder.L': 0.1,
          'Shoulder.R': 0.1,
          'UpperArm.L': 0.12,
          'UpperArm.R': 0.12,
        };
        for (const [name, weight] of Object.entries(pitchWeights)) {
          const bone = aimBones[name];
          if (bone) bone.rotation.x += pitch * weight;
        }
      },
    };
  }
}
