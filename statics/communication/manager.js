/**
 * statics/communication/manager.js
 *
 * class P2P   — 1対1 WebRTC DataChannel
 * class Group — 多対多 WebRTC フルメッシュ
 *
 * シグナリングサーバー: wss://…/ws/{room_id}
 *   サーバーは同室全員にbroadcastするだけ。内容は解釈しない。
 *   ただし2人目入室時だけ {"type":"ready"} を送ってくる（P2P用）。
 *   ★ Groupクラスはこの "ready" を無視する。
 *
 * ─── P2P 使い方 ────────────────────────────────────────────────
 *   const p2p = new P2P("wss://host/ws/roomId");
 *   p2p.on("open",  ()    => {});
 *   p2p.on("data",  (msg) => {});
 *   p2p.on("close", ()    => {});
 *   p2p.send("hello");
 *   p2p.close();
 *
 * ─── Group 使い方 ──────────────────────────────────────────────
 *   const g = new Group("wss://host/ws/roomId");
 *   g.on("ready", ()            => console.log("入室完了, myId:", g.id));
 *   g.on("join",  (peerId)      => {});
 *   g.on("leave", (peerId)      => {});
 *   g.on("data",  (peerId, msg) => {});
 *   g.broadcast("hello");
 *   g.sendTo(peerId, "hi");
 *   g.close();
 */


// ══════════════════════════════════════════════════════════════════
// 共通: ICE設定
// ══════════════════════════════════════════════════════════════════

const DEFAULT_ICE = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};


// ══════════════════════════════════════════════════════════════════
// 共通: WebSocketラッパー
//
//   - 接続が確立する前の send() はキューに溜める
//   - on("open" | "message" | "close" | "error", cb) で登録
//   - "open" は Promise.resolve() で1マイクロタスク遅延させ、
//     new SignalingSocket() 直後のコールバック登録を確実に拾う
// ══════════════════════════════════════════════════════════════════

class SignalingSocket {
  constructor(url) {
    this._url    = url;
    this._cbs    = {};
    this._ws     = null;
    this._isOpen = false;
    this._queue  = [];  // WS接続前に溜めたメッセージ
    this._connect();
  }

  on(event, cb) {
    this._cbs[event] = cb;
    return this;
  }

  send(obj) {
    const str = JSON.stringify(obj);
    if (this._isOpen) {
      this._ws.send(str);
    } else {
      this._queue.push(str);
    }
  }

  close() {
    this._ws?.close();
  }

  // ── private ────────────────────────────────────────────────────

  _emit(event, ...args) {
    this._cbs[event]?.(...args);
  }

  _connect() {
    this._ws = new WebSocket(this._url);

    this._ws.onopen = () => {
      this._isOpen = true;
      this._queue.forEach(s => this._ws.send(s));
      this._queue = [];
      // 1マイクロタスク遅らせてコールバック登録を確実に拾う
      Promise.resolve().then(() => this._emit("open"));
    };

    this._ws.onmessage = ({ data }) => {
      try {
        this._emit("message", JSON.parse(data));
      } catch (_) {
        // JSON以外は無視
      }
    };

    this._ws.onclose = () => {
      this._isOpen = false;
      this._emit("close");
    };

    this._ws.onerror = (e) => {
      this._emit("error", e);
    };
  }
}


// ══════════════════════════════════════════════════════════════════
// class P2P — 1対1
//
// シーケンス:
//   Peer A 先着 → 待機
//   Peer B 入室 → サーバーが B に {"type":"ready"} 送信
//   B → createOffer → シグナリング → A
//   A → createAnswer → シグナリング → B
//   ICE candidates 交換 → DataChannel open
// ══════════════════════════════════════════════════════════════════

class P2P {
  constructor(signalingUrl, rtcConfig = DEFAULT_ICE) {
    this._config = rtcConfig;
    this._cbs    = {};
    this._pc     = null;
    this._dc     = null;

    this._sig = new SignalingSocket(signalingUrl);
    this._sig.on("message", (msg) => this._onSignal(msg));
    this._sig.on("error",   (e)   => this._emit("error", e));
  }

  // ── public ──────────────────────────────────────────────────────

  /** events: "open" | "data" | "close" | "error" */
  on(event, cb) {
    this._cbs[event] = cb;
    return this;
  }

  /** 文字列またはオブジェクト（自動JSON化）を送信 */
  send(msg) {
    if (!this._dc || this._dc.readyState !== "open") {
      throw new Error("DataChannel not open");
    }
    this._dc.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  close() {
    this._pc?.close();
    this._sig.close();
  }

  // ── private ─────────────────────────────────────────────────────

  _emit(ev, ...args) {
    this._cbs[ev]?.(...args);
  }

  async _onSignal(msg) {
    if (msg.type === "ready") {
      await this._createPC(true);
      const offer = await this._pc.createOffer();
      await this._pc.setLocalDescription(offer);
      this._sig.send(offer);

    } else if (msg.type === "offer") {
      await this._createPC(false);
      await this._pc.setRemoteDescription(new RTCSessionDescription(msg));
      const answer = await this._pc.createAnswer();
      await this._pc.setLocalDescription(answer);
      this._sig.send(answer);

    } else if (msg.type === "answer") {
      await this._pc.setRemoteDescription(new RTCSessionDescription(msg));

    } else if (msg.type === "candidate") {
      await this._pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    }
  }

  async _createPC(isOfferer) {
    this._pc = new RTCPeerConnection(this._config);

    this._pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this._sig.send({ type: "candidate", candidate });
      }
    };

    if (isOfferer) {
      this._dc = this._pc.createDataChannel("p2p");
      this._setupDC(this._dc);
    } else {
      this._pc.ondatachannel = ({ channel }) => {
        this._dc = channel;
        this._setupDC(this._dc);
      };
    }
  }

  _setupDC(dc) {
    dc.onopen    = ()  => this._emit("open");
    dc.onclose   = ()  => this._emit("close");
    dc.onerror   = (e) => this._emit("error", e);
    dc.onmessage = ({ data }) => {
      let parsed;
      try { parsed = JSON.parse(data); } catch { parsed = data; }
      this._emit("data", parsed);
    };
  }
}


// ══════════════════════════════════════════════════════════════════
// class Group — 多対多フルメッシュ
//
// 仕組み:
//   各メンバーが自分の peerId (UUID) を持つ。
//   シグナリングメッセージには必ず { from, to } を付与し、
//   サーバーのbroadcastを受けた側がクライアントでフィルタする。
//
//   ★ サーバーから来る {"type":"ready"} (P2P用) は
//      from フィールドがないので _onSignal の先頭で弾く。
//
// シーケンス（新規入室）:
//   新メンバー → WS接続 → "hello" broadcast（from: 自分のid）
//   既存メンバー全員 → "hello" 受信 → 各自が新メンバーへ offer 送信
//   新メンバー → offer 受信 → answer 返送
//   ICE candidates 交換 → DataChannel open → "join" emit
//
// 退出:
//   "bye" broadcast → 相手が _removePeer → "leave" emit
// ══════════════════════════════════════════════════════════════════

class Group {
  constructor(signalingUrl, rtcConfig = DEFAULT_ICE) {
    this._config = rtcConfig;
    this._cbs    = {};
    this._id     = crypto.randomUUID();  // 自分のpeerId（構築時に確定）
    this._peers  = new Map();            // peerId -> { pc, dc }

    this._sig = new SignalingSocket(signalingUrl);
    this._sig.on("open",    ()    => this._onWsOpen());
    this._sig.on("message", (msg) => this._onSignal(msg));
    this._sig.on("error",   (e)   => this._emit("error", e));
  }

  // ── public ──────────────────────────────────────────────────────

  /**
   * events:
   *   "ready"  ()             — WS接続完了・入室済み
   *   "join"   (peerId)       — 新メンバーとのDataChannel open
   *   "leave"  (peerId)       — メンバー退出
   *   "data"   (peerId, msg)  — メッセージ受信
   *   "error"  (err)          — エラー
   */
  on(event, cb) {
    this._cbs[event] = cb;
    return this;
  }

  /** 自分のpeerId（new Group() 直後から取得可能） */
  get id() {
    return this._id;
  }

  /** 現在DataChannel確立済みのpeerIdの配列 */
  get members() {
    return [...this._peers.keys()];
  }

  /** 接続済み全員にbroadcast */
  broadcast(msg) {
    const str = typeof msg === "string" ? msg : JSON.stringify(msg);
    for (const { dc } of this._peers.values()) {
      if (dc?.readyState === "open") {
        dc.send(str);
      }
    }
  }

  /** 特定のpeerに送信 */
  sendTo(peerId, msg) {
    const peer = this._peers.get(peerId);
    if (peer?.dc?.readyState === "open") {
      peer.dc.send(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
  }

  close() {
    this._sig.send({ type: "bye", from: this._id });
    for (const { pc } of this._peers.values()) {
      pc?.close();
    }
    this._peers.clear();
    this._sig.close();
  }

  // ── private ─────────────────────────────────────────────────────

  _emit(ev, ...args) {
    this._cbs[ev]?.(...args);
  }

  // WS接続完了 → 自己紹介 → "ready" emit
  _onWsOpen() {
    this._sig.send({ type: "hello", from: this._id });
    this._emit("ready");
  }

  async _onSignal(msg) {
    // ★ from がないメッセージは全て無視
    //   （サーバーが送る {"type":"ready"} がここで弾かれる）
    if (!msg.from) return;

    // 自分が送ったものは無視
    if (msg.from === this._id) return;

    // to が指定されていて自分宛てでなければ無視
    if (msg.to && msg.to !== this._id) return;

    const fromId = msg.from;

    if (msg.type === "hello") {
      // 新メンバー到着 → offerを送る
      await this._createPeer(fromId, true);

    } else if (msg.type === "bye") {
      this._removePeer(fromId);

    } else if (msg.type === "offer") {
      await this._createPeer(fromId, false);
      const peer = this._peers.get(fromId);
      if (!peer) return;
      await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this._sig.send({
        type: "answer",
        from: this._id,
        to:   fromId,
        sdp:  answer,
      });

    } else if (msg.type === "answer") {
      const peer = this._peers.get(fromId);
      if (peer) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      }

    } else if (msg.type === "candidate") {
      const peer = this._peers.get(fromId);
      if (peer) {
        await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      }
    }
  }

  async _createPeer(peerId, isOfferer) {
    // 重複作成を防ぐ
    if (this._peers.has(peerId)) return;

    const pc = new RTCPeerConnection(this._config);
    this._peers.set(peerId, { pc, dc: null });

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this._sig.send({
          type:      "candidate",
          from:      this._id,
          to:        peerId,
          candidate,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "failed" || s === "disconnected" || s === "closed") {
        this._removePeer(peerId);
      }
    };

    if (isOfferer) {
      const dc = pc.createDataChannel("group");
      this._peers.get(peerId).dc = dc;
      this._setupDC(dc, peerId);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._sig.send({
        type: "offer",
        from: this._id,
        to:   peerId,
        sdp:  offer,
      });

    } else {
      pc.ondatachannel = ({ channel }) => {
        this._peers.get(peerId).dc = channel;
        this._setupDC(channel, peerId);
      };
    }
  }

  _setupDC(dc, peerId) {
    dc.onopen = () => {
      this._emit("join", peerId);
    };

    dc.onclose = () => {
      this._removePeer(peerId);
    };

    dc.onmessage = ({ data }) => {
      let parsed;
      try { parsed = JSON.parse(data); } catch { parsed = data; }
      this._emit("data", peerId, parsed);
    };
  }

  _removePeer(peerId) {
    const peer = this._peers.get(peerId);
    if (!peer) return;
    peer.pc?.close();
    this._peers.delete(peerId);
    this._emit("leave", peerId);
  }
}
