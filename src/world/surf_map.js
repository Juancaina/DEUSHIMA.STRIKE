/**
 * SURF_DEUSHIMA ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â arena de surf inspirada en surfd.net / surf_boreas.
 * Rampas inclinadas, huecos y checkpoints. La fÃƒÆ’Ã‚Â­sica vive en Player.updateSurf().
 */
import * as THREE from '../../vendor/three.module.js';
import { ArenaBuilder } from './aim_map.js';
import { createMaterialSet, disposeMaterial } from './textures.js';

export const SURF_MAP_INFO = {
  id: 'surf_deushima',
  name: 'SURF_DEUSHIMA',
  displayName: 'SURF_DEUSHIMA',
  mode: 'surf',
  description: 'Rampas, huecos y checkpoints. MantenÃƒÆ’Ã‚Â© velocidad y aterrizÃƒÆ’Ã‚Â¡ en el finish.',
};

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function addRamp(b, matKey, { x = 0, z1, z2, y1, y2, width = 6 }) {
  const len = Math.abs(z2 - z1);
  const dy = y2 - y1;
  const angle = Math.atan2(dy, len);
  const geom = new THREE.PlaneGeometry(width, len, 1, 12);
  geom.rotateX(-Math.PI / 2);
  geom.rotateX(angle);
  const cy = (y1 + y2) / 2;
  geom.translate(x, cy, (z1 + z2) / 2);
  b.addRaw(matKey, geom);
  // Sin barandas altas: en surf la rampa debe quedar limpia y legible.
  return { x1: x - width / 2, x2: x + width / 2, z1: Math.min(z1, z2), z2: Math.max(z1, z2), y1: z1 < z2 ? y1 : y2, y2: z1 < z2 ? y2 : y1 };
}

export function buildSurfMap(game) {
  const info = SURF_MAP_INFO;
  const materialSet = createMaterialSet('cs_assault');
  const builder = new ArenaBuilder(info.id, materialSet, hashString(info.id));
  const ramps = [];
  const platforms = [];

  best: {
    // Plataforma inicial
    builder.boxMM('concreteFloor', -7, 7.0, 27, 7, 8.2, 38, { uvFit: true });
    platforms.push({ x1: -7, x2: 7, z1: 27, z2: 38, y: 8.2 });
    builder.boxMM('sandWallDark', -7, 8.2, 37.4, 7, 9.2, 38, { uvFit: true });
    builder.addSign?.('SURF_DEUSHIMA', { x: 0, y: 10.2, z: 37.1, ry: Math.PI, w: 4.8, h: 1.1, bg: '#10161b', fg: '#ffb000', border: '#9b5b21', sub: 'SURFD.NET INSPIRED' });

    // Rampa 1: larga, baja de 8 a 1.5
    ramps.push(addRamp(builder, 'concreteFloor', { x: 0, z1: 27, z2: -2, y1: 8.0, y2: 1.6, width: 7 }));

    // Plataforma intermedia
    builder.boxMM('metalDark', -5, 0.2, -8.5, 5, 1.8, -2, { uvFit: true });
    platforms.push({ x1: -5, x2: 5, z1: -8.5, z2: -2, y: 1.8 });

    // Rampa 2: subida con hueco
    ramps.push(addRamp(builder, 'concreteFloor', { x: 0, z1: -15, z2: -33, y1: 1.8, y2: 8.5, width: 6 }));

    // Finish
    builder.boxMM('metalDark', -6, 8.5, -42, 6, 9.8, -32, { uvFit: true });
    platforms.push({ x1: -6, x2: 6, z1: -42, z2: -32, y: 9.8 });
    builder.boxMM('concreteFloor', -6, 9.8, -36, 6, 10.1, -34, { uvFit: true });
    builder.addSign?.('FINISH', { x: 0, y: 11.6, z: -38.1, ry: 0, w: 3.4, h: 1.0, bg: '#0d1a12', fg: '#7dff63', border: '#2d7a3a' });

    // Rampa alternativa lateral (para lÃƒÆ’Ã‚Â­neas)
    ramps.push(addRamp(builder, 'concreteFloor', { x: 12, z1: 20, z2: -4, y1: 8.0, y2: 2.4, width: 4.5 }));
    builder.boxMM('metalDark', 9.5, 2.4, -9, 14.5, 3.8, -4, { uvFit: true });
    platforms.push({ x1: 9.5, x2: 14.5, z1: -9, z2: -4, y: 3.8 });

    // decoraciÃƒÆ’Ã‚Â³n: vigas, cielo, luces
    // soportes estructurales anclados al piso
    for (const [x, z, top] of [[-7, 27, 8.2], [7, 27, 8.2], [-6, -42, 9.8], [6, -42, 9.8], [-5, -8.5, 1.8], [5, -8.5, 1.8]]) {
      builder.boxMM('metalDark', x - 0.35, 0, z - 0.35, x + 0.35, top, z + 0.35, { uvFit: true });
    }
    for (let z = 24; z >= -38; z -= 18) {
      const light = new THREE.PointLight(0xffcf9a, 7, 20, 1.5);
      light.position.set(0, 9, z);
      builder.root.add(light);
      builder.lights.push(light);
    }
    builder.addEnvironment({
      skyTop: 0x101a2a,
      skyBottom: 0xd07a42,
      sunColor: 0xffd2a0,
      sunIntensity: 2.2,
      hemiColor: 0x6d86a8,
      hemiGround: 0x3c2e25,
      hemiIntensity: 0.9,
      ambientColor: 0x5a5a66,
      ambientIntensity: 0.35,
      sunDir: { x: -0.5, y: 0.72, z: 0.4 },
    });
    builder.addSky({
      skyTop: 0x0b1322,
      skyBottom: 0xe08a4c,
      sunDir: { x: -0.5, y: 0.72, z: 0.4 },
    }, { radius: 150, sunSize: 8 });
    builder.addClouds?.(6, 23);
  }

  builder.finalize();
  let triangles = 0;
  builder.root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    if (g) triangles += g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
  });

  const data = {
    id: info.id,
    name: info.name,
    displayName: info.displayName,
    mode: 'surf',
    description: info.description,
    bounds: { minX: -24, maxX: 24, minZ: -50, maxZ: 42 },
    spawns: {
      CT: [{ x: 0, y: 8.25, z: 32, yaw: 0 }],
      T: [{ x: 0, y: 8.25, z: 32, yaw: 0 }],
    },
    surfRamps: ramps,
    surfPlatforms: platforms,
    surfStart: { x: 0, y: 8.2, z: 32 },
    surfFinish: { x: 0, y: 9.8, z: -37, r: 4.5 },
    checkpoints: [
      { x: 0, y: 8.25, z: 32, yaw: 0, name: 'START' },
      { x: 0, y: 1.85, z: -5, yaw: 0, name: 'CP1' },
      { x: 0, y: 9.85, z: -37, yaw: 0, name: 'FINISH' },
    ],
    callouts: [],
    bombsites: [],
    hostageSpawns: [],
    rescueZone: null,
    buyZones: { CT: { min: { x: -999, z: -999 }, max: { x: -998, z: -998 } }, T: { min: { x: -999, z: -999 }, max: { x: -998, z: -998 } } },
    menuCamera: { pos: { x: 22, y: 18, z: 34 }, lookAt: { x: 0, y: 5, z: -10 } },
    root: builder.root,
    colliders: builder.colliders,
    stats: { triangles: Math.round(triangles), colliders: builder.colliders.length },
  };

  data.dispose = () => {
    builder.root.removeFromParent();
    builder.root.traverse((o) => { if ((o.isMesh || o.isLine) && o.geometry) o.geometry.dispose(); });
    for (const m of builder.uniqueMaterials) disposeMaterial(m);
    builder.uniqueMaterials.length = 0;
    for (const l of builder.lights) l.dispose?.();
    builder.lights.length = 0;
    materialSet.dispose();
    data.colliders.length = 0;
  };
  game.scene.add(builder.root);
  game.log?.(`Mapa ${info.id}: ${data.stats.triangles} tris Ãƒâ€šÃ‚Â· ${ramps.length} ramps Ãƒâ€šÃ‚Â· ${platforms.length} platforms`);
  return data;
}



