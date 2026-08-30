/*
  reset()で状態を初期に戻す(done後など)。
  step(action)で、state,action,現在のstateでactionを取ったときの報酬(reward),次の状態(nextState),終了判定(done)を取得。
*/


/*
  cartpole
   - shape: [ 4 ] , -1 〜 +1 || 台車のX, Y座標 : 2 | 棒の角度(最下点...-1, 最高点...+1) : 1 | 棒の角速度 : 1
*/
class Cartpole {
  static gameKind = "cartpole";
  static forceSize = 0.1;
  static g = 9.8;
  static m = 0.1;
  static M = 1;
  static halfL = 0.5;

  // inputIdxは無い。
  constructor(_) {
    this.inputIdx = null;
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
    const g = Cartpole.g, m = Cartpole.m, M = Cartpole.M, halfL = Cartpole.halfL;
    const x = this.x, v = this.v, theta = this.theta, omega = this.omega;

    const sin = Math.sin(this.theta);
    const cos = Math.cos(theta);
    const w = (g * sin + cos * (-f - m * halfL * omega * omega * sin) / (M + m))
                / (halfL * (4 / 3 - m * cos * cos / (M + m)));
    const a = (f + m * halfL * (omega * omega * sin - w * cos)) / (M + m);

    v += a * fixedDt;
    v *= 0.995;
    x += v * fixedDt;
    omega += w * fixedDt;
    omega *= 0.999;
    theta += omega * dt;
    theta = Math.atan2(Math.sin(theta), Math.cos(theta));

    if (Math.abs(x) > 1) {
      done = true;
      this.reset();
    }

    return done;
  }

  // { state, action, reward, nextState, done } を返す。
  step(action) {
    const retData = {
      state: this.getCurrentState(),
      action,
      reward: this.getReward(action)
    };
    retData.done = calcEnv(action);
    retData.nextState = this.getCurrentState();
    return retData;
  }
}


export { Cartpole };
