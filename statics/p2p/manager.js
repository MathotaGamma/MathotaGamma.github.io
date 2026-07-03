// P2P Manager
export default class P2PManager {
  constructor(serverUrl, roomId, options = {}) {
    this.serverUrl = serverUrl;
    this.roomId = roomId;
    this.iceServers = options.iceServers || [{ urls: "stun:stun.l.google.com:19302" }];

    this.ws = null;
    this.peerConnection = null;
    this.dataChannel = null;

    // 外部（ゲーム側）へイベントを通知するためのコールバック
    this.onLatencyCalculated = null;
    this.onPeerLatencyNotified = null;
    this.onStatusChanged = null;
    this.onError = null;
    this.onDisconnected = null;
  }

  // 接続の開始トリガー
  connect() {
    this._setupWebRTC();

    this.ws = new WebSocket(`wss://${this.serverUrl}/ws/${this.roomId}`);
    this._setupSignaling();
  }

  // 接続を明示的に終了し、リソースを解放する
  disconnect() {
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  // 計測開始ボタンなどから呼ばれる公開メソッド
  sendPing() {
    if (this.dataChannel && this.dataChannel.readyState === "open") {
      this.dataChannel.send(JSON.stringify({ type: "ping", sentAt: performance.now() }));
    }
  }

  // 内部メソッド：シグナリング処理
  _setupSignaling() {
    this.ws.onopen = () => this._updateStatus("マッチング待機中");

    this.ws.onerror = (event) => this._notifyError("シグナリングサーバーとの接続でエラーが発生しました", event);

    this.ws.onclose = () => this._updateStatus("シグナリングサーバーから切断されました");

    this.ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === "ready") {
          await this._createOffer();
        } else if (message.type === "offer") {
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
        this._notifyError("シグナリングメッセージの処理に失敗しました", err);
      }
    };
  }

  // 内部メソッド：WebRTC & DataChannel設定
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
        this._updateStatus(`接続状態: ${state}`);
        if (this.onDisconnected) this.onDisconnected(state);
      }
    };

    // 最速UDPモード
    this.dataChannel = this.peerConnection.createDataChannel("latencyChannel", {
      ordered: false,
      maxRetransmits: 0,
    });
    this._setupDataChannelEvents(this.dataChannel);

    this.peerConnection.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this._setupDataChannelEvents(this.dataChannel);
    };
  }

  _setupDataChannelEvents(channel) {
    channel.onopen = () => {
      this._updateStatus("P2P直結完了 (超低遅延)");
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(); // サーバーから離脱
    };

    channel.onclose = () => {
      this._updateStatus("データチャネルが閉じられました");
      if (this.onDisconnected) this.onDisconnected("datachannel-closed");
    };

    channel.onerror = (event) => this._notifyError("データチャネルでエラーが発生しました", event);

    channel.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (err) {
        this._notifyError("受信データの解析に失敗しました", err);
        return;
      }

      if (data.type === "ping") {
        channel.send(JSON.stringify({ type: "pong", sentAt: data.sentAt }));
      } else if (data.type === "pong") {
        const now = performance.now();
        const oneWayLatency = (now - data.sentAt) / 2;
        const errorFrame = oneWayLatency / (1000 / 60);

        // 外部のコールバック関数にデータを渡す
        if (this.onLatencyCalculated) this.onLatencyCalculated(oneWayLatency, errorFrame);

        // 相手にレポートを再送
        channel.send(JSON.stringify({ type: "report", latencyMs: oneWayLatency, frame: errorFrame }));
      } else if (data.type === "report") {
        if (this.onPeerLatencyNotified) this.onPeerLatencyNotified(data.latencyMs, data.frame);
      }
    };
  }

  async _createOffer() {
    try {
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
      this.ws.send(JSON.stringify({ type: "offer", sdp: offer }));
    } catch (err) {
      this._notifyError("オファーの作成に失敗しました", err);
    }
  }

  _updateStatus(status) {
    if (this.onStatusChanged) this.onStatusChanged(status);
  }

  _notifyError(message, detail) {
    if (this.onError) this.onError(message, detail);
    else console.error(message, detail);
  }
}
