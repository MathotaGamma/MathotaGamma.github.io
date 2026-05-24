/**
 * statics/communication/manager.js
 *
 * class P2P   … 1対1 WebRTC DataChannel
 * class Group … 多対多 WebRTC フルメッシュ（全員が全員と直接つながる）
 *
 * 共通シグナリングサーバー: wss://…/ws/{room_id}
 *   - サーバーは内容を解釈せず同室全員にbroadcastするだけ
 *   - 2人目以降の入室時に {"type":"ready"} を送ってくる
 *
 * ─────────────────────────────────────────────────────
 * P2P 使い方:
 *   const p2p = new P2P("wss://host/ws/room42");
 *   p2p.on("open",  ()    => console.log("接続完了"));
 *   p2p.on("data",  (msg) => console.log("受信:", msg));
 *   p2p.on("close", ()    => console.log("切断"));
 *   p2p.send("hello");
 *
 * Group 使い方:
 *   const g = new Group("wss://host/ws/room42");
 *   g.on("join",    (peerId)       => console.log("参加:", peerId));
 *   g.on("leave",   (peerId)       => console.log("退出:", peerId));
 *   g.on("data",    (peerId, msg)  => console.log("受信:", peerId, msg));
 *   g.on("ready",   ()             => console.log("ルーム接続完了"));
 *   g.broadcast("hello");
 *   g.sendTo(peerId, "hello");
 * ─────────────────────────────────────────────────────
 */

// ── 共通: ICE設定 ──────────────────────────────────────────
const DEFAULT_ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// ── 共通: シグナリングWS管理 ──────────────────────────────
class SignalingSocket {
  constructor(url) {
    this._url  = url;
    this._cbs  = {};
    this._ws   = null;
    this._open = false;
    this._queue = [];   // 接続前に溜まったメッセージ
    this._connect();
  }

  on(event, cb) { this._cbs[event] = cb; return this; }
  _emit(event, ...args) { this._cbs[event]?.(...args); }

  send(obj) {
    const str = JSON.stringify(obj);
    if (this._open) { this._ws.send(str); }
    else            { this._queue.push(str); }
  }

  close() { this._ws?.close(); }

  _connect() {
    this._ws = new WebSocket(this._url);

    this._ws.onopen = () => {
      this._open = true;
      this._queue.forEach(s => this._ws.send(s));
      this._queue = [];
      this._emit("open");
    };

    this._ws.onmessage = ({ data }) => {
      try { this._emit("message", JSON.parse(data)); }
      catch (_) {}
    };

    this._ws.onclose = () => {
      this._open = false;
      this._emit("close");
    };

    this._ws.onerror = (e) => this._emit("error", e);
  }
}


// ════════════════════════════════════════════════════════════
// class P2P — 1対1
// ════════════════════════════════════════════════════════════
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

  // ── public ──────────────────────────────────────────────
  /** events: "open" | "data" | "close" | "error" */
  on(event, cb) { this._cbs[event] = cb; return this; }

  send(msg) {
    if (!this._dc || this._dc.readyState !== "open")
      throw new Error("DataChannel not open");
    this._dc.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  close() { this._pc?.close(); this._sig.close(); }

  // ── private ─────────────────────────────────────────────
  _emit(ev, ...a) { this._cbs[ev]?.(...a); }

  async _onSignal(msg) {
    if (msg.type === "ready") {
      // 自分が2人目 → オファーを作る
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
      if (candidate) this._sig.send({ type: "candidate", candidate });
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
      let v; try { v = JSON.parse(data); } catch { v = data; }
      this._emit("data", v);
    };
  }
}


// ════════════════════════════════════════════════════════════
// class Group — 多対多フルメッシュ
// ════════════════════════════════════════════════════════════
/**
 * 仕組み:
 *   - 各メンバーは自分の peerId (UUID) を持つ
 *   - シグナリングメッセージには to/from を付けて、
 *     サーバーが全員にbroadcastした後クライアント側でフィルタ
 *   - 新規入室 → "hello" をbroadcast → 既存メンバーが1対1でofferを返す
 *   - 退出 → "bye" をbroadcast
 */
class Group {
  constructor(signalingUrl, rtcConfig = DEFAULT_ICE) {
    this._config  = rtcConfig;
    this._cbs     = {};
    this._peerId  = crypto.randomUUID();          // 自分のID
    this._peers   = new Map();                    // peerId -> { pc, dc }

    this._sig = new SignalingSocket(signalingUrl);

    this._sig.on("open",    ()    => this._onWsOpen());
    this._sig.on("message", (msg) => this._onSignal(msg));
    this._sig.on("error",   (e)   => this._emit("error", e));
  }

  // ── public ──────────────────────────────────────────────
  /** events: "ready" | "join" | "leave" | "data" | "error"
   *  "ready"  ()
   *  "join"   (peerId)
   *  "leave"  (peerId)
   *  "data"   (peerId, msg)
   */
  on(event, cb) { this._cbs[event] = cb; return this; }

  /** 自分のpeerId */
  get id() { return this._peerId; }

  /** 接続中のpeerIdリスト */
  get members() { return [...this._peers.keys()]; }

  /** 全員に送信 */
  broadcast(msg) {
    for (const { dc } of this._peers.values()) {
      if (dc?.readyState === "open")
        dc.send(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
  }

  /** 特定の相手に送信 */
  sendTo(peerId, msg) {
    const peer = this._peers.get(peerId);
    if (peer?.dc?.readyState === "open")
      peer.dc.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  close() {
    this._sig.send({ type: "bye", from: this._peerId });
    for (const { pc } of this._peers.values()) pc?.close();
    this._peers.clear();
    this._sig.close();
  }

  // ── private ─────────────────────────────────────────────
  _emit(ev, ...a) { this._cbs[ev]?.(...a); }

  // WS接続完了 → 自己紹介
  _onWsOpen() {
    this._sig.send({ type: "hello", from: this._peerId });
    this._emit("ready");
  }

  async _onSignal(msg) {
    // 自分宛て or ブロードキャスト以外は無視
    if (msg.to && msg.to !== this._peerId) return;
    // 自分からのメッセージも無視
    if (msg.from === this._peerId) return;

    const fromId = msg.from;

    if (msg.type === "hello") {
      // 新メンバーが来た → こちらからofferを送る
      await this._createPeer(fromId, true);

    } else if (msg.type === "bye") {
      this._removePeer(fromId);

    } else if (msg.type === "offer") {
      await this._createPeer(fromId, false);
      const pc = this._peers.get(fromId).pc;
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._sig.send({ type: "answer", from: this._peerId, to: fromId, sdp: answer });

    } else if (msg.type === "answer") {
      const peer = this._peers.get(fromId);
      if (peer) await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));

    } else if (msg.type === "candidate") {
      const peer = this._peers.get(fromId);
      if (peer) await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    }
  }

  async _createPeer(peerId, isOfferer) {
    // すでにある場合はスキップ
    if (this._peers.has(peerId)) return;

    const pc = new RTCPeerConnection(this._config);
    this._peers.set(peerId, { pc, dc: null });

    pc.onicecandidate = ({ candidate }) => {
      if (candidate)
        this._sig.send({ type: "candidate", from: this._peerId, to: peerId, candidate });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected")
        this._removePeer(peerId);
    };

    if (isOfferer) {
      const dc = pc.createDataChannel("group");
      this._peers.get(peerId).dc = dc;
      this._setupDC(dc, peerId);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._sig.send({ type: "offer", from: this._peerId, to: peerId, sdp: offer });

    } else {
      pc.ondatachannel = ({ channel }) => {
        this._peers.get(peerId).dc = channel;
        this._setupDC(channel, peerId);
      };
    }
  }

  _setupDC(dc, peerId) {
    dc.onopen  = () => this._emit("join", peerId);
    dc.onclose = () => this._removePeer(peerId);
    dc.onmessage = ({ data }) => {
      let v; try { v = JSON.parse(data); } catch { v = data; }
      this._emit("data", peerId, v);
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
