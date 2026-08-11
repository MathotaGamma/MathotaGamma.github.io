/*
new CogniKeel({ inputShape: [84,84,4], 
*/

class Common {
  // inputShapeは一次元配列で低次元からノード数を指定していく。
  constructor() {
    this.onLog = null;
    this.inputShape = null;
    this.seed = 0;
    while (this.seed === 0)
      this.seed = (Math.random() * 4294967296) >>> 0;
    
  }
  
  logger(methodName, message) {
    if (methodName !== undefined && message === undefined) {
      message = methodName;
      methodName = null;
    }
    if (this.onLog) {
      if (methodName)
        this.onLog(`Log: ${this.constructor.name} > ${methodName} ... ${message}`);
      else
        this.onLog(`Log: CogniKeel ... ${message}`);
    }
  }
  
  throwError(methodName, message) {
    throw new Error(`Error: ${this.constructor.name} > ${methodName} ... ${message}`);
  }

  // 疑似乱数生成
  Xorshift32(seed=null) {
    let x = seed==null ? this.seed : seed;

    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.seed = x;
    return x / 4294967296;
  }
  
  showArrayAroundIndex(array, index, size=3) {
    const leftIndex = index-Math.ceil((size-1)/2);
    const rightIndex = index+Math.floor((size-1)/2)+1;
    return `${leftIndex <= 0 ? '' : '... '}${array.subarray(Math.max(leftIndex, 0), Math.min(rightIndex, array.length))}${rightIndex >= array.length ? '' : ' ...'}`;
  }
}

class CogniKeel extends Common {
  #configureArgs;
  #onlineNetwork;
  #targetNetwork;
  #replayBuffer;
  // 例: [84,84,4]...84*84*4の入力(例えば84px*84pxの画像過去4フレーム)
  // orderがC,H,Wでarray[C][H][W]、nullならそのまま
  /*
  modelType: "dqn" | "ddqn"(TD Targetの計算に使う)
  */
  constructor({ inputShape, order=null, replayBufferSize=100000, useWebGL=false, onLog=null, modelType="dqn"}) {
    super();
    if (inputShape == null)
      this.throwError('constructor', '引数にinputShapeが必要です。');
    this.order = order;
    // this.indexesとthis.inputShape設定
    const {indexes, targetShape: convertedInputShape} = this.applyOrder(inputShape);
    this.modelType = modelType;
    this.indexes = indexes;
    this.inputShape = convertedInputShape;
    //this.layers = [];
    this.status = this.constructor.STATUS.UNBUILT;
    this.onLog = onLog;
    this.useWebGL = useWebGL;
    //this.hasOutputLayer = false;
    //this.addLayers([Layer.Input({inputShape: this.inputShape})]);
    this.stepCount = 0;
    
    const onlineNetwork = new Network({ ckInstance: this, inputShape: this.inputShape, onLog: this.onLog, useWebGL: this.useWebGL });
    this.#onlineNetwork = onlineNetwork;
    
    const targetNetwork = new Network({ ckInstance: this, inputShape: this.inputShape, onLog: this.onLog, useWebGL: this.useWebGL });
    this.#targetNetwork = targetNetwork;
    
    this.#replayBuffer = new ReplayBuffer(replayBufferSize);
  }
  
  static STATUS = {
    // 適切な層の形状構成待ち(Input,OutputLayerひとつずつ)
    UNBUILT: 'unbuilt',
    // 初期化待ち
    UNINITIALIZED: 'uninitialized',
    // NNなどを初期化中
    INITIALIZING: 'initializing',
    // いつでも学習開始できる状態(待機)
    READY: 'ready',
    // 学習中(順伝播、推論、逆伝播、環境更新){ inputShape, order, onLog=null }
    LEARNING: 'learning',
    // 環境更新、推論中
    IDLE: 'idle'
  }
  
  statusUpdate(status) {
    const nextStatus = this.constructor.STATUS[status];
    if (nextStatus == null)
      this.throwError('statusUpdate', `存在しないSTATUSに更新しようとしています(STATUS: ${status})。`);
    this.logger('statusUpdate', `STATUSが${this.status}から${nextStatus}に更新されました。`);
    this.status = nextStatus;
  }
  
  setLogger(logger) {
    this.onLog = logger;
    this.#onlineNetwork.setLogger(logger);
    this.#targetNetwork.setLogger(logger);
  }
  
  setIsCheck(bool) {
    this.isCheck = bool;
    this.#onlineNetwork.setIsCheck(bool);
    this.#targetNetwork.setIsCheck(bool);
  }
  
  // 設定
  configure(args) {
    // 1. すべてのデフォルト値を1つのオブジェクトとして定義
    const defaults = {
      useWebGL: false,
      learningRate: 0.001,
      gamma: 0.99,
      batchSize: 32,
      replayBufferSize: 100000,
      minReplayBufferLength: 1000,
      optimizer: {
        type: 'adam',
        beta1: 0.9,
        beta2: 0.999,
        epsOpt: 1e-8
      },
      loss: {
        type: 'huber',
        delta: 1.0
      },
      gradientClipNorm: 10.0,
      epsilonStart: 1.0,
      epsilonEnd: 0.01,
      epsilonDecay: {
        type: "linear",
        steps: 100000
      }
    };

    // 2. 引数 args で上書きされた安全な convertedArgs を生成
    const input = args ?? {};
    const convertedArgs = {
      ...defaults,
      ...input,
      optimizer: { ...defaults.optimizer, ...input.optimizer },
      loss: { ...defaults.loss, ...input.loss },
      epsilonDecay: { ...defaults.epsilonDecay, ...input.epsilonDecay }
    };
    this.#configureArgs = convertedArgs;
    
    if (this.status !== this.constructor.STATUS.UNBUILT && this.status !== this.constructor.STATUS.UNINITIALIZED) {
      this.logger('configure', 'Warn: STATUSがUNBUILTまたはUNINITIALIZEDの時のみ、configureを実行できます。');
      return;
    }
    this.useWebGL = convertedArgs.useWebGL;
    
    this.learningRate = convertedArgs.learningRate;
    this.gamma = convertedArgs.gamma;
    this.batchSize = convertedArgs.batchSize;
    this.replayBufferSize = convertedArgs.replayBufferSize;
    this.minReplayBufferLength = convertedArgs.minReplayBufferLength;
    this.optimizer = convertedArgs.optimizer;
    this.loss = convertedArgs.loss;
    this.gradientClipNorm = convertedArgs.gradientClipNorm;

    this.epsilonStart = convertedArgs.epsilonStart;
    this.epsilonEnd = convertedArgs.epsilonEnd;
    this.epsilonDecay = convertedArgs.epsilonDecay;
    
    // これらの値を用いた設定
    this.epsilon = this.epsilonStart;
    // バグ修正: 以前はここで this.#replayBuffer.configure(this.minReplayBufferLength) を
    // 呼んでおり、ReplayBufferのcapacity(リングバッファの容量、デフォルト100000)を
    // 誤ってminReplayBufferLength(学習を開始する最低経験数、デフォルト1000)で
    // 上書きしてしまっていた。結果、経験は直近1000件しか保持されず、
    // 経験の多様性が失われて学習が不安定になっていた。
    // capacityはconstructor時のreplayBufferSizeのまま維持する(configureでは変更しない)。
    // オプティマイザの保持
    const opt = this.optimizer;
    this.optimizerType = opt.type;
    const optimizerFunc = this.constructor.optimizers[opt.type];
    switch (opt.type) {
      /*
      {
        type: 'sgd'
      }
      */
      case "sgd":
        this.optimizerFunc = (theta, g) => optimizerFunc(theta, g, this.learningRate);
        break;
      /*
      {
        type: 'momentum',
        // momentum係数
        alpha: 0.9
      }
      */
      case "momentum":
        this.optimizerFunc = (v, theta, g) => optimizerFunc(v, opt.alpha, theta, g, this.learningRate, opt.epsOpt);
        break;
      /*
      {
        type: "rmsprop",
        beta: 0.9
      }
      */
      case "rmsprop":
        this.optimizerFunc = (v, theta, g) => optimizerFunc(opt.beta, v, theta, g, this.learningRate, opt.epsOpt);
        break;
      /*
      {
        type: 'adam',
        // 一次モーメントの係数
        beta1: 0.9,
        // 二次モーメントの係数
        beta2: 0.999,
        // 零除算を避けるための微小な値
        epsOpt: 1e-8
      }
      */
      case "adam":
        this.optimizerFunc = (powBeta1, powBeta2, m, v, theta, g) => optimizerFunc(opt.beta1, opt.beta2, powBeta1, powBeta2, m, v, theta, g, this.learningRate, opt.epsOpt);
        break;
    }
    // 誤差関数を保持
    const lossFuncs = this.constructor.lossFuncs[this.loss.type];
    switch (this.loss.type) {
      case 'mse':
        this.lossFunc = (td, y) => lossFuncs.func(td, y);
        this.lossPrimeFunc = (td, y) => lossFuncs.primeFunc(td, y);
        break;
      case 'huber':
        this.lossFunc = (td, y) => lossFuncs.func(td, y, this.loss.delta);
        this.lossPrimeFunc = (td, y) => lossFuncs.primeFunc(td, y, this.loss.delta);
        break;
      case 'mae':
        this.lossFunc = (td, y) => lossFuncs.func(td, y);
        this.lossPrimeFunc = (td, y) => lossFuncs.primeFunc(td, y);
        break;
    }
    
    const networkConfigArgs = {
      useWebGL: convertedArgs.useWebGL,
      optimizerType: opt.type,
      optimizerFunc: this.optimizerFunc,
      gradientClipNorm: this.gradientClipNorm
    }
    this.#onlineNetwork.configure(networkConfigArgs);
    this.#targetNetwork.configure(networkConfigArgs);
    
    this.logger('configure', '設定を変更しました。');
  }
  
  /*
    theta...更新するパラメータ(重み)
    g...勾配
    eta...学習率
    epsilon...零除算を防ぐための微小な値
  */
  static optimizers = {
    // θ(t+1)=θ_t-η∇
    "sgd": (theta, g, eta, epsilon) => [theta-eta*g],
    /*
      慣性を取り入れた
      v_(t+1) = αv_t+η∇,
      θ_(t+1) = θ_t-v_(t+1)
    */
    "momentum": (v, alpha, theta, g, eta, epsilon) => {
      const retV = alpha*v+eta*g;
      // v_(t+1), θ_(t+1)
      return [retV, theta-retV];
    },
    /*
      v_(t+1) = βv_t+(1-β)g^2,
      θ_(t+1) = θ_t-ηg/(√v_(t+1) +ε)
    */
    "rmsprop": (beta, v, theta, g, eta, epsilon) => {
      const retV = beta*v+(1-beta)*g*g;
      return [retV, theta-eta*g/(Math.sqrt(retV)+epsilon)];
    },
    /*
      m_(t+1) = β_1 m_t+(1-β_1)∇,
      v_(t+1) = β_2 v_t+(1-β_2)∇^2,
      m, vのtが小さい時の補正を計算。
      β^tの計算の代わりにpowBetaで毎回掛け算する。
      m^_(t+1) = m_(t+1)/(1-β_1^t),
      v^_(t+1) = v_(t+1)/(1-β_2^t),
      θ_(t+1) = θ_t-ηm^_(t+1)/(√v^_(t+1) +ε)
    */
    "adam": (beta1, beta2, powBeta1, powBeta2, m, v, theta, g, eta, epsilon) => {
      const retM = beta1*m+(1-beta1)*g;
      const retV = beta2*v+(1-beta2)*g*g;
      const retPowBeta1 = powBeta1*beta1;
      const retPowBeta2 = powBeta2*beta2;
      const mAdjust = retM/(1-retPowBeta1);
      const vAdjust = retV/(1-retPowBeta2);
      return [
        retPowBeta1, retPowBeta2, retM, retV,
        theta-eta*mAdjust/(Math.sqrt(vAdjust)+epsilon)
      ];
    }
  }
  
  // 選んだ行動以外には損失関数は利用しない
  static lossFuncs = {
    // 二乗誤差
    "mse": {
      func: (td, y) => (td-y)*(td-y)/2,
      primeFunc: (td, y) => y-td
    },
    // Huber損失(mse,maeの組み合わせ)
    "huber": {
      func: (td, y, delta) => {
        const dif = td-y;
        const diff = dif*dif;
        if (diff > delta*delta)
          return delta*(Math.abs(dif)-delta/2);
        else
          return diff/2;
      },
      primeFunc: (td, y, delta) => {
        const dif = y-td;
        if (Math.abs(dif) > delta)
          // ※∂L/∂Q=∂L/∂σ*∂σ/∂Qより、td-y,y-tdどちらでも結果は同じ。
          return delta*Math.sign(dif);
        else
          return dif;
      }
    },
    // 絶対誤差
    "mae": {
      func: (td, y) => Math.abs(td-y),
      // ※∂L/∂Q=∂L/∂σ*∂σ/∂Qより、td-y,y-tdどちらでも結果は同じ。
      primeFunc: (td, y) => Math.sign(y-td)
    }
  }
  
  addLayers(layers) {
    this.#onlineNetwork.addLayers(layers);
    const newLayers = new Array(layers.length);
    for (let index = 0; index < layers.length; index++) {
      newLayers[index] = layers[index].clone();
    }
    this.#targetNetwork.addLayers(newLayers);
  }
  
  initialize() {
    if (this.status !== this.constructor.STATUS.UNINITIALIZED) {
      this.logger('initialize', '初期化はstatusが'+this.constructor.STATUS.UNINITIALIZED+'時に行う必要があります。');
      return;
    }
    this.statusUpdate('INITIALIZING');
    this.#onlineNetwork.initialize();
    this.#targetNetwork.initialize();
    this.statusUpdate('READY')
  }
  
  // まだ完成していない
  // precisionは、full, high, medium, low, lower, leastで、重みなどの保存桁数を指定する
  getMCLM(precision='high') {
    let content = '';
    function getHeader({ precision, configureArgs, optimizer }) {
      return `precision ${precision}
configure ${configureArgs}`
    }
    
    content += getHeader({
      precision,
      configureArgs: JSON.stringify(this.#configureArgs)
    });
    
    const layers = this.#onlineNetwork.layers;
    
    for (const layer of layers) {
      content += '\n\n#' + layer.getKind() + '\n';
      const miniMCLMList = layer.toMCLM(precision);
      for (const miniMCLM of Object.keys(miniMCLMList)) {
        let miniMCLMData = miniMCLMList[miniMCLM];
        if (Array.isArray(miniMCLMData))
          miniMCLMData = miniMCLMData.join(' ');
        content += miniMCLM + ' ' + miniMCLMData + '\n';
      }
    }
    
    return content;
  }
  
  getOutputs(type="object") {
    return this.#onlineNetwork.getOutputs(type);
  }
  
  getInfo(type="object") {
    return this.#onlineNetwork.getInfo(type);
  }
  
  getWeight({
    // "online" | "target"
    networkType="online",
    // 層のインデックス。非負整数
    layerIndex,
    // "weight" | "bias"
    weightType="weight",
    // 重み(またはバイアス)のインデックス。非負整数
    weightIndex
  })
  {
    let network;
    if (networkType === "online")
      network = this.#onlineNetwork;
    else if (networkType === "target")
      network = this.#targetNetwork;
    let weightTypeKey;
    if (weightType === "weight")
      weightTypeKey = "weights";
    else if (weightType === "bias")
      weightTypeKey = "biases";
    return network.layers[layerIndex][weightTypeKey][weightIndex];
  }
  
  applyOrder(shape) {
    const order = this.order;
    if (order === null) {
      const totalLength = shape.reduce((acc,cur) => acc*cur, 1);
      const indexes = new Int32Array(totalLength);
      for (let index = 0; index < totalLength; index++)
        indexes[index] = index;
      return {
        indexes,
        targetShape: shape
      }
    }
    const ndim = order.length;
    
    
    const targetOrder = ({
      2: ["W", "C"],
      3: ["H", "W", "C"],
      4: ["D", "H", "W", "C"]
    })[ndim];

    // 元の多次元配列における各軸のストライド（1歩あたりの要素数）を計算
    // 例: shape=[3,2,4] order=[H,C,W] -> strides=[8, 4, 1]
    const strides = new Array(ndim);
    let acc = 1;
    for (let i = ndim - 1; i >= 0; i--) {
      strides[i] = acc;
      acc *= shape[i];
    }

    // targetOrder 順に見た時の各軸の「サイズ」と「元のストライド」を揃える
    const targetShape = new Array(ndim);
    const targetStrides = new Array(ndim);

    for (let i = 0; i < ndim; i++) {
      const axis = targetOrder[i];
      const origIdx = order.indexOf(axis);
      if (origIdx == -1)
        this.throwError('applyOrder', `orderに軸 '${axis}' が見つかりません。`);
      targetShape[i] = shape[origIdx];
      targetStrides[i] = strides[origIdx];
    }

    // 全要素数分のインデックス配列を作成
    const totalLength = shape.reduce((acc,cur) => acc*cur, 1);
    const indexes = new Int32Array(totalLength);

    // targetOrderのループを回して元の多次元インデックスに対応するフラットインデックスを生成
    // カウンター currentIndices = [h, w, c] を [0, 0, 0] からスタート
    const currentIndices = new Array(ndim).fill(0);
    for (let i = 0; i < totalLength; i++) {
      // 現在の target 順のインデックスから、元のフラットインデックスを計算
      let flatIndex = 0;
      // h,w,cとstridesを掛け合わせて各次元分足す
      for (let d = 0; d < ndim; d++)
        flatIndex += currentIndices[d] * targetStrides[d];
      indexes[i] = flatIndex;

      // target 順で次元を1あげる
      for (let d = ndim - 1; d >= 0; d--) {
        currentIndices[d]++;
        // 桁上げをせず終了
        if (currentIndices[d] < targetShape[d])
          break;
        // 桁上げ
        currentIndices[d] = 0;
      }
    }

    return {indexes, targetShape}
  }
  
  step(state) {
    // 現在の状態に対するonline Q-Tableの出力を得る
    
    const actions = this.#forward({
      inputs: state,
      batchSize: 1,
      isPreserve: true,
      isLearn: true,
    });
    
    if (actions == null)
      this.throwError('step', '#forwardの戻り値が不正です。')
    
    // epsilon Greedy法で行動を決める
    const action = this.#epsilonGreedy({
      actions,
      forceEpsilon: null,
    });
    
    if (action == null || !Number.isFinite(action))
      this.throwError('step', `#epsilonGreedyの戻り値が不正です。action: ${action}, actions: ${actions.join(' ')}`);
    
    // ここで一度返す。
    // ck.rememberをクラス外で実行するため、
    // 別のメソッドに分割する。
    
    return { action, actions }
  }
  
  // valueチェックもする
  evaluationStep(state) {
    if (!(state instanceof Float32Array))
      this.throwError('evaluationStep', '入力のstateはFloat32Arrayの必要があります。');
    // 現在の状態に対するonline Q-Tableの出力を得る
    const actions = this.#forward({
      inputs: state,
      batchSize: 1,
      isPreserve: false,
      isLearn: false,
    });
    
    if (actions == null || actions.includes(NaN))
      this.throwError('evaluationStep', '#forwardの戻り値がnull相当か、NaNが含まれています。')
    
    // epsilon Greedy法で行動を決める
    const action = this.#epsilonGreedy({
      actions,
      forceEpsilon: 0
    });
    
    if (action == null || !Number.isInteger(action))
      this.throwError('evaluationStep', '#epsilonGreedyの戻り値がnull相当か、整数値でありません。');
    
    // ここで一度返す。
    // ck.rememberをクラス外で実行するため、
    // 別のメソッドに分割する。
    
    return { action, actions };
  }
  
  remember({
    // 現在の状態
    state,
    // 取った行動
    action,
    // 得た報酬
    reward,
    // 次の状態
    nextState,
    // episode終了かどうか
    done
  })
  {
    this.#replayBuffer.add(structuredClone({
      state, action, reward, nextState, done
    }));
  }
  
  #forward({
    inputs, batchSize,
    // ReplayBufferに保存するか
    isPreserve,
    // 学習するか
    isLearn
  })
  {
    // batchSize...学習時のデータ数
    // nullなら推論。
    
    // 入力の順番をD,H,W,C(or H,W,C)(or W,C)に変える。
    const totalInputLength = this.inputShape.reduce((acc, cur) => acc*cur, 1);
    inputs = inputs instanceof Float32Array ? inputs : new Float32Array(inputs.flat(Infinity));
    if (inputs.length != totalInputLength*batchSize)
      this.throwError('#forward', `入力の要素数が一致しません。期待値: ${totalInputLength*batchSize}, 実際の値: ${inputs.length}`);
    
    const convertedInputs = new Float32Array(totalInputLength*batchSize);
    const indexes = this.indexes;
    if (totalInputLength !== indexes.length)
      this.throwError('forward', `constructor時に自動定義されるindexesの長さがinputShapeに適合しません。期待値: ${totalInputLength*batchSize}, 実際の値: ${inputs.length*batchSize}`);
    
    // 高速化: 元は ind%totalInputLength と Math.floor(ind/totalInputLength) を
    // 全要素で計算していたが、剰余・除算は重いのでbatchループの二重forに変更。
    // batchSize=1の場合(step/evaluationStep/predict)は特にオーバーヘッドが丸ごと消える。
    let writeIdx = 0;
    for (let b = 0; b < batchSize; b++) {
      const batchOffset = b * totalInputLength;
      for (let i = 0; i < totalInputLength; i++) {
        convertedInputs[writeIdx++] = inputs[indexes[i] + batchOffset];
      }
    }
    
    const ret =  this.#onlineNetwork.forward({ inputs: convertedInputs, batchSize });
    if (this.isCheck && ret.findIndex(value => value == null || Number.isNaN(value)) !== -1)
      this.throwError('#forward', '戻り値に無効な値が含まれています。');
    return ret;
  }
  
  #targetForward({
    inputs, batchSize,
    // ReplayBufferに保存するか
    isPreserve,
    // 学習するか
    isLearn
  })
  {
    // batchSize...学習時のデータ数
    // nullなら推論。
    
    // 入力の順番をD,H,W,C(or H,W,C)(or W,C)に変える。
    const totalInputLength = this.inputShape.reduce((acc, cur) => acc*cur, 1);
    inputs = inputs instanceof Float32Array ? inputs : new Float32Array(inputs.flat(Infinity));
    if (inputs.length != totalInputLength*batchSize)
      this.throwError('#forward', `入力の要素数が一致しません。期待値: ${totalInputLength*batchSize}, 実際の値: ${inputs.length}`);
    
    const convertedInputs = new Float32Array(totalInputLength*batchSize);
    const indexes = this.indexes;
    if (totalInputLength !== indexes.length)
      this.throwError('forward', `constructor時に自動定義されるindexesの長さがinputShapeに適合しません。期待値: ${totalInputLength*batchSize}, 実際の値: ${inputs.length*batchSize}`);
    
    // 高速化: 元は ind%totalInputLength と Math.floor(ind/totalInputLength) を
    // 全要素で計算していたが、剰余・除算は重いのでbatchループの二重forに変更。
    // batchSize=1の場合(step/evaluationStep/predict)は特にオーバーヘッドが丸ごと消える。
    let writeIdx = 0;
    for (let b = 0; b < batchSize; b++) {
      const batchOffset = b * totalInputLength;
      for (let i = 0; i < totalInputLength; i++) {
        convertedInputs[writeIdx++] = inputs[indexes[i] + batchOffset];
      }
    }
    
    const ret =  this.#targetNetwork.forward({ inputs: convertedInputs, batchSize });
    if (this.isCheck && ret.findIndex(value => value == null || Number.isNaN(value)) !== -1)
      this.throwError('#forward', '戻り値に無効な値が含まれています。');
    return ret;
  }
  
  predict(inputs) {
    if (this.status !== this.constructor.STATUS.READY) {
      this.logger('predict', 'Warn: 初期化を完了させてください。');
      return;
    }
    
    this.statusUpdate('IDLE');
    
    const result = this.#forward({
      inputs,
      batchSize: 1,
      isPreserve: false,
      isLearn: false,
      isEvaluate: true
    })
    this.statusUpdate('READY');
    return result;
  }
  
  // this.epsilonを関数内部で更新するため、epsilonなどの変数は渡さない。
  #epsilonGreedy({
    // onlineQTableで出力した値のリスト
    actions,
    // epsilonをこのstepだけある値に矯正する場合に使用。それ以外はnull
    forceEpsilon=null,
  })
  {
    const rand = this.Xorshift32();
    if (forceEpsilon === null) {
      const epsilonDecay = this.epsilonDecay;
      if (epsilonDecay.type !== "exponential" && epsilonDecay.type !== "linear")
        this.throwError("epsilonGreedy", "configureでの引数のepsilonDecayが持つ「type」キーは'linear'もしくは'exponential'のいずれかの必要があります。");
      
      if (epsilonDecay.type === "exponential")
        this.epsilon = Math.max(this.epsilonEnd, this.epsilon*epsilonDecay.rate);
      else if(epsilonDecay.type === "linear")
        this.epsilon = Math.max(this.epsilonEnd, this.epsilon-(this.epsilonStart-this.epsilonEnd)/epsilonDecay.steps);
      
      if (rand > this.epsilon) {
        if (actions.length === 0) return null;
  
        let maxIdx = 0;
        let maxVal = actions[0];
  
        for (let i = 1; i < actions.length; i++) {
          if (actions[i] > maxVal) {
            maxVal = actions[i];
            maxIdx = i;
          }
        }
        return maxIdx;
      } else {
        if (actions.length === 0)
          return null;
        return Math.floor(actions.length*this.Xorshift32());
      }
    } else if (Number.isFinite(forceEpsilon)) {
      const epsilon = forceEpsilon;
      
      if (rand > epsilon) {
        if (actions.length === 0) return null;
  
        let maxIdx = 0;
        let maxVal = actions[0];
  
        for (let i = 1; i < actions.length; i++) {
          if (actions[i] > maxVal) {
            maxVal = actions[i];
            maxIdx = i;
          }
        }
        return maxIdx;
      } else {
        if (actions.length === 0)
          return null;
        return Math.floor(actions.length*this.Xorshift32());
      }
    }
  }
  
  updateTargetNetwork() {
    const weights = this.#onlineNetwork.getWeights();
    this.#targetNetwork.setWeights(weights);
  }
  
  // batchSizeなどはconfigureで決めている
  /*
  this.batchSize分のバッチで学習する。
  */
  learn(args=null) {
    let isCustom;
    if (args !== null) {
      if (args.state == null || args.action == null || args.reward == null || args.nextState == null || args.done == null)
        this.throwError('learn', 'learnの引数に渡す場合、Object型でstate,actions,reward,nextState,doneのkeyが必要です。');
      args = structuredClone(args);
      args.action = new Uint32Array([args.action]);
      args.reward = new Float32Array([args.reward]);
      args.done = new Uint32Array([args.done ? 1 : 0]);
      isCustom = true;
    }
    if (!isCustom && this.#replayBuffer.length < this.minReplayBufferLength)
      return {
        ok: true,
        done: false,
        message: `経験が、指定した学習に必要な最低量 に足りていません。(経験数: ${this.#replayBuffer.length}, 最低量: ${this.minReplayBufferLength})`
      }
    const batchSize = isCustom ? 1 : this.batchSize;
    const sampledReplays = isCustom ? args : this.#replayBuffer.sample(batchSize);
    const stateLength = this.totalInputLength;
    if (this.isCheck && sampledReplays.nextState.findIndex(value => value == null || Number.isNaN(value)) !== -1)
      this.throwError('learn', `sampledReplays.nextStateに無効な値(NaN, null相当)が含まれています。nextState: ${sampledReplays.nextState.join(',')}`);
    // 次の状態における全てのQ値を取得
    
    let nextActions;
    let expectedValue;
    let onlineArgsContainer;
    const modelType = this.modelType;
    if (modelType === "dqn") {
      nextActions = this.#targetForward({
        inputs: sampledReplays.nextState,
        batchSize
      });
      if (this.isCheck && nextActions.findIndex(value => value == null || Number.isNaN(value)) !== -1)
        this.throwError('learn', `nextActionsに無効な値(NaN, null相当)が含まれています。`);
    }
    else if (modelType === "ddqn") {
      nextActions = this.#forward({
        inputs: sampledReplays.nextState,
        batchSize
      });
      if (this.isCheck && nextActions.findIndex(value => value == null || Number.isNaN(value)) !== -1)
        this.throwError('learn', `nextActionsに無効な値(NaN, null相当)が含まれています。`);
      onlineArgsContainer = this.#targetForward({
        inputs: sampledReplays.nextState,
        batchSize
      });
    }

    
    const actions = this.#forward({
      inputs: sampledReplays.state,
      batchSize
    })
    
    const gamma = this.gamma;
    const outputLength = actions.length/batchSize;
    const lossFunc = this.lossFunc;
    const lossPrimeFunc = this.lossPrimeFunc;
    const layers = this.#onlineNetwork.layers;
    const layerLength = layers.length;
    let outputOffset = 0;
    let batchIdx=0;
    let action;
    let reward;
    // TDターゲット
    let tdTarget;
    // TD誤差
    // let tdError;
    // TD誤差の微分
    let tdErrorPrime;
    // stateは要らない(すでに使った)
    const actionList = sampledReplays.action;
    const rewardList = sampledReplays.reward;
    // nextStateListは要らない(すでに使った)
    const doneList = sampledReplays.done;
    
    let duList = new Float32Array(outputLength*batchSize);
    let maxVal;
    let val;
    let maxIdx;
    // バッチ毎に計算
    for (; batchIdx < batchSize; batchIdx++) {
      // ===== TD誤差(損失)を求める =====
      reward = rewardList[batchIdx];
      action = actionList[batchIdx];
      // ddqnは上で求めてる
      if (modelType === "dqn")
        expectedValue = Math.max(...nextActions.subarray(outputOffset, outputOffset+outputLength));
      else if (modelType === "ddqn") {
        maxVal = -Infinity;
        maxIdx = -1;
        for (let idx = 0; idx < outputLength; idx++) {
          val = nextActions[outputOffset+idx];
          if (maxVal < val) {
            maxVal = val;
            maxIdx = idx;
          }
        }
        expectedValue = onlineArgsContainer[outputOffset+maxIdx];
      }
        
      tdTarget = reward + (1-doneList[batchIdx]) * gamma * expectedValue;
      
      if (tdTarget == null || Number.isNaN(tdTarget))
        this.throwError('learn', `tdTargetが無効な値です(NaN, null相当)。reward: ${reward}, gamma: ${gamma}`);
      
      // 実際にとった行動に対するQ値
      const q = actions[batchIdx * outputLength + action];
      
      // TD誤差(=Loss)
      // tdError = lossFunc(tdTarget, q);
      // TD誤差の微分
      tdErrorPrime = lossPrimeFunc(tdTarget, q);
      if (tdErrorPrime == null || Number.isNaN(tdErrorPrime))
        this.throwError('learn', `tdErrorPrimeが無効な値です(NaN, null相当)。tdTarget: ${tdTarget}, q: ${q}, action: ${action}`);
      duList[outputOffset+action] = tdErrorPrime;
      outputOffset += outputLength;
    }
    
    // ===== 逆伝播 =====
    for (let layerIdx = layerLength-1; layerIdx >= 0; layerIdx--) {
      const layer = layers[layerIdx];
      duList = layer.backward(duList, batchSize);
    }
    
    return {
      ok: true,
      done: true,
    }
  }
}

// 経験バッファ
/*
{ state, action, reward, nextState, done }
を配列に保存する。
配列の長さがreplayBufferSizより大きければ
古い経験から捨てていく。(indexを循環させることで古い経験が捨てられる。)
*/
class ReplayBuffer extends Common {
  constructor(config) {
    super();
    this.configure(config);
    // SoAで保存。
    const capacity = this.capacity;
    this.state = new Array(capacity);
    this.action = new Uint32Array(capacity);
    this.reward = new Float32Array(capacity);
    this.nextState = new Array(capacity);
    // true...1, false...0
    this.done = new Uint8Array(capacity);
    
    // 次に保存するindex
    this.index = 0;
    // 保存されている経験の数
    this.length = 0;
  }
  
  // replayBufferSizeを決定する
  configure(capacity) {
    this.capacity = capacity
  }
  
  // 配列に経験を保存し、index,lengthを更新する。
  // indexが最後まで行ったら0に戻る。
  add(replay) {
    if (!this.capacity || !Number.isInteger(this.capacity) || this.capacity <= 0)
      this.throwError('remember', 'configureで設定するcapacityは自然数の値を要求します。現在は不正な値が入っています。');
    const index = this.index;
    this.state[index] = replay.state;
    this.action[index] = replay.action;
    this.reward[index] = replay.reward;
    this.nextState[index] = replay.nextState;
    this.done[index] = replay.done ? 1 : 0;
    
    this.index = (index+1)%this.capacity;
    this.length = Math.min(this.length+1, this.capacity);
  }
  
  // replayBufferからbatchSize分の経験を取得する。
  sample(batchSize) {
    if (this.length === 0)
      return null;
    const length = this.length;
    let rand;
    let index;
    let count = 0;
    // state, nextStateはくっつけて渡す
    const stateLength = this.state[0].length;
    const state = new Float32Array(batchSize*stateLength);
    const action = new Uint32Array(batchSize);
    const reward = new Float32Array(batchSize);
    const nextState = new Float32Array(batchSize*stateLength);
    const done = new Uint8Array(batchSize);
    
    let stateOffset = 0;
    for (; count < batchSize; count++) {
      rand = this.Xorshift32();
      index = Math.floor(length*rand);
      state.set(this.state[index], stateOffset);
      action[count] = this.action[index];
      reward[count] = this.reward[index];
      nextState.set(this.nextState[index], stateOffset);
      done[count] = this.done[index];
      
      stateOffset += stateLength;
    }
    
    return {
      state,
      action,
      reward,
      nextState,
      done
    };
  }
}

// ニューラルネットワーク関連
/*
initializeで初期化して、
addLayersで層を追加。
forwardで順伝播を行なってactions(結果全て)を返す。
onlineNetworkでgetWeightsをして、それをtargetNetworkにsetWeightsすることで
同期する。
*/
class Network extends Common {
  constructor({ ckInstance, inputShape, useWebGL=false, onLog=null }) {
    super();
    this.ckInstance = ckInstance;
    this.inputShape = inputShape;
    this.onLog = onLog;
    this.useWebGL = useWebGL;
    this.layers = [];
    this.addLayers([Layer.Input({inputShape: this.inputShape})]);
  }
  
  initialize() {
    for (let layer of this.layers) {
      layer.initialize();
    }
  }
  
  setIsCheck(bool) {
    this.isCheck = bool;
    const layers = this.layers;
    for (let index = 0; index < layers.length; index++) {
      const layer = layers[index];
      layer.isCheck = bool;
    }
  }
  
  setLogger(logger) {
    this.onLog = logger;
    for (const layer of this.layers) {
      layer.onLog = logger;
    }
  }
  
  configure({
    useWebGL,
    optimizerType,
    optimizerFunc,
    gradientClipNorm
  })
  {
    this.useWebGL = useWebGL;
    this.optimizerType = optimizerType;
    this.optimizerFunc = optimizerFunc;
    this.gradientClipNorm = gradientClipNorm;
    const layers = this.layers;
    let layer;
    for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
      layer = layers[layerIdx];
      layer.useWebGL = useWebGL;
      layer.optimizerType = optimizerType;
      layer.optimizerFunc = optimizerFunc;
      layer.optimizerInit();
      layer.gradientClipNorm = gradientClipNorm;
    }
  }
  
  addLayers(layers) {
    if (layers.length === 0) return;
    const useWebGL = this.useWebGL;
    const optimizerType = this.optimizerType;
    const optimizerFunc = this.optimizerFunc;
    const gradientClipNorm = this.gradientClipNorm;
    if (this.layers.length === 0) {
      const layer = layers.shift();
      // constructorで自動実行されるaddLayers([InputLayer]);
      if (layer.getKind() === 'InputLayer') {
        layer.build(null, this.onLog);
        this.configure({
          useWebGL,
          optimizerType,
          optimizerFunc,
          gradientClipNorm
        });
        this.layers.push(layer);
        return;
      }
      this.throwError('addLayers', 'layers.lengthが0であり、不適当な長さです。CogniKeelの初期化やlayersの処理を見直してください。');
    }
    
    // 次層の入力形式
    let inputShape = this.layers[this.layers.length-1].outputShape;
    
    for (const layer of layers) {
      if (!(layer instanceof Layer))
        this.throwError('addLayer', '引数がLayerクラス(またはその子クラス)の一次元配列である必要があります。');
      
      if (layer.getKind() === 'InputLayer')
        this.throwError('addLayers', 'InputLayerは一つのCogniKeelインスタンスにつき一つしか指定できません。');
      
      layer.build(inputShape, this.onLog);
      this.layers.push(layer);
      inputShape = layer.outputShape;
    }
    
    // バグ修正: gradientClipNormが渡されておらず、configure()→addLayers()の順で
    // 呼んだ場合に、既にconfigure済みのgradientClipNorm設定が
    // undefinedで上書きされ、勾配クリッピングが無効化されてしまっていた。
    this.configure({
      useWebGL,
      optimizerType,
      optimizerFunc,
      gradientClipNorm
    });
    
    this.ckInstance.statusUpdate('UNINITIALIZED');
  }
  
  forward({ inputs, batchSize }) {
    let result;
    // useWebGL===trueの場合、構築したGLSL言語コードを実行するため分岐
    if (this.useWebGL)
      result = this.#forwardWebGL({ inputs, batchSize });
    else
      result = this.#forwardJS({ inputs, batchSize });
    
    return result;
  }
  
  #forwardJS({ inputs, batchSize }) {
    const outputs = [];
    
    let nextLayerInput = inputs;
    const isCheck = this.isCheck;
    
    for (let layer of this.layers) {
      nextLayerInput = layer.forward(nextLayerInput, batchSize);
      if (isCheck && nextLayerInput.findIndex(value => value == null || Number.isNaN(value)) !== -1)
        this.throwError('#forwardJS', `nextLayerInputに無効な値が含まれています。kind: ${layer.getKind()}, info: ${JSON.stringify(layer.getInfo())}`);
    }
    return nextLayerInput;
  }
  
  #forwardWebGL({ inputs, batchSize }) {
    this.throwError('forwardWebGL', 'まだWebGLのコードは実装されていません。')
  }
  
  getOutputs(type="object") {
    const outputs = [];
    for (let layer of this.layers) {
      if (layer.outputs == null)
        this.throwError("getOutputs", `forwardを実行していないか、各Layerでの実行結果の値の保存ができていません。(kind: ${layer.getKind()})`);
      if (type==="string")
        outputs.push(layer.getKind()+':'+layer.outputs.join(' '));
      else if (type === "object")
        outputs.push({
          kind: layer.getKind(),
          outputs: layer.outputs
        });
    }
    return type === "string" ? outputs.join('\n') : outputs;
  }
  
  getInfo(type) {
    const retInfoData = [];
    for (let layer of this.layers) {
      if (layer.getInfo == null)
        this.throwError("getInfo", `LayerにgetInfoメソッドが定義されていません。(kind: ${layer.getKind()})`);
      if (type==="string" || type==="array")
        retInfoData.push(layer.getKind()+':'+JSON.stringify(layer.getInfo()));
      else if (type === "object")
        retInfoData.push({
          kind: layer.getKind(),
          info: layer.getInfo()
        });
    }
    let ret;
    if (type === "string")
      ret = retInfoData.join('\n');
    else if (type === "object" || type === "array")
      ret = retInfoData;
    return ret;
  }
  
  getWeights() {
    const layers = this.layers;
    const layerLength = layers.length;
    let biasesAndWeightsList = [];
    for (let index = 0; index < layerLength; index++) {
      const layer = layers[index];
      // [ biases, weights ]で返ってくる
      biasesAndWeightsList = biasesAndWeightsList.concat(layer.getWeights());
    }
    
    return biasesAndWeightsList;
  }
  
  setWeights(biasesAndWeights) {
    const layers = this.layers;
    const layerLength = layers.length;
    
    for (let index = 0; index < layerLength; index++) {
      const layer = layers[index];
      const biases = biasesAndWeights[2*index];
      const weights = biasesAndWeights[2*index+1];
      // [ biases, weights ]を与える
      layer.setWeights([ biases, weights ]);
    }
  }
}

// 各レイヤーのベースとなるクラス
class Layer extends Common {
  constructor(args) {
    super();
    this.constructorArgs = structuredClone(args);
  }
  
  construct() {
    this.onLog = null;
    this.units = null;
    this.inputShape = null;
    this.outputShape = null;
    this.layerKind = this.getKind();
  }
  
  getInfo() {
    return {
      kind: this.getKind(),
      inputShape: this.inputShape,
      outputShape: this.outputShape
    }
  }
  
  getConstructorArgs() {
    return this.constructorArgs;
  }
  
  clone() {
    return new this.constructor(this.getConstructorArgs());
  }
  
  getKind() {
    return this.constructor.name;
  }
  
  getJoinedWeights(precision) {
    let w;
    let b;
    
    function changeResolution(array, n) {
      return Array.from(array).map(
        k => Number(k.toExponential(n-1)).toString()
      );
    }
    
    switch (precision) {
      case 'full':
        w = this.weights;
        b = this.biases;
        break;
      case 'high':
        w = changeResolution(this.weights, 12);
        b = changeResolution(this.biases, 12);
        break;
      case 'medium':
        w = changeResolution(this.weights, 8);
        b = changeResolution(this.biases, 8);
        break;
      case 'low':
        w = changeResolution(this.weights, 6);
        b = changeResolution(this.biases, 6);
        break;
      case 'lower':
        w = changeResolution(this.weights, 4);
        b = changeResolution(this.biases, 4);
        break;
      case 'least':
        w = changeResolution(this.weights, 2);
        b = changeResolution(this.biases, 2);
        break;
    }
    
    return {biases: b?.join(' '), weights: w?.join(' ')}
  }
  
  getWeights() {
    return [this.biases, this.weights];
  }
  
  setWeights(biasesAndWeights) {
    if (biasesAndWeights[0] != null)
      this.biases = biasesAndWeights[0];
    if (biasesAndWeights[1] != null)
      this.weights = biasesAndWeights[1];
  }
  
  build(inputShape, onLog) {
    this.inputShape = inputShape;
    this.totalInputElements = inputShape ? inputShape.reduce((acc,cur) => acc*cur, 1) : null;
    this.totalOutputElements = this.outputShape ? this.outputShape.reduce((acc,cur) => acc*cur, 1) : null;
    this.onLog = onLog;
    this.logger('build', `入力 ${inputShape} -> 出力 ${this.outputShape}`);
  }
  
  initialize() {
    this.totalInputLength = this.inputShape ? this.inputShape.reduce((acc,cur)=>acc*cur,1) : null;
    this.totalOutputLength = this.outputShape ? this.outputShape.reduce((acc,cur)=>acc*cur,1) : null;
  }
  
  optimizerInit() {
    const weightLength = this.weights?.length;
    const biasLength = this.biases?.length;
    if (weightLength == null || biasLength == null)
      return;
    switch (this.optimizerType) {
      case "sgd":
        this.savedOptValues = null;
        break;
      case "momentum":
        this.savedOptValues = {
          w_v: new Float32Array(weightLength),
          b_v: new Float32Array(biasLength)
        }
        break;
      case "rmsprop":
        this.savedOptValues = {
          w_v: new Float32Array(weightLength),
          b_v: new Float32Array(biasLength)
        }
        break;
      case "adam":
        this.savedOptValues = {
          w_m: new Float32Array(weightLength),
          w_v: new Float32Array(weightLength),
          w_powBeta1: new Float32Array(weightLength).fill(1),
          w_powBeta2: new Float32Array(weightLength).fill(1),
          b_m: new Float32Array(biasLength),
          b_v: new Float32Array(biasLength),
          b_powBeta1: new Float32Array(biasLength).fill(1),
          b_powBeta2: new Float32Array(biasLength).fill(1),
        }
        break;
    }
  }
  
  activationInit() {
    this.needY = ActivationLayer.activations[this.activation]?.variable === 'Y';
    this.savedValues = null;
    
    const activation = ActivationLayer.activations[this.activation];
    
    this.func = activation ? activation.func : (x)=>x;
    this.primeFunc = activation ? activation.primeFunc : (x)=>1;
  }
  
  inputCheck(inputs, batchSize) {
    if (inputs == null)
      this.throwError('forward', '入力が無効な値です(null相当)。');
    if (inputs.length !== this.totalInputLength*batchSize)
      this.throwError('forward', `入力の要素数が一致しません。期待値: ${this.totalInputLength*batchSize}, 実際の値: ${inputs.length}`);
    if (inputs.includes(null) || inputs.includes(NaN))
      this.throwError('forward', `入力に不適当な値が入っています。`);
  }
  
  duListCheck(inputs, batchSize) {
    if (inputs.length !== this.totalOutputLength*batchSize)
      this.throwError('backward', `入力の要素数が一致しません。期待値: ${this.totalOutputLength*batchSize}, 実際の値: ${inputs.length}`);
  }
  
  static Activation (args) {
    return new ActivationLayer(args);
  }
  
  static Input (args) {
    return new InputLayer(args);
  }
  
  static Dense (args) {
    return new DenseLayer(args);
  }
  
  static Conv1d(args) {
    return new Conv1dLayer(args);
  }
  
  static Conv2d(args) {
    return new Conv2dLayer(args);
  }
  
  static Conv3d(args) {
    return new Conv3dLayer(args);
  }
  
  static Pooling1d(args) {
    return new Pooling1dLayer(args);
  }
  
  static Pooling2d(args) {
    return new Pooling2dLayer(args);
  }
  
  static Pooling3d(args) {
    return new Pooling3dLayer(args);
  }
  
  static Flatten(args) {
    return new FlattenLayer(args);
  }
  
  getInitWeights({ len, type='uniform', fanIn=1, fanOut=1 }) {
    const retWeights = new Float32Array(len);

    const randn = () => {
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    };

    if (type === 'uniform') {
      for (let i = 0; i < len; i++) {
        retWeights[i] = Math.random() - 0.5;
      }

    } else if (type === 'He' || type === 'he') {
      const std = Math.sqrt(2.0 / fanIn);
      for (let i = 0; i < len; i++) {
        retWeights[i] = randn() * std;
      }

    } else if (type === 'HeUniform') {
      const limit = Math.sqrt(6.0 / fanIn);
      for (let i = 0; i < len; i++) {
        retWeights[i] = (Math.random() * 2 - 1) * limit;
      }

    } else if (type === 'Xavier' || type === 'glorot') {
      const std = Math.sqrt(2.0 / (fanIn + fanOut));
      for (let i = 0; i < len; i++) {
        retWeights[i] = randn() * std;
      }

    } else if (type === 'XavierUniform') {
      const limit = Math.sqrt(6.0 / (fanIn + fanOut));
      for (let i = 0; i < len; i++) {
        retWeights[i] = (Math.random() * 2 - 1) * limit;
      }

    } else if (type === 'consecutive') {
      for (let i = 0; i < len; i++) {
        retWeights[i] = i;
      }
    } else {
      this.throwError('getInitWeights', `未対応の初期化タイプです: ${type}`);
    }
    
    return retWeights;
  }
}

class InputLayer extends Layer {
  constructor(args) {
    const { inputShape } = args;
    super(args);
    super.construct();
    this.inputShape = inputShape;
  }
  
  build(_, onLog) {
    this.outputShape = Number.isFinite(this.inputShape)
      ? [this.inputShape]
      : this.inputShape;
    super.build(this.inputShape, onLog);
  }
  
  initialize() {
    super.initialize();
  }
  
  toMCLM(_) {
    return {
      input: this.inputShape
    }
  }
  
  forward(inputs, batchSize) {
    super.inputCheck(inputs, batchSize);
    this.inputs = inputs;
    
    const outputs = inputs instanceof Float32Array ? inputs : new Float32Array(inputs);
    this.outputs = outputs;
    return outputs;
  }
  
  backward(inputs, batchSize) {
    super.duListCheck(inputs, batchSize);
    return inputs;
  }
}

class ActivationLayer extends Layer {
  constructor(args) {
    const { type } = args;
    super(args);
    super.construct();
    this.type = type;
    this.func = null;
    this.funcPrime = null;
  }
  
  getInfo() {
    const commonInfo = super.getInfo();
    return {
      ...commonInfo,
      type: this.type
    }
  }
  
  build(inputShape, onLog) {
    this.outputShape = inputShape;
    super.build(inputShape, onLog);
    const activationData = this.constructor.activations[this.type];
    if (activationData == null)
      this.throwError('build', `未対応の活性化関数typeです: ${this.type}`);
  }
  
  static activations = {
    'sigmoid': {
      variable: 'Y',
      func: (x) => 1/(1+Math.exp(-x)),
      primeFunc: (y) => y*(1-y)
    },
    'tanh': {
      variable: 'Y',
      func: (x) => Math.tanh(x),
      primeFunc: (y) => 1-y*y
    },
    'ReLU': {
      variable: 'X',
      func: (x) => Math.max(0,x),
      primeFunc: (x) => x > 0 ? 1 : 0
    },
  }
  
  initialize() {
    super.initialize();
  }
  
  toMCLM(_) {
    return {
      type: this.type
    }
  }
  
  forward(inputs, batchSize) {
    super.inputCheck(inputs, batchSize);
    this.inputs = inputs;

    const outputs = this.constructor.arrayThroughActivationFunc({
      inputs: inputs,
      type: this.type
    })

    this.outputs = outputs;
    return outputs;
  }
  
  // バグ修正: ActivationLayerにbackward()が未実装だった。
  // Layer.Activation()を単独の層として使うネットワーク構成の場合、
  // learn()内のbackward伝播ループでlayer.backwardがundefinedとなりクラッシュしていた。
  // また、activationInit()もinitialize()から呼ばれておらずthis.primeFunc/
  // this.savedValuesが未設定だったため、既存のarrayThroughActivationPrimeFunc
  // (inputVariable='X'を渡すとactivationのvariableに応じて自動でfuncを通してから
  // primeFuncを適用してくれる)をthis.inputsに対して使う形にした。
  // 重みを持たない層なので、活性化関数の微分を掛けるだけで前の層へそのまま渡す。
  backward(duList, batchSize) {
    super.duListCheck(duList, batchSize);
    const primes = this.constructor.arrayThroughActivationPrimeFunc({
      inputs: this.inputs,
      inputVariable: 'X',
      type: this.type
    });
    const length = duList.length;
    const retDuList = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      retDuList[i] = primes[i] * duList[i];
    }
    return retDuList;
  }
  
  static arrayThroughActivationFunc({ inputs, type }) {
    const activation = this.activations[type];
    const inputLength = inputs.length;
    const func = activation.func;
    const retValues = new Float32Array(inputLength);
    for (let index = 0; index < inputLength; index++) {
      retValues[index] = func(inputs[index]);
    }
    
    return retValues;
  }
  
  static arrayThroughActivationPrimeFunc({ inputs, inputVariable=null, type }) {
    const activation = this.activations[type];
    const variable = activation.variable;
    let needConvert = false;
    if (inputVariable !== null && (inputVariable === 'X' && variable === 'Y'))
      needConvert = true;
    const func = activation.func;
    const primeFunc = activation.primeFunc;
    const inputLength = inputs.length;
    const retPrimeValues = new Float32Array(inputLength);
    for (let index = 0; index < inputLength; index++) {
      const input = inputs[index];
      const value = needConvert ? func(input) : input;
      retPrimeValues[index] = primeFunc(value);
    }
    
    return retPrimeValues;
  }
}

class DenseLayer extends Layer {
  constructor({ activation=null, units, weightsInitType, fanIn, fanOut }) {
    super({ activation, units, weightsInitType, fanIn, fanOut });
    super.construct();
    this.activation = activation;
    this.units = units;
    this.initWeightsInfo = { units,weightsInitType,fanIn,fanOut };
  }

  build(inputShape, onLog) {
    this.outputShape = [this.units]
    
    if (!Array.isArray(inputShape) || inputShape.length !== 1) {
      const text = !Array.isArray(inputShape)
        ? '(配列でない型が入力されています。)'
        : `(${inputShape.length}次元が入力されています。)`;
      this.throwError('build', `Dense層の入力は一次元配列でなければいけません。${text}`)
    }
    super.build(inputShape, onLog);
  }
  
  initialize() {
    super.initialize();
    this.weights = this.getInitWeights({ len: this.totalInputLength*this.totalOutputLength, type: this.initWeightsInfo.weightsInitType, fanIn: this.initWeightsInfo.fanIn, fanOut: this.initWeightsInfo.fanOut });
    this.biases = new Float32Array(this.totalOutputLength).fill(0.0);
    super.optimizerInit({ weightLength: this.totalInputLength*this.totalOutputLength, biasLength: this.totalOutputLength });
    super.activationInit();
  }
  
  toMCLM(precision) {
    return {
      activation: this.activation,
      units: this.units,
      b: this.getJoinedWeights(precision).biases,
      w: this.getJoinedWeights(precision).weights
    }
  }

  forward(inputs, batchSize) {
    super.inputCheck(inputs, batchSize);
    this.inputs = inputs;
    this.savedValues = new Float32Array(this.totalOutputLength*batchSize);
    
    const outputs = new Float32Array(this.totalOutputLength*batchSize);
    
    const totalOut = this.totalOutputLength;
    const totalIn = this.totalInputLength;
    const weights = this.weights;
    const biases = this.biases;
    
    const needY = this.needY;
    const savedValues = this.savedValues;
    const func = this.func;
    
    if (this.isCheck) {
      let index;
      index = biases.findIndex(value => value == null || Number.isNaN(value));
      if (index !== -1)
        this.throwError('forward', `check...biasesに無効な値が含まれています。units: ${this.units}, biases: ${this.showArrayAroundIndex(biases, index, 5)}`);
      index = weights.findIndex(value => value == null || Number.isNaN(value));
      if (index !== -1)
        this.throwError('forward', `check...weightsに無効な値が含まれています。units: ${this.units}, weights: ${this.showArrayAroundIndex(weights, index, 5)}`);
    }
    
    for (let outIdx = 0; outIdx < totalOut; outIdx++) {
      const weightOffset = outIdx * totalIn;

      for (let batchIdx = 0; batchIdx < batchSize; batchIdx++) {
        const idx = batchIdx * totalOut + outIdx;
        const inputOffset = batchIdx * totalIn;
        let sum = biases[outIdx];

        for (let inIdx = 0; inIdx < totalIn; inIdx++) {
          sum += inputs[inputOffset + inIdx] * weights[weightOffset + inIdx];
        }

        if (!needY)
          savedValues[idx] = sum;
        sum = func(sum);
        if (needY)
          savedValues[idx] = sum;

        outputs[idx] = sum;
      }
    }
    
    this.outputs = outputs;
    return outputs;
  }
  
  backward(duList, batchSize) {
    const primeFunc = this.primeFunc;
    
    const optType = this.optimizerType;
    const optFunc = this.optimizerFunc;
    const savedOptValues = this.savedOptValues;
    const {
      w_m=null,
      w_v=null,
      w_powBeta1=null,
      w_powBeta2=null,
      b_m=null,
      b_v=null,
      b_powBeta1=null,
      b_powBeta2=null
    } = savedOptValues ?? {};
    
    const totalIn = this.totalInputLength;
    const totalOut = this.totalOutputLength;
    const retDuList = new Float32Array(totalIn*batchSize);
    
    const savedValues = this.savedValues;
    
    // 高速化: 以前はweights/biasesをFloat32Arrayとして毎回まるごとコピーしていたが、
    // retDuList計算(下のbatchIdxループ)は重み更新(このあとのoutIdxループ)より
    // 必ず先に実行されるため、更新前の値を読むのにコピーは不要。
    // weightsOriginal/biasesOriginalを直接参照するだけで正しく動作し、
    // 層のサイズが大きいほど効くコピー・GCコストを削減できる。
    const weightsOriginal = this.weights;
    const biasesOriginal = this.biases;
    const weights = weightsOriginal;
    const biases = biasesOriginal;
    
    const inputs = this.inputs;
    
    let duListOffset = 0;
    let retDuListOffset = 0;
    let weightOffset = 0;
    let inputOffset = 0;
    let z;
    let b;
    let w;
    let fPrime
    let du;
    let sum;
    const deltaList = new Float32Array(totalOut);
    
    const isCheck = this.isCheck;
    
    if (isCheck) {
      let index;
      index = duList.findIndex(value => value == null || Number.isNaN(value));
      if (index !== -1)
        this.throwError('backward', `duListに無効な値が含まれています(NaN, null相当)。units: ${this.units}, duList[${index}付近]: ${this.showArrayAroundIndex(duList, index, 5)}`);
    }
    
    const dW = new Float32Array(totalOut * totalIn);
    const dB = new Float32Array(totalOut);
    
    let wBase;
    
    let delta;
    const startTime = Date.now();
    for (let batchIdx = 0; batchIdx < batchSize; batchIdx++) {
      duListOffset = batchIdx * totalOut;
      retDuListOffset = batchIdx * totalIn;
      inputOffset = batchIdx * totalIn;
      for (let outIdx = 0; outIdx < totalOut; outIdx++) {
        delta = primeFunc(savedValues[batchIdx * totalOut + outIdx])*duList[duListOffset+outIdx];
        deltaList[outIdx] = delta;
        dB[outIdx] += delta;
        wBase = outIdx * totalIn;
        for (let inIdx = 0; inIdx < totalIn; inIdx++) {
          dW[wBase + inIdx] += delta * inputs[inputOffset + inIdx];
        }
      }
      
      for (let inIdx = 0; inIdx < totalIn; inIdx++) {
        sum = 0;
        for (let outIdx = 0; outIdx < totalOut; outIdx++) {
          sum += deltaList[outIdx]*weights[outIdx*totalIn+inIdx];
        }
        if (isCheck && (sum == null || Number.isNaN(sum)))
          this.throwError('backward', 'retDuListに設定する値が無効です(NaN, null相当)。');
        retDuList[retDuListOffset+inIdx] = sum;
      }
    }
    
    const invBatch = 1 / batchSize;
    const maxNorm = this.gradientClipNorm;
    if (maxNorm != null && maxNorm > 0) {
      let sumSq = 0;
      let db;
      let dw;
      for (let outIdx = 0; outIdx < totalOut; outIdx++) {
        db = dB[outIdx]*invBatch;
        dB[outIdx] = db;
        sumSq += db*db;
      }
      for (let index = 0; index < totalOut * totalIn; index++) {
        dw = dW[index]*invBatch;
        dW[index] = dw;
        sumSq += dw*dw;
      }
      const totalNorm = Math.sqrt(sumSq);
      if (totalNorm > maxNorm) {
        const scale = maxNorm / (totalNorm + 1e-6);
        for (let i = 0; i < totalOut; i++) {
          dB[i] *= scale;
        }
        for (let i = 0; i < totalOut * totalIn; i++) {
          dW[i] *= scale;
        }
      }
    }
    else {
      for (let outIdx = 0; outIdx < totalOut; outIdx++) {
        dB[outIdx] *= invBatch;
      }
      const totalWLength = totalOut * totalIn;
      for (let index = 0; index < totalWLength; index++) {
        dW[index] *= invBatch;
      }
    }
    let gradB;
    let gradW;
    
    for (let outIdx = 0; outIdx < totalOut; outIdx++) {
      gradB = dB[outIdx];
      b = biases[outIdx];
      switch (optType) {
        case "sgd":
          biasesOriginal[outIdx] = optFunc(b, gradB)[0];
          break;
        case "momentum":
        case "rmsprop":
          [
            savedOptValues.b_v[outIdx],
            biasesOriginal[outIdx]
          ] = optFunc(b_v[outIdx], b, gradB);
          break;
        case "adam":
          [
            savedOptValues.b_powBeta1[outIdx],
            savedOptValues.b_powBeta2[outIdx],
            savedOptValues.b_m[outIdx],
            savedOptValues.b_v[outIdx],
            biasesOriginal[outIdx]
          ] = optFunc(b_powBeta1[outIdx], b_powBeta2[outIdx], b_m[outIdx], b_v[outIdx], b, gradB);
          break;
      }
      if (isCheck && Number.isNaN(biasesOriginal[outIdx]))
        this.throwError('backward',`biasで数値エラーになりました。units=${this.units}, outIdx=${outIdx}, b=${b}, delta=${delta}`)
        
      for (let inIdx = 0; inIdx < totalIn; inIdx++) {
        weightOffset = outIdx * totalIn + inIdx;
        gradW = dW[weightOffset];
        w = weights[weightOffset];
          
        switch (optType) {
          case "sgd":
            weightsOriginal[weightOffset] = optFunc(w, gradW)[0];
            break;
          case "momentum":
          case "rmsprop":
            [
              savedOptValues.w_v[weightOffset],
              weightsOriginal[weightOffset]
            ] = optFunc(w_v[weightOffset], w, gradW);
            break;
          case "adam":
            [
              savedOptValues.w_powBeta1[weightOffset],
              savedOptValues.w_powBeta2[weightOffset],
              savedOptValues.w_m[weightOffset],
              savedOptValues.w_v[weightOffset],
              weightsOriginal[weightOffset]
            ] = optFunc(w_powBeta1[weightOffset], w_powBeta2[weightOffset], w_m[weightOffset], w_v[weightOffset], w, gradW);
            break;
        }
        if (isCheck && weightsOriginal[weightOffset] == null || Number.isNaN(weightsOriginal[weightOffset]))
          this.throwError('backward',`weightで数値エラーになりました。units=${this.units}, weightOffset=${weightOffset}, optFunc=${optFunc}`)
      }
    }
    
    if (this.weights.findIndex(value => value == null || Number.isNaN(value)) !== -1)
      this.throwError('backward', 'weightsに無効な値が含まれています。');
    return retDuList;
  }
}

class FlattenLayer extends Layer {
  constructor(args) {
    super(args);
    super.construct();
    if (args !== undefined)
      this.throwError('constructor', 'FlattenLayer インスタンス生成時、引数はとりません。');
  }
  
  build(inputShape, onLog) {
    if (!Array.isArray(inputShape) || inputShape.length <= 1) {
      const text = !Array.isArray(inputShape)
        ? '(配列でない型が入力されています。)'
        : `(${inputShape.length}次元が入力されています。)`;
      this.throwError('build', `Flatten層の入力は二次元配列以上でなければいけません。${text}`)
    }
    this.outputShape = [inputShape.reduce((acc, cur) => acc*cur, 1)];
    super.build(inputShape, onLog);
  }
  
  toMCLM(_) {
    return {}
  }
  
  forward(inputs, batchSize) {
    super.inputCheck(inputs, batchSize);
    this.inputs = inputs;
    
    const outputs = inputs instanceof Float32Array ? inputs : new Float32Array(inputs);
    this.outputs = outputs;
    return outputs;
  }
  
  backward(inputs, batchSize) {
    super.duListCheck(inputs, batchSize);
    return inputs;
  }
}

export { CogniKeel, Layer, Network, DenseLayer, ActivationLayer };
