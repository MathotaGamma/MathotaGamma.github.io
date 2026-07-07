class Transmission {
  static STATUS = {
    IDLE: "IDLE",
    PREPARING: "PREPARING",
    WAITING: "WAITING",
    CONNECTING: "CONNECTING",
    CONNECTED: "CONNECTED",
    RECONNECTING: "RECONNECTING",
    DISCONNECTED: "DISCONNECTED"
  }

  constructor(wsUrl, roomId) {
    this.onStatusUpdate = null;
    // 開始時
    this.onOpen = null;
    this.onJoin = null;
    this.onLeave = null;
    this.onDataReceived = null;
    this.onLog = null;
    this.onAssignedId = null;
    this.status = Transmission.STATUS.IDLE;
    this.myNumber = null;
    
    this.tms = {};
    
    this.wsOriginUrl = `wss://${wsUrl}/ws/`;
    this.roomId = roomId;
  }
  
  getMyId() {
    return this.myId;
  }
  
  getConnectorIds() {
    return Object.keys(this.tms);
  }
  
  statusUpdate(status) {
    this.status = status;
    if (this.onStatusUpdate) this.onStatusUpdate(status);
  }
  
  // method: p2p, mesh, group
  async connect(method="p2p") {
    
    if (this.ws) {
      if (this.status !== Transmission.STATUS.IDLE && this.status !== Transmission.STATUS.DISCONNECTED) return;
      return;
    }
    
    const onError = (message) => {
      if (this.onLog)
        this.onLog('error', message);
      this.statusUpdate(Transmission.STATUS.DISCONNECTED);
    }
    
    this.statusUpdate(Transmission.STATUS.PREPARING);
    const wsUrl = this.wsOriginUrl+method+'/'+this.roomId;
    this.ws = new WebSocket(wsUrl);
    
    // サーバーからデータを受け取る。
    this.ws.onopen = () => {
      
    }
    this.ws.onmessage = async (event) => {
      if (event && event.data) {
        const data = JSON.parse(event.data);
        if (this.onLog)
          this.onLog('debug', "受信したdata:\n"+event.data);
        
        // 入った人しか受信しない。
        if (data.type === "join") {
          this.myId = null;
          this.statusUpdate(Transmission.STATUS.WAITING);
          if (method === "p2p") {
            if (this.onAssignedId) this.onAssignedId(data.id);
            if (this.onLog)
              this.onLog('debug', "myId: "+data.id);
            this.myId = data.id;
            
            this.tms = {};
            if (data.list.length === 2) {
              for (const id of data.list) {
                if (id !== data.id) {
                  const tm = new Transmission.P2P(this);
                  this.tms[id] = tm;
                  await tm.connect(id, true);
                }
              }
              if (this.onOpen)
                this.onOpen();
            }
          } else if (method === "mesh") {
            if (this.onAssignedId)
              this.onAssignedId(data.id);
            
            const list = data.list;
            this.myId = data.id;
            this.tms = {};
            if (data.list.length >= 2) {
              data.list.filter(id => id !== data.id)
                .map(async (id) => {
                  const tm = new Transmission.P2P(this);
                  this.tms[id] = tm;
                  tm.connect(id, true);
              });
              if (this.onOpen)
                this.onOpen();
            }
          }
        } else if (data.type === "error") {
          onError(data.message);
        } else if (data.type === "new_peer") {
          const id = data.id;
          const tm = new Transmission.P2P(this);
          this.tms[id] = tm;
          await tm.connect(id, false); 
          if (this.onJoin)
            this.onJoin(id);
        } else if(data.type === "leave") {
          const id = data.id;
          
          if (Object.keys(this.tms).includes(id)) {
            if (this.onLog)
              this.onLog('debug', `ユーザー退室処理を開始: ${id}`);
            
            // WebRTC のコネクションを物理的にクローズする
            this.tms[id].close();
            
            // 管理連想配列から削除
            delete this.tms[id];
            
            // コールバック
            if (this.onLeave) this.onLeave(id);
            
            // 残った接続メンバー
            const remainingPeers = Object.keys(this.tms).length;
            if (remainingPeers === 0) {
              // 誰もいなくなったとき
              this.statusUpdate(Transmission.STATUS.WAITING);
            } else {
              // 他の人が残っているとき
              this.checkAllConnections();
            }
            
            if (this.onLog)
              this.onLog('debug', `ユーザー退室処理成功: ${id}`);
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
    if (Object.keys(this.tms).length === 0)
      throw new Error("Error");
    
    if (to !== null) {
      for (const id of to) {
        this.tms[id].sendData(protocol, data);
      }
    } else {
      for (const tm of Object.values(this.tms)) {
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
    
    this.role = null;
    
    this.peerConnection = null;
    this.candidateQueue = [];
  }

  async connect(id, offer) {
    console.log("connect start", this.parent.onLog)
    if (this.parent.onLog)
      this.parent.onLog('debug', "connect started");
    this.role = offer ? "offer" : "answer";
    this.parent.statusUpdate(Transmission.STATUS.CONNECTING);
    this.targetId = id;
    
    // STUNサーバーを設定してconnection作成
    this.peerConnection = new RTCPeerConnection({
      iceServers: [{
        urls: "stun:stun.l.google.com:19302"
      }],
    });
    
    this.peerConnection.onconnectionstatechange = async () => {
      // connected, disconnected(断線&自動で経路再探索), failed(再探索で見つからず完全断線)
      const state = this.peerConnection.connectionState;
      if (this.parent.onLog)
        this.parent.onLog('debug', `P2P 接続ステータス変化 [${this.targetId}]: ${state}`);
      
      if (state === "connected") {
        if (!this.parent.tms[this.targetId]) return;
        
        if (this.parent.onLog)
          this.parent.onLog('debug', `[${this.targetId}] との通信を開始しました。`);
        
        this.parent.checkAllConnections();
      }
      
      // 通信途絶はdisconnectedとなり、軽度の途絶は自動で復旧する。
      if (state === "disconnected" || state === "failed") {
        if (!this.parent.tms[this.targetId]) return;
        
        this.parent.statusUpdate(Transmission.STATUS.RECONNECTING);
        
        if (this.parent.onLog)
          this.parent.onLog('warn', `[${this.targetId}] との通信が途絶しました（状態: ${state}）。`);
      }
      
      // disconnectedの自動復旧ができなかった場合。
      if (state === "failed") {
        if (!this.parent.tms[this.targetId]) return;
        this.parent.statusUpdate(Transmission.STATUS.RECONNECTING);
        if (this.parent.onLog) {
          if (this.role === "offer")
            this.parent.onLog('warn', "接続が失敗しました。ICE Restart を試みます...");
          else if (this.role === "answer")
            this.parent.onLog('warn', "接続が失敗しました。ICE Restart の受信を待機します...");
        }
        if (this.role === "offer") {
          try {
            const offer = await this.peerConnection.createOffer({ iceRestart: true });
            await this.peerConnection.setLocalDescription(offer);
          
            if (this.parent.ws) {
              this.parent.ws.send(JSON.stringify({
                type: "offer",
                sdp: offer,
                from: this.parent.myId,
                to: this.targetId
              }));
            }
          } catch (error) {
            if (this.parent.onLog)
              this.parent.onLog('error', "再接続Offer作成失敗: " + error.message);
          }
        }
      }
    }
    
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
      await this.createOffer();
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
      if (this.parent.onLog)
        this.parent.onLog('debug', "from: "+this.parent.myId+", to: "+this.targetId+" ... channel opened.");
      this.parent.checkAllConnections();
    }
    channel.onclose = () => {
      if (this.parent.onLog)
        this.parent.onLog('debug', `${channel.label} がクローズしました。`);
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
      if (this.parent.onLog)
        this.parent.onLog('error', "Offer 作成失敗")
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
      if (this.parent.onLog)
        this.parent.onLog('error', "Offerの処理に失敗しました: "+error.message);
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
      if (this.parent.onLog)
        this.parent.onLog('error', "Answerの処理に失敗しました: "+error.message);
    }
  }
  
  async handleCandidate(data) {
    // まだ相手のSDPを登録していなければ、キューに貯めて処理を抜ける
    if (!this.peerConnection.remoteDescription) {
      this.candidateQueue.push(data.candidate);
      return;
    }

    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch(error) {
      if (this.parent.onLog)
        this.parent.onLog('error', "Candidateの追加に失敗しました: "+error.message);
    }
  }
  
  sendData(protocol, data) {
    console.log(this.targetId);
    const channel = this.dataChannels?.[protocol];
    if (channel && channel.readyState === "open") {
      channel.send(JSON.stringify(data));
    } else {
      if (this.parent.onLog)
        this.parent.onLog('warn', `[${protocol}] チャネルがオープンしていないため、データを送信できませんでした。`);
    }
  }
  
  // P2Pインスタンスを完全破棄する
  close() {
    if (this.dataChannels) {
      if (this.dataChannels.udp) {
        this.dataChannels.udp.onmessage = null;
        this.dataChannels.udp.onopen = null;
        this.dataChannels.udp.onclose = null;
        this.dataChannels.udp.close();
      }
      if (this.dataChannels.tcp) {
        this.dataChannels.tcp.onmessage = null;
        this.dataChannels.tcp.onopen = null;
        this.dataChannels.tcp.onclose = null;
        this.dataChannels.tcp.close();
      }
    }
    if (this.peerConnection) {
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.ondatachannel = null;
      this.peerConnection.close();
    }
  }
}
