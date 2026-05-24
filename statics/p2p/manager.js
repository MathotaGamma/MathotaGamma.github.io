/**
 * P2P — WebRTC peer-to-peer client with WebSocket signaling
 *
 * Usage:
 *   const p2p = new P2P("wss://your-render-app.onrender.com/ws/room42");
 *   p2p.on("data", (msg) => console.log("received:", msg));
 *   p2p.send("hello");
 */

class P2P {
  /**
   * @param {string} signalingUrl  - WebSocket URL (wss://…/ws/{room_id})
   * @param {RTCConfiguration} [rtcConfig]
   */
  constructor(signalingUrl, rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }) {
    this._url    = signalingUrl;
    this._config = rtcConfig;
    this._cbs    = {};   // event callbacks

    this._pc  = null;   // RTCPeerConnection
    this._dc  = null;   // RTCDataChannel
    this._ws  = null;   // WebSocket (signaling)

    this._connect();
  }

  // ── public ────────────────────────────────────────────────

  /** Register an event handler.  events: "open" | "data" | "close" | "error" */
  on(event, cb) { this._cbs[event] = cb; return this; }

  /** Send a string or object (auto-JSON) to the remote peer. */
  send(msg) {
    if (!this._dc || this._dc.readyState !== "open") throw new Error("DataChannel not open");
    this._dc.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  /** Close everything. */
  close() {
    this._dc?.close();
    this._pc?.close();
    this._ws?.close();
  }

  // ── private ───────────────────────────────────────────────

  _emit(event, ...args) { this._cbs[event]?.(...args); }

  _connect() {
    this._ws = new WebSocket(this._url);

    this._ws.onopen = () => {
      // 先に接続した側がオファー側になる
      // サーバーから "ready" が来たらオファーを送る
    };

    this._ws.onmessage = async ({ data }) => {
      const msg = JSON.parse(data);

      if (msg.type === "ready") {
        // 自分が2人目 → オファーを作って送る
        await this._createPeer(true);
        const offer = await this._pc.createOffer();
        await this._pc.setLocalDescription(offer);
        this._signal(offer);

      } else if (msg.type === "offer") {
        await this._createPeer(false);
        await this._pc.setRemoteDescription(new RTCSessionDescription(msg));
        const answer = await this._pc.createAnswer();
        await this._pc.setLocalDescription(answer);
        this._signal(answer);

      } else if (msg.type === "answer") {
        await this._pc.setRemoteDescription(new RTCSessionDescription(msg));

      } else if (msg.type === "candidate") {
        await this._pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      }
    };

    this._ws.onerror = (e) => this._emit("error", e);
  }

  async _createPeer(isOfferer) {
    this._pc = new RTCPeerConnection(this._config);

    // ICE候補をシグナリングサーバー経由で転送
    this._pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._signal({ type: "candidate", candidate });
    };

    if (isOfferer) {
      // オファー側がデータチャンネルを作る
      this._dc = this._pc.createDataChannel("data");
      this._setupDC(this._dc);
    } else {
      // アンサー側は ondatachannel で受け取る
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

  _signal(msg) {
    this._ws.send(JSON.stringify(msg));
  }
}
