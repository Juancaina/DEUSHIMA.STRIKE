# DEUSHIMA STRIKE V3 — movimiento CS16_1V1_AUTOBHOP

## Objetivo

El movimiento de producción para las arenas AIM usa el preset
`CS16_1V1_AUTOBHOP`. `CS16_VANILLA` existe únicamente para QA y comparación.
La física se reimplementa en JavaScript; no copia código de GoldSrc/ReGameDLL.

## Referencias de comportamiento

- ReGameDLL_CS `regamedll/pm_shared/pm_shared.cpp`: PM_Accelerate,
  PM_AirAccelerate, PM_Friction, PM_Jump y movimiento/colisión.
- HL/Quake lineage de PM_Friction para el sondeo de edge friction.
- Valores de referencia CS 1.6 usados por V3: gravity 800, accelerate 5,
  airaccelerate 10, friction 4, stopspeed 75, step size 18, maxvelocity 2000.

## Conversión de unidades

`40 unidades GoldSrc = 1 unidad de mundo DEUSHIMA`.

| Parámetro | GoldSrc | DEUSHIMA |
|---|---:|---:|
| gravity | 800 u/s² | 20 u/s² |
| stopspeed | 75 u/s | 1.875 u/s |
| air wish cap | 30 u/s | 0.75 u/s |
| jump velocity | 268.328 u/s | 6.7082 u/s |
| step size | 18 u | 0.45 u |
| maxvelocity | 2000 u/s | 50 u/s |
| edge probe ahead | 16 u | 0.40 u |
| edge probe down | 34 u | 0.85 u |

La velocidad base del arma sigue siendo `wishspeed` de suelo. No se usa como
clamp de la velocidad horizontal ya acumulada por bunnyhop.

## Integración temporal

- Simulación de movimiento: 100 Hz (`fixedStep = 0.01`).
- El render puede correr a otra frecuencia; el acumulador limita catch-up a 100 ms.
- Space se lee como estado persistente (`jumpHeld`), no mediante autorepeat.
- Si Space sigue apretado al aterrizar, el salto se resuelve antes de la fricción
  de suelo, preservando momentum XY.
- A/D + yaw usa aceleración proyectada sobre `wishdir`.
- `edgefriction = 2` sólo se aplica al permanecer en suelo cerca de un borde.
- El movimiento de colisión subdivide desplazamientos mayores a 0.18 unidades
  para reducir tunneling a velocidades de bhop.
- El duck comprueba que haya volumen libre antes de volver a altura de pie.

## QA automatizado

`tests/movement.test.mjs` cubre:

- velocidad de suelo por arma y walk;
- diagonal normalizada;
- counter-strafe;
- 10, 20 y 30 saltos manteniendo Space a 30/60/144 FPS de render;
- ausencia de doble salto;
- soltar Space detiene el chain;
- cadence irregular de render;
- air-strafe con ganancia medible frente a W estático;
- script de air-strafe comparado a 30/60/144 FPS;
- preset vanilla diagnóstico separado;
- duck/stand clearance;
- step-up con el `PhysicsWorld` real;
- anti-tunneling contra pared a 50 unidades/s;
- sondeo de edge friction.

Tolerancias actuales declaradas para el script de air-strafe de 2 segundos:

- spread de velocidad final entre 30/60/144 FPS: < 0.18 unidades/s;
- drift de posición respecto de 60 FPS: < 0.50 unidades.

El yaw sigue siendo una entrada muestreada por eventos/render, de modo que una
trayectoria de mouse sintética no es matemáticamente idéntica entre frecuencias
de render. La integración física sí ocurre a 100 Hz.

## QA online

`tests/online-e2e.mjs` comprueba en un 1v1 PeerJS real que:

- ambos clientes cargan `CS16_1V1_AUTOBHOP`;
- `autoBhopEnabled=true`;
- `fixedStep=0.01`;
- mantener Space ejecuta al menos 10 saltos reales del game loop;
- el rival recibe jump-state/tick de red mientras el jugador está en el aire.

El estado remoto transmite posición, vector de velocidad, velocidad horizontal,
yaw, pitch, grounded, crouch, jump-state, tick físico, arma y reload. El vector
de velocidad sólo se usa para una predicción visual corta; no otorga autoridad
de daño ni de inventario al cliente remoto.

## Debug HUD

Abrir:

`http://127.0.0.1:8095/?movementDebug=1`

Muestra speed XY/Y, grounded, tick, wishspeed, air acceleration, jump count,
jumpHeld, autobhop, preset, fixed dt y ping. Está desactivado por defecto.

## Limitaciones conocidas

- El mundo usa colliders AABB y no un BSP/brush solver completo; paredes y steps
  son sólidos y substepped, pero no reproduce todas las normales arbitrarias de
  pendientes de GoldSrc.
- El aim-pitch de los personajes Quaternius es una pose aditiva temporal. La
  validación anatómica definitiva depende de que los modelos exactos V3 puedan
  integrarse legalmente.
- `CS16_VANILLA` sirve sólo como comparación; el gameplay AIM normal usa
  `CS16_1V1_AUTOBHOP`.
