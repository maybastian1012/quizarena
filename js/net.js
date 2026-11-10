// Verbindung Laptop <-> Handys über WebRTC (PeerJS, kostenloser Vermittlungsserver).
/* global Peer */

export const PREFIX = 'quizarena-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

// Host (Laptop). handlers: onMessage(pid, msg), onLeave(pid), onStatus(status, detail)
export function createHost(code, handlers) {
  const conns = new Map(); // pid -> DataConnection
  let peer = null;
  let tries = 0;
  let destroyed = false;

  function start() {
    peer = new Peer(PREFIX + code, { debug: 1 });
    peer.on('open', () => { tries = 0; handlers.onStatus('online'); });
    peer.on('connection', conn => {
      conn.on('data', msg => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'hello' && typeof msg.pid === 'string') {
          const old = conns.get(msg.pid);
          if (old && old !== conn) try { old.close(); } catch (e) { /* egal */ }
          conns.set(msg.pid, conn);
          conn.pid = msg.pid;
        }
        if (conn.pid) handlers.onMessage(conn.pid, msg);
      });
      conn.on('close', () => {
        if (conn.pid && conns.get(conn.pid) === conn) { conns.delete(conn.pid); handlers.onLeave(conn.pid); }
      });
      conn.on('error', () => {});
    });
    peer.on('disconnected', () => {
      if (destroyed) return;
      handlers.onStatus('reconnecting');
      setTimeout(() => { if (!destroyed && peer && !peer.destroyed) peer.reconnect(); }, 1500);
    });
    peer.on('error', err => {
      if (destroyed) return;
      if (err.type === 'unavailable-id' && tries < 15) {
        // Nach Neuladen hält der Server die alte Verbindung noch kurz fest.
        tries++;
        handlers.onStatus('waiting-id');
        try { peer.destroy(); } catch (e) { /* egal */ }
        setTimeout(start, 2000);
        return;
      }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        handlers.onStatus('reconnecting', err.type);
        return;
      }
      handlers.onStatus('error', err.type || String(err));
    });
  }
  start();

  return {
    send(pid, msg) {
      const c = conns.get(pid);
      if (c && c.open) { try { c.send(msg); } catch (e) { /* Verbindung weg */ } }
    },
    isConnected: pid => !!(conns.get(pid) && conns.get(pid).open),
    drop(pid) { const c = conns.get(pid); if (c) { conns.delete(pid); try { c.close(); } catch (e) { /* egal */ } } },
    destroy() { destroyed = true; try { peer.destroy(); } catch (e) { /* egal */ } },
  };
}

// Spieler (Handy). handlers: onMessage(msg), onStatus(status)
export function createClient(code, pid, handlers) {
  let peer = null;
  let conn = null;
  let lastMsg = Date.now();
  let timer = null;
  let guard = null;
  let connecting = false;

  function connect() {
    if (connecting || (conn && conn.open)) return;
    connecting = true;
    handlers.onStatus('connecting');
    // Sicherheitsnetz: Kommt nach 10 s keine Verbindung zustande, neu versuchen.
    clearTimeout(guard);
    guard = setTimeout(() => {
      if (!(conn && conn.open)) {
        connecting = false;
        if (peer && !peer.open) { try { peer.destroy(); } catch (e) { /* egal */ } }
        schedule(300);
      }
    }, 10000);
    if (!peer || peer.destroyed) {
      peer = new Peer({ debug: 1 });
      peer.on('open', openConn);
      peer.on('error', err => {
        connecting = false;
        handlers.onStatus(err.type === 'peer-unavailable' ? 'no-host' : 'offline');
        schedule(err.type === 'peer-unavailable' ? 4000 : 2500);
      });
      // Verbindung zum Vermittlungsserver weg: neu anmelden. Die direkte Verbindung zum Laptop kann weiterlaufen.
      peer.on('disconnected', () => {
        setTimeout(() => { if (peer && peer.disconnected && !peer.destroyed) peer.reconnect(); }, 1500);
      });
    } else if (peer.disconnected) {
      peer.reconnect(); // löst 'open' aus -> openConn
    } else {
      openConn();
    }
  }

  function openConn() {
    if (conn && conn.open) { connecting = false; return; }
    try { if (conn) conn.close(); } catch (e) { /* egal */ }
    conn = peer.connect(PREFIX + code, { reliable: true });
    conn.on('open', () => {
      connecting = false;
      lastMsg = Date.now();
      handlers.onStatus('online');
      conn.send({ t: 'hello', pid, ...handlers.helloData() });
    });
    conn.on('data', msg => { lastMsg = Date.now(); if (msg && msg.t !== 'ping') handlers.onMessage(msg); });
    conn.on('close', () => { connecting = false; handlers.onStatus('offline'); schedule(1500); });
    conn.on('error', () => { connecting = false; schedule(2000); });
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(connect, ms);
  }

  // Lebenszeichen: Host schickt regelmäßig Pings. Bleiben sie aus, neu verbinden.
  setInterval(() => {
    if (conn && conn.open && Date.now() - lastMsg > 12000) {
      try { conn.close(); } catch (e) { /* egal */ }
      connecting = false;
      schedule(100);
    }
  }, 3000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !(conn && conn.open)) { connecting = false; schedule(100); }
  });

  connect();

  return {
    send(msg) { if (conn && conn.open) { conn.send(msg); return true; } return false; },
    isOpen: () => !!(conn && conn.open),
  };
}
