// P2P 連線層：host 當 hub，把每則訊息轉發給除了來源以外的所有人。
// 觀戰者因此不需要跟其他玩家直連，只要掛在 host 上就能看到全部戰況。
// (架構沿用自 battleship 專案的 net.js)

const ID_PREFIX = 'holdem-';
// 拿掉 0/O/1/I 這種肉眼會看錯的字，房間碼是要用嘴巴唸給朋友聽的。
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const makeRoomCode = () =>
  Array.from({ length: 6 }, () =>
    ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

export const peerIdFor = code => ID_PREFIX + code.toUpperCase();

function loadPeerJS() {
  if (window.Peer) return Promise.resolve();
  const sources = [
    'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js',
    'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js',
  ];
  return new Promise((resolve, reject) => {
    const tryNext = i => {
      if (i >= sources.length) return reject(new Error('PeerJS 載入失敗'));
      const el = document.createElement('script');
      el.src = sources[i];
      el.onload = () => resolve();
      el.onerror = () => { el.remove(); tryNext(i + 1); };
      document.head.appendChild(el);
    };
    tryNext(0);
  });
}

export function createNet({ onMessage, onStatus, onPeersChanged }) {
  const state = {
    role: null,        // 'host' | 'guest'
    code: null,
    peer: null,
    conns: new Map(),  // connId -> { conn, name }
    hostConn: null,    // 非 host 用：通往 host 的那條連線
    selfName: '',
    closed: false,
  };

  const peersSnapshot = () => [...state.conns.values()]
    .map(c => ({ id: c.conn.peer, name: c.name }));

  const notifyPeers = () => onPeersChanged?.(peersSnapshot());

  function deliver(envelope, fromConnId) {
    if (state.role === 'host') {
      for (const [id, entry] of state.conns) {
        if (id !== fromConnId && entry.conn.open) entry.conn.send(envelope);
      }
    }
    onMessage?.(envelope);
  }

  function wireConn(conn) {
    const entry = { conn, name: '' };
    state.conns.set(conn.peer, entry);

    conn.on('data', raw => {
      if (!raw || typeof raw !== 'object') return;
      if (raw.type === '__hello') {
        entry.name = raw.name || '';
        notifyPeers();
        onStatus?.({ kind: 'peer-joined', name: entry.name, id: conn.peer });
        return;
      }
      deliver(raw, conn.peer);
    });

    conn.on('open', () => {
      conn.send({ type: '__hello', name: state.selfName });
      notifyPeers();
    });

    conn.on('close', () => {
      state.conns.delete(conn.peer);
      notifyPeers();
      onStatus?.({ kind: 'peer-left', name: entry.name, id: conn.peer });
    });

    conn.on('error', err => onStatus?.({ kind: 'conn-error', error: err }));
    return entry;
  }

  // 手機用行動網路時常常躲在電信級 NAT（CGNAT）後面，光靠 STUN 打洞打不穿，
  // 這時候唯一能連上的辦法是找一台 TURN 伺服器幫忙轉發封包。
  // 這組是 Open Relay Project 公開提供的免費測試帳號（metered.ca），沒有金鑰外洩疑慮。
  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: 'turn:global.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:global.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  };

  async function makePeer(id) {
    await loadPeerJS();
    return new Promise((resolve, reject) => {
      const opts = { config: ICE_CONFIG };
      const peer = id ? new window.Peer(id, opts) : new window.Peer(opts);
      const fail = err => reject(err);
      peer.once('open', () => { peer.off('error', fail); resolve(peer); });
      peer.once('error', fail);
    });
  }

  return {
    get role() { return state.role; },
    get code() { return state.code; },
    get selfId() { return state.peer?.id; },
    get peers() { return peersSnapshot(); },
    setName(name) { state.selfName = name; },

    async host(code, name) {
      state.role = 'host';
      state.code = code;
      state.selfName = name;
      state.peer = await makePeer(peerIdFor(code));
      state.peer.on('connection', conn => wireConn(conn));
      state.peer.on('error', err => onStatus?.({ kind: 'peer-error', error: err }));
      state.peer.on('disconnected', () => {
        if (!state.closed) state.peer.reconnect();
      });
      onStatus?.({ kind: 'hosting', code });
      return code;
    },

    async join(code, name) {
      state.role = 'guest';
      state.code = code.toUpperCase();
      state.selfName = name;
      state.peer = await makePeer(null);
      state.peer.on('error', err => onStatus?.({ kind: 'peer-error', error: err }));
      state.peer.on('disconnected', () => {
        if (!state.closed) state.peer.reconnect();
      });
      const conn = state.peer.connect(peerIdFor(state.code), { reliable: true });
      state.hostConn = conn;
      wireConn(conn);
      onStatus?.({ kind: 'joining', code: state.code });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
          '連線逾時。房間代號打錯、房主已離線、或是雙方網路環境擋住了 P2P 連線（例如一邊用行動數據）都可能造成這個結果，建議先在同一個 WiFi 下測試排除網路問題'
        )), 30000);
        conn.on('open', () => { clearTimeout(timer); resolve(); });
        conn.on('error', err => { clearTimeout(timer); reject(err); });
      });
    },

    // 送給所有人（host 專用廣播；guest 呼叫時會送給 host 再由 host 轉發）
    send(payload) {
      const envelope = { ...payload, __from: state.role, __id: state.peer?.id, __name: state.selfName };
      if (state.role === 'host') {
        for (const entry of state.conns.values()) {
          if (entry.conn.open) entry.conn.send(envelope);
        }
      } else if (state.hostConn?.open) {
        state.hostConn.send(envelope);
      }
      return envelope;
    },

    // 只送給特定一個人（host 專用，例如私發手牌）
    sendTo(peerId, payload) {
      const entry = state.conns.get(peerId);
      if (entry?.conn.open) {
        entry.conn.send({ ...payload, __from: state.role, __id: state.peer?.id, __name: state.selfName });
      }
    },

    destroy() {
      state.closed = true;
      for (const entry of state.conns.values()) entry.conn.close();
      state.conns.clear();
      state.peer?.destroy();
    },
  };
}
