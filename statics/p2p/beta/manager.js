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
   * @param {Object} [options={}] - 接続オプション
   * @param {"fast"|"reliable"} [options.mode="fast"] - 通信モードの指定
   * @param {Array} [options.iceServers] - カスタムICEサーバー設定
   */
  constructor(serverUrl, roomId, options = {}) {
    this.serverUrl = serverUrl;
    this.roomId = roomId;
    this.iceServers = options.iceServers || [{ urls: "stun:stun.l.google.com:19302" }];
    
    // モードを受け取り保持（デフォルトは "fast"）
    this.mode = options.mode || "fast";

    this.ws = null;
    this.peerConnection = null;
    this.dataChannel = null;
    
    // 初期状態の設定
    this.status = P2PManager.STATUS.IDLE;

    // --- プレイヤー特定用のプロパティ（v2対応） ---
    this.playerNumber = null;         // 1: 1人目(Host), 2: 2人目(Guest)
    this.isHost = false;              // 自分がホスト（1人目の入室者）かどうか

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
    if (this.status !== P2PManager.STATUS.IDLE && this.status !== P2PManager.STATUS.DISCONNECTED) {
      console.warn("[P2PManager] 既に接続処理中、または接続が完了しています。");
      return;
    }

    // 既存リソースを完全に解放して初期化
    this._clearResources();

    this._setupWebRTC();
    this.ws = new WebSocket(`wss://${this.serverUrl}/ws/${this.roomId}`);
    this._setupSignaling();
  }

  /**
   * すべての接続を明示的に終了し、リソースを解放します
   */
  disconnect() {
    this._clearResources();
    this._updateStatus(P2PManager.STATUS.IDLE);
  }

  /**
   * 内部メソッド：接続リソースの完全なクリア
   */
  _clearResources() {
    this.playerNumber = null;
    this.isHost = false;

    if (this.dataChannel) {
      try { this.dataChannel.close(); } catch(e) {}
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      try { this.peerConnection.close(); } catch(e) {}
      this.peerConnection = null;
    }
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        try { this.ws.close(); } catch(e) {}
      }
      this.ws = null;
    }
  }

  /**
   * メイン機能：相手クライアントへ任意のデータを送信します
   * @param {*} customData - 送信するデータ
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
      if (this.status !== P2PManager.STATUS.CONNECTED) {
        this._updateStatus(P2PManager.STATUS.DISCONNECTED);
      }
    };

    this.ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);

        // 【新仕様】サーバー入室時の初期通知
        if (message.type === "welcome") {
          this.playerNumber = message.count;
          this.isHost = (message.count === 1);
          console.log(`[P2PManager] ルームに入室しました。プレイヤー番号: ${this.playerNumber} (Host: ${this.isHost})`);

          // 自分が2人目の場合、1人目（ホスト）に接続準備完了（ready）を通知してWebRTCを開始させる
          if (this.playerNumber === 2) {
            this.ws.send(JSON.stringify({ type: "ready" }));
          }
        } 
        // 2人目が入室したシグナルを1人目（ホスト）が受信したとき
        else if (message.type === "ready") {
          this._updateStatus(P2PManager.STATUS.CONNECTING);
          // Offer（送信）側が指定のモードでデータチャネルを作成
          this._createDataChannel();
          await this._createOffer();
        } 
        else if (message.type === "offer") {
          this._updateStatus(P2PManager.STATUS.CONNECTING);
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp));
          const answer = await this.peerConnection.createAnswer();
          await this.peerConnection.setLocalDescription(answer);
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "answer", sdp: answer }));
          }
        } 
        else if (message.type === "answer") {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp));
        } 
        else if (message.type === "candidate" && message.candidate) {
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
    
    // Answer（受信）側は送られてきたデータチャネルをそのまま受け取る
    this.peerConnection.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this._setupDataChannelEvents(this.dataChannel);
    };
  }

  /**
   * 内部メソッド：Offer側におけるデータチャネルの生成（指定モードによる分岐）
   */
  _createDataChannel() {
    let dcOptions = {};

    if (this.mode === "reliable") {
      dcOptions = { ordered: true };
    } else {
      dcOptions = { ordered: false, maxRetransmits: 0 };
    }

    this.dataChannel = this.peerConnection.createDataChannel("p2pDataChannel", dcOptions);
    this._setupDataChannelEvents(this.dataChannel);
  }

  /**
   * 内部メソッド：データチャネルのイベントリスナー設定
   */
  _setupDataChannelEvents(channel) {
    channel.onopen = () => {
      this._updateStatus(P2PManager.STATUS.CONNECTED);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    };
    
    channel.onclose = () => {
      this._updateStatus(P2PManager.STATUS.DISCONNECTED);
      if (this.onDisconnected) this.onDisconnected("datachannel-closed");
    };
    
    channel.onerror = (event) => this._notifyError("データチャネルでエラーが発生しました", event);

    channel.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch (err) { return; }

      // --- 遅延測定処理 ---
      if (data.type === "ping") {
        channel.send(JSON.stringify({ type: "pong", sentAt: data.sentAt }));
      } else if (data.type === "pong") {
        const now = performance.now();
        const oneWayLatency = (now - data.sentAt) / 2;
        const errorFrame = oneWayLatency / (1000 / 60);

        if (this.onLatencyCalculated) {
          this.onLatencyCalculated(oneWayLatency, errorFrame);
        }
      } 
      // --- 汎用データ処理 ---
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
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "offer", sdp: offer }));
      }
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
