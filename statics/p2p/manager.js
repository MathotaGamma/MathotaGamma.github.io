// P2PManager.js

export default class P2PManager {
  // 静的（static）プロパティとしてステータスを定義
  static STATUS = {
    IDLE: "IDLE",
    WAITING: "WAITING",
    CONNECTING: "CONNECTING",
    CONNECTED: "CONNECTED",
    DISCONNECTED: "DISCONNECTED",
  };

  constructor(serverUrl, roomId, options = {}) {
    this.serverUrl = serverUrl;
    this.roomId = roomId;
    this.iceServers = options.iceServers || [{ urls: "stun:stun.l.google.com:19302" }];

    this.ws = null;
    this.peerConnection = null;
    this.dataChannel = null;
    
    // 初期状態のセット（自身のstaticを参照）
    this.status = P2PManager.STATUS.IDLE;

    // コールバック
    this.onStatusChanged = null;
    this.onMessage = null;           // メイン：汎用データ受信
    this.onLatencyCalculated = null; // サブ：遅延計測完了
    this.onError = null;
    this.onDisconnected = null;
  }

  connect() {
    this._setupWebRTC();
    this.ws = new WebSocket(`wss://${this.serverUrl}/ws/${this.roomId}`);
    this._setupSignaling();
  }

  disconnect() {
    if (this.dataChannel) { this.dataChannel.close(); this.dataChannel = null; }
    if (this.peerConnection) { this.peerConnection.close(); this.peerConnection = null; }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    this.ws = null;
    this._updateStatus(P2PManager.STATUS.IDLE);
  }

  // メイン機能：データの送信
  sendData(customData) {
    if (this.dataChannel && this.dataChannel.readyState === "open") {
      this.dataChannel.send(JSON.stringify({
        type: "user_data",
        payload: customData
      }));
    }
  }

  // 遅延測定Pingの送信
  sendPing() {
    if (this.dataChannel && this.dataChannel.readyState === "open") {
      this.dataChannel.send(JSON.stringify({ type: "ping", sentAt: performance.now() }));
    }
  }

  _setupSignaling() {
    this.ws.onopen = () => this._updateStatus(P2PManager.STATUS.WAITING);
    this.ws.onerror = (event) => this._notifyError("シグナリングサーバーエラー", event);
    this.ws.onclose = () => {
      if (this.status !== P2PManager.STATUS.CONNECTED) this._updateStatus(P2PManager.STATUS.DISCONNECTED);
    };

    this.ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "ready") {
          this._updateStatus(P2PManager.STATUS.CONNECTING);
          this._createDataChannel();
          await this._createOffer();
        } else if (message.type === "offer") {
          this._updateStatus(P2PManager.STATUS.CONNECTING);
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp));
          const answer = await this.peerConnection.createAnswer();
          await this.peerConnection.setLocalDescription(answer);
          this.ws.send(JSON.stringify({ type: "answer", sdp: answer }));
        } else if (message.type === "answer") {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp));
        } else if (message.type === "candidate" && message.candidate) {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
        }
      } catch (err) {
        this._notifyError("シグナリングエラー", err);
      }
    };
  }

  _setupWebRTC() {
    this.peerConnection = new RTCPeerConnection({ iceServers: this.iceServers });
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "candidate", candidate: event.candidate }));
      }
    };
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      if (state === "failed" || state === "disconnected" || state === "closed") {
        this._updateStatus(P2PManager.STATUS.DISCONNECTED);
        if (this.onDisconnected) this.onDisconnected(state);
      }
    };
    this.peerConnection.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this._setupDataChannelEvents(this.dataChannel);
    };
  }

  _createDataChannel() {
    this.dataChannel = this.peerConnection.createDataChannel("latencyChannel", {
      ordered: false,
      maxRetransmits: 0,
    });
    this._setupDataChannelEvents(this.dataChannel);
  }

  _setupDataChannelEvents(channel) {
    channel.onopen = () => {
      this._updateStatus(P2PManager.STATUS.CONNECTED);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    };
    channel.onclose = () => {
      this._updateStatus(P2PManager.STATUS.DISCONNECTED);
      if (this.onDisconnected) this.onDisconnected("datachannel-closed");
    };
    channel.onerror = (event) => this._notifyError("データチャネルエラー", event);

    channel.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch (err) { return; }

      if (data.type === "ping") {
        channel.send(JSON.stringify({ type: "pong", sentAt: data.sentAt }));
      } else if (data.type === "pong") {
        const now = performance.now();
        const oneWayLatency = (now - data.sentAt) / 2;
        if (this.onLatencyCalculated) this.onLatencyCalculated(oneWayLatency);
      } else if (data.type === "user_data") {
        if (this.onMessage) this.onMessage(data.payload);
      }
    };
  }

  async _createOffer() {
    try {
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
      this.ws.send(JSON.stringify({ type: "offer", sdp: offer }));
    } catch (err) { this._notifyError("オファー作成失敗", err); }
  }

  _updateStatus(nextStatus) {
    this.status = nextStatus;
    if (this.onStatusChanged) this.onStatusChanged(this.status);
  }

  _notifyError(message, detail) {
    if (this.onError) this.onError(message, detail);
  }
}
