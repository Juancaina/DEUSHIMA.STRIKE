/**
 * Evita cierres accidentales de la pestaña/ventana durante la partida.
 *
 * Chrome no permite bloquear al 100% algunos atajos del navegador (Ctrl+W),
 * por eso además del keydown se instala beforeunload: si el juego está en
 * curso, el navegador pide confirmación antes de cerrar.
 */
const BLOCKED = new Set([
  'KeyW', // Ctrl+W / Ctrl+Shift+W
  'KeyN', // Ctrl+N / Ctrl+Shift+N
  'KeyT', // Ctrl+T
  'KeyR', // Ctrl+R / recarga
  'KeyQ', // Ctrl+Q / Ctrl+Shift+Q
  'F4', // Ctrl+F4 / Alt+F4
  'F5', // recarga
]);

function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function installShortcutGuard(game) {
  const handler = (e) => {
    if (isTyping(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.code;
    if (!key) return;

    const blocked =
      (mod && BLOCKED.has(key)) ||
      (e.altKey && key === 'F4') ||
      (mod && e.shiftKey && (key === 'KeyW' || key === 'KeyQ'));

    if (!blocked) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
  };

  window.addEventListener('keydown', handler, true);

  window.addEventListener('beforeunload', (e) => {
    const active = game && (game.state === 'playing' || game.state === 'paused' || game.state === 'roundover');
    if (!active) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  // Evita el cierre accidental con Ctrl+W del menú del navegador cuando el
  // foco está dentro del canvas.
  window.addEventListener('keyup', (e) => {
    if (isTyping(e.target)) return;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyW') {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}
