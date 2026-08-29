// 1-03-01 Conv,Poolingにbackwardを追加。

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
  
  static staticThrowError(methodName, message) {
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
  
  mergeMissingKeys(target, source) {
    if (
      !target || typeof target !== 'object' || Array.isArray(target) ||
      !source || typeof source !== 'object' || Array.isArray(source)
    ) {
      return target;
    }

    for (const key of Object.keys(source)) {
      const sourceVal = source[key];
      const targetVal = target[key];

      if (!(key in target)) {
        target[key] = typeof structuredClone === 'function'
          ? structuredClone(sourceVal)
          : JSON.parse(JSON.stringify(sourceVal));
      } else if (
        targetVal && typeof targetVal === 'object' && !Array.isArray(targetVal) &&
        sourceVal && typeof sourceVal === 'object' && !Array.isArray(sourceVal)
      ) {
        this.mergeMissingKeys(targetVal, sourceVal);
      }
    }

    return target;
  }
}

class CogniKeel extends Common {
  #constructorArgs;
  #configureArgs;
  #onlineNetwork;
  #targetNetwork;
  #replayBuffer;
  
  static VERSION = '1-03-01';
  // 例: [84,84,4]...84*84*4の入力(例えば84px*84pxの画像過去4フレーム)
  // orderがC,H,Wでarray[C][H][W]、nullならそのまま
  /*
  modelType: "dqn" | "ddqn"(TD Targetの計算に使う)
  */
  constructor(constructorArgs) {
    super();
    const constructorArgsSource = { order: null, replayBufferSize: 100000, useWebGL: false, onLog: null, modelType: "dqn" };
    
    constructorArgs = this.mergeMissingKeys(constructorArgs, constructorArgsSource);
    this.#constructorArgs = constructorArgs;
    const { inputShape, order, replayBufferSize, useWebGL, onLog, modelType } = constructorArgs;
    
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
    this.#replayBuffer.configure(this.replayBufferSize);
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
  // weightsIncludeは、重み情報を載せるか(つまり、層の情報のみ載せる場合)
  // precisionは、full, high, medium, low, lower, leastで、重みなどの保存桁数を指定する
  getMCLM(args) {
    if (this.status !== this.constructor.STATUS.READY)
      this.throwError('getMCLM', 'getMCLMはstatusが'+this.constructor.STATUS.READY+'の時に実行できます。initialize,configureを行なってください。');
    const { weightsInclude=true, precision='high', inputLayerInclude=false } = args ?? {};
    let content = '';
    
    function getHeader({ weightsInclude, precision, inputLayerInclude,  constructorArgs, configureArgs }) {
      return `weightsInclude ${String(weightsInclude)}
precision ${precision}
inputLayerInclude ${inputLayerInclude}
constructor ${constructorArgs}
configure ${configureArgs}`
    }
    
    const constructorArgs = this.#constructorArgs;
    if ('onLog' in constructorArgs)
      delete constructorArgs.onLog;
    
    content += getHeader({
      weightsInclude,
      precision,
      inputLayerInclude,
      // onLogは毎回nullにする。
      constructorArgs: JSON.stringify(constructorArgs),
      configureArgs: JSON.stringify(this.#configureArgs)
    });
    
    const layers = this.#onlineNetwork.layers;
    
    for (const layer of layers) {
      if (!inputLayerInclude && layer.getObjectName() === "Input")
        continue;
      content += '\n\n#' + layer.getObjectName() + '\n';
      const miniMCLMList = layer.toMCLM({ weightsInclude, precision });
      for (const miniMCLM of Object.keys(miniMCLMList)) {
        let miniMCLMData = miniMCLMList[miniMCLM];
        if (Array.isArray(miniMCLMData))
          miniMCLMData = miniMCLMData.join(' ');
        content += miniMCLM + ' ' + miniMCLMData + '\n';
      }
    }
    
    return content;
  }
  
  // weightsInclude: true...重みを入れる(ない場合はエラー) false...重みを初期値にする null...MCLM内のweightsIncludeと同値
  static async fromMCLM({ MCLM, onLog, weightsInclude=null }) {
    // MCLM解析
    // 改行文字で分割
    const rows = MCLM.split(/\r\n|\r|\n/);
    
    let constructorArgs;
    let configArgs;
    const layers = [];
    // [null, [b, w], [b, w]]
    // InputLayer分のnullを入れておく
    const weightsList = [null];
    
    let miniWeights = {};
    let layerArgs = {};
    let layerName;
    let isHeader = true;
    for (let row of rows) {
      // #から始まる→header終わり&Layer開始
      if (row.startsWith('#')) {
        // 前回のLayerがあればlayers.pushする
        if (layerName != null) {
          // 引数を取らないLayer
          
          if (Object.keys(layerArgs).length === 0)
            layers.push(Layer[layerName]());
          else
            layers.push(Layer[layerName](layerArgs));
          if ('b' in miniWeights || 'w' in miniWeights) {
            if ('b' in miniWeights && 'w' in miniWeights) {
              // [b, w]を追加
              weightsList.push([miniWeights.b, miniWeights.w]);
            } else {
              CogniKeel.staticThrowError('static fromMCLM', "MCLM内に、'b'又は'w'の一方しか存在しないLayerが存在します。");
            }
          } else {
            // 重みを取らないLayer又はweightsInclude==falseの場合
            weightsList.push(null);
          }
        }
        
        isHeader = false;
        miniWeights = {};
        layerArgs = {};
        // #を消す
        layerName = row.slice(1);
        
        continue;
      }
      
      // 空文字など
      if (/^\s*$/.test(row))
        continue;
      if (isHeader) {
        if (row.startsWith('constructor')) {
          try {
            constructorArgs = JSON.parse(row.slice(11));
          } catch (err) {
            CogniKeel.staticThrowError('static fromMCLM', `static fromMCLM', 'mclm解析中に妥当でない構文が見つかりました(constructorがJSON型でない)(constructor: ${(row.slice(11, 19)) + (row.length > 19 ? '...' : '')})。`);
          }
          if (onLog != null)
            constructorArgs.onLog = onLog;
        } else if (row.startsWith('configure')) {
          try {
           configArgs = JSON.parse(row.slice(9));
          } catch (err) {
            CogniKeel.staticThrowError('static fromMCLM', `static fromMCLM', 'mclm解析中に妥当でない構文が見つかりました(configureがJSON型でない)(configure: ${(row.slice(9, 17)) + (row.length > 17 ? '...' : '')})。`);
          }
        } else if (row.startsWith('weightsInclude')) {
          
          if (row.slice(15) !== "true" && row.slice(15) !== "false")
            CogniKeel.staticThrowError('static fromMCLM', "MCLM内のweightsIncludeは'true'又は'false'の必要があります。");
          const value = row.slice(15) === "true";
          if (weightsInclude && !value)
            CogniKeel.staticThrowError('static fromMCLM', 'この関数の引数のweightsIncludeがtrueの場合、MCLM内のweightsIncludeがtrueの必要があります。')
          if (weightsInclude == null)
            weightsInclude = value;
        }
      } else {
        if (row.startsWith('b') || row.startsWith('w')) {
          const value = row.slice(2);
          miniWeights[row[0]] = new Float32Array(value.split(/\s+/).map(k => parseFloat(k)));
          continue;
        }
        const rowSplit = row.split(/\s+/, 2);
        switch (rowSplit[0]) {
          case 'activation':
            layerArgs[rowSplit[0]] = rowSplit[1];
            break;
          case 'units':
            layerArgs[rowSplit[0]] = parseInt(rowSplit[1]);
            break;
          case 'kernel':
            if (rowSplit[1].split(/\s+/).length === 1)
              layerArgs[rowSplit[0]] = parseInt(rowSplit[1]);
            else
              layerArgs[rowSplit[0]] = rowSplit[1].split(/\s+/).map(k => parseInt(k));
            break;
          case 'strides':
            layerArgs[rowSplit[0]] = parseInt(rowSplit[1]);
            break;
          case 'padding':
            if (rowSplit[1] === 'same')
              layerArgs[rowSplit[0]] = rowSplit[1];
            else
              layerArgs[rowSplit[0]] = parseInt(rowSplit[1]);
            break;
          case 'filter':
            layerArgs[rowSplit[0]] = parseInt(rowSplit[1]);
            break;
          case 'deficit':
            layerArgs[rowSplit[0]] = rowSplit[1] === 'true';
            break;
          default:
            layerArgs[rowSplit[0]] = rowSplit[1];
        }
        
      }
    }
    // 最後のLayerを追加する
    if (layerName != null) {
      layers.push(Layer[layerName](layerArgs));
      if ('b' in miniWeights || 'w' in miniWeights) {
        if ('b' in miniWeights && 'w' in miniWeights) {
          // [b, w]を追加
          weightsList.push([miniWeights.b, miniWeights.w]);
        } else {
          CogniKeel.staticThrowError('static fromMCLM', "MCLM内に、'b'又は'w'の一方しか存在しないLayerが存在します。");
        }
      } else {
        // 重みを取らないLayer又はweightsInclude==falseの場合
        weightsList.push(null);
      }
    }
    
    const ck = new this(constructorArgs);
    
    ck.addLayers(layers);
    ck.configure(configArgs);
    ck.initialize();
    ck.logger('fromMCLM', 'CogniKeelインスタンスの生成が完了しました。');
    if (weightsInclude)
      ck.setWeights(weightsList);
    return ck;
  }
  
  setWeights(weightsList) {
    function miniSetWeights({ ins, layers, weightsList }) {
      for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
        const biasesAndWeights = weightsList[layerIdx];
        if (biasesAndWeights === null)
          continue;
        //console.log(weightsList)
        if (!Array.isArray(biasesAndWeights))
          ins.throwError('setWeights', '引数(weightsList)の長さがlayersの長さと一致していないか、引数に、配列[biases, weights]かnull以外が含まれています。')
        const layer = layers[layerIdx];
        layer.setWeights(biasesAndWeights);
      }
    }
    miniSetWeights({ ins: this, layers: this.#onlineNetwork.layers, weightsList });
    miniSetWeights({ ins: this, layers: this.#targetNetwork.layers, weightsList });
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
  
  /*
  online(またはtarget)ネットワークの全層のweights,biases(,outputs)を走査し、
  NaN/Infinityの有無、最大値、最小値、0(またはその付近)の値の個数を集計する。
  {
    ok,           // true...NaN/Infinityなし, false...どこかにあり
    max,          // 有効な値の中の最大値(有効な値が一つもない場合はnull)
    min,          // 有効な値の中の最小値(有効な値が一つもない場合はnull)
    zeroCount,    // |value| < epsilon を満たす値の個数
    nanCount,     // NaNの個数
    infCount,     // Infinity(+-)の個数
    checkedCount, // 走査した値の総数
    brokenLayers  // NaN/Infinityが見つかった層の情報のリスト
  }
  */
  checkAll({
    // "online" | "target"
    networkType="online",
    // これ未満の絶対値を「0付近」とみなす閾値
    epsilon=1e-6,
    // 各層のoutputs(直近のforward結果)も走査対象に含めるか
    includeOutputs=true
  }={})
  {
    let network;
    if (networkType === "online")
      network = this.#onlineNetwork;
    else if (networkType === "target")
      network = this.#targetNetwork;
    else
      this.throwError('checkAll', `networkTypeは'online'または'target'である必要があります。(networkType: ${networkType})`);
    
    const layers = network.layers;
    
    let max = -Infinity;
    let min = Infinity;
    let zeroCount = 0;
    let nanCount = 0;
    let infCount = 0;
    let checkedCount = 0;
    const brokenLayers = [];
    
    const scanArray = (array, layerIndex, kind) => {
      if (array == null) return;
      let layerNanCount = 0;
      let layerInfCount = 0;
      const length = array.length;
      for (let i = 0; i < length; i++) {
        const value = array[i];
        checkedCount++;
        if (Number.isNaN(value)) {
          nanCount++;
          layerNanCount++;
          continue;
        }
        if (!Number.isFinite(value)) {
          infCount++;
          layerInfCount++;
          continue;
        }
        if (value > max) max = value;
        if (value < min) min = value;
        if (Math.abs(value) < epsilon) zeroCount++;
      }
      if (layerNanCount > 0 || layerInfCount > 0) {
        brokenLayers.push({
          layerIndex,
          layerKind: layers[layerIndex]?.getKind(),
          kind,
          nanCount: layerNanCount,
          infCount: layerInfCount
        });
      }
    };
    
    for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
      const layer = layers[layerIndex];
      scanArray(layer.weights, layerIndex, 'weights');
      scanArray(layer.biases, layerIndex, 'biases');
      if (includeOutputs)
        scanArray(layer.outputs, layerIndex, 'outputs');
    }
    
    const ok = nanCount === 0 && infCount === 0;
    const hasValidValue = checkedCount - nanCount - infCount > 0;
    
    if (!ok)
      this.logger('checkAll', `NaN/Infinityを検出しました。nanCount: ${nanCount}, infCount: ${infCount}, brokenLayers: ${JSON.stringify(brokenLayers)}`);
    
    return {
      ok,
      max: hasValidValue ? max : null,
      min: hasValidValue ? min : null,
      zeroCount,
      nanCount,
      infCount,
      checkedCount,
      brokenLayers
    };
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
    if (!(state instanceof Float32Array))
      this.throwError('evaluationStep', '入力のstateはFloat32Arrayの必要があります。');
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
  
  // 性能評価用step(epsilon=0に強制)
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
    // ここで即座に検査することで、環境(シミュレーション)側で発生したNaN/Infinityを
    // その場で捕捉する。ReplayBuffer.sample()まで検査を先送りすると、
    // 実際に問題が発生したstepから何ステップも後、たまたまその経験がサンプリング
    // された時に初めてエラーになり、原因の特定が非常に困難になるため。
    //
    // 注意: Number.isNaN()は「型がnumberでNaNの場合のみtrue」を返す。
    // reward/actionを誤って配列やFloat32Array(例: [NaN], new Float32Array([NaN]))
    // で渡すとNumber.isNaN()はfalseを返してこのチェックをすり抜けてしまい、
    // 後でFloat32Arrayへの代入時に暗黙の型変換でNaNとして書き込まれてしまう。
    // これを防ぐため、typeofまで含めて厳密にチェックする。
    const checkScalar = (name, value) => {
      if (typeof value !== 'number' || !Number.isFinite(value))
        this.throwError('remember', `引数の${name}が不正な値です。有限の数値(number型)である必要があります。${name}: ${value} (型: ${typeof value})`);
    };
    
    const checkVector = (name, value) => {
      if (value == null)
        this.throwError('remember', `引数の${name}が不正な値です(null相当)。`);
      const arr = (Array.isArray(value) || value instanceof Float32Array) ? value : [value];
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (typeof v !== 'number' || !Number.isFinite(v))
          this.throwError('remember', `引数の${name}[${i}]が不正な値です(NaNまたはInfinity、もしくはnumber型でない)。${name}[${i}]: ${v} (型: ${typeof v})`);
      }
    };
    
    checkScalar('reward', reward);
    checkScalar('action', action);
    if (done == null)
      this.throwError('remember', `引数のdoneが不正な値です(null相当)。done: ${done}`);
    checkVector('state', state);
    checkVector('nextState', nextState);
    
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
  constructor(capacity) {
    super();
    // 次に保存するindex
    this.index = 0;
    // 保存されている経験の数
    this.length = 0;
    this.configure(capacity);
  }
  
  // replayBufferSizeを決定する。
  // 実際にSoA配列(state,action,reward,nextState,done)をこのサイズで確保し直す。
  // バグ修正: 以前はthis.capacityという数値を書き換えるだけで、
  // 実際のstate/action/reward/nextState/done配列を再確保していなかった。
  // そのためCogniKeelのconstructor時のreplayBufferSizeと、
  // その後のck.configure()に渡すreplayBufferSizeが食い違うと、
  // this.capacity(論理サイズ)と実配列の長さがズレてしまっていた。
  // state/nextStateは通常のArrayなので境界を超えても黙って伸びて気づかれないが、
  // action/reward/doneはTypedArray(固定長)のため、境界外の書き込みは黙って無視され、
  // 読み出すとundefinedが返る。それがFloat32Arrayに代入される際にNaNへ変換され、
  // 「学習を進めるとcapacity付近のindexでrewardがNaNになる」という
  // 追いにくいバグを引き起こしていた。
  configure(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0)
      this.throwError('configure', `capacityは正の整数である必要があります。(capacity: ${capacity})`);
    // 既に経験が保存された状態でcapacityを変更すると、
    // 配列を再確保した瞬間にそれまでの経験が失われる(かつindex/lengthの整合性も崩れる)ため、
    // ズレの再発防止も兼ねて明示的にエラーとする。
    if (this.length > 0 && capacity !== this.capacity)
      this.throwError('configure', `既に経験が${this.length}件保存された状態でreplayBufferSize(capacity)を変更することはできません。学習を開始する前(remember()を呼ぶ前)に一度だけ設定してください。(現在のcapacity: ${this.capacity}, 変更後に指定されたcapacity: ${capacity})`);
    
    this.capacity = capacity;
    // SoAで保存。
    this.state = new Array(capacity);
    this.action = new Uint32Array(capacity);
    this.reward = new Float32Array(capacity);
    this.nextState = new Array(capacity);
    // true...1, false...0
    this.done = new Uint8Array(capacity);
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
    let miniState;
    let miniNextState;
    let stateOffset = 0;

    for (; count < batchSize; count++) {
      rand = this.Xorshift32();
      index = Math.floor(length*rand);
      miniState = structuredClone(this.state[index]);
      miniNextState = structuredClone(this.nextState[index]);
      state.set(miniState, stateOffset);
      action[count] = this.action[index];
      reward[count] = this.reward[index];
      nextState.set(miniNextState, stateOffset);
      done[count] = this.done[index];

      if (rand < 0 || rand >= 1)
        this.throwError('sample', `Xorshift32の値が不正(0<=rand<1でない)です。(rand: ${rand})`);
      if (done[count] !== 0 && done[count] !== 1)
        this.throwError('sample', `doneの値が不正です。(index: ${index}, done: ${done[count]})`);
      if (Number.isNaN(action[count]))
        this.throwError('sample', `actionの値が不正です。(index: ${index}, action: ${action[count]})`);
      if (Number.isNaN(reward[count]))
        this.throwError('sample', `rewardの値が不正です。(index: ${index}, reward: ${reward[count]})`);
      for (let ind = 0; ind < stateLength; ind++) {
        if (Number.isNaN(miniState[ind]))
          this.throwError('sample', `stateの値が不正です。(index: ${index}, ind: ${ind}, state: ${miniState[ind]})`);
        if (Number.isNaN(miniNextState[ind]))
          this.throwError('sample', `nextStateの値が不正です。(index: ${index}, ind: ${ind}, nextState: ${miniNextState[ind]})`);
      }
      
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
    
    this.configure({
      useWebGL,
      optimizerType,
      optimizerFunc
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
    // 二次元の入力用(+Channel)
    /*
    let totalLength = 0;
    const len = inputs.length;
    for (let i = 0; i < len; i++) {
      totalLength += inputs[i].length;
    }
    // メモリを一括確保
    const result = new Float32Array(totalLength);
    // コピー（setメソッドはC++レイヤーで高速にメモリコピーされる。）
    let offset = 0;
    for (let i = 0; i < len; i++) {
      const input = inputs[i];
      result.set(input, offset);
      offset += input.length;
    }
    */
    
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
  
  // 共通の情報
  // kind,inputShape,outputShapeで情報が十分である場合、
  // 拡張先のクラスにgetInfo書く必要はない。
  // 逆に、不十分ならそのクラスに
  // {...super.getInfo(), ~}をreturnさせる。させる。
  getInfo() {
    return {
      kind: this.getKind(),
      inputShape: this.inputShape,
      outputShape: this.outputShape
    }
  }
  
  // constructor時に取った引数(defaultは適応される)
  getConstructorArgs() {
    return this.constructorArgs;
  }
  
  // 新しい、同種のLayerのインスタンス生成
  clone() {
    return new this.constructor(this.getConstructorArgs());
  }
  
  // DenseLayer
  getKind() {
    return this.constructor.name;
  }
  
  // Dense
  getObjectName() {
    // 最後の'Layer'を消す
    return this.constructor.name.slice(0, -5);
  }
  
  getJoinedWeights(precision) {
    let w;
    let b;
    
    // array: Float32Array
    // n: 数値の桁数(=指数表記の小数点以下の桁数+1)
    function changeResolution(array, n) {
      return Array.from(array).map(
        k => Number(k.toExponential(n-1)).toString()
      );
    }
    
    // 解像度...16が最大(full)
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
  
  // initializeの最後に記述。
  // this.activationからthis.savedValues, this.func, this.primeFunc
  activationInit() {
    // 'Y'...true, 'X'...false, activationなし...null
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
  
  // args必要なし(エラーハンドリング用)
  static Flatten(args) {
    return new FlattenLayer(args);
  }
  
  getInitWeights({ len, type='uniform', fanIn=1, fanOut=1 }) {
    const retWeights = new Float32Array(len);

    // ボックス＝ミュラー法による標準正規分布 (平均0, 標準偏差1) の乱数生成ヘルパー
    const randn = () => {
      let u = 0, v = 0;
      while (u === 0) u = Math.random(); // 0を回避（Math.log(0)対策）
      while (v === 0) v = Math.random();
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    };

    if (type === 'uniform') {
      // 単純な一様乱数 (-0.5 ～ 0.5)
      for (let i = 0; i < len; i++) {
        retWeights[i] = Math.random() - 0.5;
      }

    } else if (type === 'He' || type === 'he') {
      // He (Kaiming) の正規分布 (ReLU用)
      // stddev = sqrt(2 / fanIn)
      const std = Math.sqrt(2.0 / fanIn);
      for (let i = 0; i < len; i++) {
        retWeights[i] = randn() * std;
      }

    } else if (type === 'HeUniform') {
      // He の一様分布 (ReLU用)
      // limit = sqrt(6 / fanIn)
      const limit = Math.sqrt(6.0 / fanIn);
      for (let i = 0; i < len; i++) {
        retWeights[i] = (Math.random() * 2 - 1) * limit;
      }

    } else if (type === 'Xavier' || type === 'glorot') {
      // Xavier (Glorot) の正規分布 (Sigmoid / Tanh用)
      // stddev = sqrt(2 / (fanIn + fanOut))
      const std = Math.sqrt(2.0 / (fanIn + fanOut));
      for (let i = 0; i < len; i++) {
        retWeights[i] = randn() * std;
      }

    } else if (type === 'XavierUniform') {
      // Xavier の一様分布 (Sigmoid / Tanh用)
      // limit = sqrt(6 / (fanIn + fanOut))
      const limit = Math.sqrt(6.0 / (fanIn + fanOut));
      for (let i = 0; i < len; i++) {
        retWeights[i] = (Math.random() * 2 - 1) * limit;
      }

    } else if (type === 'consecutive') {
      // バイアス用（0初期化）
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
    
    // 高速化: 呼び出し元(CogniKeel#forward)で既に新規のFloat32Arrayとして
    // 渡ってくるため、ここで毎stepコピーし直す必要はない。
    // 万一Float32Array以外が来た場合のみ変換する。
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
    'linear': {
      variable: 'X',
      func: (x) => x,
      primeFunc: (x) => 1
    },
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

    // 出力用の新しい Float32Array を用意
    const outputs = this.constructor.arrayThroughActivationFunc({
      inputs: inputs,
      type: this.type
    })

    // 次の層へ引き渡すために1次元配列(Float32Array)を返す
    this.outputs = outputs;
    return outputs;
  }
  
  backward(duList, batchSize) {
    super.duListCheck(duList, batchSize);
    const primes = this.constructor.arrayThroughActivationPrimeFunc({
      inputs: this.inputs,
      type: this.type
    });
    const length = duList.length;
    const retDuList = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      retDuList[i] = primes[i] * duList[i];
    }
    return retDuList;
  }
  
  // Float32Arrayの入力に対するfunc
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
  
  // Float32Arrayの入力に対するprimeFunc
  static arrayThroughActivationPrimeFunc({ inputs, inputVariable=null, type }) {
    const activation = this.activations[type];
    const variable = activation.variable;
    // もしinputVariable==='x'でactivationsのvariable==='y'なら一度funcを通す
    // 但し、inputVariable===nullならactivationsのvariableとして解釈する。
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
    this.units = units; // 出力ノード数
    this.initWeightsInfo = { units,weightsInitType,fanIn,fanOut };
  }

  // 前の層の出力ノード数
  build(inputShape, onLog) {
    this.outputShape = [this.units]
    
    if (!Array.isArray(inputShape) || inputShape.length !== 1) {
      const text = !Array.isArray(inputShape)
        ? '(配列でない型が入力されています。)'
        : `(${inputShape.length}次元が入力されています。)`;
      this.throwError('build', `Dense層の入力は一次元配列でなければいけません。${text}`)
    }
    super.build(inputShape, onLog);
    // TODO: ここで入出力サイズに合わせた「重みテクスチャ」をWebGLで確保する
  }
  
  initialize() {
    super.initialize();
    this.weights = this.getInitWeights({ len: this.totalInputLength*this.totalOutputLength, type: this.initWeightsInfo.weightsInitType, fanIn: this.initWeightsInfo.fanIn, fanOut: this.initWeightsInfo.fanOut });
    this.biases = new Float32Array(this.totalOutputLength).fill(0.0);
    super.optimizerInit({ weightLength: this.totalInputLength*this.totalOutputLength, biasLength: this.totalOutputLength });
    super.activationInit();
  }
  
  toMCLM({ weightsInclude, precision }) {
    if (!weightsInclude) {
      return {
        activation: this.activation,
        units: this.units
      }
    }
    return {
      activation: this.activation,
      units: this.units,
      b: this.getJoinedWeights(precision).biases,
      w: this.getJoinedWeights(precision).weights
    }
  }

  // batchSizeは学習時のTarget Networkでのみ使用。
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
    
    // outIdx*totalIn+inIdx で直接インデックス計算し、
    // 内積はローカル変数sumに貯めてから一括書き込みする。
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
    /*
      i: 前層、j: 現在の層
      delta^l_j = fPrime^l(u^l_j)*duList_j
      delta^(l-1)_i = f^(l-1)'(u^(l-1)_i)*sum[j=0~n^l-1] delta^l_j*w^l_ij
      ∂L/∂w^l_ij = delta^l_j*z^(l-1)_i
    */
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
    
    // l-1層目のノード数
    const totalIn = this.totalInputLength;
    // l層目のノード数(=this.units)
    const totalOut = this.totalOutputLength;
    const retDuList = new Float32Array(totalIn*batchSize);
    
    const savedValues = this.savedValues;
    
    // 更新用
    const weightsOriginal = this.weights;
    const biasesOriginal = this.biases;
    // 取得用
    const weights = new Float32Array(weightsOriginal);
    const biases = new Float32Array(biasesOriginal)
    
    const inputs = this.inputs;
    
    let duListOffset = 0;
    let retDuListOffset = 0;
    let weightOffset = 0;
    let inputOffset = 0;
    // z^(l-1)_i
    let z;
    // w^(l+1)_0j
    let b;
    // w^(l+1)_ij
    let w;
    // f^l'(u^l_i)
    let fPrime
    // delta^(l+1)_j
    let du;
    let sum;
    // batch毎のdeltaを保存しておくリスト
    const deltaList = new Float32Array(totalOut);
    
    const isCheck = this.isCheck;
    
    if (isCheck) {
      let index;
      index = duList.findIndex(value => value == null || Number.isNaN(value));
      if (index !== -1)
        this.throwError('backward', `duListに無効な値が含まれています(NaN, null相当)。units: ${this.units}, duList[${index}付近]: ${this.showArrayAroundIndex(duList, index, 5)}`);
    }
    
    // バッチ全体の勾配累積バッファ
    const dW = new Float32Array(totalOut * totalIn);
    const dB = new Float32Array(totalOut);
    
    let wBase;
    
    let delta;
    const startTime = Date.now();
    // 入力層側のノードをループ
    for (let batchIdx = 0; batchIdx < batchSize; batchIdx++) {
      duListOffset = batchIdx * totalOut;
      retDuListOffset = batchIdx * totalIn;
      inputOffset = batchIdx * totalIn;
      // δ^l_j
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
      // L2ノルムの計算 (|g|^2)
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
      // ノルムが閾値を超えていたら縮小スケーリング
      if (totalNorm > maxNorm) {
        // 零除算防止
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
      // クリッピングがオフの場合
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
    
    // batchを累積して各重みを一度だけ更新。
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
        if (isCheck && (weightsOriginal[weightOffset] == null || Number.isNaN(weightsOriginal[weightOffset])))
          this.throwError('backward',`weightで数値エラーになりました。units=${this.units}, weightOffset=${weightOffset}, optFunc=${optFunc}`)
      }
    }
    
    // console.log('DenseLayerのbackwardに要した時間 : '+String((Date.now()-startTime)/1000)+' s');
    if (this.weights.findIndex(value => value == null || Number.isNaN(value)) !== -1)
      this.throwError('backward', 'weightsに無効な値が含まれています。');
    return retDuList;
  }
}

class BaseSpatialLayer extends Layer {
  // type...max | avg
  /*
    conv:
      - activation
      - filter
      - padding
      - kernel
      - strides
      - deficit
      - weightsInitType
      - fanIn
      - fanOut
  */
  /*
    Pooling:
      - activation
      - type
      - padding
      - kernel
      - strides
      - deficit
  */
  constructor({ activation=null, type=null, filter=null, padding, kernel, strides, deficit=true, weightsInitType, fanIn, fanOut }) {
    super({ activation, type, filter, padding, kernel, strides, deficit, weightsInitType, fanIn, fanOut });
    super.construct();
    this.activation = activation;
    if (filter != null)
      this.filter = filter;
    if (type != null)
      this.type = type;
    this.kernel = null;
    this.originalKernel = kernel;
    this.originalPadding = padding;
    this.originalStrides = strides;
    this.deficit = deficit;
    this.outputShape = [];
    this.initWeightsInfo = { weightsInitType, fanIn, fanOut }
  }
  
  getInfo() {
    const commonInfo = super.getInfo();
    const retData = {
      ...commonInfo,
      activation: this.activation,
      kernel: this.kernel,
      padding: this.padding,
      strides: this.strides,
      deficit: this.deficit
    }
    if (this.filter != null)
      retData.filter = this.filter;
    if (this.type != null)
      retData.type = this.type;
    return retData;
  }

  // 各次元ごとのサイズとパディング（margin）を計算する共通メソッド
  #miniBuild(inputLength, kernel, stride, layerName) {
    let outputLength;
    let padding;
    let nonPadLength;
    
    if (Number.isInteger(this.originalPadding)) {
      if (this.originalPadding < 0) {
        this.throwError('build', `${layerName}のpaddingは非負整数または'same'である必要があります。`);
      }
      const originalPadding = this.originalPadding;

      if (this.deficit === false) {
        nonPadLength = inputLength;
        // 端数が出た場合も最後の要素までカバー（切り上げ）
        outputLength = 1 + Math.ceil((inputLength + 2 * originalPadding - kernel) / stride);
        const totalPaddingNeeded = (outputLength - 1) * stride + kernel - inputLength;
        
        const padBefore = originalPadding;
        // 後半の余白をpadding以上に拡張して帳尻を合わせる
        const padAfter = Math.max(originalPadding, totalPaddingNeeded - padBefore);
        padding = [padBefore, padAfter];
      } else {
        nonPadLength = inputLength-(inputLength+2*originalPadding-kernel)%stride;
        // 切り捨てモード
        outputLength = 1 + Math.floor((inputLength + 2 * originalPadding - kernel) / stride);
        padding = [originalPadding, originalPadding];
      }

    } else if (this.originalPadding === 'same') {
      nonPadLength = inputLength;
      outputLength = Math.ceil(inputLength / stride);
      const totalPadding = Math.max(0, (outputLength - 1) * stride + kernel - inputLength);
      const padBefore = Math.floor(totalPadding / 2);
      const padAfter = totalPadding - padBefore;
      padding = [padBefore, padAfter];
      
    } else {
      this.throwError('build', `${layerName}のpaddingは非負整数または'same'である必要があります。`);
    }

    // サイズ合わない対策：出力が0以下になったらエラー
    if (outputLength <= 0) {
      this.throwError('build', `${layerName}の入力サイズに対してウィンドウサイズ(kernel/poolSize)が大きすぎます。(計算された出力サイズ: ${outputLength})`);
    }

    return { outputLength, padding, nonPadLength };
  }

  // 1D〜3Dの各次元のループ処理を一般化したもの
  executeSpatialBuild(inputShape, spatialDims, layerName) {
    this.dim = spatialDims;
    this.outputShape = [];
    this.padding = [];
    this.nonPadLength = [];
    
    this.kernel = typeof this.originalKernel === 'number' ? new Array(spatialDims).fill(this.originalKernel) : this.originalKernel;
    this.strides = typeof this.originalStrides === 'number' ? new Array(spatialDims).fill(this.originalStrides) : this.originalStrides;

    for (let dim = 0; dim < spatialDims; dim++) {
      const inputLength = inputShape[dim];
      // 数値ならそのまま、配列ならインデックスから取得
      const kernel = this.kernel[dim];
      const stride = this.strides[dim];

      const { outputLength, padding, nonPadLength } = this.#miniBuild(inputLength, kernel, stride, layerName);
      this.outputShape.push(outputLength);
      this.padding.push(padding);
      this.nonPadLength.push(nonPadLength);
    }
    
    this.flatPadding = this.padding.flat(Infinity);
  }
  
  initialize() {
    super.initialize();
    // 畳み込み層なら
    if (this.getKind().startsWith('Conv')) {
      this.weights = this.getInitWeights({
        // k_w,k_w,C_in,C_outの積の数だけの重み
        len: this.kernel.reduce((acc,cur)=>acc*cur,1)
          * this.inputShape[this.inputShape.length-1]
          * this.filter,
        type:
          this.initWeightsInfo.weightsInitType,
        fanIn:
          this.initWeightsInfo.fanIn,
        fanOut:
          this.initWeightsInfo.fanOut
      });
      this.biases = new Float32Array(this.filter).fill(0.0);
    }
    
    // this.DIndexesとthis.kernelSizeを設定
    this.#generateD();
    
    super.activationInit();
  }
  
  #generateD () {
    // ここで作るDとは、一つのフィルタに対する重みの中の、
    // 一つのチャンネルに対する重みのインデックス対応。
    // つまりH,Wの入力をカーネルが走査する時の、
    // ある出力における足し合わされる入力のH,Wの座標データ。
    
    const outputTableSize = this.outputShape.slice(0,this.outputShape.length-1).reduce((acc,cur)=>acc*cur,1);
    
    const inputShapes = this.inputShape;
    const outputShapes = this.outputShape;
    const kernels = this.kernel;
    const startPaddings = this.padding.map(padding => padding[0]);
    const strides = this.strides;
    const nonPadLengths = this.nonPadLength;
    
    const kernelSize = kernels.reduce((acc,cur)=>acc*cur,1);
    const totalDim = kernels.length;
    // const originDimCoords = new Array(totalDim).fill(0);
    
    /*
      例で考える。必要な変数だけ記述する。
      入力サイズ: H:5,W:4
      kernel: 3*3
      strides: 1
      padding: 0
      の時、
      出力サイズは
      3*2である。この3*2の各要素を構成するカーネルの
      各要素を構成する入力のindex(C=1の時のindex)
      を集めたものをDとする。
      output -> kernel(3*3)...input(このうちの3*3)
    */
    
    // 高速化: 旧実装はDKernelIdxes(Uint32Array)も同時に作っていたが、
    // DKernelIdxes[outputIdx*kernelSize+kernelIdx] は常に kernelIdx 自身と一致する
    // (offsetの下位ビットがそのままkernelIdxになる作りのため)。
    // 無意味な配列確保・書き込み・forwardConv内での読み出しなので廃止。
    const DIndexes = new Int32Array(outputTableSize * kernelSize);
    
    const dimFromOutputIdx = new Uint32Array(totalDim).fill(0);
    // カーネルの各要素を参照&各要素に対応する入力値
    for (let outputIdx = 0; outputIdx < outputTableSize; outputIdx++) {
      // kernel上のどの点にいるか(Cは除く。D,H,W)
      const dimCoords = new Array(totalDim).fill(0);
      for (let kernelIdx = 0; kernelIdx < kernelSize; kernelIdx++) {
        // kernel上のある点を構成する入力の値の座標
        let index = 0;
        let valid = true;
        
        // w+W*(h+H*(d+D*0))
        // indexと、inputの参照範囲に入っているかのチェック
        for (let dim = 0; dim < totalDim; dim++) {
          // スタート時index=0だからそのサイズは掛けられない。
          index *= inputShapes[dim];
          // ある次元での入力値の座標
          const dimIdx = dimFromOutputIdx[dim]*strides[dim]-startPaddings[dim] + dimCoords[dim];
          
          // 入力値が参照できるかチェック。
          const endIdx = nonPadLengths[dim];
          if (dimIdx < 0 || endIdx <= dimIdx) {
            valid = false;
            break;
          }
          index += dimIdx;
        }
        
        // valid===falseの場合(=paddingの時)、forwardでは値0が与えられる。
        const offset = outputIdx * kernelSize + kernelIdx;
        DIndexes[offset] = valid ? index : -1;
        
        // 次の次元別のindexへ
        for (let dim = totalDim-1; dim >= 0; dim--) {
          dimCoords[dim]++;
          // 桁上げしない
          if (dimCoords[dim] < kernels[dim])
            break;
          dimCoords[dim] = 0;
        }
      }
      
      for (let dim = totalDim - 1; dim >= 0; dim--) {
        dimFromOutputIdx[dim]++;
        // 桁上げしない
        if (dimFromOutputIdx[dim] < outputShapes[dim])
          break;
        dimFromOutputIdx[dim] = 0;
      }
    }
    this.DIndexes = DIndexes;
    this.kernelSize = kernelSize;
  }
  
  // this.activation入れてない！
  forwardConv(inputs, batchSize) {
    super.inputCheck(inputs, batchSize);
    this.inputs = inputs;
    
    const outputTableSize = this.outputShape.slice(0, this.outputShape.length - 1).reduce((acc, cur) => acc * cur, 1);
    const kernelSize = this.kernelSize;
    const totalInputLength = this.totalInputLength;
    const totalOut = this.totalOutputLength;
    const filter = this.filter;
    const weights = this.weights;
    const biases = this.biases;
    const outputs = new Float32Array(batchSize * totalOut);
    const DIndexes = this.DIndexes;
    
    const needY = this.needY;
    // シャローコピー！！
    const savedValues = this.savedValues;
    const func = this.func;
    
    const channelLength = this.inputShape[this.inputShape.length - 1];

    for (let batchIdx = 0; batchIdx < batchSize; batchIdx++) {
      const inputBatchOffset = batchIdx * totalInputLength;
      const batchOutOffset = batchIdx * totalOut;

      // フィルタごとの処理
      for (let filterIdx = 0; filterIdx < filter; filterIdx++) {
        const filterWeightOffset = filterIdx * (channelLength * kernelSize);
        const filterOutOffset = batchOutOffset + filterIdx * outputTableSize;
        
        // 出力の各ノードごとの処理(全てのchannelの和をとる)
        for (let outputTableIdx = 0; outputTableIdx < outputTableSize; outputTableIdx++) {
          const dOffset = outputTableIdx * kernelSize;
          const outIdx = filterOutOffset + outputTableIdx;
          let sum = biases[filterIdx];
          
          // 高速化: k(カーネル要素)を外側、channelを内側に入れ替え。
          // 旧実装はchannelが外側だったため、DIndexes[dOffset+k]をchannelLength回
          // 重複して読み直していた。この形ならDIndexesの読み出しはk毎に1回で済み、
          // 内側のinputsアクセスも連続アドレス(inBase+channelIdx)になりキャッシュに乗りやすい。
          for (let k = 0; k < kernelSize; k++) {
            const inIndex = DIndexes[dOffset + k];
            // paddingなどで参照範囲外ならスキップ
            if (inIndex < 0) continue;

            const inBase = inputBatchOffset + inIndex * channelLength;
            const wBase = filterWeightOffset + k;

            for (let channelIdx = 0; channelIdx < channelLength; channelIdx++) {
              sum += inputs[inBase + channelIdx] * weights[wBase + channelIdx * kernelSize];
            }
          }
          
          // バグ修正: 旧実装は savedValues[outputTableIdx+outputOffset] を使っていたが、
          // outputOffset が常に0のままだったため filter違い・batch違いで同じ場所を
          // 上書きしていた。outputsと同じ outIdx を使うよう修正。
          if (needY === false)
            savedValues[outIdx] = sum;
          if (func)
            sum = func(sum);
          if (needY === true)
            savedValues[outIdx] = sum;
          outputs[outIdx] = sum;
        }
      }
    }
    
    this.outputs = outputs;
    return outputs;
  }
  
  // this.activation入れてない！
  forwardPooling(inputs, batchSize) {
    super.inputCheck(inputs, batchSize);
    this.inputs = inputs;
    const inputTableSize = this.inputShape.slice(0, this.inputShape.length - 1).reduce((acc, cur) => acc * cur, 1);
    const outputTableSize = this.outputShape.slice(0, this.outputShape.length - 1).reduce((acc, cur) => acc * cur, 1);
    const totalOut = this.totalOutputLength;
    const outputs = new Float32Array(batchSize * totalOut);
    
    // バグ修正: 旧実装は this.D を参照していたが、this.D はどこにも設定されておらず
    // 未定義参照でクラッシュしていた({index}オブジェクトの配列を想定していたが、
    // 実際に#generateDが作るのはDIndexes/DKernelIdxesのフラットな型付き配列)。
    // convと同じ DIndexes をそのまま使う形に統一。
    const DIndexes = this.DIndexes;
    const kernelSize = this.kernelSize;
    
    const needY = this.needY;
    // シャローコピー！！
    const savedValues = this.savedValues;
    const func = this.func;
    
    const channelLength = this.inputShape[this.inputShape.length - 1];
    const isMax = this.type === 'max';
    
    let offsetOnAll = 0;
    let offsetByChannel = 0;

    for (let batchIdx = 0; batchIdx < batchSize; batchIdx++) {
      for (let channelIdx = 0; channelIdx < channelLength; channelIdx++) {
        // 高速化: 旧実装はbatch*channelの回数分 new Float32Array(outputTableSize) を
        // 確保・fillしていた(GC圧がかなり高かった)。スカラー変数に貯めて直接outputsへ書く形に変更。
        for (let outputTableIdx = 0; outputTableIdx < outputTableSize; outputTableIdx++) {
          const dOffset = outputTableIdx * kernelSize;
          let value = isMax ? -Infinity : 0;
          let count = 0;

          for (let k = 0; k < kernelSize; k++) {
            const inIndex = DIndexes[dOffset + k];
            // paddingなどで参照範囲外ならスキップ
            if (inIndex < 0) continue;

            const val = inputs[offsetOnAll + inIndex * channelLength + channelIdx];

            if (isMax) {
              if (val > value) value = val;
            } else {
              value += val;
            }
            count++;
          }

          // 全てpadding等で有効値がなかった場合のフォールバック
          if (isMax && count === 0) value = 0;
          // avgの場合は有効な要素数で割る
          if (!isMax && count > 0) value /= count;

          const idx = offsetByChannel + outputTableIdx;

          if (needY === false)
            savedValues[idx] = value;
          if (func)
            value = func(value);
          if (needY === true)
            savedValues[idx] = value;

          outputs[idx] = value;
        }
        offsetByChannel += outputTableSize;
      }
      offsetOnAll += channelLength * inputTableSize;
    }
    
    this.outputs = outputs;
    return outputs;
  }
  
  backwardConv(duList, batchSize) {
    super.duListCheck(duList, batchSize);
 
    const primeFunc = this.primeFunc;
    const savedValues = this.savedValues;
    const inputs = this.inputs;
    const DIndexes = this.DIndexes;
    const kernelSize = this.kernelSize;
 
    const outputTableSize = this.outputShape.slice(0, this.outputShape.length - 1).reduce((acc, cur) => acc * cur, 1);
    const totalInputLength = this.totalInputLength;
    const totalOut = this.totalOutputLength;
    const filter = this.filter;
    const channelLength = this.inputShape[this.inputShape.length - 1];
 
    // 更新用(実体)
    const weightsOriginal = this.weights;
    const biasesOriginal = this.biases;
    // 逆伝播計算用(更新前の値のスナップショット)
    const weights = new Float32Array(weightsOriginal);
 
    const retDuList = new Float32Array(totalInputLength * batchSize);
    const dW = new Float32Array(weightsOriginal.length);
    const dB = new Float32Array(filter);
 
    // ===== 勾配の集計 =====
    for (let batchIdx = 0; batchIdx < batchSize; batchIdx++) {
      const inputBatchOffset = batchIdx * totalInputLength;
      const batchOutOffset = batchIdx * totalOut;
 
      for (let filterIdx = 0; filterIdx < filter; filterIdx++) {
        const filterWeightOffset = filterIdx * (channelLength * kernelSize);
        const filterOutOffset = batchOutOffset + filterIdx * outputTableSize;
 
        for (let outputTableIdx = 0; outputTableIdx < outputTableSize; outputTableIdx++) {
          const outIdx = filterOutOffset + outputTableIdx;
          const delta = primeFunc(savedValues[outIdx]) * duList[outIdx];
          dB[filterIdx] += delta;
 
          const dOffset = outputTableIdx * kernelSize;
          for (let k = 0; k < kernelSize; k++) {
            const inIndex = DIndexes[dOffset + k];
            // paddingなどで参照範囲外ならスキップ
            if (inIndex < 0) continue;
 
            const inBase = inputBatchOffset + inIndex * channelLength;
            const wBase = filterWeightOffset + k;
 
            for (let channelIdx = 0; channelIdx < channelLength; channelIdx++) {
              const weightIdx = wBase + channelIdx * kernelSize;
              dW[weightIdx] += delta * inputs[inBase + channelIdx];
              retDuList[inBase + channelIdx] += delta * weights[weightIdx];
            }
          }
        }
      }
    }
 
    // ===== バッチ平均化 + 勾配クリッピング(DenseLayerと同様) =====
    const invBatch = 1 / batchSize;
    const maxNorm = this.gradientClipNorm;
    if (maxNorm != null && maxNorm > 0) {
      let sumSq = 0;
      for (let i = 0; i < filter; i++) {
        dB[i] *= invBatch;
        sumSq += dB[i] * dB[i];
      }
      for (let i = 0; i < dW.length; i++) {
        dW[i] *= invBatch;
        sumSq += dW[i] * dW[i];
      }
      const totalNorm = Math.sqrt(sumSq);
      if (totalNorm > maxNorm) {
        const scale = maxNorm / (totalNorm + 1e-6);
        for (let i = 0; i < filter; i++) dB[i] *= scale;
        for (let i = 0; i < dW.length; i++) dW[i] *= scale;
      }
    } else {
      for (let i = 0; i < filter; i++) dB[i] *= invBatch;
      for (let i = 0; i < dW.length; i++) dW[i] *= invBatch;
    }
 
    // ===== オプティマイザによる更新(DenseLayerと同様の分岐) =====
    const optType = this.optimizerType;
    const optFunc = this.optimizerFunc;
    const savedOptValues = this.savedOptValues;
    const {
      w_m = null, w_v = null, w_powBeta1 = null, w_powBeta2 = null,
      b_m = null, b_v = null, b_powBeta1 = null, b_powBeta2 = null
    } = savedOptValues ?? {};
 
    for (let filterIdx = 0; filterIdx < filter; filterIdx++) {
      const gradB = dB[filterIdx];
      const b = biasesOriginal[filterIdx];
      switch (optType) {
        case "sgd":
          biasesOriginal[filterIdx] = optFunc(b, gradB)[0];
          break;
        case "momentum":
        case "rmsprop":
          [
            savedOptValues.b_v[filterIdx],
            biasesOriginal[filterIdx]
          ] = optFunc(b_v[filterIdx], b, gradB);
          break;
        case "adam":
          [
            savedOptValues.b_powBeta1[filterIdx],
            savedOptValues.b_powBeta2[filterIdx],
            savedOptValues.b_m[filterIdx],
            savedOptValues.b_v[filterIdx],
            biasesOriginal[filterIdx]
          ] = optFunc(b_powBeta1[filterIdx], b_powBeta2[filterIdx], b_m[filterIdx], b_v[filterIdx], b, gradB);
          break;
      }
    }
 
    const weightLength = weightsOriginal.length;
    for (let weightIdx = 0; weightIdx < weightLength; weightIdx++) {
      const gradW = dW[weightIdx];
      const w = weightsOriginal[weightIdx];
      switch (optType) {
        case "sgd":
          weightsOriginal[weightIdx] = optFunc(w, gradW)[0];
          break;
        case "momentum":
        case "rmsprop":
          [
            savedOptValues.w_v[weightIdx],
            weightsOriginal[weightIdx]
          ] = optFunc(w_v[weightIdx], w, gradW);
          break;
        case "adam":
          [
            savedOptValues.w_powBeta1[weightIdx],
            savedOptValues.w_powBeta2[weightIdx],
            savedOptValues.w_m[weightIdx],
            savedOptValues.w_v[weightIdx],
            weightsOriginal[weightIdx]
          ] = optFunc(w_powBeta1[weightIdx], w_powBeta2[weightIdx], w_m[weightIdx], w_v[weightIdx], w, gradW);
          break;
      }
    }
 
    return retDuList;
  }
  
  backwardPooling(duList, batchSize) {
    super.duListCheck(duList, batchSize);
 
    const primeFunc = this.primeFunc;
    const savedValues = this.savedValues;
    const inputs = this.inputs;
    const DIndexes = this.DIndexes;
    const kernelSize = this.kernelSize;
 
    const inputTableSize = this.inputShape.slice(0, this.inputShape.length - 1).reduce((acc, cur) => acc * cur, 1);
    const outputTableSize = this.outputShape.slice(0, this.outputShape.length - 1).reduce((acc, cur) => acc * cur, 1);
    const channelLength = this.inputShape[this.inputShape.length - 1];
    const isMax = this.type === 'max';
    const totalInputLength = this.totalInputLength;
 
    const retDuList = new Float32Array(totalInputLength * batchSize);
 
    let offsetOnAll = 0;
    let offsetByChannel = 0;
 
    for (let batchIdx = 0; batchIdx < batchSize; batchIdx++) {
      for (let channelIdx = 0; channelIdx < channelLength; channelIdx++) {
        for (let outputTableIdx = 0; outputTableIdx < outputTableSize; outputTableIdx++) {
          const idx = offsetByChannel + outputTableIdx;
          const delta = primeFunc(savedValues[idx]) * duList[idx];
          const dOffset = outputTableIdx * kernelSize;
 
          if (isMax) {
            // forward時と同じ走査でargmaxを再探索し、そこにのみ勾配を流す。
            let maxVal = -Infinity;
            let maxInIdx = -1;
            for (let k = 0; k < kernelSize; k++) {
              const inIndex = DIndexes[dOffset + k];
              if (inIndex < 0) continue;
              const inIdx = offsetOnAll + inIndex * channelLength + channelIdx;
              const val = inputs[inIdx];
              if (val > maxVal) {
                maxVal = val;
                maxInIdx = inIdx;
              }
            }
            if (maxInIdx !== -1)
              retDuList[maxInIdx] += delta;
          } else {
            // avg: 有効な(padding外の)入力全てに均等に勾配を分配する。
            let count = 0;
            for (let k = 0; k < kernelSize; k++) {
              if (DIndexes[dOffset + k] >= 0) count++;
            }
            if (count > 0) {
              const share = delta / count;
              for (let k = 0; k < kernelSize; k++) {
                const inIndex = DIndexes[dOffset + k];
                if (inIndex < 0) continue;
                const inIdx = offsetOnAll + inIndex * channelLength + channelIdx;
                retDuList[inIdx] += share;
              }
            }
          }
        }
        offsetByChannel += outputTableSize;
      }
      offsetOnAll += channelLength * inputTableSize;
    }
 
    return retDuList;
  }
  
  toMCLM({ weightsInclude, precision }) {
    const retData = {
      activation: this.activation,
      kernel: this.originalKernel,
      strides: this.originalStrides,
      padding: this.originalPadding,
      deficit: this.deficit,
    }
    if (this.filter != null)
      retData.filter = this.filter;
    if (this.type != null)
      retData.type = this.type;
    if (weightsInclude && this.weights != null && this.biases != null)
      ({biases: retData.b, weights: retData.w} = this.getJoinedWeights(precision));
    
    return retData;
  }
}

class Conv1dLayer extends BaseSpatialLayer {
  constructor({ activation, filter, kernel, strides, padding, deficit, weightsInitType, fanIn, fanOut }) {
    super({ activation, filter, kernel, padding, strides, deficit, weightsInitType, fanIn, fanOut });
    if (filter == null)
      this.throwError("constructor", "引数にfilterが存在する必要があります。");
  }

  build(inputShape, onLog) {
    if (inputShape.length === 1) inputShape = [inputShape[0], 1];
    if (inputShape.length !== 2) {
      this.throwError('build', 'Conv1dLayerの入力形状は [W] または [W, C] である必要があります。');
    }

    // 1次元分の空間計算を実行
    this.executeSpatialBuild(inputShape, 1, 'Conv1dLayer');

    this.outputShape.push(this.filter); // W, C
    
    super.build(inputShape, onLog);
  }
  
  forward(inputs, batchSize) {
    return super.forwardConv(inputs, batchSize);
  }
  
  backward(duList, batchSize) {
    this.duListCheck(duList, batchSize);
    return super.backwardConv(duList, batchSize);
  }
}

class Conv2dLayer extends BaseSpatialLayer {
  constructor({ activation, filter, kernel, strides, padding, deficit, weightsInitType, fanIn, fanOut }) {
    super({ activation, filter, kernel, padding, strides, deficit, weightsInitType, fanIn, fanOut });
    if (filter == null)
      this.throwError("constructor", "引数にfilterが存在する必要があります。");
  }

  build(inputShape, onLog) {
    if (inputShape.length === 2) inputShape = [inputShape[0], inputShape[1], 1];
    if (inputShape.length !== 3) {
      this.throwError('build', 'Conv2dLayerの入力形状は [W, H] または [W, H, C] である必要があります。');
    }

    this.executeSpatialBuild(inputShape, 2, 'Conv2dLayer');
    this.outputShape.push(this.filter); // W, H, C
    super.build(inputShape, onLog);
  }
  
  forward(inputs, batchSize) {
    return super.forwardConv(inputs, batchSize);
  }
  
  backward(duList, batchSize) {
    this.duListCheck(duList, batchSize);
    return super.backwardConv(duList, batchSize);
  }
}

class Conv3dLayer extends BaseSpatialLayer {
  constructor({ activation, filter, kernel, strides, padding, deficit, weightsInitType, fanIn, fanOut }) {
    super({ activation, filter, kernel, padding, strides, deficit, weightsInitType, fanIn, fanOut });
    if (filter == null)
      this.throwError("constructor", "引数にfilterが存在する必要があります。");
  }

  build(inputShape, onLog) {
    if (inputShape.length === 3) inputShape = [inputShape[0], inputShape[1], inputShape[2], 1];
    if (inputShape.length !== 4) {
      this.throwError('build', 'Conv3dLayerの入力形状は [W, H, D] または [W, H, D, C] である必要があります。');
    }

    this.executeSpatialBuild(inputShape, 3, 'Conv3dLayer');
    this.outputShape.push(this.filter); // W, H, D, C
    super.build(inputShape, onLog);
  }
  
  forward(inputs, batchSize) {
    return super.forwardConv(inputs, batchSize);
  }
  
  backward(duList, batchSize) {
    this.duListCheck(duList, batchSize);
    return super.backwardConv(duList, batchSize);
  }
}

class Pooling1dLayer extends BaseSpatialLayer {
  constructor({ activation, type, kernel, strides, padding, deficit, weightsInitType, fanIn, fanOut }) {
    super({ activation, type, kernel, strides, padding, deficit, weightsInitType, fanIn, fanOut });
    this.type = type; // 'max' または 'avg'
  }

  build(inputShape, onLog) {
    if (inputShape.length === 1) inputShape = [inputShape[0], 1];
    if (inputShape.length !== 2) {
      this.throwError('build', 'Pooling1dLayerの入力形状は [W] または [W, C] である必要があります。');
    }

    this.executeSpatialBuild(inputShape, 1, 'Pooling1dLayer');

    this.outputShape.push(inputShape[1]); // 入力チャンネル C をそのまま引き継ぐ
    super.build(inputShape, onLog);
  }
  
  forward(inputs, batchSize) {
    return super.forwardPooling(inputs, batchSize);
  }
  
  backward(duList, batchSize) {
    this.duListCheck(duList, batchSize);
    return super.backwardPooling(duList, batchSize);
  }
}

class Pooling2dLayer extends BaseSpatialLayer {
  constructor({ activation, type, kernel, strides, padding, deficit, weightsInitType, fanIn, fanOut }) {
    super({ activation, type, kernel, strides, padding, deficit, weightsInitType, fanIn, fanOut });
  }

  build(inputShape, onLog) {
    if (inputShape.length === 2) inputShape = [inputShape[0], inputShape[1], 1];
    if (inputShape.length !== 3) {
      this.throwError('build', 'Pooling2dLayerの入力形状は [W, H] または [W, H, C] である必要があります。');
    }

    this.executeSpatialBuild(inputShape, 2, 'Pooling2dLayer');
    this.outputShape.push(inputShape[2]); // 入力チャンネル C をそのまま引き継ぐ
    super.build(inputShape, onLog);
  }
  
  forward(inputs, batchSize) {
    return super.forwardPooling(inputs, batchSize);
  }
  
  backward(duList, batchSize) {
    this.duListCheck(duList, batchSize);
    return super.backwardPooling(duList, batchSize);
  }
}

class Pooling3dLayer extends BaseSpatialLayer {
  constructor({ activation, type, kernel, strides, padding, deficit, weightsInitType, fanIn, fanOut }) {
    super({ activation, type, kernel, strides, padding, deficit, weightsInitType, fanIn, fanOut });
  }

  build(inputShape, onLog) {
    if (inputShape.length === 3) inputShape = [inputShape[0], inputShape[1], inputShape[2], 1];
    if (inputShape.length !== 4) {
      this.throwError('build', 'Pooling3dLayerの入力形状は [W, H, D] または [W, H, D, C] である必要があります。');
    }

    this.executeSpatialBuild(inputShape, 3, 'Pooling3dLayer');
    this.outputShape.push(inputShape[3]); // 入力チャンネル C をそのまま引き継ぐ
    super.build(inputShape, onLog);
  }
  
  forward(inputs, batchSize) {
    return super.forwardPooling(inputs, batchSize);
  }
  
  backward(duList, batchSize) {
    this.duListCheck(duList, batchSize);
    return super.backwardPooling(duList, batchSize);
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
    
    // 高速化: Flattenは形状のメタデータを変えるだけで、内部のメモリレイアウトは
    // そのまま流用できる。前層の出力(既にFloat32Array)を毎stepコピーする必要はない。
    const outputs = inputs instanceof Float32Array ? inputs : new Float32Array(inputs);
    this.outputs = outputs;
    return outputs;
  }
  
  backward(inputs, batchSize) {
    super.duListCheck(inputs, batchSize);
    return inputs;
  }
}




class WebGL extends Common {
  constructor(layers) {
    super();
    this.layers = layers;
  }
  
  generateGlslCode() {
    
  }
}


export { CogniKeel, Layer };
  
