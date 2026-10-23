/**
 * OnlineSession â€” lobby PeerJS host-autoritativo para el modo Online 1v1 de CS16.
 *
 * Protocolo (PeerJS DataConnection, serializaciÃ³n JSON):
 *   Control interno (plano):
 *     { t:'hello', name }                       guest -> host
 *     { t:'lobby', lobby }                      host -> guest (lobby autoritativo)
 *     { t:'ready', ready }                      guest -> host
 *     { t:'start', role, code, names, hostTeam, guestTeam, startAt, targetKills }
 *     { t:'full' }                              host -> tercer jugador (y cierra)
 *     { t:'restartLobby' }                      host -> guest
 *     { t:'ping', ts } / { t:'pong', ts }       heartbeat interno (no se usa en partida)
 *   Mensajes de partida:
 *     { t:<tipo>, p:<payload> }                 se enrutan a handlers.onMatchMessage(tipo, payload)
 *
 * No usa `game` para lÃ³gica de partida: solo handlers. `game` se guarda por si el
 * consumidor quiere acceder desde afuera.
 *
 * Nota de testeo: `handlers.peerFactory(id, options)` permite inyectar un stub de
 * PeerJS en Node (global `window.Peer` no existe fuera del navegador).
 */

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const CODE_RE = /^[A-Z2-9]{5}$/;
const PEER_PREFIX = 'cs16aim';
const MODE = '1v1';
import { DEFAULT_ONLINE_MAP, isOnlineMap } from '../world/online_map_pool.js';
const TARGET_KILLS = 13;
const HOST_CODE_RETRIES = 5;
const PEER_OPEN_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 15000;
const LOBBY_TIMEOUT_MS = 15000;
const START_DELAY_MS = 500;
const COUNTDOWN_MS = 1500;
const MAX_NAME_LENGTH = 16;

/** STUN pÃºblicos (Google + Twilio). Sin TURN propio: redes muy restrictivas pueden fallar. */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

const ERROR_MESSAGES = {
  'unavailable-id': 'Ese cÃ³digo de sala ya estÃ¡ en uso.',
  'peer-unavailable': 'No se encontrÃ³ la sala. VerificÃ¡ el cÃ³digo e intentÃ¡ de nuevo.',
  network: 'No se pudo conectar al servidor. RevisÃ¡ tu conexiÃ³n a internet.',
  'network-error': 'No se pudo conectar al servidor. RevisÃ¡ tu conexiÃ³n a internet.',
  'server-error': 'El servidor de salas no responde. IntentÃ¡ de nuevo en unos segundos.',
  'socket-error': 'Se cortÃ³ la conexiÃ³n con el servidor de salas.',
  'socket-closed': 'Se cortÃ³ la conexiÃ³n con el servidor de salas.',
  'unexpected-close': 'La sala se cerrÃ³ inesperadamente.',
  webrtc: 'FallÃ³ la conexiÃ³n directa entre los jugadores. ProbÃ¡ de nuevo.',
  'browser-incompatible':
    'Tu navegador no es compatible con WebRTC. ProbÃ¡ con Chrome, Edge o Firefox actualizado.',
  'ssl-unavailable': 'La conexiÃ³n segura no estÃ¡ disponible. AbrÃ­ el juego con https.',
  'invalid-id': 'El cÃ³digo de sala no es vÃ¡lido.',
  'invalid-key': 'La configuraciÃ³n de la sala no es vÃ¡lida.',
  disconnected: 'Se perdiÃ³ la conexiÃ³n con el servidor de salas.',
};

function translatePeerError(err) {
  const type = err && (err.type || err.name);
  if (type && ERROR_MESSAGES[type]) return ERROR_MESSAGES[type];
  if (err && err.message) return `Error de conexiÃ³n: ${err.message}`;
  return 'OcurriÃ³ un error de conexiÃ³n. IntentÃ¡ de nuevo.';
}

function sanitizeName(name) {
  const clean = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return clean || 'Jugador';
}

function normalizeCode(code) {
  return String(code == null ? '' : code)
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, '')
    .slice(0, CODE_LENGTH);
}

function randomCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < CODE_LENGTH; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return code;
}

function makeLink(code) {
  const loc = typeof globalThis !== 'undefined' ? globalThis.location : null;
  if (!loc || !loc.origin) return '';
  const path = loc.pathname || '/';
  return `${loc.origin}${path}${path.includes('?') ? '&' : '?'}join=${code}`;
}

function makeLobby(code, hostName, guest) {
  return {
    code,
    mode: MODE,
    map: DEFAULT_ONLINE_MAP,
    targetKills: TARGET_KILLS,
    host: { name: hostName, ready: false, connected: true },
    guest: guest
      ? { name: guest.name, ready: !!guest.ready, connected: true }
      : null,
  };
}

function copyLobby(lobby) {
  if (!lobby) return null;
  return {
    code: lobby.code,
    mode: lobby.mode,
    map: lobby.map,
    targetKills: lobby.targetKills,
    host: lobby.host ? { ...lobby.host } : null,
    guest: lobby.guest ? { ...lobby.guest } : null,
  };
}

export class OnlineSession {
  /**
   * @param {object} game instancia de Game (no se usa para lÃ³gica)
   * @param {object} handlers
   *   onStatus({phase,message}), onLobby(lobby), onStart(payload),
   *   onMatchMessage(type,payload), onClosed(reason), onError(message),
   *   peerFactory(id,options) -> Peer (solo tests)
   */
  constructor(game, handlers = {}) {
    this.game = game || null;
    this.handlers = handlers || {};

    this._peer = null;
    this._conn = null;
    this._connOpen = false;
    this._role = null;
    this._code = null;
    this._name = '';
    this._guestName = '';
    this._hostName = '';
    this._remoteName = '';
    this._lobby = null;
    this._started = false;
    this._closed = true;
    this._closing = false;
    this._destroyed = false;
    this._closedEmitted = false;
    this._timers = new Set();
    this._startTimer = null;
    this._joinReject = null;
    this._lobbyWaiters = [];
    this._lastError = '';

    this._peerOptions = {
      config: { iceServers: ICE_SERVERS.map((s) => ({ ...s })) },
      debug: 0,
    };
    this._peerFactory =
      typeof this.handlers.peerFactory === 'function' ? this.handlers.peerFactory : null;
  }

  /* ====================================================================== */
  /* Getters                                                                */
  /* ====================================================================== */

  get role() {
    return this._role;
  }

  get code() {
    return this._code;
  }

  get lobby() {
    return this._lobby;
  }

  get connected() {
    return !!this._conn && (this._connOpen || this._conn.open === true);
  }

  get remoteName() {
    if (this._role === 'host') return this._guestName || '';
    return this._hostName || this._remoteName || '';
  }

  get started() {
    return this._started;
  }

  get peer() {
    return this._peer;
  }

  get peerId() {
    return this._peer && this._peer.id ? this._peer.id : null;
  }

  /* ====================================================================== */
  /* Host                                                                   */
  /* ====================================================================== */

  /**
   * Crea una sala como host. Reintenta hasta 5 cÃ³digos si PeerJS devuelve
   * `unavailable-id`.
   * @returns {Promise<{code:string, link:string}>}
   */
  async host(name) {
    if (this._role) throw new Error('Ya estÃ¡s en una sala');
    this._prepareSession();
    this._role = 'host';
    this._name = sanitizeName(name);
    this._hostName = this._name;
    this._status('creating', 'Creando sala...');

    let lastError = null;
    for (let attempt = 0; attempt < HOST_CODE_RETRIES; attempt++) {
      const code = randomCode();
      try {
        await this._openPeer(PEER_PREFIX + code);
        this._code = code;
        break;
      } catch (err) {
        lastError = err;
        this._teardownPeer();
        if (err && err.type === 'unavailable-id') {
          this._status('creating', 'Ese cÃ³digo estÃ¡ ocupado. Probando con otro...');
          continue;
        }
        const message = translatePeerError(err);
        this._status('error', message);
        this._emitError(message);
        this._teardownPeer();
        this._resetFields();
        throw new Error(message);
      }
    }

    if (!this._code) {
      const message =
        'No se pudo crear la sala despuÃ©s de varios intentos. ' +
        (lastError && lastError.type === 'unavailable-id'
          ? 'Todos los cÃ³digos estaban ocupados. ProbÃ¡ de nuevo.'
          : 'RevisÃ¡ tu conexiÃ³n a internet y probÃ¡ de nuevo.');
      this._status('error', message);
      this._emitError(message);
      this._teardownPeer();
      this._resetFields();
      throw new Error(message);
    }

    this._attachPeerEvents();
    this._lobby = makeLobby(this._code, this._name, null);
    this._status(
      'waiting',
      `Sala ${this._code} creada. Esperando a tu amigo...`,
    );
    this._emitLobby();
    return { code: this._code, link: makeLink(this._code) };
  }

  /* ====================================================================== */
  /* Guest                                                                  */
  /* ====================================================================== */

  /**
   * Se une a una sala existente y resuelve cuando el host mandÃ³ el lobby.
   * Timeout de conexiÃ³n: 15 s.
   */
  async join(code, name) {
    if (this._role) throw new Error('Ya estÃ¡s en una sala');
    const cleanCode = normalizeCode(code);
    if (!CODE_RE.test(cleanCode)) {
      const message = 'CÃ³digo invÃ¡lido. Debe tener 5 caracteres (A-Z y 2-9).';
      this._status('error', message);
      this._emitError(message);
      throw new Error(message);
    }

    this._prepareSession();
    this._role = 'guest';
    this._code = cleanCode;
    this._name = sanitizeName(name);
    this._guestName = this._name;

    this._status('creating', 'Conectando...');
    try {
      await this._openPeer(null);
    } catch (err) {
      const message =
        err && err.type === 'timeout'
          ? 'Tiempo de espera agotado al conectar. RevisÃ¡ tu conexiÃ³n a internet.'
          : translatePeerError(err);
      this._status('error', message);
      this._emitError(message);
      this._teardownPeer();
      this._resetFields();
      throw new Error(message);
    }

    this._attachPeerEvents();
    this._status('connecting', 'Conectando con la sala...');

    let conn;
    try {
      conn = await this._connectToHost(PEER_PREFIX + cleanCode);
    } catch (err) {
      const message = (err && err.message) || translatePeerError(err);
      this._status('error', message);
      this._emitError(message);
      this._teardownPeer();
      this._resetFields();
      throw new Error(message);
    }

    this._conn = conn;
    this._connOpen = true;
    this._bindConn(conn);
    this._status('connecting', 'Conectado. Esperando al host...');
    this._sendRaw({ t: 'hello', name: this._name });

    try {
      await this._waitLobby();
    } catch (err) {
      const message = (err && err.message) || 'El host no respondiÃ³.';
      this._status('error', message);
      this._emitError(message);
      this._teardownPeer();
      this._resetFields();
      throw new Error(message);
    }

    this._status(
      'connected',
      this._hostName ? `Conectado a la sala de ${this._hostName}` : 'Conectado a la sala',
    );
  }

  /* ====================================================================== */
  /* Lobby                                                                  */
  /* ====================================================================== */

  /** Marca/desmarca READY. Host: actualiza y difunde. Guest: avisa al host. */
  setReady(value) {
    const ready = !!value;
    if (this._role === 'host') {
      if (!this._lobby || !this._lobby.host) return;
      this._lobby.host.ready = ready;
      this._broadcastLobby();
      this._maybeStart();
      return;
    }
    if (this._role === 'guest') {
      if (!this._lobby || !this._lobby.guest) return;
      this._lobby.guest.ready = ready;
      this._sendRaw({ t: 'ready', ready });
      this._emitLobby();
    }
  }

  /** Host chooses the arena before both players ready up. Broadcast is authoritative. */
  setMap(mapId) {
    if (this._role !== 'host' || !this._lobby || this._started || !isOnlineMap(mapId)) return false;
    if (this._lobby.map === mapId) return true;
    this._cancelStartTimer();
    this._lobby.map = mapId;
    this._lobby.host.ready = false;
    if (this._lobby.guest) this._lobby.guest.ready = false;
    this._broadcastLobby();
    return true;
  }

  /** Solo host: vuelve al lobby (ready=false) y avisa a ambos. */
  resetToLobby() {
    if (this._role !== 'host' || !this._lobby) return false;
    this._cancelStartTimer();
    this._started = false;
    this._lobby.host.ready = false;
    if (this._lobby.guest) this._lobby.guest.ready = false;
    this._sendRaw({ t: 'restartLobby' });
    this._broadcastLobby();
    this._status('connected', 'En el lobby. Esperando que ambos estÃ©n listos...');
    return true;
  }

  /* ====================================================================== */
  /* Partida                                                                */
  /* ====================================================================== */

  /** Mensaje de partida al otro peer. Devuelve false si no hay conexiÃ³n. */
  send(type, payload) {
    if (!type || !this._conn || !this.connected) return false;
    const envelope = {
      t: String(type),
      p: payload && typeof payload === 'object' ? payload : {},
    };
    try {
      this._conn.send(envelope);
      return true;
    } catch {
      return false;
    }
  }

  /* ====================================================================== */
  /* Cierre / limpieza                                                      */
  /* ====================================================================== */

  close(reason = 'Saliste de la sala') {
    if (this._closed) return;
    this._closed = true;
    this._closing = true;
    this._clearTimers();
    const conn = this._conn;
    this._conn = null;
    this._connOpen = false;
    if (conn) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    }
    this._teardownPeer();
    this._status('closed', reason || 'Saliste de la sala');
    this._resetFields();
    this._closed = true;
    this._closing = false;
  }

  /* ====================================================================== */
  /* Internos: setup                                                        */
  /* ====================================================================== */

  _prepareSession() {
    this._clearTimers();
    this._teardownPeer();
    this._conn = null;
    this._connOpen = false;
    this._resetFields();
    this._closed = false;
    this._closing = false;
    this._destroyed = false;
  }

  _resetFields() {
    this._clearTimers();
    this._conn = null;
    this._connOpen = false;
    this._role = null;
    this._code = null;
    this._name = '';
    this._guestName = '';
    this._hostName = '';
    this._remoteName = '';
    this._lobby = null;
    this._started = false;
    this._startTimer = null;
    this._joinReject = null;
    this._closedEmitted = false;
    for (const waiter of this._lobbyWaiters.splice(0)) {
      waiter.reject(new Error('La conexiÃ³n se cerrÃ³ antes de recibir el lobby.'));
    }
  }

  _destroyPeerObject(peer) {
    if (!peer) return;
    try {
      peer.removeAllListeners?.();
    } catch {
      /* ignore */
    }
    try {
      peer.destroy?.();
    } catch {
      /* ignore */
    }
  }

  _teardownPeer() {
    const peer = this._peer;
    this._peer = null;
    if (peer) this._destroyPeerObject(peer);
  }

  _setTimer(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      try {
        fn();
      } catch (err) {
        this._emitError(translatePeerError(err));
      }
    }, ms);
    this._timers.add(id);
    return id;
  }

  _clearTimers() {
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    this._startTimer = null;
  }

  _cancelStartTimer() {
    if (this._startTimer != null) {
      clearTimeout(this._startTimer);
      this._timers.delete(this._startTimer);
      this._startTimer = null;
    }
  }

  _peerCtor() {
    if (this._peerFactory) return this._peerFactory;
    if (typeof globalThis !== 'undefined' && typeof globalThis.Peer === 'function') {
      return globalThis.Peer;
    }
    if (typeof window !== 'undefined' && typeof window.Peer === 'function') {
      return window.Peer;
    }
    return null;
  }

  _makePeerObject(id) {
    if (this._peerFactory) {
      return this._peerFactory(id, this._peerOptions);
    }
    const Peer = this._peerCtor();
    if (!Peer) {
      const err = new Error(
        'PeerJS no estÃ¡ disponible. RecargÃ¡ la pÃ¡gina o probÃ¡ con otro navegador.',
      );
      err.type = 'peerjs-missing';
      throw err;
    }
    try {
      return id ? new Peer(id, this._peerOptions) : new Peer(this._peerOptions);
    } catch (err) {
      if (err && !err.type) err.type = 'peerjs-init';
      throw err;
    }
  }

  /** Abre el Peer (host con id fijo o guest con id aleatorio) y espera `open`. */
  _openPeer(id) {
    let peer;
    try {
      peer = this._makePeerObject(id);
    } catch (err) {
      return Promise.reject(err);
    }
    this._peer = peer;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const err = new Error(
          this._role === 'host'
            ? 'No se pudo crear la sala. RevisÃ¡ tu conexiÃ³n a internet.'
            : 'No se pudo conectar al servidor. RevisÃ¡ tu conexiÃ³n a internet.',
        );
        err.type = 'timeout';
        reject(err);
      }, PEER_OPEN_TIMEOUT_MS);
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(peer);
      };
      const onError = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err || { type: 'network' });
      };
      const cleanup = () => {
        clearTimeout(timer);
        try {
          peer.off?.('open', onOpen);
        } catch {
          /* ignore */
        }
      };
      try {
        peer.on('open', onOpen);
        peer.on('error', onError);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  _attachPeerEvents() {
    const peer = this._peer;
    if (!peer) return;
    peer.on('error', (err) => this._onPeerError(err));
    peer.on('disconnected', () => this._onPeerDisconnected());
    peer.on('close', () => this._onPeerClose());
    if (this._role === 'host') {
      peer.on('connection', (conn) => this._onIncomingConnection(conn));
    }
  }

  _makeConnection(hostPeerId) {
    if (!this._peer || typeof this._peer.connect !== 'function') {
      const err = new Error('No se pudo iniciar la conexiÃ³n.');
      err.type = 'connect';
      throw err;
    }
    return this._peer.connect(hostPeerId, {
      serialization: 'json',
      reliable: true,
      metadata: { name: this._name },
    });
  }

  _connectToHost(hostPeerId) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let conn;
      try {
        conn = this._makeConnection(hostPeerId);
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        finish(
          reject,
          new Error('Tiempo de espera agotado. No se encontrÃ³ la sala. VerificÃ¡ el cÃ³digo.'),
        );
      }, CONNECT_TIMEOUT_MS);
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._joinReject = null;
        fn(value);
      };
      this._joinReject = (message) => finish(reject, new Error(message));
      try {
        conn.on('open', () => finish(resolve, conn));
        conn.on('error', (err) => {
          const type = err && err.type;
          const message =
            type === 'peer-unavailable'
              ? 'No se encontrÃ³ la sala. VerificÃ¡ el cÃ³digo e intentÃ¡ de nuevo.'
              : translatePeerError(err);
          finish(reject, new Error(message));
        });
        conn.on('close', () => {
          if (!settled) finish(reject, new Error('La conexiÃ³n se cerrÃ³ antes de empezar.'));
        });
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  /* ====================================================================== */
  /* Internos: eventos PeerJS                                               */
  /* ====================================================================== */

  _onPeerError(err) {
    if (this._closing || this._closed) return;
    const type = err && err.type;
    const message = translatePeerError(err);
    this._lastError = message;
    if (this._joinReject) {
      const reject = this._joinReject;
      this._joinReject = null;
      reject(message);
      return;
    }
    this._emitError(message);
    const fatalNetwork = ['network', 'server-error', 'socket-error', 'socket-closed'].includes(type);
    if (fatalNetwork && this._started) this._emitClosed(message);
  }

  _onPeerDisconnected() {
    if (this._closing || this._closed) return;
    if (!this._peer) return;
    this._status('connecting', 'Se perdiÃ³ la conexiÃ³n con el servidor. Reconectando...');
    try {
      this._peer.reconnect?.();
    } catch {
      /* ignore */
    }
    this._setTimer(() => {
      if (this._closing || this._closed) return;
      if (this._peer && this._peer.disconnected && !this._peer.destroyed) {
        const message = 'No se pudo reconectar con el servidor de salas.';
        this._status('error', message);
        this._emitError(message);
        if (this._started || !this.connected) this._emitClosed(message);
      }
    }, 8000);
  }

  _onPeerClose() {
    if (this._closing || this._closed) return;
    const message = 'Se cerrÃ³ la conexiÃ³n de la sala.';
    this._status('error', message);
    this._emitClosed(message);
  }

  /* ====================================================================== */
  /* Internos: conexiones                                                   */
  /* ====================================================================== */

  _onIncomingConnection(conn) {
    if (this._closing || this._closed) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
      return;
    }
    if (this._conn) {
      this._rejectFull(conn);
      return;
    }
    this._conn = conn;
    this._connOpen = conn.open === true;
    this._bindConn(conn);
    const onOpen = () => {
      if (this._conn !== conn || this._closing) return;
      this._connOpen = true;
      if (!this._started) {
        this._status('connected', 'Jugador conectado. Esperando datos...');
      }
    };
    if (conn.open === true) onOpen();
    else conn.on('open', onOpen);
  }

  _rejectFull(conn) {
    const sendFull = () => {
      try {
        conn.send({ t: 'full' });
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          conn.close();
        } catch {
          /* ignore */
        }
      }, 150);
    };
    if (conn.open === true) sendFull();
    else {
      try {
        conn.on('open', sendFull);
      } catch {
        /* ignore */
      }
    }
  }

  _bindConn(conn) {
    conn.on('data', (data) => this._onData(data));
    conn.on('close', () => this._onConnClose(conn));
    conn.on('error', (err) => this._onConnError(conn, err));
  }

  _onConnClose(conn) {
    if (conn !== this._conn) return;
    this._conn = null;
    this._connOpen = false;
    this._cancelStartTimer();
    if (this._closing || this._closed) return;
    if (this._started) {
      this._started = false;
      this._emitClosed('El otro jugador se desconectÃ³.');
      return;
    }
    if (this._role === 'host') {
      this._guestName = '';
      this._remoteName = '';
      this._lobby = makeLobby(this._code, this._name, null);
      this._status('waiting', 'El jugador se desconectÃ³. Esperando a alguien mÃ¡s...');
      this._emitLobby();
      return;
    }
    this._emitClosed('Se perdiÃ³ la conexiÃ³n con el host.');
  }

  _onConnError(conn, err) {
    if (this._closing || this._closed) return;
    const message = translatePeerError(err);
    this._lastError = message;
    this._emitError(message);
  }

  /* ====================================================================== */
  /* Internos: protocolo                                                     */
  /* ====================================================================== */

  _sendRaw(obj) {
    if (!this._conn || !this.connected) return false;
    try {
      this._conn.send(obj);
      return true;
    } catch {
      return false;
    }
  }

  _onData(raw) {
    if (this._closing || this._closed) return;
    let msg = raw;
    if (typeof raw === 'string') {
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    const type = msg.t;

    if (type === 'hello') return this._onHello(msg);
    if (type === 'lobby') return this._onLobbyMessage(msg);
    if (type === 'ready') return this._onReadyMessage(msg);
    if (type === 'start') return this._onStartMessage(msg);
    if (type === 'full') return this._onFullMessage();
    if (type === 'restartLobby') return this._onRestartLobby();
    if (type === 'ping') return this._onPing(msg);
    if (type === 'pong') {
      if (msg.p && typeof msg.p === 'object' && this._started) {
        this._emitMatch('pong', msg.p);
      }
      return;
    }
    if (this._started) this._emitMatch(type, this._payloadOf(msg));
  }

  _payloadOf(msg) {
    if (msg.p && typeof msg.p === 'object') return msg.p;
    const payload = {};
    for (const key of Object.keys(msg)) {
      if (key !== 't' && key !== 'p') payload[key] = msg[key];
    }
    return payload;
  }

  _onHello(msg) {
    if (this._role !== 'host' || !this._lobby) return;
    if (this._started) return;
    const name = sanitizeName(msg.name);
    this._guestName = name;
    this._remoteName = name;
    this._lobby.guest = { name, ready: false, connected: true };
    this._status('connected', `Jugador conectado: ${name}`);
    this._broadcastLobby();
    this._maybeStart();
  }

  _onReadyMessage(msg) {
    if (this._role !== 'host' || !this._lobby) return;
    if (!this._lobby.guest) return;
    this._lobby.guest.ready = !!msg.ready;
    this._broadcastLobby();
    this._maybeStart();
  }

  _onLobbyMessage(msg) {
    if (this._role !== 'guest') return;
    const lobby = msg.lobby && typeof msg.lobby === 'object' ? msg.lobby : null;
    if (!lobby) return;
    if (!isOnlineMap(lobby.map)) {
      this._emitError('La sala usa un mapa no disponible en esta versión del juego.');
      return;
    }
    this._lobby = copyLobby(lobby);
    if (this._lobby.host && this._lobby.host.name) this._hostName = this._lobby.host.name;
    this._remoteName = this._hostName;
    this._status(
      'connected',
      this._hostName ? `Conectado a la sala de ${this._hostName}` : 'Conectado a la sala',
    );
    this._resolveLobbyWaiters();
    this._emitLobby();
  }

  _onStartMessage(msg) {
    if (this._role !== 'guest') return;
    const payload = this._payloadOf(msg);
    if (!isOnlineMap(payload.map) || payload.map !== this._lobby?.map) {
      this._emitError('El mapa de la partida no coincide con el elegido en la sala.');
      return;
    }
    payload.role = payload.role === 'host' ? 'host' : 'guest';
    if (this._lobby) {
      if (this._lobby.host) this._lobby.host.ready = true;
      if (this._lobby.guest) this._lobby.guest.ready = true;
    }
    this._started = true;
    this._status('connected', 'Â¡Partida en curso!');
    try {
      this.handlers.onStart?.(payload);
    } catch (err) {
      console.error('[CS16 online] onStart', err);
    }
  }

  _onFullMessage() {
    const message = 'La sala estÃ¡ llena (mÃ¡ximo 2 jugadores).';
    this._lastError = message;
    this._emitError(message);
    if (this._joinReject) {
      const reject = this._joinReject;
      this._joinReject = null;
      reject(message);
    }
    for (const waiter of this._lobbyWaiters.splice(0)) waiter.reject(new Error(message));
    if (this._role === 'guest') {
      this._closed = true;
      this._closing = true;
      const conn = this._conn;
      this._conn = null;
      this._connOpen = false;
      try {
        conn?.close();
      } catch {
        /* ignore */
      }
      this._teardownPeer();
      this._resetFields();
      this._closed = true;
      this._closing = false;
    }
  }

  _onRestartLobby() {
    if (this._role !== 'guest') return;
    this._started = false;
    if (this._lobby) {
      if (this._lobby.host) this._lobby.host.ready = false;
      if (this._lobby.guest) this._lobby.guest.ready = false;
    }
    this._status('connected', 'El host volviÃ³ al lobby. Esperando READY...');
    this._emitLobby();
  }

  _onPing(msg) {
    // Ping/pong de partida viajan con payload (`{t:'ping', p:{t:...}}`) y se enrutan
    // a onMatchMessage. Esto cubre sÃ³lo el heartbeat interno plano.
    if (msg.p && typeof msg.p === 'object') {
      if (this._started) this._emitMatch('ping', msg.p);
      return;
    }
    this._sendRaw({ t: 'pong', ts: msg.ts });
  }

  _maybeStart() {
    if (this._role !== 'host' || this._started || this._closing || this._closed) return;
    if (!this._lobby || !this._lobby.guest || !this._lobby.host) {
      this._cancelStartTimer();
      return;
    }
    if (!this.connected) {
      this._cancelStartTimer();
      return;
    }
    if (!this._lobby.host.ready || !this._lobby.guest.ready) {
      this._cancelStartTimer();
      return;
    }
    if (this._startTimer != null) return;
    this._status('connected', 'Â¡Ambos listos! Empezando partida...');
    this._startTimer = this._setTimer(() => {
      this._startTimer = null;
      if (this._started || this._closed || this._closing) return;
      if (!this._lobby || !this._lobby.guest) return;
      if (!this._lobby.host.ready || !this._lobby.guest.ready) return;
      this._startMatch();
    }, START_DELAY_MS);
  }

  _startMatch() {
    if (this._role !== 'host' || !this._lobby || !this._lobby.guest) return;
    if (this._started) return;
    this._started = true;
    const now = Date.now();
    const common = {
      code: this._code,
      names: { host: this._lobby.host.name, guest: this._lobby.guest.name },
      hostTeam: 'CT',
      guestTeam: 'T',
      startAt: now + COUNTDOWN_MS,
      targetKills: TARGET_KILLS,
      map: this._lobby.map,
      // Same team-specific initial spawn rolls arrive at both clients.
      spawnRolls: { CT: Math.random(), T: Math.random() },
    };
    const guestPayload = { ...common, role: 'guest' };
    this._sendRaw({ t: 'start', ...guestPayload });
    this._status('connected', 'Partida en curso');
    try {
      this.handlers.onStart?.({ ...common, role: 'host' });
    } catch (err) {
      console.error('[CS16 online] onStart', err);
    }
  }

  /* ====================================================================== */
  /* Internos: emisiÃ³n de callbacks                                         */
  /* ====================================================================== */

  _status(phase, message) {
    this._lastStatus = { phase, message };
    try {
      this.handlers.onStatus?.({ phase, message: message || '' });
    } catch (err) {
      console.error('[CS16 online] onStatus', err);
    }
  }

  _broadcastLobby() {
    if (!this._lobby) return;
    if (this._role === 'host') {
      this._sendRaw({ t: 'lobby', lobby: copyLobby(this._lobby) });
    }
    this._emitLobby();
  }

  _emitLobby() {
    try {
      this.handlers.onLobby?.(copyLobby(this._lobby));
    } catch (err) {
      console.error('[CS16 online] onLobby', err);
    }
  }

  _emitError(message) {
    try {
      this.handlers.onError?.(message);
    } catch (err) {
      console.error('[CS16 online] onError', err);
    }
  }

  _emitMatch(type, payload) {
    try {
      this.handlers.onMatchMessage?.(type, payload);
    } catch (err) {
      console.error('[CS16 online] onMatchMessage', type, err);
    }
  }

  _emitClosed(reason) {
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this._started = false;
    try {
      this.handlers.onClosed?.(reason);
    } catch (err) {
      console.error('[CS16 online] onClosed', err);
    }
  }

  _resolveLobbyWaiters() {
    for (const waiter of this._lobbyWaiters.splice(0)) waiter.resolve();
  }

  _waitLobby(timeoutMs = LOBBY_TIMEOUT_MS) {
    if (this._lobby) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let done = false;
      const waiter = {
        resolve: () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const index = this._lobbyWaiters.indexOf(waiter);
        if (index >= 0) this._lobbyWaiters.splice(index, 1);
        reject(
          new Error('El host no respondiÃ³. VerificÃ¡ el cÃ³digo e intentÃ¡ de nuevo.'),
        );
      }, timeoutMs);
      this._lobbyWaiters.push(waiter);
    });
  }
}

