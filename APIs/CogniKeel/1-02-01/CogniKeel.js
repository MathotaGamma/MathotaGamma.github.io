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
  
  Xorshift32(seed=null) {
    let x = seed==null ? this.seed : seed;

    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.seed = x;
    return x / 4294967296;
  }
}

class CogniKeel extends Common {
  // 例: [84,84,4]...84*84*4の入力(例えば84px*84pxの画像過去4フレーム)
  constructor({ inputShape, order, replayBufferSize=100000, useWebGL=false, onLog=null }) {
    super();
    if (order == null || inputShape == null)
      this.throwError('constructor', '引数にinputShape,orderが必要です。');
    this.order = order;
    // this.indexesとthis.inputShape設定
    const {indexes, targetShape: convertedInputShape} = this.applyOrder(inputShape);
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
    this.onlineNetwork = onlineNetwork;
    
    const targetNetwork = new Network({ ckInstance: this, inputShape: this.inputShape, onLog: this.onLog, useWebGL: this.useWebGL });
    this.targetNetwork = targetNetwork;
    
    this.replayBuffer = new ReplayBuffer(replayBufferSize);
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
    this.onlineNetwork.setLogger(logger);
  }
  
  // 設定
  configure ({
    // webglを使うか
    useWebGL=false,
    // 学習率
    learningRate=0.001,
    // 割引率
    gamma=0.99,
    // 一回の学習で使用するreplayの数
    batchSize=32,
    // 経験バッファの容量
    replayBufferSize=100000,
    // 学習する最低の経験バッファサイズ
    minReplayBufferLength=1000,
    // オプティマイザの種類(今は'adam'だけ)
    optimizer={
      type: 'adam',
      // 1次モーメント(勾配の平均)の減衰率
      beta1: 0.9,
      // 2次モーメント(振動の平均)の減衰率
      beta2: 0.999,
      // 零除算を避けるための小さな値
      epsilon: 1e-8
    },
    // 損失関数
    loss={
      type: 'huber',
      delta: 1.0
    },
    // 勾配クリッピング
    gradientClipNorm=10.0,
    
    // ===== ε-greedy =====
    // εの開始の値
    epsilonStart=1.0,
    // εの最終の値
    epsilonEnd=0.01,
    // εの減衰方法
    /*
      2種。
      
      exponential(係数倍していく)
      {
        type: "exponential",
        rate: 0.995
      }
      
      linear(start->endまでにかかるstep数指定)
      {
        type: "linear",
        steps: 100000
      }
    */
    epsilonDecay= {
      type: "linear",
      steps: 100000
    },
  })
  {
    if (this.status !== this.constructor.STATUS.UNBUILT && this.status !== this.constructor.STATUS.UNINITIALIZED) {
      this.logger('configure', 'Warn: STATUSがUNBUILTまたはUNINITIALIZEDの時のみ、configureを実行できます。');
      return;
    }
    this.useWebGL = useWebGL;
    
    this.learningRate = learningRate;
    this.gamma = gamma;
    this.batchSize = batchSize;
    this.replayBufferSize = replayBufferSize;
    this.minReplayLength = minReplayBufferLength;
    this.optimizer = optimizer;
    this.loss = loss;
    this.gradientClipNorm = gradientClipNorm;

    this.epsilonStart = epsilonStart;
    this.epsilonEnd = epsilonEnd;
    this.epsilonDecay = epsilonDecay;
    
    // これらの値を用いた設定
    this.epsilon = this.epsilonStart;
    this.replayBuffer.configure(this.minReplayLength);
    this.onlineNetwork.useWebGL = useWebGL;
    this.targetNetwork.useWebGL = useWebGL;
    
    this.logger('configure', '設定を変更しました。');
  }
  
  // 選んだ行動以外には損失関数は利用しない！
  static lossFuncs = {
    // 二乗誤差
    "mse": {
      func: (td, y) => (td-y)*(td-y)/2,
      primeFunc: (td, y) => (td-y)
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
        const dif = td-y;
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
      primeFunc: (td, y) => Math.sign(td-y)
    }
  }
  
  addLayers(layers) {
    this.onlineNetwork.addLayers(layers);
  }
  
  initialize() {
    if (this.status !== this.constructor.STATUS.UNINITIALIZED) {
      this.logger('initialize', '初期化はstatusが'+this.constructor.STATUS.UNINITIALIZED+'時に行う必要があります。');
      return;
    }
    this.statusUpdate('INITIALIZING');
    this.onlineNetwork.initialize();
    this.statusUpdate('READY')
  }
  
  // まだ完成していない
  // precisionは、full, high, medium, low, lower, leastで、重みなどの保存桁数を指定する
  createMCLM(precision='high') {
    let content = '';
    function getHeader({ stepCount, precision }) {
      return `precision ${precision}
stepCount ${stepCount == 0 ? 'null' : String(stepCount)}`
    }
    
    content += getHeader({ stepCount: this.stepCount, precision });
    
    const layers = this.onlineNetwork.layers;
    
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
  
  getOutputs(type="string") {
    return this.onlineNetwork.getOutputs(type);
  }
  
  getInfo(type="object") {
    return this.onlineNetwork.getInfo(type);
  }
  
  applyOrder(shape) {
    const order = this.order;
    const ndim = order.length;
    
    
    const targetOrder = ({
      2: ["H", "W"],
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
    
    const { actions, performances } = this.#forward({
      inputs: state,
      batchSize: 1,
      isPreserve: true,
      isLearn: true,
    });
    
    if (actions == null)
      this.throwError('step', '#forwardの戻り値が不正です。')
    
    // epsilon Greedy法で行動を決める
    const { action, performance } = this.#epsilonGreedy({
      actions,
      forceEpsilon: null,
    });
    
    performances.push(performance);
    
    if (action == null)
      this.throwError('step', `#epsilonGreedyの戻り値が不正です。`);
    
    // ここで一度返す。
    // ck.rememberをクラス外で実行するため、
    // 別のメソッドに分割する。
    
    return { action, performances };
  }
  
  evaluationStep(state) {
    // 現在の状態に対するonline Q-Tableの出力を得る
    const { actions, performances } = this.#forward({
      inputs: state,
      batchSize: 1,
      isPreserve: false,
      isLearn: false,
    });
    
    if (actions == null)
      this.throwError('evaluationStep', '#forwardの戻り値が不正です。')
    
    // epsilon Greedy法で行動を決める
    const { action, performance } = this.#epsilonGreedy({
      actions,
      forceEpsilon: 0
    });
    performances.push(performance);
    
    if (action == null)
      this.throwError('evaluationStep', '#epsilonGreedyの戻り値が不正です。')
    
    // ここで一度返す。
    // ck.rememberをクラス外で実行するため、
    // 別のメソッドに分割する。
    
    return { action, performances };
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
    this.replayBuffer.add(structuredClone({
      state, action, reward, nextState, done
    }));
  }
  
  // batchSizeなどはconfigureで決めている
  learn() {
    
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
    
    return this.onlineNetwork.forward(convertedInputs, batchSize);
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
    let startTime = performance.now();
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
        return { action: maxIdx, performance: performance.now()-startTime };
      } else {
        if (actions.length === 0)
          return { action: null, performance: performance.now()-startTime };
        return { action: Math.floor(actions.length*this.Xorshift32()), performance: performance.now()-startTime };
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
        return { action: maxIdx, performance: performance.now()-startTime };
      } else {
        if (actions.length === 0)
          return { action: null, performance: performance.now()-startTime };
        return { action: Math.floor(actions.length*this.Xorshift32()), performance: performance.now()-startTime };
      }
    }
  }
  
  updateTargetNetwork() {
    const weights = this.onlineNetwork.getWeights();
    this.targetNetwork.setWeights(weights);
  }
}

class ReplayBuffer extends Common {
  constructor(config) {
    super();
    this.configure(config);
    this.replayBuffer = [];
  }
  
  configure(replayBufferSize) {
    this.replayBufferSize = replayBufferSize;
  }
  
  add(replay) {
    if (!this.replayBufferSize || !Number.isInteger(this.replayBufferSize) || this.replayBufferSize <= 0)
      this.throwError('remember', 'configureで設定するreplayBufferSizeは自然数の値を要求します。現在は不正な値が入っています。');
    this.replayBuffer.push(replay);
    while (this.replayBuffer.length > this.replayBufferSize) {
      this.replayBuffer.shift();
    }
  }
  
  len() {
    return this.replayBuffer.length;
  }
}

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
  
  setLogger(logger) {
    this.onLog = logger;
    for (const layer of this.layers) {
      layer.onLog = logger;
    }
  }
  
  addLayers(layers) {
    if (layers.length === 0) return;
    if (this.layers.length === 0) {
      const layer = layers.shift();
      // constructorで自動実行されるaddLayers([InputLayer]);
      if (layer.getKind() === 'InputLayer') {
        layer.build(null, this.onLog);
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
    
    this.ckInstance.statusUpdate('UNINITIALIZED');
  }
  
  forward(inputs, batchSize) {
    let result;
    if (this.useWebGL)
      result = this.#forwardWebGL(inputs, batchSize);
    else
      result = this.#forwardJS(inputs, batchSize);
    
    return result;
  }
  
  #forwardJS(inputs, batchSize) {
    const outputs = [];
    
    let nextLayerInput = inputs;
    const performances = [];
    
    for (let layer of this.layers) {
      const startTime = performance.now();
      nextLayerInput = layer.forward(nextLayerInput, batchSize);
      performances.push(performance.now()-startTime);
    }
    return { actions: nextLayerInput, performances };
  }
  
  #forwardWebGL(inputs, batchSize) {
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
  constructor() {
    super();
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
  
  getKind() {
    return this.constructor.name;
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
    
    return 'biases : '+b?.join(' ')+'weights : '+w?.join(' ');
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
  
  // initializeの最後に記述。
  // this.activationからthis.savedValues, this.func, this.primeFunc
  activationInit() {
    // 'Y'...true, 'X'...false, activationなし...null
    this.needY = ActivationLayer.activations[this.activation]?.variable === 'Y';
    this.savedValues = new Float32Array(this.totalOutputLength);
    this.func = ActivationLayer.activations[this.activation]?.func;
    
    this.primeFunc = ActivationLayer.activations[this.activation]?.primeFunc;
  }
  
  inputCheck(inputs, batchSize) {
    if (inputs.length !== this.totalInputLength*batchSize)
      this.throwError('forward', `入力の要素数が一致しません。期待値: ${this.totalInputLength*batchSize}, 実際の値: ${inputs.length}`);
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

    } else if (type === 'zeros') {
      // バイアス用（0初期化）
      retWeights.fill(0);

    } else {
      this.throwError('getInitWeights', `未対応の初期化タイプです: ${type}`);
    }
    
    return retWeights;
  }
}

class InputLayer extends Layer {
  constructor({ inputShape }) {
    super();
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
}

class ActivationLayer extends Layer {
  constructor({ type }) {
    super();
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
      funcPrime: (y) => y*(1-y)
    },
    'tanh': {
      variable: 'Y',
      func: (x) => Math.tanh(x),
      funcPrime: (y) => 1-y*y
    },
    'ReLU': {
      variable: 'X',
      func: (x) => Math.max(0,x),
      funcPrime: (x) => x > 0 ? 1 : 0
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
    super();
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
    super.activationInit();
  }
  
  toMCLM(precision) {
    return {
      activation: this.activation,
      units: this.units,
      w: this.getJoinedWeights(precision)
    }
  }

  forward(inputs, batchSize) {
    super.inputCheck(inputs, batchSize);
    this.inputs = inputs;
    
    if (batchSize == null)
      this.logger("Dense Forward実行");
    
    const outputs = new Float32Array(this.totalOutputLength*batchSize);
    
    const totalOut = this.totalOutputLength;
    const totalIn = this.totalInputLength;
    const weights = this.weights;
    const biases = this.biases;
    
    const needY = this.needY;
    const savedValues = this.savedValues;
    const func = this.func;

    // 高速化 & バグ修正:
    // 旧実装は weightIdx を outIdx/batchIdx/inIdx を跨いで通しでインクリメントしつつ
    // weightSize で剰余を取っていた(毎要素で除算発生 + batchSize>=2で重みがズレるバグ)。
    // outIdx*totalIn+inIdx で直接インデックス計算する形に変更し、
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
        if (func)
          sum = func(sum);
        if (needY)
          savedValues[idx] = sum;

        outputs[idx] = sum;
      }
    }
    
    this.outputs = outputs;
    return outputs;
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
  constructor({ activation=null, type=null, filter=null, padding, kernel, strides, deficit = true, weightsInitType, fanIn, fanOut }) {
    super();
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
  
  toMCLM(precision) {
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
    if (this.weights != null)
      retData.w = this.getJoinedWeights(precision);
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
}

class FlattenLayer extends Layer {
  constructor(args) {
    super();
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
}




class WebGL extends Common {
  constructor(layers) {
    super();
    this.layers = layers;
  }
  
  generateGlslCode() {
    
  }
}
