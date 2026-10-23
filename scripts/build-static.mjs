/**
 * Build estático para Vercel.
 *
 * El proyecto local usa assets GoldSrc de Valve en assets/cs16/ para el modo
 * personal. Esos archivos NO se publican. El build público incluye:
 *   - código de juego
 *   - branding propio
 *   - personajes Kenney (CC0)
 *
 * Los mapas AIM_REDLINE, AIM_MAP y ASSAULT tienen materiales procedurales de
 * respaldo cuando faltan los WAD; AIM_REDLINE es completamente procedural.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const files = ['index.html', 'favicon.svg'];
for (const file of files) {
  const src = path.join(root, file);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, file));
}

// Marca el build público: el código evita pedir assets de Valve que no se
// publican y usa HUD/arma procedurales de respaldo.
const indexPath = path.join(out, 'index.html');
if (fs.existsSync(indexPath)) {
  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.replace('<head>', '<head>\n    <script>globalThis.__DEUSHIMA_PUBLIC__ = true;</script>');
  fs.writeFileSync(indexPath, html);
}

const dirs = ['src', 'vendor'];
for (const dir of dirs) {
  const src = path.join(root, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(out, dir), { recursive: true });
}

// Assets públicos propios / CC0, más el audio CS solicitado.
// Solo se copia assets/cs16/sound; texturas/modelos/HUD de Valve NO se copian.
for (const dir of ['branding', 'characters']) {
  const src = path.join(root, 'assets', dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(out, 'assets', dir), { recursive: true });
}
// El usuario pidió sonidos de CS en la versión publicada: se incluye SOLO la
// carpeta de audio (no texturas/modelos/HUD de Valve).
const soundSrc = path.join(root, 'assets', 'cs16', 'sound');
if (fs.existsSync(soundSrc)) {
  fs.cpSync(soundSrc, path.join(out, 'assets', 'cs16', 'sound'), { recursive: true });
}
for (const file of ['deushima-strike.png']) {
  const src = path.join(root, 'assets', file);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, 'assets', file));
}

const vercel = {
  version: 2,
  cleanUrls: true,
  trailingSlash: false,
  headers: [
    {
      source: '/vendor/(.*)',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
    },
    {
      source: '/assets/characters/(.*)',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }],
    },
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    },
  ],
};
fs.writeFileSync(path.join(out, 'vercel.json'), JSON.stringify(vercel, null, 2));
fs.writeFileSync(path.join(out, 'BUILD_INFO.txt'), [
  'DEUSHIMA STRIKE - public static build',
  'Includes only audio (assets/cs16/sound) per user request.',
  'Textures/models/HUD of Valve are NOT included.',
].join('\n'));

for (const forbidden of ['assets/cs16/textures', 'assets/cs16/models', 'assets/cs16/ui', 'server.mjs', 'package.json', 'node_modules']) {
  if (fs.existsSync(path.join(out, forbidden))) {
    throw new Error(`Build público contiene ${forbidden}`);
  }
}
const bytes = (p) => {
  if (!fs.existsSync(p) || fs.statSync(p).isFile()) return fs.statSync(p).size;
  return fs.readdirSync(p).reduce((n, f) => n + bytes(path.join(p, f)), 0);
};
console.log(`Static build ready: ${out}`);
console.log(`  ${(bytes(out) / 1024 / 1024).toFixed(1)} MB · audio CS incluido, sin texturas/modelos/HUD de Valve`);
