// P2P Manager
export default class P2PManager {
    constructor(serverUrl, roomId) {
        this.serverUrl = serverUrl;
        this.roomId = roomId;
        this.ws = null;
        this.peerConnection = null;
        this.dataChannel = null;

        // 外部（ゲーム側）からレイテンシ確定時のイベントを受け取るためのコールバック
        this.onLatencyCalculated = null;
        this.onPeerLatencyNotified = null;
        this.onStatusChanged = null;
    }

    // 接続の開始トリガー
    connect() {
        this.ws = new WebSocket(`wss://${this.serverUrl}/ws/${this.roomId}`);
        this._setupSignaling();
    }

    // 内部メソッド：シグナリング処理
    _setupSignaling() {
        this.ws.onopen = () => this._updateStatus("マッチング待機中");
        this.ws.onmessage = async (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'ready') this._createOffer();
            else if (message.type === 'offer') {
                await this.peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp));
                const answer = await this.peerConnection.createAnswer();
                await this.peerConnection.setLocalDescription(answer);
                this.ws.send(JSON.stringify({ type: 'answer', sdp: answer }));
            } else if (message.type === 'answer') {
                await this.peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp));
            } else if (message.type === 'candidate' && message.candidate) {
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
            }
        };
    }

    // 内部メソッド：WebRTC & DataChannel設定
    _setupWebRTC() {
        this.peerConnection = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) this.ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
        };

        // 最速UDPモード
        this.dataChannel = this.peerConnection.createDataChannel("latencyChannel", { ordered: false, maxRetransmits: 0 });
        this._setupDataChannelEvents(this.dataChannel);

        this.peerConnection.ondatachannel = (event) => {
            this.dataChannel = event.channel;
            this._setupDataChannelEvents(this.dataChannel);
        };
    }

    _setupDataChannelEvents(channel) {
        channel.onopen = () => {
            this._updateStatus("P2P直結完了 (超低遅延)");
            this.ws.close(); // サーバーから離脱
        };

        channel.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'ping') {
                channel.send(JSON.stringify({ type: 'pong', sentAt: data.sentAt }));
            } else if (data.type === 'pong') {
                const now = performance.now();
                const oneWayLatency = (now - data.sentAt) / 2;
                const errorFrame = oneWayLatency / (1000 / 60);

                // 外部のコールバック関数にデータを渡す
                if (this.onLatencyCalculated) this.onLatencyCalculated(oneWayLatency, errorFrame);

                // 相手にレポートを再送
                channel.send(JSON.stringify({ type: 'report', latencyMs: oneWayLatency, frame: errorFrame }));
            } else if (data.type === 'report') {
                if (this.onPeerLatencyNotified) this.onPeerLatencyNotified(data.latencyMs, data.frame);
            }
        };
    }

    // 計測開始ボタンなどから呼ばれる公開メソッド
    sendPing() {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(JSON.stringify({ type: 'ping', sentAt: performance.now() }));
        }
    }

    async _createOffer() {
        const offer = await this.peerConnection.createOffer();
        await this.peerConnection.setLocalDescription(offer);
        this.ws.send(JSON.stringify({ type: 'offer', sdp: offer }));
    }

    _updateStatus(status) {
        if (this.onStatusChanged) this.onStatusChanged(status);
    }
}
