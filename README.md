# DEUSHIMA STRIKE

Reconstrucción local en browser de **Counter-Strike 1.6** con identidad propia:
**DEUSHIMA STRIKE**. Usa los assets reales de la instalación GoldSrc, un menú con
arte original, HUD clásico, armas originales, duelos 1v1 rápidos y un mapa de surf.

![Menú DEUSHIMA STRIKE](screenshots/deushima-menu.png)

## Características

- **Menú DEUSHIMA STRIKE** con el arte de portada provisto y botones estilo CS 1.6.
- **AIM_REDLINE local contra bots** desde el menú (además de AIM_MAP y ASSAULT).
- **HUD original**: `640hud*.spr`, números, iconos, radar, daño direccional y crosshair.
- **385 sonidos originales** + efecto de recarga propio: armas, pasos, radio, dolor/muerte, C4 y UI.
- **Recarga unificada**: todas las armas usan el mismo sonido, tardan **2 s** y
  recargan automáticamente al vaciar el cargador.
- **Personajes Kenney**: bots y rivales usan los modelos `Animated Characters Protagonists`
  (idle/run/jump, skins CT/T, ~2.2 m, pose de disparo) desde `assets/characters/`.
- **Nombres de aliados**: etiqueta sobre la cabeza, visible a través de paredes, con barra de vida.
- **Aparición aleatoria** en cada ronda del lado TT y CT (no siempre el mismo punto).
- **Viewmodels originales** de AK-47, M4A1, AWP, Deagle, USP, Glock y más.
- **Pausa/configuración estilo CS 1.6**: Ratón, Teclado, Audio, Vídeo, Juego.
- **Pantalla completa** desde el menú y protección contra cierres accidentales
  (`Ctrl+W`, `Ctrl+R`, `Ctrl+T`, etc.; aviso antes de cerrar la pestaña).
- **Mira limpia**: sin el punto central.
- **Duelo 1v1 rápido**:
  - sin freeze: arranca en el instante;
  - un kill cierra la ronda;
  - animación de muerte/caída y siguiente ronda automática al tocar el suelo;
  - primero a **13 rondas**; **12-12 es empate**;
  - **spawn aleatorio** en cada ronda del lado CT y del lado T.
- **Mapas**: `AIM_REDLINE`, `aim_1v1`, `ASSAULT · ARENA 1V1`, `de_dust2`, `cs_office` y
  **`SURF_DEUSHIMA`**. AIM_REDLINE está disponible en local y en el online 1v1.
- **Surf**: rampas, huecos, checkpoints, timer, récord local y física de
  deslizamiento/air-strafe propia, inspirada en surfd.net / `claude-surf`.
- **Online 1v1** con PeerJS: lobby, código, READY, rondas por kill y revancha.
- **Sprites nuevos** de `E:\Ivan\Desktop\sprites` integrados (daño, iconos, HUD).

## Capturas

| Menú | Duelo |
|---|---|
| ![Menú](screenshots/deushima-menu.png) | ![Duelo](screenshots/deushima-duel.png) |

| Assault | Surf |
|---|---|
| ![Assault](screenshots/deushima-assault.png) | ![Surf](screenshots/deushima-surf.png) |

![Pausa / configuración](screenshots/deushima-settings.png)

| AIM_REDLINE CT | AIM_REDLINE T |
|---|---|
| ![AIM_REDLINE CT](screenshots/deushima-redline-ct.png) | ![AIM_REDLINE T](screenshots/deushima-redline-t.png) |

| Personajes Kenney | Nombres de aliados |
|---|---|
| ![Personajes](screenshots/deushima-characters.png) | ![Tags](screenshots/deushima-ally-tags.png) |

## Entrega para texturas

La carpeta limpia para editar texturas con Astra GPT está en:

```
E:\Ivan\Desktop\DEUSHIMA_STRIKE
```

Ver `TEXTURES.md` para el mapa de carpetas.

## Requisitos

- Windows + Chrome/Edge actualizado.
- Node.js 20+.
- Copia legítima de Counter-Strike 1.6 en Steam.

## Extraer assets

La carpeta `Counter-Strike Source` **no** es CS 1.6. La instalación GoldSrc está en:

```
D:\SteamLibrary\steamapps\common\Half-Life\cstrike
```

```powershell
cd cs16-classic
python tools/extract-assets.py --source "D:\SteamLibrary\steamapps\common\Half-Life\cstrike"
python tools/convert-smds.py
python tools/fix-hud-alpha.py
python tools/install-user-sprites.py
```

Los assets generados viven en `assets/cs16/` y no se publican.

## Ejecutar

```powershell
node server.mjs
```

Abrir **http://127.0.0.1:8095/**. El servidor escucha en `0.0.0.0` para LAN.

## Controles

| Tecla | Acción |
|---|---|
| WASD | Moverse |
| Mouse | Apuntar |
| Click izq. | Disparar |
| Click der. | Zoom AWP |
| R | Recargar / reiniciar run en Surf |
| 1 / 2 / 3 | Primaria / secundaria / cuchillo |
| Shift | Caminar |
| Ctrl | Agacharse |
| Space | Saltar |
| B | Comprar (bombardeo) |
| Tab | Marcador |
| Esc | Pausa / configuración |

En **Surf**: usá A/D en el aire para mantener velocidad; R reinicia el run.

## Arquitectura

```
index.html
server.mjs                   servidor estático
src/main.js                  bootstrap
src/game.js                  motor, cámara, mapas, input, loop
src/duel.js                  1v1 rápido a 13, muerte y auto-ronda
src/surf.js                  timer/checkpoints del surf
src/characters.js            modelos Kenney (FBX + skins + animaciones)
src/ui/name-tags.js          nombres de aliados a través de paredes
src/ui/shortcut-guard.js     protección de atajos del navegador
src/core/player.js           movimiento CS + física surf
src/classic-viewmodel.js     viewmodels GoldSrc
src/ui/classic.js/css        menú, HUD, pausa/settings DEUSHIMA
src/world/aim_map.js         arena 1v1
src/world/assault_map.js     arena Assault
src/world/surf_map.js        SURF_DEUSHIMA
src/world/wad.js             texturas WAD originales
tools/extract-assets.py      extracción GoldSrc
tools/convert-smds.py        MDL/SMD → JSON
```

## Verificación

```powershell
node tests/assets-check.mjs
node tests/duel-logic.test.mjs
node tests/online-e2e.mjs       # dos Chrome + PeerJS
node tools/browser-test.mjs      # click real, HUD, mapas
```

Estado verificado:

- HUD 102 entradas, 385 sonidos, 33 modelos.
- Duelo: sin freeze, retardo de muerte, auto-ronda, primero a 13 y empate 12-12.
- Surf: el jugador avanza por la rampa (20+ u/s) y respawnea al caer.
- Assault/aim/dust2 cargan con texturas WAD.
- AIM_REDLINE local contra bots: movimiento, disparo, navegación y combate verificados.
- Online: lobby/READY/partida/revancha; los tres mapas AIM_REDLINE/AIM_MAP/ASSAULT cargan en ambos clientes.
- Publicado: `https://cs16-1v1.vercel.app` verificado con dos Chrome reales.

## Publicado online

**https://cs16-1v1.vercel.app**

El build público se genera con:

```powershell
npm run build:static
npm run deploy
```

`dist/` contiene branding propio, personajes Kenney y **los sonidos de CS**
(`assets/cs16/sound`). No incluye texturas/modelos/HUD de Valve, por eso
el build publicado usa HUD y arma procedurales de respaldo. AIM_REDLINE es
completamente procedural y se puede jugar online desde la URL publicada.

## Limitaciones

- El online usa **PeerJS P2P**, no un servidor Socket.io autoritativo.
- El online lleva a 13 kills/rondas, pero no implementa el empate 12-12.
- Los mapas son layouts propios inspirados en CS; **no son los BSP originales**.
- Los viewmodels usan la malla original en pose estática; las animaciones de arma son
  procedurales.
- **Assets de Valve solo para uso personal**. No publicar `assets/cs16` en Vercel/Git.




