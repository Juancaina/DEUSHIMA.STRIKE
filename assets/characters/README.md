# Personajes â€” Kenney Animated Characters Protagonists

Modelo base y animaciones originales del pack **Kenney Animated Characters
Protagonists** (CC0, ver `License.txt`).

## Archivos

| Archivo | Uso |
|---|---|
| `characterMedium.fbx` | modelo/skeleton base (se clona para cada bot) |
| `idle.fbx` | animaciÃ³n idle |
| `run.fbx` | animaciÃ³n de carrera |
| `jump.fbx` | animaciÃ³n de salto |
| `cyborgFemaleA.png` | skin CT principal |
| `skaterMaleA.png` | skin CT alternativa |
| `criminalMaleA.png` | skin T principal |
| `skaterFemaleA.png` | skin T alternativa |

La altura se normaliza a **~2.2 m** (cuerpo estirado, cabeza reducida) en `src/characters.js` (`MODEL_SCALE`).
El modelo mira hacia `-Z` despuÃ©s de la rotaciÃ³n de 180Â°.

## Para editar skins

Los PNG son atlas de piel del personaje. Se pueden editar directamente con
cualquier editor de imÃ¡genes o con Astra GPT:

- mantener el mismo tamaÃ±o y transparencia;
- mantener los nombres de archivo;
- recargar la pÃ¡gina (`Ctrl+F5`) despuÃ©s de guardar.

Los botones de equipo usan:

- `SKINS.CT = ['cyborgFemaleA', 'skaterMaleA']`
- `SKINS.T = ['criminalMaleA', 'skaterFemaleA']`


