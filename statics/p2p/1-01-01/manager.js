class Transmission {
  static STATUS = {
    IDLE: "IDLE",
    PREPARING: "PREPARING",
    WAITING: "WAITING",
    CONNECTING: "CONNECTING",
    CONNECTED: "CONNECTED",
    DISCONNECTED: "DISCONNECTED"
  }

  constructor(wsUrl, roomId) {
    this.onStatusUpdate = null;
    this.onJoin = null;
    this.onLeave = null;
    this.onDataReceived = null;
    this.status = Transmission.STATUS.IDLE;
    this.myNumber = null;
    
    this.tms = {};
    
    this.wsOriginUrl = `wss://${wsUrl}/ws/`;
    this.roomId = roomId;
  }
  
  statusUpdate(status) {
    this.status = status;
    if (this.onStatusUpdate) this.onStatusUpdate(status);
  }
  
  // method: p2p, mesh, group
  connect(method="p2p") {
    if (this.ws) {
      if (this.status !== Transmission.STATUS.IDLE && this.status !== Transmission.STATUS.DISCONNECTED) return;
      return;
    }
    
    const onError = (message) => {
      console.error(message);
      this.statusUpdate(Transmission.STATUS.DISCONNECTED);
    }
    
    this.statusUpdate(Transmission.STATUS.PREPARING);
    const wsUrl = this.wsOriginUrl+method+'/'+this.roomId;
    this.ws = new WebSocket(wsUrl);
    
    // サーバーからデータを受け取る。
    this.ws.onopen = () => {
      
    }
    this.ws.onmessage = (event) => {
      if (event && event.data) {
        const data = JSON.parse(event.data);
        console.log("受信したdata", event.data);
        
        // 入った人しか受信しない。
        if (data.type === "join") {
          this.myId = null;
          this.statusUpdate(Transmission.STATUS.WAITING);
          if (method === "p2p") {
            console.log("myId", data.id);
            this.myId = data.id;
            
            this.tms = {};
            if (data.list.length === 2) {
              for (const id of data.list) {
                if (id !== data.id) {
                  const tm = new Transmission.P2P(this);
                  this.tms[id] = tm;
                  tm.connect(id, true);
                }
              }
            }
          } else if (method === "mesh") {
            const list = data.list;
            this.myId = data.id;
            this.tms = {};
            if (data.list.length >= 2) {
              for (const id of data.list) {
                if (id !== data.id) {
                  const tm = new Transmission.P2P(this);
                  this.tms[id] = tm;
                  tm.connect(id, true);
                }
              }
            }
          }
        } else if (data.type === "error") {
          onError(data.message);
        } else if (data.type === "new_peer") {
          const id = data.id;
          const tm = new Transmission.P2P(this);
          this.tms[id] = tm;
          tm.connect(id, false); 
        } else if(data.type === "leave") {
          const id = data.id;
          if (method === "p2p") {
            if (Object.keys(this.tms).includes(id)) {
              delete this.tms[id];
              this.statusUpdate(Transmission.STATUS.WAITING);
              if (this.onLeave) this.onLeave(id);
            }
          } else if (method === "mesh") {
            if (Object.keys(this.tms).includes(id)) {
              delete this.tms[id];
              if (Object.keys(this.tms).length === 0) {
                this.statusUpdate(Transmission.STATUS.WAITING);
              }
              if (this.onLeave) this.onLeave(id);
            }
          }
        } else if (["offer", "answer", "candidate"].includes(data.type)) {
          
          if (data.to === this.myId && this.tms[data.from]) {
            this.tms[data.from].handleSignaling(data);
          }
        }
        
      }
    }
    this.ws.onerror = (error) => {
      onError(JSON.stringify(error));
    }
    this.ws.onclose = () => {
      this.statusUpdate(Transmission.STATUS.DISCONNECTED);
    }
  }
  
  sendData(protocol, data, to=null) {
    console.log(this.myId, Object.keys(this.tms));
    if (Object.keys(this.tms).length === 0)
      throw new Error("Error");
    
    if (to !== null) {
      this.tms[to].sendData(protocol, data);
    } else {
      for (const tm of Object.values(this.tms)) {
        console.log(tm);
        tm.sendData(protocol, data);
      }
    }
  }
  
  checkAllConnections() {
    const p2pInstances = Object.values(this.tms);
    if (p2pInstances.length === 0) return;
    // 全てのp2p instanceが開通しているかチェック
    const allConnected = p2pInstances.every(
      tm => tm.dataChannels
             && tm.dataChannels.udp?.readyState === "open"
             && tm.dataChannels.tcp?.readyState === "open"
    );
    
    if (allConnected) this.statusUpdate(Transmission.STATUS.CONNECTED);
  }
  
  clear() {
    // P2P側のリソース解放（RTCPeerConnectionのcloseなど）も今後ここで行う
    if (this.tm && typeof this.tm.clear === "function") {
      this.tm.clear();
    }

    if (this.ws) {
      // メッセージや切断のイベントハンドラを全て抹消して、
      // clear直後に届くかもしれないメッセージを無視させる
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;

      this.ws.close();
      this.ws = null;
    }

    this.statusUpdate(Transmission.STATUS.IDLE);
  }
}

Transmission.P2P = class {
  constructor(parent) {
    this.parent = parent;
    this.targetId = null;
    
    this.peerConnection = null;
    this.candidateQueue = [];
  }

  connect(id, offer) {
    this.parent.statusUpdate(Transmission.STATUS.CONNECTING);
    this.targetId = id;
    
    // STUNサーバーを設定してconnection作成
    this.peerConnection = new RTCPeerConnection({
      iceServers: [{
        urls: "stun:stun.l.google.com:19302"
      }],
    });
    
    // 経路候補を発見した場合のリスナー
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.parent.ws) {
        // targetIdに経路候補を送信
        this.parent.ws.send(JSON.stringify({
          type: "candidate",
          candidate: event.candidate,
          from: this.parent.myId,
          to: this.targetId
        }));
      }
    }
    
    if (offer) {
      this.dataChannels = {
        udp: this.peerConnection.createDataChannel("dataChannel_udp", {
          ordered: false,
          maxRetransmits: 0
        }),
        tcp: this.peerConnection.createDataChannel("dataChannel_tcp", {
          ordered: true
        })
      }
      
      // 今後、各チャンネルの onmessage などを登録する共通処理へ渡す
      this.setupDataChannelHandlers(this.dataChannels.udp);
      this.setupDataChannelHandlers(this.dataChannels.tcp);
  
      // 接続要求を作る
      this.createOffer();
    } else {
      // 入れ物の用意
      this.dataChannels = {}
      
      // offerから来たdatachannel
      // udpとtcpで2回くる
      this.peerConnection.ondatachannel = (event) => {
        const channel = event.channel;
        
        // channel.label: createDataChannelの第一引数
        if (channel.label === "dataChannel_udp")
          this.dataChannels.udp = channel;
        else if (channel.label === "dataChannel_tcp")
          this.dataChannels.tcp = channel;
        
        this.setupDataChannelHandlers(channel);
      }
    }
  }
  
  // channelのイベントハンドラ
  setupDataChannelHandlers(channel) {
    channel.onmessage = (event) => {
      // channelで届いたDataをコールバック関数に渡す。
      if (this.parent.onDataReceived) this.parent.onDataReceived(JSON.parse(event.data));
    }
    channel.onopen = () => {
      console.log("from: "+this.parent.myId+", to: "+this.targetId+" ... channel opened.");
      this.parent.checkAllConnections();
    }
    channel.onclose = () => {
      console.log(`${channel.label} がクローズしました。`);
    }
  }
  
  async createOffer() {
    try {
      // Offer SDP (接続要求書)を作成。
      const offer = await this.peerConnection.createOffer();
      // 自分のLocalDescriptionにofferをセット。
      await this.peerConnection.setLocalDescription(offer);
      
      if (this.parent.ws) {
        // 送信
        this.parent.ws.send(JSON.stringify({
          type: "offer",
          sdp: offer,
          from: this.parent.myId,
          to: this.targetId
        }));
      }
    } catch(error) {
      console.error("Offer 作成失敗")
    }
  }
  
  handleSignaling(data) {
    if (data.type === "offer")
      this.handleOffer(data);
    else if (data.type === "answer")
      this.handleAnswer(data);
    else if (data.type === "candidate")
      this.handleCandidate(data);
  }
  
  // 要求書の受領から応答書の返信まで
  async handleOffer(data) {
    try {
      // 受け取った要求書を相手の情報として保存。
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
      
      // 貯まっていた候補をすべて登録する
      for (const candidate of this.candidateQueue)
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      this.candidateQueue = [];
      
      // 応答書の作成。
      const answer = await this.peerConnection.createAnswer();
      // 自分の情報として保存。
      await this.peerConnection.setLocalDescription(answer);
      if (this.parent.ws)
        // 相手に応答書を送る。
        this.parent.ws.send(JSON.stringify({
          type: "answer",
          from: this.parent.myId,
          to: this.targetId,
          sdp: answer
        }));
    } catch(error) {
      console.error("Offerの処理に失敗しました:", error);
    }
  }
  
  async handleAnswer(data) {
    try {
      // 相手の情報を保存する。
      await this.peerConnection.setRemoteDescription(data.sdp);
      
      // 貯まっていた候補をすべて登録する
      for (const candidate of this.candidateQueue)
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      this.candidateQueue = [];
    } catch(error) {
      console.error("Answerの処理に失敗しました:", error);
    }
  }
  
  async handleCandidate(data) {
    console.log('candidate受信:', data.candidate);
    
    // まだ相手のSDPを登録していなければ、キューに貯めて処理を抜ける
    if (!this.peerConnection.remoteDescription) {
      this.candidateQueue.push(data.candidate);
      return;
    }

    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch(error) {
      console.error("Candidateの追加に失敗しました:", error);
    }
  }
  
  sendData(protocol, data) {
    const channel = this.dataChannels?.[protocol];
    if (channel && channel.readyState === "open") {
      channel.send(JSON.stringify(data));
    } else {
      console.warn(`[${protocol}] チャネルがオープンしていないため、データを送信できませんでした。`);
    }
  }
}
