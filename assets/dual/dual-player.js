/**
 * DualPlayer — reproductor JS para el núcleo Dual (mGBA Splitscreen).
 *
 * Versión final (2026-11-25), probada en Node con el puente v2
 * (mgs_state_hash + mgs_detach_player). Requiere el build NUEVO del puente
 * (bridge-v2/test o assets/dual/); el build viejo (bridge-build/) NO tiene
 * esas exportaciones.
 *
 * Arquitectura (ver bridge-v2/DUAL-PLAYER-DESIGN.md §2):
 *  - Transporte: la DataConnection PeerJS ya existente de la sala
 *    (reliable: true). Los mensajes Dual llevan `dual: true` + `kind`.
 *  - El host (creador de la sala) es la autoridad de ticks: un tick = un
 *    cuadro emulado. Retardo de entrada 3 cuadros; backpressure: el host
 *    no corre más de 30 cuadros por delante del ack más bajo (~500 ms de
 *    tolerancia a acks; con 12 el juego se congelaba en cada ráfaga de
 *    latencia del móvil y los botones dejaban de responder hasta que
 *    volvían los acks). El RITMO lo marca el reloj real (FRAME_MS):
 *    como mucho 1 cuadro por cada 16,67 ms, sin importar la frecuencia
 *    de la pantalla; sin ese freno, en 120/144 Hz el juego se aceleraba.
 *  - Handshake: dual-hello (host) -> dual-ready (invitado) -> dual-start.
 *  - Hash de estado cada 60 cuadros (jugador 0) y cada 300 (todos). Ante
 *    desync: ambos paran y se muestra cuadro + jugador + hashes, con
 *    "Volver a sincronizar" (reenvío de estados por chunks) y "Salir".
 *  - Salida de un jugador: mgs_detach_player(player); el resto sigue.
 *  - Limitación v1: sin transferencia de saves (.sav); la sesión Dual
 *    arranca sin batería. El handshake lleva saveHashes [null, null].
 *
 * Uso (desde la página, tras la integración):
 *   const dual = new DualPlayer({ wasmUrl: 'assets/dual/mgba-splitscreen-web.js',
 *     wasmBinUrl: 'assets/dual/mgba-splitscreen-web.wasm',
 *     canvases: [canvasLocal, canvasRemoto], onEvent });
 *   await dual.start({ romBytes, romHash, playerCount: 2, isHost, conn });
 *   dual.stop();
 *
 * En Node (pruebas) se pasa `wasmFactory` en vez de URLs, y `canvases` y
 * audio se omiten.
 */

'use strict';

const DUAL_PROTOCOL_VERSION = 1;
const INPUT_DELAY_FRAMES = 3;    // retardo de entrada (cuadros)
const MAX_AHEAD_FRAMES = 30;     // backpressure: cuánto puede adelantarse el host (~500 ms de tolerancia a acks; con 12 el juego se congelaba en cada ráfaga de latencia del móvil y los botones dejaban de responder hasta que volvían los acks; con 5 el audio se vaciaba en cada ráfaga)
const HASH_EVERY_FRAMES = 60;    // hash del jugador 0 cada N cuadros
const HASH_ALL_EVERY_FRAMES = 300; // hash de todos los jugadores cada N cuadros
const LATE_INPUT_LIMIT = 30;     // inputs tardíos seguidos antes de pausar y avisar
const FRAME_MS = 1000 / 60;      // ritmo real del juego: 1 cuadro cada 16,67 ms de reloj.
// El bucle Dual NO tenía freno de reloj: avanzaba 1 cuadro por rAF, así
// que en pantallas de 120/144 Hz el juego corría a 2x/2,4x. La única
// contención era la ventana MAX_AHEAD (con 12 el host se congelaba tanto
// que el ritmo medio quedaba cerca de 60; con 30 dejó de frenar y el juego
// se aceleró). El ritmo lo marca este acumulador, no el rAF ni los acks:
// como mucho 1 cuadro por cada FRAME_MS de reloj real, y como mucho 1
// cuadro por rAF. La ventana de 30 se queda (tolerancia a acks), pero ya
// no puede acelerar el juego. El invitado aplica los ticks al llegar
// (por diseño: así se pone al día tras un parón); el host marca el ritmo.
const LEAVE_GRACE_MS = 10_000;   // gracia tras cierre de conexión antes de detach
const RESYNC_CHUNK = 16 * 1024;  // bytes por chunk en la resincronización
const AUDIO_SRC_RATE = 32768;    // Hz del audio del puente (estéreo s16)

// Máscaras de teclas (mGBA active-high; la traducción GB la hace el puente).
const KEY = {
  A: 0x001, B: 0x002, SELECT: 0x004, START: 0x008,
  RIGHT: 0x010, LEFT: 0x020, UP: 0x040, DOWN: 0x080,
  R: 0x100, L: 0x200,
};
// Mismo mapeo que el modo Solo y que la tabla «Controles» de la página:
// X = A, Z = B, A/S = L/R, Enter = Start, Shift (izq. o der.) = Select.
// (Antes A y B iban al revés: KeyZ era A y KeyX era B.)
// Es el mapa POR DEFECTO: cada DualPlayer arranca con él y la página
// puede sustituirlo en caliente con setKeyMap() cuando el jugador
// reasigna las teclas en el panel «Controles».
const KEYBOARD_MAP = {
  ArrowUp: KEY.UP, ArrowDown: KEY.DOWN, ArrowLeft: KEY.LEFT, ArrowRight: KEY.RIGHT,
  KeyX: KEY.A, KeyZ: KEY.B, KeyA: KEY.L, KeyS: KEY.R,
  Enter: KEY.START, Space: KEY.SELECT, ShiftLeft: KEY.SELECT, ShiftRight: KEY.SELECT,
};

// Base64 que funciona en navegador y en Node.
function bufToB64(buf) {
  if (typeof Buffer !== 'undefined') return Buffer.from(buf).toString('base64');
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  }
  return btoa(s);
}
function b64ToBuf(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

class DualPlayer {
  constructor(opts) {
    opts = opts || {};
    this.wasmUrl = opts.wasmUrl || null;         // 'assets/dual/mgba-splitscreen-web.js'
    this.wasmBinUrl = opts.wasmBinUrl || null;   // 'assets/dual/mgba-splitscreen-web.wasm'
    this.wasmFactory = opts.wasmFactory || null; // Node: (opts) => factory(opts)
    this.canvases = opts.canvases || null;       // [canvasP0, canvasP1, ...]
    this.onEvent = opts.onEvent || (() => {});   // (type, data) — mensajes a la UI
    this.audioEnabled = opts.audio !== false;
    this.keyMap = KEYBOARD_MAP;                  // mapa de teclado activo (setKeyMap lo cambia)
    // Fuente de audio del puente: 5 = mezcla de todos (defecto del
    // puente), 1–4 = solo ese jugador (índice + 1), 0 = mudo. La
    // página pasa la suya al construir («Solo mi pantalla» = local + 1)
    // y la cambia en caliente con setAudioSource(). El audio es solo
    // salida: no afecta al lockstep ni a los hashes.
    this.audioSource = typeof opts.audioSource === 'number' ? opts.audioSource : 5;
    this.Module = null;
    this.ccall = null;
    this.running = false;
    this.ready = false;                          // puente cargado e iniciado
    this.isHost = false;
    this.playerCount = 2;
    this.localIndex = 0;
    this.conn = null;                            // PeerJS DataConnection (ya abierta; compat: primera de conns)
    this.conns = [];                             // todas las DataConnections (anfitrión: 1 por invitado; invitado: 1 al anfitrión)
    this.guestConns = null;                      // anfitrión: [{conn, seat}] (seat 1..playerCount-1)
    this.seatByConn = new Map();                 // conn -> asiento del otro lado
    this.readySeats = new Set();                 // asientos que ya mandaron dual-ready (anfitrión)
    this.resyncReadySeats = new Set();           // asientos que ya mandaron resync-ready (anfitrión)
    this.peerHashesBySeat = new Map();           // anfitrión: seat -> Map(frame -> hashes)
    this._closeHandlers = new Map();             // conn -> manejador de cierre (para quitarlo en stop())
    this.leaveTimers = new Map();                // seat -> temporizador de gracia tras cierre
    this.romHash = null;
    this.frame = 0;
    this.localKeys = 0;                          // máscara de teclas del jugador local (teclado | tacto)
    this.kbKeys = 0;                             // parte del teclado físico
    this.touchKeys = 0;                          // parte de los botones táctiles
    this.remoteKeys = [];                        // última máscara conocida por jugador
    this.inputHistory = [];                      // por jugador: {frame, keys}[] (host)
    this.acks = [];                              // último frame confirmado por jugador
    this.lateInputs = 0;
    this.pauseReason = null;                     // 'late-input' | 'remote' | null
    this.localHashes = new Map();                // frame -> hashes locales
    this.peerHashes = new Map();                 // frame -> hashes remotos
    this.pendingTicks = new Map();               // frame -> tick (invitado, desorden)
    this.rafId = 0;
    this.lastTickAt = 0;
    this._started = false;                       // el anfitrión ya mandó dual-start (solo una vez)
    this._backpressured = false;                 // el host está frenado esperando acks (ver _loop)
    this.paused = false;
    this.desynced = false;
    this.resync = null;                          // estado de resincronización (host)
    this.resyncIn = null;                        // estado de resincronización (invitado)
    this.departed = new Set();                   // jugadores que salieron (cable desconectado)
    this._paceAcc = 0;                           // acumulador de ritmo real (ms)
    this._paceLast = 0;                          // performance.now() del rAF anterior
    this._keyDown = this._keyDown.bind(this);
    this._keyUp = this._keyUp.bind(this);
    this._onConnData = this._onConnData.bind(this);
    this._onConnClose = this._onConnClose.bind(this);
    // Audio (se crea en start(), dentro del gesto del usuario).
    this.audioCtx = null;
    this.audioNode = null;
    this._aqL = [];                              // cola de muestras (tasa fuente)
    this._aqR = [];
    this._aqRead = 0;                            // índice de lectura (muestras)
  }

  // ---------- ciclo de vida ----------

  async start(opts) {
    opts = opts || {};
    this.playerCount = opts.playerCount || 2;
    this.isHost = !!opts.isHost;
    // Conexiones: el anfitrión pasa guestConns [{conn, seat}] (1 por
    // invitado); el invitado pasa conn (una sola, al anfitrión). Por
    // compatibilidad, conn solo también vale (se envuelve en lista).
    this.guestConns = opts.guestConns || null;
    this.conns = this.guestConns ? this.guestConns.map((g) => g.conn)
      : (opts.conn ? [opts.conn] : []);
    this.conn = this.conns[0] || null;
    this.seatByConn = new Map((this.guestConns || []).map((g) => [g.conn, g.seat]));
    this.readySeats = new Set();
    this.resyncReadySeats = new Set();
    this.peerHashesBySeat = new Map();
    this._closeHandlers = new Map();
    this.leaveTimers = new Map();
    this.romHash = opts.romHash || null;
    this.localIndex = opts.localPlayerIndex !== null && opts.localPlayerIndex !== undefined
      ? opts.localPlayerIndex : (this.isHost ? 0 : 1);
    this.frame = 0;
    this._paceAcc = 0;
    this._paceLast = 0;
    this.localKeys = 0;
    this.kbKeys = 0;
    this.touchKeys = 0;
    this.remoteKeys = new Array(this.playerCount).fill(0);
    this.inputHistory = Array.from({ length: this.playerCount }, () => []);
    this.acks = new Array(this.playerCount).fill(-1);
    this.lateInputs = 0;
    this.pauseReason = null;
    this.localHashes.clear();
    this.peerHashes.clear();
    this.pendingTicks.clear();
    this.paused = false;
    this.desynced = false;
    this._started = false;
    this._backpressured = false;
    this.resync = null;
    this.resyncIn = null;
    this.departed.clear();

    await this._loadWasm();
    this._initBridge(opts.romBytes);
    this._attachInput();
    if (this.audioEnabled) this._initAudio();

    if (this.conns.length > 0) {
      for (const c of this.conns) {
        c.on('data', this._onConnData);
        // El cierre necesita saber QUÉ conexión se cerró (para detach
        // solo ese asiento): un manejador por conexión.
        const onClose = () => this._onConnClose(c);
        this._closeHandlers.set(c, onClose);
        c.on('close', onClose);
      }
    }
    this.ready = true;
    this.running = true;

    if (this.conns.length === 0) {
      // Modo humo (sin invitado): el juego corre local, sin backpressure.
      this._emit('waiting', { message: 'Modo Dual sin invitado — el juego corre local (P1 sin entrada).' });
      this._loop();
      return true;
    }
    if (this.isHost) {
      this._emit('waiting', { message: 'Esperando a los jugadores…' });
      if (!opts.waitForStart) this.beginHandshake();
      // Con waitForStart, el bucle arranca al recibir 'dual-ready' de
      // TODOS los invitados (la página llama a beginHandshake() desde
      // #mp-start).
    } else {
      this._emit('waiting', { message: 'Esperando a que el host inicie…' });
      // sendReady: el invitado se recreó tras un dual-hello con otro
      // playerCount/asiento y debe avisar al host de que ya está listo.
      if (opts.sendReady) this._send({ dual: true, kind: 'dual-ready', player: this.localIndex, romHash: this.romHash });
      this._guestLoop();
    }
    return true;
  }

  stop() {
    this.running = false;
    this.ready = false;
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.rafId);
    for (const t of this.leaveTimers.values()) clearTimeout(t);
    this.leaveTimers.clear();
    this._started = false;
    this._detachInput();
    this._stopAudio();
    for (const c of this.conns) {
      try { c.off('data', this._onConnData); } catch (e) { /* noop */ }
      const onClose = this._closeHandlers.get(c);
      if (onClose) { try { c.off('close', onClose); } catch (e) { /* noop */ } }
    }
    this._closeHandlers.clear();
    if (this.Module) { try { this.ccall('mgs_quit', null, [], []); } catch (e) { /* ya parado */ } }
    this.Module = null;
    this._emit('stopped', {});
  }

  // ---------- WASM / puente ----------

  async _loadWasm() {
    const instantiateWasm = async (info, receiveInstance) => {
      let bytes;
      if (typeof process !== 'undefined' && process.versions && process.versions.node && this.wasmBinUrl) {
        bytes = require('fs').readFileSync(this.wasmBinUrl);
      } else if (typeof fetch !== 'undefined' && this.wasmBinUrl) {
        const res = await fetch(this.wasmBinUrl);
        bytes = await res.arrayBuffer();
      } else {
        throw new Error('DualPlayer: sin vía para cargar el .wasm');
      }
      const { instance } = await WebAssembly.instantiate(bytes, info);
      receiveInstance(instance);
    };
    if (this.wasmFactory) {
      this.Module = await this.wasmFactory({ instantiateWasm });
    } else {
      // Script clásico: el glue de Emscripten (MODULARIZE) expone
      // window.MgbaSplitScreenWasm. NO usar import() dinámico: el glue no
      // es un módulo ES (no tiene export default).
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = this.wasmUrl;
        s.onload = resolve;
        s.onerror = () => reject(new Error('No se pudo cargar ' + this.wasmUrl));
        document.head.appendChild(s);
      });
      const factory = window.MgbaSplitScreenWasm;
      if (typeof factory !== 'function') throw new Error('MgbaSplitScreenWasm no está definido tras cargar el glue');
      this.Module = await factory({ instantiateWasm });
    }
    this.ccall = (n, ret, args, vals) => this.Module.ccall(n, ret, args, vals);
  }

  _initBridge(romBytes) {
    const c = this.ccall;
    c('mgs_init', null, ['number'], [this.playerCount]);
    const bytes = romBytes instanceof Uint8Array ? romBytes : new Uint8Array(romBytes);
    const ptr = this.Module._malloc(bytes.byteLength);
    this.Module.HEAPU8.set(bytes, ptr);
    const rc = c('mgs_load_rom', 'number', ['number', 'number'], [ptr, bytes.byteLength]);
    this.Module._free(ptr);
    if (rc !== 0) throw new Error('mgs_load_rom devolvió ' + rc);
    c('mgs_reset_sio', null, [], []);
    c('mgs_set_audio_source', null, ['number'], [this.audioSource]);
  }

  // ---------- bucle principal ----------

  beginHandshake() {
    // Solo el host, y solo cuando la página lo pide (botón #mp-start).
    // Un dual-hello por invitado, cada uno con SU asiento (el libre más
    // bajo de 1..playerCount-1, asignado por la página al entrar a la
    // sala). El host arranca solo cuando TODOS los invitados conectados
    // manden su dual-ready (ver _onConnData 'dual-ready').
    if (!this.isHost || this.conns.length === 0 || !this.ready) return false;
    this.readySeats = new Set();
    for (const c of this.conns) {
      if (!c.open) continue;
      const seat = this.seatByConn.has(c) ? this.seatByConn.get(c) : 1;
      if (this.departed.has(seat)) continue;
      try {
        c.send({ dual: true, kind: 'dual-hello', version: DUAL_PROTOCOL_VERSION,
          playerCount: this.playerCount, seat, romHash: this.romHash,
          saveHashes: new Array(this.playerCount).fill(null), seed: 0 });
      } catch (e) { /* enlace caído */ }
    }
    this._emit('waiting', { message: 'Enviando invitación Dual…' });
    return true;
  }

  _loop() {
    if (!this.running) return;
    if (this.paused) { this.rafId = requestAnimationFrame(() => this._loop()); return; }
    // Ritmo real (FRAME_MS): como mucho 1 cuadro por cada 16,67 ms de
    // reloj, y como mucho 1 cuadro por rAF. Sin esto, en pantallas de
    // 120/144 Hz el juego corría a 2x/2,4x (el rAF era el único reloj).
    // El acumulador se limita a 2 cuadros: tras un parón (pausa,
    // backpressure, pestaña en segundo plano) no se "pone al día" en
    // ráfaga, simplemente reanuda a velocidad real.
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (this._paceLast > 0) {
      this._paceAcc += now - this._paceLast;
      if (this._paceAcc > 2 * FRAME_MS) this._paceAcc = 2 * FRAME_MS;
    }
    this._paceLast = now;
    if (this._paceAcc < FRAME_MS) {
      this.rafId = requestAnimationFrame(() => this._loop());
      return;
    }
    this._paceAcc -= FRAME_MS;
    // Backpressure (solo con invitado): no correr más de MAX_AHEAD
    // cuadros por delante del ack más bajo. Los jugadores que salieron
    // no cuentan: si no, el host se quedaría esperando acks que nunca
    // llegan y la partida se congelaría tras una salida.
    if (this.conns.length > 0) {
      const remoteAcks = this.acks.slice(1).filter((_, i) => !this.departed.has(i + 1));
      if (remoteAcks.length > 0) {
        const minAck = Math.min(...remoteAcks);
        if (this.frame - minAck > MAX_AHEAD_FRAMES) {
          // Solo avisar al entrar en backpressure (una vez): antes se
          // emitía 'waiting' en CADA cuadro frenado y el status de la
          // página se quedaba en «Esperando a los jugadores…» aunque la
          // partida siguiera corriendo, porque nada lo restauraba.
          if (!this._backpressured) {
            this._backpressured = true;
            this._emit('waiting', { message: 'Esperando a los jugadores…' });
          }
          this.rafId = requestAnimationFrame(() => this._loop());
          return;
        }
      }
    }
    // Al salir del freno, restaurar el status: 'resumed' pone en la
    // página «Partida Dual en curso.» (misma rama que reanudar la pausa).
    if (this._backpressured) {
      this._backpressured = false;
      this._emit('resumed', { message: 'Partida Dual en curso.' });
    }
    const keys = this._collectKeysForFrame(this.frame);
    this._runFrame(keys);
    this._send({ dual: true, kind: 'tick', frame: this.frame, keys });
    this._maybeHash(this.frame);
    this.frame++;
    this.rafId = requestAnimationFrame(() => this._loop());
  }

  _guestLoop() {
    // El invitado solo avanza cuando llega un tick (sin ejecución
    // especulativa). Este rAF drena audio y vigila que lleguen ticks.
    if (!this.running) return;
    if (this.paused) { this.rafId = requestAnimationFrame(() => this._guestLoop()); return; }
    if (Date.now() - this.lastTickAt > 2000 && this.frame > 0 && this.conns.length > 0) {
      this._emit('waiting', { message: 'Sin ticks del host… revisa la conexión.' });
      this.lastTickAt = Date.now(); // no spamear el aviso
    }
    this.rafId = requestAnimationFrame(() => this._guestLoop());
  }

  _collectKeysForFrame(frame) {
    const keys = new Array(this.playerCount).fill(0);
    keys[this.localIndex] = this.localKeys;
    for (let p = 0; p < this.playerCount; p++) {
      if (p === this.localIndex) continue;
      // Un jugador que salió no manda entradas: sus teclas quedan en 0
      // y no se cuenta como entrada tardía (si no, el host pausaría).
      if (this.departed.has(p)) { keys[p] = 0; continue; }
      const wanted = frame - INPUT_DELAY_FRAMES;
      const hist = this.inputHistory[p];
      let found = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].frame <= wanted) { found = hist[i].keys; break; }
      }
      if (found === null) {
        // Calentamiento: los primeros cuadros aún no tienen entradas.
        // Sin conexión (modo humo) no hay entradas remotas que esperar:
        // se reutiliza la última conocida (0) sin pausar. Con conexión sí
        // se pausa tras LATE_INPUT_LIMIT cuadros seguidos sin entrada.
        if (this.conns.length > 0 && frame > 10) {
          this.lateInputs++;
          if (this.lateInputs >= LATE_INPUT_LIMIT) {
            this.paused = true;
            this.pauseReason = 'late-input';
            this._emit('waiting', { message: 'Esperando la entrada de los jugadores…' });
            this.lateInputs = 0;
          }
        }
        keys[p] = this.remoteKeys[p]; // reutilizar última conocida
      } else {
        this.lateInputs = 0;
        keys[p] = found;
        this.remoteKeys[p] = found;
      }
      while (hist.length > 120) hist.shift();
    }
    return keys;
  }

  _runFrame(keys) {
    for (let p = 0; p < this.playerCount; p++) {
      this.ccall('mgs_set_keys', null, ['number', 'number'], [p, keys[p]]);
    }
    this.ccall('mgs_run_frame', null, [], []);
    this._presentVideo();
    this._pumpAudio();
  }

  _maybeHash(frame) {
    const n = frame + 1;
    if (n % HASH_EVERY_FRAMES === 0) {
      const hashes = [this._stateHash(0)];
      if (n % HASH_ALL_EVERY_FRAMES === 0) {
        for (let p = 1; p < this.playerCount; p++) hashes.push(this._stateHash(p));
      }
      this.localHashes.set(n, hashes);
      this._send({ dual: true, kind: 'hash', frame: n, player: this.localIndex, hashes });
      this._checkHash(n);
    }
  }

  _stateHash(player) {
    return this.ccall('mgs_state_hash', 'number', ['number'], [player]) >>> 0;
  }

  // Con varios invitados, cada uno manda sus hashes con su asiento:
  // el anfitrión los guarda por asiento y compara contra cada uno por
  // separado (un desync de un solo invitado debe detectarse y atribuirse
  // a ese asiento). El invitado solo recibe los del anfitrión (asiento 0).
  _checkHash(frame, seat) {
    const local = this.localHashes.get(frame);
    let remote = null;
    if (this.isHost) {
      if (seat === undefined) return;
      const bySeat = this.peerHashesBySeat.get(seat);
      remote = bySeat ? bySeat.get(frame) : null;
    } else {
      remote = this.peerHashes.get(frame);
    }
    if (!local || !remote) return;
    for (let p = 0; p < Math.min(local.length, remote.length); p++) {
      if (local[p] !== remote[p]) {
        this._onDesync(frame, p, local[p], remote[p]);
        return;
      }
    }
  }

  _onDesync(frame, player, localHash, remoteHash) {
    if (this.desynced) return;
    this.desynced = true;
    this.running = false;
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.rafId);
    this._send({ dual: true, kind: 'desync', frame, player, localHash, remoteHash });
    this._emit('desync', {
      frame, player,
      localHash: localHash.toString(16),
      remoteHash: remoteHash.toString(16),
      message: `Desincronización en el cuadro ${frame}: el jugador ${player} no coincide (hash local ${localHash.toString(16)} vs remoto ${remoteHash.toString(16)}). La sesión se detuvo para no corromper la partida.`,
    });
  }

  // ---------- resincronización (Volver a sincronizar) ----------

  requestResync() {
    if (this.conns.length === 0) return false;
    if (this.isHost) { this._startResync(); return true; }
    this._send({ dual: true, kind: 'resync-request', player: this.localIndex });
    this._emit('waiting', { message: 'Pidiendo resincronización al host…' });
    return true;
  }

  _captureStates() {
    const states = [];
    for (let p = 0; p < this.playerCount; p++) {
      const size = this.ccall('mgs_save_state', 'number', ['number'], [p]);
      const ptr = this.ccall('mgs_state_ptr', 'number', [], []);
      states.push(new Uint8Array(this.Module.HEAPU8.subarray(ptr, ptr + size)));
    }
    return states;
  }

  _loadStates(states) {
    for (let p = 0; p < states.length; p++) {
      const bytes = states[p];
      const ptr = this.Module._malloc(bytes.byteLength);
      this.Module.HEAPU8.set(bytes, ptr);
      const rc = this.ccall('mgs_load_state_bytes', 'number', ['number', 'number', 'number'], [p, ptr, bytes.byteLength]);
      this.Module._free(ptr);
      if (rc !== 0) throw new Error('mgs_load_state_bytes p' + p + ' rc=' + rc);
    }
    // Limpieza determinista del enlace tras la carga (NO el reset completo):
    // mgs_reset_sio recalcula cycleOffset desde el reloj vivo y puede
    // reprogramar el evento lockstep; tras un desync los dos lados tienen
    // relojes vivos distintos y el reset los deja a unos ciclos de distancia,
    // lo que vuelve a desincronizar ~25 cuadros después (verificado en Node).
    // mgs_sio_clear solo suelta las colas/eventos rancios y los flags de
    // sueño (el arreglo anti-congelamiento), dejando cycleOffset y el
    // horario del evento tal como los trae el estado cargado.
    this.ccall('mgs_sio_clear', null, [], []);
  }

  _startResync() {
    if (!this.isHost || !this.ready) return;
    const frame = this.frame;
    const states = this._captureStates();
    const id = Date.now() + '-' + Math.floor(Math.random() * 1e6);
    this.resync = { id, frame, states };
    this._send({ dual: true, kind: 'resync-begin', id, frame,
      sizes: states.map((s) => s.byteLength) });
    for (let p = 0; p < states.length; p++) {
      const total = Math.ceil(states[p].byteLength / RESYNC_CHUNK);
      for (let i = 0; i < total; i++) {
        const chunk = states[p].subarray(i * RESYNC_CHUNK, (i + 1) * RESYNC_CHUNK);
        this._send({ dual: true, kind: 'resync-chunk', id, player: p,
          index: i, total, data: bufToB64(chunk) });
      }
    }
    this._emit('waiting', { message: 'Enviando estados para resincronizar…' });
  }

  _onResyncReady(msg) {
    if (!this.isHost || !this.resync || msg.id !== this.resync.id) return;
    // Con varios invitados, esperar el resync-ready de TODOS los
    // asientos activos antes de mandar resync-go (si no, uno quedaría
    // con el estado viejo y desincronizaría al instante).
    if (msg.player !== undefined) this.resyncReadySeats.add(msg.player);
    const active = this._activeGuestSeats();
    for (const s of active) {
      if (!this.resyncReadySeats.has(s)) return;
    }
    // Recargar los propios estados también: ambos lados quedan bit a bit
    // iguales tras el mismo load+reset (verificado en Node).
    this._loadStates(this.resync.states);
    const frame = this.resync.frame;
    this.resync = null;
    this.resyncReadySeats = new Set();
    this._send({ dual: true, kind: 'resync-go', frame });
    this._resumeAfterResync(frame);
  }

  // Asientos de invitados con la conexión abierta y no salidos.
  // (Si un invitado se cae en mitad de una resincronización, su
  // resync-ready no llegará nunca: no se le espera.)
  _activeGuestSeats() {
    const seats = [];
    for (const [c, seat] of this.seatByConn) {
      if (c.open && !this.departed.has(seat)) seats.push(seat);
    }
    // Sin mapa de asientos (compat con conn única), caer a 1..N-1.
    if (seats.length === 0 && this.seatByConn.size === 0) {
      for (let s = 1; s < this.playerCount; s++) {
        if (!this.departed.has(s)) seats.push(s);
      }
    }
    return seats;
  }

  _resumeAfterResync(frame) {
    this.frame = frame;
    this.desynced = false;
    this.localHashes.clear();
    this.peerHashes.clear();
    this.pendingTicks.clear();
    this.inputHistory = Array.from({ length: this.playerCount }, () => []);
    // Backpressure es relativa al cuadro actual: dar por confirmados los
    // cuadros hasta el de resincronización, si no el host se quedaría
    // esperando acks que nunca llegan (frame - (-1) > MAX_AHEAD).
    this.acks = new Array(this.playerCount).fill(frame - 1);
    this.lateInputs = 0;
    this.running = true;
    this._emit('resynced', { frame, message: `Resincronizado en el cuadro ${frame}. ¡A seguir jugando!` });
    if (this.isHost) this._loop(); else this._guestLoop();
  }

  // ---------- red (PeerJS) ----------

  // Fan-out: el anfitrión manda a TODOS sus invitados; el invitado
  // tiene una sola conexión (al anfitrión), así que es lo mismo que
  // antes. Los mensajes que solo van al anfitrión (input, ack,
  // dual-ready, resync-ready) los manda el invitado por su única
  // conexión; los del anfitrión llegan a todos los invitados.
  _send(msg) {
    for (const c of this.conns) {
      if (c && c.open) { try { c.send(msg); } catch (e) { /* enlace caído */ } }
    }
  }

  _onConnData(msg) {
    if (!msg || !msg.dual) return; // mensajes de la sala (hola/ping) los lleva la página
    switch (msg.kind) {
      case 'dual-hello': {
        if (this.isHost) break;
        if (msg.version !== DUAL_PROTOCOL_VERSION) {
          this._emit('error', { message: 'Versión Dual incompatible (' + msg.version + ').' });
          break;
        }
        if (msg.romHash && this.romHash && msg.romHash !== this.romHash) {
          this._emit('error', { message: 'El ROM del host no coincide con el tuyo.' });
          break;
        }
        // El invitado se creó con valores provisionales (playerCount 2,
        // asiento 1). Si el saludo trae otros, la página debe recrear el
        // jugador con esos datos (evento 'need-player'); si coinciden,
        // se responde dual-ready directamente (caso 2P, sin recrear).
        if (msg.playerCount !== this.playerCount ||
            (msg.seat !== undefined && msg.seat !== this.localIndex)) {
          this._emit('need-player', {
            playerCount: msg.playerCount || this.playerCount,
            seat: (msg.seat !== undefined ? msg.seat : this.localIndex),
          });
          break;
        }
        this.playerCount = msg.playerCount || this.playerCount;
        this._send({ dual: true, kind: 'dual-ready', player: this.localIndex, romHash: this.romHash });
        break;
      }
      case 'dual-ready': {
        if (!this.isHost) break;
        if (msg.player !== undefined) this.readySeats.add(msg.player);
        // Arrancar solo cuando TODOS los invitados activos estén listos
        // (y solo una vez: un dual-ready duplicado no debe re-arrancar
        // el bucle ni reenviar dual-start).
        if (this._started) break;
        const active = this._activeGuestSeats();
        if (active.length === 0) break;
        if (active.every((s) => this.readySeats.has(s))) {
          this._started = true;
          this._send({ dual: true, kind: 'dual-start', frame: 0 });
          this._emit('started', { frame: 0 });
          this._loop();
        }
        break;
      }
      case 'dual-start':
        if (this.isHost) break;
        this.lastTickAt = Date.now();
        this._emit('started', { frame: msg.frame || 0 });
        break;
      case 'input': // solo lo lee el host
        if (this.isHost && msg.player !== undefined && msg.player !== this.localIndex) {
          this.inputHistory[msg.player].push({ frame: msg.frame, keys: msg.keys });
          if (this.paused && this.pauseReason === 'late-input') {
            this.paused = false;
            this.pauseReason = null;
            this.lateInputs = 0;
          }
        }
        break;
      case 'tick': { // solo lo leen los invitados
        if (this.isHost) break;
        if (msg.frame < this.frame) break; // duplicado
        if (msg.frame > this.frame) { this.pendingTicks.set(msg.frame, msg); break; }
        this._applyTick(msg);
        // Drenar ticks guardados que ya tocan en orden.
        while (this.pendingTicks.has(this.frame)) {
          const next = this.pendingTicks.get(this.frame);
          this.pendingTicks.delete(this.frame);
          this._applyTick(next);
        }
        break;
      }
      case 'ack':
        if (this.isHost && msg.player !== undefined) {
          this.acks[msg.player] = Math.max(this.acks[msg.player], msg.frame);
        }
        break;
      case 'hash': {
        // El anfitrión guarda los hashes por asiento del remitente y
        // compara contra cada invitado por separado; el invitado solo
        // recibe los del anfitrión.
        if (this.isHost) {
          if (msg.player !== undefined) {
            let bySeat = this.peerHashesBySeat.get(msg.player);
            if (!bySeat) { bySeat = new Map(); this.peerHashesBySeat.set(msg.player, bySeat); }
            bySeat.set(msg.frame, msg.hashes);
            this._checkHash(msg.frame, msg.player);
          }
        } else {
          this.peerHashes.set(msg.frame, msg.hashes);
          this._checkHash(msg.frame);
        }
        break;
      }
      case 'desync': {
        if (this.desynced) break;
        // El anfitrión reenvía el aviso a los demás invitados para que
        // todos paren (si no, los demás seguirían esperando ticks).
        if (this.isHost) this._send({ dual: true, kind: 'desync', frame: msg.frame, player: msg.player, localHash: msg.localHash, remoteHash: msg.remoteHash });
        this.desynced = true;
        this.running = false;
        if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.rafId);
        this._emit('desync', {
          frame: msg.frame, player: msg.player,
          localHash: String(msg.remoteHash), remoteHash: String(msg.localHash),
          message: `Desincronización en el cuadro ${msg.frame}: el jugador ${msg.player} no coincide (hash local ${String(msg.remoteHash)} vs remoto ${String(msg.localHash)}). La sesión se detuvo para no corromper la partida.`,
        });
        break;
      }
      case 'pause':
        // El anfitrión reenvía la pausa a los demás invitados para que
        // todos pausen juntos; el invitado solo pausa su lado.
        if (this.isHost) this._send({ dual: true, kind: 'pause', player: msg.player });
        this.paused = true;
        this.pauseReason = 'remote';
        this._emit('paused', { by: msg.player });
        break;
      case 'resume':
        if (this.isHost) this._send({ dual: true, kind: 'resume', player: msg.player });
        this.paused = false;
        this.pauseReason = null;
        this._emit('resumed', { by: msg.player });
        break;
      case 'leave': {
        const p = msg.player;
        try { this.ccall('mgs_detach_player', 'number', ['number'], [p]); } catch (e) { /* noop */ }
        this.departed.add(p);
        // El anfitrión reenvía la salida a los demás invitados para que
        // todos desconecten ese cable (si no, sus puentes seguirían con
        // ese núcleo en el enlace y divergirían del anfitrión).
        if (this.isHost) this._send({ dual: true, kind: 'leave', player: p });
        this._emit('player-left', { player: p, message: `Jugador ${p} salió — cable desconectado.` });
        break;
      }
      case 'resync-request':
        if (this.isHost) this._startResync();
        break;
      case 'resync-begin': {
        if (this.isHost) break;
        this.resyncIn = { id: msg.id, frame: msg.frame, sizes: msg.sizes,
          parts: msg.sizes.map(() => []), received: 0,
          total: msg.sizes.reduce((a, s) => a + Math.ceil(s / RESYNC_CHUNK), 0) };
        break;
      }
      case 'resync-chunk': {
        const r = this.resyncIn;
        if (!r || msg.id !== r.id) break;
        const bytes = b64ToBuf(msg.data);
        r.parts[msg.player][msg.index] = bytes;
        r.received++;
        if (r.received >= r.total) {
          const states = r.parts.map((chunks, p) => {
            const total = r.sizes[p];
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.byteLength; }
            return out;
          });
          try {
            this._loadStates(states);
            this.resyncIn = null;
            this._send({ dual: true, kind: 'resync-ready', id: msg.id, player: this.localIndex });
          } catch (e) {
            this._emit('error', { message: 'No se pudo cargar el estado resincronizado: ' + e.message });
          }
        }
        break;
      }
      case 'resync-ready':
        this._onResyncReady(msg);
        break;
      case 'resync-go':
        if (this.isHost) break;
        // El invitado ya cargó los estados al completar los chunks; aquí
        // solo reanuda en el cuadro indicado.
        this._resumeAfterResync(msg.frame);
        break;
      default:
        break;
    }
  }

  _applyTick(msg) {
    this._runFrame(msg.keys);
    this.frame = msg.frame + 1;
    this.lastTickAt = Date.now();
    this._send({ dual: true, kind: 'input', frame: this.frame, player: this.localIndex, keys: this.localKeys });
    this._send({ dual: true, kind: 'ack', frame: msg.frame, player: this.localIndex });
    this._maybeHash(msg.frame);
  }

  _onConnClose(conn) {
    // Gracia de 10 s: si era un parpadeo de la conexión, el otro lado puede
    // reconectar; si no, detach y seguir con los que quedan. Cada
    // conexión tiene su propio temporizador (con 3 invitados, cada uno se
    // va por su lado). El asiento que se va: en el anfitrión, el de esa
    // conexión; en el invitado, el 0 (el anfitrión).
    this._emit('waiting', { message: 'Jugador desconectado — esperando…' });
    const seat = this.isHost
      ? (this.seatByConn.has(conn) ? this.seatByConn.get(conn) : 1)
      : 0;
    const oldTimer = this.leaveTimers.get(seat);
    if (oldTimer) clearTimeout(oldTimer);
    this.leaveTimers.set(seat, setTimeout(() => {
      this.leaveTimers.delete(seat);
      if (!this.running && !this.desynced) return;
      try { this.ccall('mgs_detach_player', 'number', ['number'], [seat]); } catch (e) { /* noop */ }
      this.departed.add(seat);
      // El anfitrión avisa a los demás invitados para que también
      // desconecten ese cable (si no, sus puentes divergirían).
      if (this.isHost) this._send({ dual: true, kind: 'leave', player: seat });
      this._emit('player-left', { player: seat, message: `Jugador ${seat} se desconectó — cable desconectado.` });
    }, LEAVE_GRACE_MS));
  }

  // ---------- entrada ----------

  _attachInput() {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', this._keyDown);
    window.addEventListener('keyup', this._keyUp);
  }

  _detachInput() {
    if (typeof window === 'undefined') return;
    window.removeEventListener('keydown', this._keyDown);
    window.removeEventListener('keyup', this._keyUp);
  }

  // Mientras el foco está en un campo de texto (código de sala, servidor
  // netplay…) las teclas son para escribir, no para jugar: sin esta
  // guarda, teclear el código de la sala movía al personaje y el Shift o
  // el Enter de la propia escritura se colaban como Select/Start.
  _typingInField(e) {
    const t = e && e.target;
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
  }

  _keyDown(e) {
    if (this._typingInField(e)) return;
    const mask = this.keyMap[e.code];
    if (mask !== undefined) {
      this.kbKeys |= mask;
      this.localKeys = this.kbKeys | this.touchKeys;
      if (e.preventDefault) e.preventDefault();
    }
  }

  _keyUp(e) {
    if (this._typingInField(e)) return;
    const mask = this.keyMap[e.code];
    if (mask !== undefined) {
      this.kbKeys &= ~mask;
      this.localKeys = this.kbKeys | this.touchKeys;
      if (e.preventDefault) e.preventDefault();
    }
  }

  // Entrada táctil: la página llama a dual.setTouchKeys(mask) con la
  // máscara combinada del D-pad + botones en pantalla. Se guarda aparte
  // y se combina con el teclado: antes esto SOBRESCRIBÍA localKeys, así
  // que tocar un botón en pantalla soltaba de golpe cualquier tecla
  // física que se estuviera manteniendo (y viceversa).
  setTouchKeys(mask) {
    this.touchKeys = mask;
    this.localKeys = this.kbKeys | this.touchKeys;
  }

  // Mapa de teclado reasignado desde el panel «Controles» de la página
  // ({ codigoDeTecla: mascara }). Sustituye al activo y suelta las
  // teclas físicas que estuvieran mantenidas, para que ninguna quede
  // pegada con el mapa viejo; la parte táctil no se toca.
  setKeyMap(map) {
    if (map && typeof map === 'object') this.keyMap = map;
    this.kbKeys = 0;
    this.localKeys = this.touchKeys;
  }

  // Fuente de audio del puente en caliente: 5 = mezcla de todos los
  // jugadores, 1–4 = solo ese jugador (índice + 1), 0 = mudo. Es solo
  // salida de audio (la mezcla no entra en el estado ni en los hashes),
  // así que cambiarla no toca el lockstep. La cola se vacía para que el
  // cambio se oiga al momento y no queden restos de la otra fuente.
  setAudioSource(n) {
    this.audioSource = n;
    if (!this.Module || !this.ready) return;
    try { this.ccall('mgs_set_audio_source', null, ['number'], [n]); } catch (e) { /* puente caído */ }
    this._aqL = [];
    this._aqR = [];
    this._aqRead = 0;
    this._aqPos = 0;
  }

  pause() { this.paused = true; this.pauseReason = 'remote'; this._send({ dual: true, kind: 'pause', player: this.localIndex }); this._emit('paused', { by: this.localIndex }); }
  resume() { this.paused = false; this.pauseReason = null; this._send({ dual: true, kind: 'resume', player: this.localIndex }); this._emit('resumed', { by: this.localIndex }); }
  leave() { this._send({ dual: true, kind: 'leave', player: this.localIndex }); this.stop(); }

  // ---------- video / audio ----------

  _presentVideo() {
    if (!this.canvases || !this.Module) return;
    try {
      for (let p = 0; p < this.playerCount; p++) {
        const cv = this.canvases[p];
        if (!cv) continue;
        const w = this.ccall('mgs_get_video_width', 'number', ['number'], [p]);
        const h = this.ccall('mgs_get_video_height', 'number', ['number'], [p]);
        if (!w || !h) continue;
        const ptr = this.ccall('mgs_get_video', 'number', ['number'], [p]);
        if (!ptr) continue;
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
        const ctx = cv.getContext('2d');
        if (!ctx) continue;
        const img = new ImageData(new Uint8ClampedArray(this.Module.HEAPU8.buffer, ptr, w * h * 4), w, h);
        ctx.putImageData(img, 0, 0);
      }
    } catch (e) { /* vídeo best-effort: nunca debe romper el bucle */ }
  }

  _bridgeRate() {
    try {
      if (!this.Module) return 0;
      const r = this.ccall('mgs_get_audio_rate', 'number', [], []);
      return (typeof r === 'number' && r > 0) ? r : 0;
    } catch (e) { return 0; }
  }

  _initAudio() {
    if (typeof window === 'undefined' || !window.AudioContext) return;
    try {
      // La tasa real la da el puente: el núcleo GBA puede ir a 65536 Hz
      // según el juego (Kirby pone SOUNDBIAS a resolución 1). Nunca
      // asumir 32768: el drenaje remuestrea desde esta tasa.
      this._srcRate = this._bridgeRate() || AUDIO_SRC_RATE;
      const AC = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AC({ sampleRate: this._srcRate });
      if (this.audioCtx.resume) this.audioCtx.resume();
      const node = this.audioCtx.createScriptProcessor(4096, 0, 2);
      node.onaudioprocess = (ev) => this._drainAudio(ev);
      node.connect(this.audioCtx.destination);
      this.audioNode = node;
    } catch (e) { this.audioCtx = null; this.audioNode = null; }
  }

  _stopAudio() {
    try { if (this.audioNode) this.audioNode.disconnect(); } catch (e) { /* noop */ }
    try { if (this.audioCtx) this.audioCtx.close(); } catch (e) { /* noop */ }
    this.audioNode = null;
    this.audioCtx = null;
    this._aqL = [];
    this._aqR = [];
    this._aqRead = 0;
  }

  _pumpAudio() {
    if (!this.audioCtx || !this.Module) return;
    try {
      // La tasa puede cambiar en mitad del juego (SOUNDBIAS); la cola
      // vieja es de otra tasa y se descarta.
      const rate = this._bridgeRate();
      if (rate && rate !== this._srcRate) {
        this._srcRate = rate;
        this._aqL = []; this._aqR = []; this._aqRead = 0; this._aqPos = 0;
      }
      const ptr = this.ccall('mgs_get_audio', 'number', [], []);
      const n = this.ccall('mgs_audio_frames', 'number', [], []);
      if (!ptr || n <= 0) return;
      const s16 = new Int16Array(this.Module.HEAPU8.buffer, ptr, n * 2);
      for (let i = 0; i < n; i++) {
        this._aqL.push(s16[i * 2] / 32768);
        this._aqR.push(s16[i * 2 + 1] / 32768);
      }
      // Tope ~1,5 s de cola: si el drenaje va por detrás, soltar lo viejo.
      const maxQ = (this._srcRate || AUDIO_SRC_RATE) * 3 / 2;
      if (this._aqL.length - this._aqRead > maxQ) {
        const drop = (this._aqL.length - this._aqRead) - maxQ;
        this._aqRead += drop;
        if (this._aqRead > 8192) {
          this._aqL.splice(0, this._aqRead);
          this._aqR.splice(0, this._aqRead);
          this._aqRead = 0;
        }
      }
    } catch (e) { /* audio best-effort */ }
  }

  _drainAudio(ev) {
    const outL = ev.outputBuffer.getChannelData(0);
    const outR = ev.outputBuffer.getChannelData(1);
    const rate = this.audioCtx ? this.audioCtx.sampleRate : (this._srcRate || AUDIO_SRC_RATE);
    const step = (this._srcRate || AUDIO_SRC_RATE) / rate;
    if (this._aqPos === undefined) this._aqPos = 0;
    for (let i = 0; i < outL.length; i++) {
      const pos = this._aqPos;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const avail = this._aqL.length - this._aqRead;
      if (idx + 1 >= avail) { outL[i] = 0; outR[i] = 0; }
      else {
        const a = this._aqRead + idx;
        outL[i] = this._aqL[a] + (this._aqL[a + 1] - this._aqL[a]) * frac;
        outR[i] = this._aqR[a] + (this._aqR[a + 1] - this._aqR[a]) * frac;
      }
      this._aqPos += step;
    }
    // Consumir lo ya leído.
    const consumed = Math.floor(this._aqPos);
    if (consumed > 0) {
      this._aqRead += consumed;
      this._aqPos -= consumed;
      if (this._aqRead > 8192) {
        this._aqL.splice(0, this._aqRead);
        this._aqR.splice(0, this._aqRead);
        this._aqRead = 0;
      }
    }
  }

  _emit(type, data) { try { this.onEvent(type, data); } catch (e) { /* UI no debe romper el bucle */ } }
}

// Export para la página (script clásico) y para Node (pruebas).
DualPlayer.KEY = KEY;
DualPlayer.KEYBOARD_MAP = KEYBOARD_MAP;
if (typeof module !== 'undefined' && module.exports) module.exports = { DualPlayer, KEY, KEYBOARD_MAP };
if (typeof window !== 'undefined') window.DualPlayer = DualPlayer;
