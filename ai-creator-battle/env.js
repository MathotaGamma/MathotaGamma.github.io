/*
  reset()で状態を初期に戻す(done後など)。
  step(action)で、state,action,現在のstateでactionを取ったときの報酬(reward),次の状態(nextState),終了判定(done)を取得。
*/

// 画面サイズは-1~1より、幅2、高さ2

// ===== cartpole =====
/*
  cartpole
   - shape: [ 4 ] , -1 〜 +1 || 台車のX, Y座標 : 2 | 棒の角度(最下点...-1, 最高点...+1) : 1 | 棒の角速度 : 1
*/
class Cartpole {
  static gameKind = "cartpole";
  static aspectRatio = 2.0;
  
  static fixedDt = 0.016;
  static forceSize = 0.1;
  static g = 9.8;
  static m = 0.1;
  static M = 1;
  static halfL = 0.5;

  
  static cartSize = {
    w: 0.4,
    h: 0.2
  }

  // inputIdxは無い。
  constructor({ canvas, fixedAspect='width' }) {
    this.inputIdx = null;
    this.canvas = canvas;
    const aspectRatio = Cartpole.aspectRatio;
    if (fixedAspect === 'width')
      this.canvas.height = this.canvas.width/aspectRatio;
    else
      this.canvas.width = this.canvas.height*aspectRatio;
    
    const ctx = this.canvas.getContext('2d');
    this.ctx = ctx;
    // x, v, theta, omega
    this.reset();
  }

  // inputIdxに分岐がある場合は、getCurrentState内で条件分岐させる。
  getCurrentState() {
    const state = new Float32Array(4);
    state[0] = this.x;
    state[1] = this.v / 10.0;
    state[2] = this.theta / Math.PI;
    state[3] = this.omega / 10.0;
    return state;
  }

  getReward(action) {
    const angleReward = Math.cos(this.theta);
    const positionPenalty = Math.abs(this.x);
    if (Number.isNaN(angleReward) || Number.isNaN(positionPenalty))
      throw new Error(`angleReward: ${angleReward}, positionPenalty: ${positionPenalty}`);
    return angleReward - positionPenalty * 0.5;
  }

  reset() {
    // x: -1~-1
    this.x = 0;
    this.v = 0;
    this.theta = Math.PI;
    this.omega = 0;
  }

  calcEnv(action) {
    let done = false;
    let f = 0;
    if (action === 0) f = -Cartpole.forceSize;
    else if (action === 1) f = Cartpole.forceSize;
    
    const fixedDt = Cartpole.fixedDt;
    const g = Cartpole.g, m = Cartpole.m, M = Cartpole.M, halfL = Cartpole.halfL;
    const x = this.x, v = this.v, theta = this.theta, omega = this.omega;

    const sin = Math.sin(this.theta);
    const cos = Math.cos(theta);
    const w = (g * sin + cos * (-f - m * halfL * omega * omega * sin) / (M + m))
                / (halfL * (4 / 3 - m * cos * cos / (M + m)));
    const a = (f + m * halfL * (omega * omega * sin - w * cos)) / (M + m);

    this.v += a * fixedDt;
    this.v *= 0.995;
    this.x += this.v * fixedDt;
    this.omega += w * fixedDt;
    this.omega *= 0.999;
    this.theta += this.omega * fixedDt;
    this.theta = Math.atan2(Math.sin(this.theta), Math.cos(this.theta));

    if (Math.abs(x) > 1) {
      done = true;
      this.reset();
    }

    return done;
  }

  // アスペクト比による潰れの対策は、縦方向は0 ~ 1(wの半分)とする(halfWを使用する)
  draw() {
    // 横は 0 ~ 2, 縦は 0 ~ 1
    // 中心の座標は(1, 1)
    const ratio = this.canvas.width/2;
    const halfL = Cartpole.halfL;
    const ctx = this.ctx;
    const cartSize = Cartpole.cartSize;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // カート
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(ratio*(1 + this.x - cartSize.w / 2), ratio*(0.7 - cartSize.h), ratio*cartSize.w, ratio*cartSize.h);

    // 振り子
    const pivotX = 1 + this.x;
    const pivotY = 0.7 - cartSize.h;
    const poleLength = 2 * halfL;
    const tipX = pivotX + poleLength * Math.sin(this.theta);
    const tipY = pivotY - poleLength * Math.cos(this.theta);

    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(ratio*pivotX, ratio*pivotY);
    ctx.lineTo(ratio*tipX, ratio*tipY);
    ctx.stroke();

    /*
    // パネルテキスト更新
    const infoPanel = document.getElementById('info-panel');
    infoPanel.innerHTML = `
          <strong>CogniKeel Pendulum Control</strong><br>
          <hr>
          Mode: <span style="color:${isEvaluation ? '#00ffcc' : '#aaa'}">${isEvaluation ? 'EVALUATION (探索OFF)' : 'TRAINING'}</span><br>
          Episode: ${episodeCount}<br>
          Epoch Step: ${epochCount} / ${epochCountLength}<br>
          Epsilon: ${isEvaluation ? 0 : (ck.epsilon ? ck.epsilon.toFixed(4) : 'N/A')}<br>
          Episode累積報酬: ${totalReward.toFixed(2)}<br>
          <strong>Eval平均累積報酬: ${lastEvaluationResult}</strong><br>
          <hr>
          Action: ${currentAction} (${isUserInteracting ? 'Manual ' : ''}${moveDir || 'Stay'})<br>
          Angle: ${(theta * 180 / Math.PI).toFixed(1)}°
        `;
      }
      */
  }
  
  // { state, action, reward, nextState, done } を返す。
  step(action) {
    if (action == null || !Number.isFinite(action))
      throw new Error('actionが期待する形式と異なります(action: '+action+')。');
    const retData = {
      state: this.getCurrentState(),
      action,
      reward: this.getReward(action)
    };
    retData.done = this.calcEnv(action);
    retData.nextState = this.getCurrentState();
    this.draw();
    return retData;
  }
}

// ===== breakout =====
// 作り途中
class Breakout {
  static gameKind = 'breakout';
  static aspectRatio = 1.0;

  static fixedDt = 0.016;
  
  constructor(inputIdx) {
    this.inputIdx = inputIdx;
  }
}


export { Cartpole, Breakout };
