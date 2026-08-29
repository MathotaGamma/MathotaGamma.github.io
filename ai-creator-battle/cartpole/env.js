/*
  reset()で状態を初期に戻す(done後など)。
  step({ state, action })で、現在のstateでactionを取ったときの報酬(reward),次の状態(nextState),終了判定(done)を取得。
*/

/*
  cartpole
   - shape: [ 4 ] , -1 〜 +1 || 台車のX, Y座標 : 2 | 棒の角度(最下点...-1, 最高点...+1) : 1 | 棒の角速度 : 1
*/
export default class Cartpole {
  static gameKind = "cartpole";

  // inputIdxは無い。
  constructor(_) {
    this.inputIdx = null;
    // x, v, theta, omega
    this.reset();
  }

  getCurrentState() {
    const state = new Float32Array(4);
    state[0] = this.x;
    state[1] = this.v / 10.0;
    state[2] = this.theta / Math.PI;
    state[3] = this.omega / 10.0;
    return state;
  }

  reset() {
    // x: -1~-1
    this.x = 0;
    this.v = 0;
    this.theta = Math.PI;
    this.omega = 0;
  }
  
  step(action) {
    
  }
}
