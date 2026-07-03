/**
 * WebRTC（DataChannel）を使用したP2P通信管理クラス
 */
export default class P2PManager {
  /**
   * 接続ステータスを定義する静的プロパティ
   */
  static STATUS = {
    IDLE: "IDLE",                 // 初期状態（未接続）
    WAITING: "WAITING",           // シグナリングサーバー接続完了・マッチング待機中
    CONNECTING: "CONNECTING",     // 相手クライアントを検知し、P2P接続処理中
    CONNECTED: "CONNECTED",       // P2P直結完了（データチャネル確立状態）
    DISCONNECTED: "DISCONNECTED", // 切断状態
  };

  /**
   * @param {string} serverUrl - シグナリングサーバーのURL
   * @param {string} roomId - 接続対象のルームID
   * @param {Object} [options={}] - 接続オプション（ICEサーバー設定など）
   */
  constructor(serverUrl, roomId, options = {}) {
    this.serverUrl = serverUrl;
    this.roomId = roomId;
    this.iceServers = options.iceServers || [{ urls: "stun:stun.l.google.com:19302" }];

    this.ws = null;
    this.peerConnection = null;
    this.dataChannel = null;
    
    // 初期状態の設定
    this.status = P2PManager.STATUS.IDLE;

    // --- 外部通知用コールバック関数 ---
    this.onStatusChanged = null;     // ステータス変更時
    this.onMessage = null;           // 汎用データ受信時（メイン機能）
    this.onLatencyCalculated = null; // 遅延時間計算完了時（サブ機能）
    this.onError = null;             // エラー発生時
    this.onDisconnected = null;      // 切断発生時
  }

  /**
   * シグナリングサーバーおよびWebRTCの接続を開始します
   */
  connect() {
    this._setupWebRTC();
    this.ws = new WebSocket(`wss://${this.serverUrl}/ws/${this.roomId}`);
    this._setupSignaling();
  }

  /**
   * すべての接続を明示的に終了し、リソースを解放します
   */
  disconnect() {
    if (this.dataChannel) { this.dataChannel.close(); this.dataChannel = null; }
    if (this.peerConnection) { this.peerConnection.close(); this.peerConnection = null; }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    this.ws = null;
    this._updateStatus(P2PManager.STATUS.IDLE);
  }

  /**
   * メイン機能：相手クライアントへ任意のデータを送信します
   * @param {*} customData - 送信するデータ（オブジェクト、文字列、数値など）
   */
  sendData(customData) {
    if (this.dataChannel && this.dataChannel.readyState === "open") {
      this.dataChannel.send(JSON.stringify({
        type: "user_data",
        payload: customData
      }));
    }
  }

  /**
   * サブ機能：遅延測定用のPingパケットを送信します
   */
  sendPing() {
    if (this.dataChannel && this.dataChannel.readyState === "open") {
      this.dataChannel.send(JSON.stringify({ type: "ping", sentAt: performance.now() }));
    }
  }

  /**
   * 内部メソッド：シグナリングプロトコルの設定
   */
  _setupSignaling() {
    this.ws.onopen = () => this._updateStatus(P2PManager.STATUS.WAITING);
    this.ws.onerror = (event) => this._notifyError("シグナリングサーバーとの通信でエラーが発生しました", event);
    this.ws.onclose = () => {
      // P2P接続が既に成功している場合は、シグナリングサーバーの切断を正常系として扱います
      if (this.status !== P2PManager.STATUS.CONNECTED) {
        this._updateStatus(P2PManager.STATUS.DISCONNECTED);
      }
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
        this._notifyError("シグナリングメッセージの処理に失敗しました", err);
      }
    };
  }

  /**
   * 内部メソッド：WebRTC（RTCPeerConnection）の初期設定
   */
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

  /**
   * 内部メソッド：Offer側におけるデータチャネルの生成
   */
  _createDataChannel() {
    // リアルタイム性を最優先とするため、順序保証なし・再送なし（UDP互換モード）で生成
    this.dataChannel = this.peerConnection.createDataChannel("latencyChannel", {
      ordered: false,
      maxRetransmits: 0,
    });
    this._setupDataChannelEvents(this.dataChannel);
  }

  /**
   * 内部メソッド：データチャネルのイベントリスナー設定
   */
  _setupDataChannelEvents(channel) {
    channel.onopen = () => {
      this._updateStatus(P2PManager.STATUS.CONNECTED);
      // P2P直結が成功したため、シグナリングサーバー（WebSocket）から安全に切断します
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    };
    
    channel.onclose = () => {
      this._updateStatus(P2PManager.STATUS.DISCONNECTED);
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

      // --- 遅延測定処理（サブ機能） ---
      if (data.type === "ping") {
        channel.send(JSON.stringify({ type: "pong", sentAt: data.sentAt }));
      } else if (data.type === "pong") {
        const now = performance.now();
        const oneWayLatency = (now - data.sentAt) / 2;
        const errorFrame = oneWayLatency / (1000 / 60); // 60FPS換算におけるズレフレーム数

        if (this.onLatencyCalculated) {
          this.onLatencyCalculated(oneWayLatency, errorFrame);
        }
      } 
      // --- 汎用データ処理（メイン機能） ---
      else if (data.type === "user_data") {
        if (this.onMessage) this.onMessage(data.payload);
      }
    };
  }

  /**
   * 内部メソッド：Offer（接続要求）の作成および送信
   */
  async _createOffer() {
    try {
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
      this.ws.send(JSON.stringify({ type: "offer", sdp: offer }));
    } catch (err) { 
      this._notifyError("オファーの作成に失敗しました", err); 
    }
  }

  /**
   * 内部メソッド：接続ステータスの更新および外部通知
   */
  _updateStatus(nextStatus) {
    this.status = nextStatus;
    if (this.onStatusChanged) this.onStatusChanged(this.status);
  }

  /**
   * 内部メソッド：エラー発生時の通知処理
   */
  _notifyError(message, detail) {
    if (this.onError) this.onError(message, detail);
    else console.error(message, detail);
  }
}
