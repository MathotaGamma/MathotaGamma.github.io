class DQN {
  constructor({
    bufferSize = 1000,
    minBufferSize = 0,
    batchSize = 32,
    eta = 0.005,
    gamma = 0.5,
    E = (q, d) => 1/2*(q-d)**2,
    dE = (q, d) => q-d,
    actionType = "random",
  } = {
    bufferSize: 1000,
    batchSize: 32,
    eta: 0.01,
    gamma: 0.5,
    actionType: "random"
  }) {
    this.syncInterval = 500;
    this.simulating = false;
    this.stepCount = 0;
    this.episodeCount = 0;
    this.eta = eta; // 学習率
    this.gamma = gamma;
    this.E = E;
    this.dE = dE;
    this.actionType = actionType
    this.layers = [];
    this.L = this.layers.length;
    this.bufferSize = bufferSize;
    this.minBufferSize = minBufferSize;
    this.batchSize = batchSize;
    this.replayBuffer = [];
  }
  
  static Layer = class {
    constructor(inSize, outSize, { f, df, weightsType, mask }) {
      // typeは今のところ "dense" or "partial"
      this.type = mask == null ? "dense" : "partial";
      this.inSize = inSize == 0 ? null : inSize;
      this.outSize = outSize;
      if(typeof f === "string") {
        switch (f) {
          case "ReLU":
            this.f = (x) => x < 0 ? 0 : x;
            this.df = (x) => x < 0 ? 0 : 1;
            break;
          case "LeakyReLU":
            this.f = (x) => x < 0 ? 0.01 * x : x;
            this.df = (x) => x < 0 ? 0.01 : 1;
            break;
          case "tanh":
            this.f = (x) => Math.tanh(x);
            this.df = (x) => 1-(Math.tanh(x))**2;
            break;
          case "identity":
          case "linear":
            this.f = (x) => x;
            this.df = (x) => 1;
            break;
          default:
            throw new TypeError(
              `Layer constructor: Invalid argument\n - Unknown activation function string '${f}'. Available: 'ReLU', 'LeakyReLU', 'identity ( = linear)'`
            );
        }
      } else if(typeof f === "function") {
        if(typeof df !== "function") throw new TypeError(`Layer constructor: Invalid argument\n - if 'f' is a function, 'df' must be a function too, 'df' got ${typeof df}`);
        this.f = f;
        this.df = df;
      } else {
        throw new TypeError(`Layer constructor: Invalid argument\n - 'f' must be a function or string, got ${typeof f}`);
      }
      this.mask = inSize ? mask ?? Array.from({length: outSize}, (_,j) => 
                 new Array(inSize).fill(1)
               ) : null; // mask[j][i], jは出力のindex
      this.weightsType = weightsType; // "He","random"(<-defalut)
      this.w = this.inSize ? this.initWeights() : null;
      this.bias = this.inSize ? new Array(outSize).fill(0) : null;
    }
    
    initWeights() {
      const type = this.weightsType;
      switch (type) {
        case "He":
          function randn() {
            // Box-Muller法
            const u1 = Math.random();
            const u2 = Math.random();
            return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          }
          const std = Math.sqrt(2 / this.inSize);
          return Array.from({length: this.outSize}, (_,j) =>
            Array.from({length: this.inSize}, (_,i) =>
              randn() * std * (this.mask ? this.mask[j][i] : 1)
            )
          );
          break;
        default:
          return Array.from({length: this.outSize}, (_,j) => 
            Array.from({length: this.inSize}, (_,i) => 
              (Math.random()*0.1-0.05)*(this.mask ? this.mask[j][i] : 1)
            )
          )
        
      }
    }
    
    getWeights() {
      return this.w;
    }
    
    setWeights(w) {
      if(!this.inSize) throw new Error("setWeights : InternalError\n - This layer doesn't have 'inSize'.");
      if(!Array.isArray(w)) throw new Error("setWeights : Invalid argument\n - Input type is not Array.");
      if(!Array.isArray(w[0])) throw new Error("setWeights : Invalid argument\n - Input must be a 2D array (array of arrays)")
      if(w.length != this.outSize) throw new Error(`setWeights : Invalid argument\n  - Input outer length mismatch: expected ${this.outSize}, got ${w.length}`);
      w.forEach((row, j) => {
        if (row.length !== this.inSize) {
          throw new RangeError(`setWeights : Invalid argument\n  - Input array ''Input[${j}]'' inner length mismatch, expected ${this.inSize}, got ${row.length}`);
        }
      });
      
      this.w = structuredClone(w);
    }
    
    forward(x) {
      // 入力層でforwardしたら入力値をそのまま出力値としている
      if(!Array.isArray(x)) throw new Error("forward : Invalid argument\n - Input type is not Array.");
      if(!this.inSize) return {u: x, z: x};
      if(x.length !== this.inSize) throw new Error(`forward : Input length mismatch: expected ${this.inSize}, got ${x.length}`);

      const u = [];
      const z = [];
      for(let j = 0; j < this.outSize; j++) {
        z.push(this.bias[j]);
        for(let i = 0; i < this.inSize; i++) {
          z[j] += x[i] * this.w[j][i] * this.mask[j][i];
        }
        // y[j]はプリミティブ型
        u.push(z[j]);
        z[j] = this.f(u[j]);
      }
      
      return {u, z};
    }
    
    backward(delta1, w1, mask1, u) { // deltaを戻り値とする
      const delta = new Array(this.outSize).fill(0);
      if(w1 == null) { // 出力層
        // delta1[j] = y[j]-d[j]で入力される。
        for(let j = 0; j < this.outSize; j++){
          delta[j] = delta1[j]*this.df(u[j]);
        }
      } else {
        for(let j = 0; j < this.outSize; j++) {
          let sum = 0;
          for(let k = 0; k < delta1.length; k++) {
            sum += delta1[k]*w1[k][j]*mask1[k][j];
          }
          delta[j] = sum * this.df(u[j]);
        }
      }
      
      return delta;
    }
    
    getSize() {
      return this.outSize;
    }
  }
  
  addLayer(units, { f = (x) => x, df = (x) => 1, weightsType="random", mask=null }={}) {
    const inSize = this.L ? this.layers[this.L-1].outSize : null;
    const layer = new DQN.Layer(inSize, units, { f, df, weightsType, mask });
    this.layers.push(layer);
    this.L = this.layers.length;
    return layer;
  }
  
  predict(s) {
    // 入力層でforwardしたら入力値をそのまま出力値としている
    let x = s;
    const z = [];
    const u = [];
    for(let l = 0; l < this.L; l++) {
      let k = this.layers[l].forward(x);
      u.push(k.u);
      x = k.z; // 出力値を次の入力値にする
      z.push(x);
    }
    const q = z[z.length-1];
    return {u, z, q};
  }
  
  storeTransition(s, a, r, s1,done) {
    this.replayBuffer.push({s,a,r,s1,done})
    if(this.replayBuffer.length > this.bufferSize) this.replayBuffer.shift();
  }
  
  selectAction(q, actionType=null) {
    actionType = actionType ?? this.actionType;
    switch (this.actionType) {
      case "epsilon":
        const rand = Math.random();
        if(rand < this.epsilon) {
          this.updateEpsilon("actionRand");
          return Math.floor(q.length*Math.random());
        } else {
          this.updateEpsilon("actionMax");
          return q.indexOf(Math.max(...q));
        }
      case "greedy":
      case "max":
        return q.indexOf(Math.max(...q));
      case "random":
        return Math.floor(q.length*Math.random());
      default:
        throw new Error(`selectAction: Invalid type '${this.actionType}'. Use 'epsilon', 'max ( = greedy)', or 'random'.`);
    }
  }
  
  getBatch() {
    let batch = [];
    const buffer = this.replayBuffer;
    if(buffer.length == 0 || buffer.length <= this.minBufferSize) return [];
    for(let k = Math.min(this.batchSize-1, buffer.length-1); k >= 0; k--) {
      const idx = Math.floor(buffer.length*Math.random());
      batch.push({...buffer[idx]});
    }
    
    return batch;
  }
  
  backPropagation(batch) {
    let delta = [];
    for(let k = 0; k < batch.length; k++) {
      const {s, a, r, s1, done} = batch[k];
      const {u, z, q} = this.predict(s);
      const q1 = this.targetNet.predict(s1).q;
      const d = q.slice(); // ここでqを使うのは、あとで計算するthis.dEで、行動a以外のjでq[j]-d[j] = 0とするため。
      if(!done) d[a] = r + this.gamma*Math.max(...q1);
      else d[a] = r;
      
      let delta1 = q.map((_,j) => this.dE(q[j], d[j]));
      let w1 = null;
      let mask1 = null;
      for(let l = this.L-1; l >= 1; l--) {
        delta.push(delta1);
        const layer = this.layers[l];
        delta1 = layer.backward(delta1, w1, mask1, u[l]);
        for(let j = 0; j < layer.outSize; j++) {
          this.layers[l].bias[j] -= this.eta * delta1[j];
          for(let i = 0; i < layer.inSize; i++) {
            layer.w[j][i] -= this.eta * delta1[j] * z[l-1][i]*layer.mask[j][i];
          }
        }
        w1 = layer.w;
        mask1 = layer.mask;
      }
    }
    
    let w = [];
    for(let l = 1; l < this.L; l++) {
      w.push(this.layers[l].w);
    }
    
    return {delta,w};
  }
  
  mutate(rate = 0.02, scale = 0.01, targetLayer = null) {
    const layers = targetLayer != null ? [this.layers[targetLayer]] : this.layers;
    for (let layer of layers) {
      if (!layer.w) continue;
      for (let j = 0; j < layer.w.length; j++) {
        for (let i = 0; i < layer.w[j].length; i++) {
          if (Math.random() < rate) {
            layer.w[j][i] += (Math.random() * 2 - 1) * scale;
            /*if (isNaN(layer.w[j][i])) {
              layer.w[j][i] = Math.random() * 0.1 - 0.05;
            }*/
          }
        }
      }
    }
  }
  
  initTargetNet() {
    this.targetNet = new DQN({
      bufferSize: this.bufferSize,
      gamma: this.gamma,
      eta: this.eta,
      syncInterval: this.syncInterval
    });

    // 各層を同構造で複製
    for (let l = 0; l < this.L; l++) {
      const layer = this.layers[l];
      const layerCopy = new this.constructor.Layer(layer.inSize, layer.outSize, {
        f: layer.f,
        df: layer.df,
        weightsType: layer.weightsType,
        mask: layer.mask ? layer.mask.map(row => [...row]) : null
      });
      // 重み・バイアスの複製
      if (layer.w) layerCopy.w = layer.w.map(row => [...row]);
      if (layer.bias) layerCopy.bias = [...layer.bias];
      this.targetNet.layers.push(layerCopy);
    }
    this.targetNet.L = this.L;
  }

  // === 定期的にtargetNetへ同期 ===
  updateTargetNet() {
    if (!this.targetNet) return;
    for (let l = 1; l < this.L; l++) {
      const layer = this.layers[l];
      const tLayer = this.targetNet.layers[l];
      for (let j = 0; j < layer.outSize; j++) {
        tLayer.bias[j] = layer.bias[j];
        for (let i = 0; i < layer.inSize; i++) {
          tLayer.w[j][i] = layer.w[j][i];
        }
      }
    }
  }


  
  #step(n, {kind="step", async=false, returnKind=[],preCount=0,preReward=0,limiter=10}={}) {
    let returnList = [];
    let stop = false;
    let count = preCount;
    
    this.initTargetNet();
    
    while(!stop) {
      const Data = {};
      count++;
      
      if(count % this.syncInterval === 0) this.updateTargetNet();
      
      let s = this.s;
      let {u, z, q} = this.predict(s);
      q.forEach((q0) => {
        if (isNaN(q0) || !isFinite(q0)) {
          console.error("NaN detected in Q-values!");
          throw new Error("NaN detected in Q-values!");
        }
      });
      if(this.replayBuffer.length > this.minBufferSize) this.epsilonDecayTf = true;
      
      const a = this.selectAction(q);
      let s1, r, done
      //console.log(count)
      try {
        ({s1, r, done} = this.env({s, a, count, step: this.stepCount, time: (Date.now()-this.startTime)/1000}));
      } catch(err) {
        console.error("Env Error",err.message);
        throw err;
      }
      if(!done) done = false;
      else done = true;
      
      this.storeTransition(s, a, r, s1, done);
      const batch = this.getBatch();
      
      this.mutate(0.02, 0.01);
      const {delta, w} = this.backPropagation(batch);
      
      this.updateEpsilon("step");
      
      Data.count = count;
      if(returnKind.includes("s")) Data.s = s;
      if(returnKind.includes("a")) Data.a = a;
      if(returnKind.includes("r")) Data.r = r;
      if(returnKind.includes("q")) Data.q = q;
      if(returnKind.includes("done")) Data.done = done;
      if(returnKind.includes("u")) Data.u = u;
      if(returnKind.includes("z")) Data.z = z;
      if(returnKind.includes("delta")) Data.delta = delta;
      if(returnKind.includes("w")) Data.w = w;
      if(returnKind.includes("step")) Data.step = this.stepCount;
      if(returnKind.includes("episode")) Data.episode = this.episodeCount;
      if(returnKind.includes("epsilon")) Data.epsilon = this.epsilon;
      if(returnKind.includes("time")) Data.time
= (Date.now()-this.startTime)/1000;
      if(returnKind.includes("totalTime")) Data.totalTime = (Date.now()-this.totalStartTime)/1000;
      
      if(this.onStep) {
        try {
          this.onStep(Data);
        } catch(err) {
          console.error("onStep Error",err.message);
          throw err;
        }
        
      }
      if(returnKind.length) returnList.push(Data);
      
      if(this.rewardList.length < this.episodeCount) this.rewardList.push(0);
      this.rewardList[this.episodeCount-1] += r;
      if(!done) {
        this.s = s1;
        this.stepCount++;
      } else {
        this.s = structuredClone(this.sInit);
        this.stepCount = 1;
        this.updateEpsilon("episode");
        this.episodeCount++;
        this.startTime = Date.now();
        if(kind == "reward" && this.rewardList[this.rewardList.length-1] >= n) stop;
      }
      
      //console.log(kind)
      if(kind == "epsilon" && this.epsilon < n) stop = true;
      if(kind == "episode" && this.episodeCount > n) stop = true;
      if(kind == "step" && count >= n) stop = true;
      if(kind == "time" && (Date.now()-this.totalStartTime)/1000 > n) stop = true;
      if(async) break;
      if(limiter && (Date.now()-this.totalStartTime)/1000 > limiter) {
        console.warn("After "+String(limiter)+" seconds the limiter was activated.")
        break;
      }
    }
    
    if(returnKind.length) return [returnList, stop];
  }
  
  async simulate(delay=10, {returnKind=[]}={}) {
    this.simulating = true;
    let s = structuredClone(this.sInit);
    let count = 1;
    let stepCount = 1;
    let episodeCount = 1;
    this.startTime = Date.now();
    while(this.simulating) {
      let Data = {};
      const { q } = this.predict(s);
      const a = this.selectAction(q, "greedy" );
      let s1, r, done;
      try {
        ({ s1, r, done } = this.env({s, a, count, step: stepCount, time: (Date.now()-this.startTime)/1000}));
      } catch(err) {
        console.error("Env Error",err.message);
        throw err;
      }
      Data.count = count;
      if(returnKind.includes("s")) Data.s = s;
      if(returnKind.includes("a")) Data.a = a;
      if(returnKind.includes("r")) Data.r = r;
      if(returnKind.includes("q")) Data.q = q;
      if(returnKind.includes("done")) Data.done = done;
      if(returnKind.includes("u")) Data.u = null;
      if(returnKind.includes("z")) Data.z = null;
      if(returnKind.includes("delta")) Data.delta = null;
      if(returnKind.includes("w")) Data.w = null;
      if(returnKind.includes("step")) Data.step = stepCount;
      if(returnKind.includes("episode")) Data.episode = episodeCount;
      if(returnKind.includes("epsilon")) Data.epsilon = 0;
      if(returnKind.includes("time")) Data.time = (Date.now()-this.startTime)/1000;
      if(returnKind.includes("totalTime")) Data.totalTime = (Date.now()-this.totalStartTime)/1000;
      
      if(this.onStep) {
        try {
          this.onStep(Data);
        } catch(err) {
          console.error("onStep Error",err.message);
          throw err;
        }
        
      }
      if(!done) {
        s = s1;
        stepCount++;
      } else {
        s = structuredClone(this.sInit);
        stepCount = 0;
        episodeCount++;
        this.startTime = Date.now();
      }
      count++;
      await this.sleep(delay);
    }
  }
    
  sleep(delay) {
    return new Promise(resolve => setTimeout(resolve, delay));
  }
  
  async train(num, {kind="step", delay=0, returnKind = ["s","a","r","q","done","epsilon"], limiter=10}={}) { // kindはstep, episode, epsilon, reward, time
    let result = [];
    this.stepCount = 1;
    this.episodeCount = 1;
    this.s = structuredClone(this.sInit);
    this.rewardList = [0];
    this.startTime = Date.now(); // episode
    this.totalStartTime = Date.now();
    if(delay === 0) {
      result = this.#step(num, {kind, returnKind, limiter})[0];
    } else {
      let preCount = 0;
      while(true) {
        preCount++;
        try {
          const ret = this.#step(num, {kind, async: true, returnKind, preCount: preCount, limiter}); // 同期stepをそのまま呼ぶ
          if(ret[1]) break;
          result.push(ret[0]);
        } catch(err) {
          throw err;
        }
        
        await this.sleep(delay);
      }
    }
    return result;
  }
  
  set setEnv(func) {
    this.env = func;
  }
  
  set setOnStep(func) {
    this.onStep = func;
  }
  
  set setState(s) {
    this.sInit = structuredClone(s);
    this.s = structuredClone(s);
  }
  
  updateEpsilon(state) { // stateはstep,episode,other
    if(this.actionType != "epsilon") return;
    switch (this.epsilonMarginRule) {
      case "step":
        if(this.stepCount < this.epsilonMargin) return;
        break;
      case "episode":
        if(this.episodeCount < this.epsilonMargin) return;
        break;
      case "time":
        if(Date.now() - this.trainStart < 1000*this.epsilonMargin) return;
        break;
    }
    if (this.epsilonDecayRule == "action") {
      if (state == "actionRand" || state == "actionMax") this.epsilon *= this.epsilonDecay;
      
    } else if (this.epsilonDecayRule == state) {
      this.epsilon *= this.epsilonDecay;
    }
  }
  
  setSimulateTF(tf){
    this.simulating = tf;
  }
  
  setEpsilonData({init=1, decay=0.9995, min=0.01, margin=100, marginRule="step", epsilonDecayRule="step"}={}) {
    this.actionType = "epsilon";
    this.epsilonTf = true;
    this.epsilon = init;
    this.epsilonInit = init;
    this.epsilonMin = min;
    this.epsilonDecay = decay;
    this.epsilonMargin = margin;
    this.epsilonMarginRule = marginRule;
    this.epsilonDecayRule = epsilonDecayRule;
  }
  
  getReplayBuffer() {
    return this.replayBuffer;
  }
  
  getLayer(l) {
    return this.layers[l];
  }
  
  getNetwork() {
    return this.layers;
  }
}
