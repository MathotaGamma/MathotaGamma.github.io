//変更点:グラフ描画機能のrenderAllのコード変更(drawGridを先に実行し、それに伴う変数の計算のコードを追加)、renderGraphの動作変更(drawGridに必要だった変数の計算処理を削除)、ViewThree(3Dグラフ描画機能)追加
//注意点
/*
例:
viewer.addGraph(
  (t) => 
    {
      return t**2 - 4*t + 5;
    }
  ,-3,5,1200,{color: "#00aaff",}
);

必ずアロー関数は
(変数) => { return ~~~ ;}
で書くこと。('{}','return',';'必須)
*/
/*
CompVis.ViewThreeはTHREE.jsを使用しています。
※内部に組み込んでいるため、別で用意する必要はありません。
THREE : "https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.module.js",
OrbitControls : "https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/controls/OrbitControls.js",
CSS2DRenderer : "https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/renderers/CSS2DRenderer.js"

使用例

const myDiv = document.getElementById("my-div");
const view = new CompVis.ViewThree(myDiv);

// 非同期で実行しても安全に追加されます

view.addGraph(
  (t) => [
    4*Math.cos(2*t)*Math.cos(t+Math.PI/4),
    4*Math.sin(2*t),
    4*Math.cos(2*t)*Math.sin(t+Math.PI/4)
  ],
  -Math.PI, Math.PI, 100, { color: 0xdd4477 }
);

view.addGraph((t) => Math.exp(t/8), -20, 20, 200, { color: 0x7fffd4 });

view.exec((THREE, scene, camera, renderer, controls) => {
  let geometry = new THREE.BoxGeometry(1,1,1);
  let material = new THREE.MeshLambertMaterial({color: 0x4444ff});
  const cube = new THREE.Mesh(geometry, material);
  scene.add(cube);
});
*/
//For more information on the _graph method, see <https://makeplayonline.onrender.com/Blog/Contents/API/CompVisJS/explanation>.

class CompVis {
  constructor(k_real, k_imag) {
    this._real = k_real;
    this._imag = k_imag;
  }
  
  static ver = '1.01.02';
  static time = '2025/9/17/18:30';
  
  //Methods that throw errors about functions whose arguments must be real numbers
  #Error_Argument_real(k){
    if(isNaN(k)){
      throw new Error('CompVisJS-Argument error->The argument of this method must be a real number.')
    }
  }
  
  
  get value(){
    return [this._real,this._imag];
  }
  static _value(k){
    if(Array.isArray(k)){
      let list_k = [];
      for(let k_k = 0; k_k < k.length; k_k++){
        list_k.push(k[k_k].value);
      }
      return list_k;
    } else{
      return k.value;
    }
  }
  
  get #mini_str(){
    let k;
    if(this._real == 0){
      if(this._imag == 0){
        k = "0";
      } else {
        k = String(this._imag)+"i";
      }
    } else {
      k = String(this._real);
      if(this._imag > 0){
        k += "+"+String(this._imag)+"i";
      } else if(this._imag < 0){
        k += String(this._imag)+"i";
      }
    }
    return k;
  }
  get str(){
    return CompVis._str(this);
  }
  static _str(k){
    if(Array.isArray(k)){
      let list_k = [];
      for(let k_k = 0; k_k < k.length; k_k++){
        list_k.push(k[k_k].#mini_str);
      }
      return list_k;
    } else {
      return k.#mini_str;
    }
  }
  
  round(k=0){
    let k_k;
    if(k >= 0){
      k_k = new CompVis(this._real.toFixed(k),this._imag.toFixed(k));
    } else {
      k_k = new CompVis(Math.round(this._real*10**k)/10**k,Math.round(this._imag*10**k)/10**k)
    }
    return k_k;
  }
  static _round(value_k,k=0){
    if(Array.isArray(value_k)){
      let list_k = [];
      for(let ind_k = 0; ind_k < value_k.length; ind_k++){
        list_k.push(value_k[ind_k].round(k));
      }
      return list_k;
    } else {
      return value_k.round(k);
    }
  }
  
  #RtoI(k){
    if(!isNaN(k)){
      k = new CompVis(k,0);
    }
    return k;
  }
  
  static _toComp(k){
    if(Array.isArray(k[0])){
      return k.map((j) => {
        return new CompVis(j[0],j[1]);
      })
    } else {
      return new CompVis(k[0],k[1]);
    }
  }
  
  get real(){
    return this._real;
  }
  get imag(){
    return this._imag;
  }
  get conj(){
    return new CompVis(this._real,-this._imag);
  }
  get abs(){
    return Math.sqrt(this._real*this._real+this._imag*this._imag);
  }
  get arg(){
    return Math.atan2(this._imag,this._real);
  }
  get log(){
    return new CompVis(Math.log(this.abs),this.arg);
  }
  get exp(){
    return new CompVis(Math.cos(this._imag),Math.sin(this._imag)).pro(Math.exp(this._real));
  }
  
  
  static _DFT(l,return_type='normal'){
    if(return_type != 'normal' && return_type != 'text_list') throw new Error("CompVisJS-Argument error->The second argument of the DFT method must be either 'normal' or 'text_list'.");
    let N = l.length;
    let abs = [];
    let arg = [];
    let return_value = [];
    let F = [];
    for(let k = 0; k < N; k++){
      F.push(new CompVis(0,0));
    
      for(let j = 0; j < N; j++){
        F[k] = F[k].add(new CompVis(0,1).pro(-2*Math.PI*j*k/N).exp.pro(l[j]));
      }
      F[k] = F[k].div(N);
      if(return_type == 'normal') {
        return_value.push({value:F[k],abs:F[k].abs,arg:F[k].arg});
      } else {
        return_value.push(`value:${F[k].str},abs:${F[k].abs},arg:${F[k].arg}`);
      }
    }
    return return_value;
  }
  static _Real(k){
    if(!Array.isArray(k)){
      return k.real;
    } else {
      return k.map((j) => {
        return j.real;
      });
    }
  }
  static _Imag(k){
    if(!Array.isArray(k)){
      return k.imag;
    } else {
      return k.map((j) => {
        return j.imag;
      });
    }
  }
  
  
  add(k){
    k = this.#RtoI(k);
    return new CompVis(this._real+k.real,this._imag+k.imag);
  }
  dif(k){
    k = this.#RtoI(k);
    return new CompVis(this._real-k.real,this._imag-k.imag);
  }
  pro(k){
    k = this.#RtoI(k);
    return new CompVis(this._real*k.real-this._imag*k.imag,this._real*k.imag+this._imag*k.real);
  }
  div(k){
    k = this.#RtoI(k);
    let k_k = this.pro(k.conj);
    let k_abs2 = k.abs*k.abs;
    return new CompVis(k_k.real/k_abs2,k_k.imag/k_abs2);
  }
  log_n(k){
    this.#Error_Argument_real(k);
    return new CompVis(Math.log(this.abs)/Math.log(k),this.arg/Math.log(k));
  }
  pow_by(k){
    k = this.#RtoI(k);
    let k_k = k.pro(this.log);
    return k_k.exp;
  }
  pow_of(k){
    k = this.#RtoI(k);
    let k_k = this.pro(k.log);
    return k_k.exp;
  }
  rotate(k){
    this.#Error_Argument_real(k);
    k = new CompVis(0,1).pro(k).exp;
    return this.pro(k);
  }
}

CompVis.Quater = class {
  constructor(a = null, b = null, c = null, d = null) {
    if (a != null && typeof a === 'object') {
      if (Array.isArray(a)) {
        b = a[1];
        c = a[2];
        d = a[3];
        a = a[0];
      } else {
        const requiredKeys = ['w', 'x', 'y', 'z'];
        const keys = Object.keys(a);
        if (keys.length == 4 && requiredKeys.every(key => keys.includes(key))) {
          if (requiredKeys.every(key => typeof a[key] === 'number')) {
            const A = structuredClone(a);
            this.w = A.w;
            this.x = A.x;
            this.y = A.y;
            this.z = A.z;
            return;
          }
        }
      }
    }

    if (a == null && b == null && c == null && d == null) {
      this.w = 0;
      this.x = 0;
      this.y = 0;
      this.z = 0;
      return;
    } else if (a != null && b == null && c == null && d == null) {
      if (typeof a == "number") {
        this.w = a;
        this.x = 0;
        this.y = 0;
        this.z = 0;
        return;
      }
    } else if (a != null && b != null && c != null && d == null) {
      if (typeof a == "number" && typeof b == "number" && typeof c == "number") {
        this.w = 0;
        this.x = a;
        this.y = b;
        this.z = c;
        return;
      }
    } else if (a != null && b != null && c != null && d != null) {
      if (
        typeof a == "number" &&
        typeof b == "number" &&
        typeof c == "number" &&
        typeof d == "number"
      ) {
        this.w = a;
        this.x = b;
        this.y = c;
        this.z = d;
        return;
      }
    }

    alert("error");
    throw new Error("constructor < Quater");
  }

  get val() {
    return {
      w: this.w,
      x: this.x,
      y: this.y,
      z: this.z
    }
  }

  get str() {
    return `w:${this.w} x:${this.x} y:${this.y} z:${this.z}`;
  }

  get clone() {
    return new CompVis.Quater(this.val);
  }

  add(q) {
    const s = this.clone;
    s.w += q.w;
    s.x += q.x;
    s.y += q.y;
    s.z += q.z;
    return s;
  }

  dif(q) {
    const s = this.clone;
    s.w -= q.w;
    s.x -= q.x;
    s.y -= q.y;
    s.z -= q.z;
    return s;
  }

  pro(q) { // Q*q  (pro_rと全く同じ！)
    if (typeof q == "number") {
      return new CompVis.Quater(this.w * q, this.x * q, this.y * q, this.z * q);
    }

    const Q = this.clone;

    const s = new CompVis.Quater();
    s.w = q.w * Q.w - q.x * Q.x - q.y * Q.y - q.z * Q.z;
    s.x = q.w * Q.x + q.x * Q.w - q.y * Q.z + q.z * Q.y;
    s.y = q.w * Q.y + q.y * Q.w + q.x * Q.z - q.z * Q.x;
    s.z = q.w * Q.z + q.z * Q.w - q.x * Q.y + q.y * Q.x;
    return s;
  }

  pro_r(q) { // proと全く同じ！ 
    return this.pro(q);
  }

  pro_l(q) { // q*Q
    const Q = this.clone;
    const s = new CompVis.Quater();
    s.w = Q.w * q.w - Q.x * q.x - Q.y * q.y - Q.z * q.z;
    s.x = Q.w * q.x + Q.x * q.w - Q.y * q.z + Q.z * q.y;
    s.y = Q.w * q.y + Q.y * q.w + Q.x * q.z - Q.z * q.x;
    s.z = Q.w * q.z + Q.z * q.w - Q.x * q.y + Q.y * q.x;
    return s;
  }

  div(q) {
    if (typeof q == "number") return this.pro(1 / q);
    return this.pro(q.inv);
  }

  div_by(q) {
    if (typeof q == "number") return this.inv.pro(q);
    return q.pro(this.inv);
  }

  get norm() {
    return Math.sqrt(this.w ** 2 + this.x ** 2 + this.y ** 2 + this.z ** 2);
  }

  get conj() {
    return new CompVis.Quater(this.w, -this.x, -this.y, -this.z);
  }

  get normalize() {
    return this.pro(1 / this.norm);
  }

  get inv() {
    return this.conj.pro(1 / this.norm ** 2);
  }
}

CompVis.View = class {
  constructor(canvasElem, options = {}) {
    this.canvas = canvasElem;
    this.ctx = this.canvas.getContext("2d");
    this.dpi = window.devicePixelRatio || 1;
    this.graphs = [];

    // 初期座標・拡大率（gridコード準拠）
    this.offsetX = 0;
    this.offsetY = 0;

    // 1単位＝100px（初期）
    this.xScale = 100;
    this.yScale = 100;

    // 制限値
    this.MIN_SCALE = 1e-4;
    this.MAX_SCALE = 1e6;

    // タッチ操作用変数
    this.lastTouchDist = null;
    this.lastTouchCenter = null;
    this.lastPanPos = null;

    this.resize();
    window.addEventListener("resize", () => this.resize());

    //mode -> static : mainOption適用。
    //     -> dynamic: mainoption適用しない。
    this.mode = options.mode !== undefined ? options.mode : "static";
    this.autoScale = options.autoScale !== undefined ? options.autoScale : false;
    this.showAxis = options.showAxis !== undefined ? options.showAxis : false;
    this.rangeX = options.rangeX !== undefined ? options.rangeX : [-this.W / 2, this.W / 2];
    this.rangeY = options.rangeY !== undefined ? options.rangeY : [-this.H / 2, this.H / 2];

    if (this.mode === "dynamic") {
      // イベント登録
      this.canvas.addEventListener("wheel", e => this.onWheel(e));
      this.canvas.addEventListener("touchstart", e => this.onTouchStart(e), {
        passive: false
      });
      this.canvas.addEventListener("touchmove", e => this.onTouchMove(e), {
        passive: false
      });
      this.canvas.addEventListener("touchend", e => this.onTouchEnd(e));
    }
  }

  //----------------
  // resize
  //----------------
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * this.dpi;
    this.canvas.height = rect.height * this.dpi;
    this.canvas.style.width = rect.width + "px";
    this.canvas.style.height = rect.height + "px";
    this.ctx.setTransform(this.dpi, 0, 0, this.dpi, 0, 0);
    this.W = this.canvas.width / this.dpi;
    this.H = this.canvas.height / this.dpi;
    this.renderAll();
  }

  //----------------
  // グラフ追加
  //----------------
  addGraph(f, a, b, span, options = {}) {
    for (let i = 0; i <= span; i++) {
      const t = a + (b - a) * i / span;
      let res;
      try {
        res = f(t);
      } catch {
        continue;
      }
      if (res instanceof Array) {
        options.isParametric = true;
        break;
      }
    }
    const graph = {
      f,
      a,
      b,
      span,
      color: options.color !== undefined ? options.color : "0ff",
      isParametric: options.isParametric !== undefined ? options.isParametric : false,
    };
    this.graphs.push(graph);
    //this.renderAll();
    return graph;
  }

  getGraphPoints(graph) {
    const points = [];
    const { f, a, b, span } = graph;

    for (let i = 0; i <= span; i++) {
      const t = a + (b - a) * i / span;
      let res;
      try {
        res = f(t);
      } catch {
        continue;
      }
      if (Array.isArray(res) && res.length >= 2) {
        points.push({ x: res[0], y: res[1] });
      } else if (typeof res === "number") {
        points.push({ x: t, y: res });
      }
    }
    return points;
  }
  
  //----------------
  // グラフ全体描画
  //----------------
  renderAll() {
    this.ctx.clearRect(0, 0, this.W, this.H);

    // staticモードの場合のみスケールを計算
    if (this.mode === "static") {
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;

      for (const graph of this.graphs) {
        const points = this.getGraphPoints(graph);
        if (points.length > 0) {
          minX = Math.min(minX, ...points.map(p => p.x));
          maxX = Math.max(maxX, ...points.map(p => p.x));
          minY = Math.min(minY, ...points.map(p => p.y));
          maxY = Math.max(maxY, ...points.map(p => p.y));
        }
      }
      if (this.autoScale) {
        this.xScale = (this.W - 20) / ((maxX - minX) || 1);
        this.yScale = (this.H - 20) / ((maxY - minY) || 1);
        this.offsetX = (minX + maxX) / 2;
        this.offsetY = (minY + maxY) / 2;
      } else {
        const fixedMinX = Math.min(this.rangeX[0], this.rangeX[1]);
        const fixedMaxX = Math.max(this.rangeX[0], this.rangeX[1]);
        const fixedMinY = Math.min(this.rangeY[0], this.rangeY[1]);
        const fixedMaxY = Math.max(this.rangeY[0], this.rangeY[1]);
        this.xScale = this.W / (fixedMaxX - fixedMinX);
        this.yScale = this.H / (fixedMaxY - fixedMinY);
        this.offsetX = (this.rangeX[0] + this.rangeX[1]) / 2;
        this.offsetY = (this.rangeY[0] + this.rangeY[1]) / 2;
      }
    }

    // グリッドを先に描画
    if (this.showAxis) {
      this.drawGrid();
    }

    // グラフを描画
    const viewData = [];
    for (const graph of this.graphs) {
      viewData.push(this.renderGraph(graph));
    }

    return viewData;
  }

  calcRange() {
    let wid = this.W / (2 * this.xScale);
    let hei = this.H / (2 * this.yScale);

    return {
      a: -wid + this.offsetX,
      b: wid + this.offsetX
    };
  }

  //----------------
  // グリッド描画（元gridコードをほぼそのまま）
  //----------------
  calcSpacing() {
    const idealPx = 15;
    let factorList = [];
    [this.xScale, this.yScale].forEach((k) => {
      const raw = idealPx / k;
      const exp = Math.floor(Math.log10(raw));
      const base = raw / Math.pow(10, exp);
      let factor;
      if (base <= 1) factor = 1;
      else if (base <= 2) factor = 2;
      else if (base <= 5) factor = 5;
      else factor = 10;
      factorList.push(factor * Math.pow(10, exp));
    });
    return {
      x: factorList[0],
      y: factorList[1]
    };
  }

  drawGrid() {
    const ctx = this.ctx;
    const spacing = this.calcSpacing();
    const spacingPx = {
      x: spacing.x * this.xScale,
      y: spacing.y * this.yScale
    };
    const originX = this.W / 2 - this.offsetX * this.xScale;
    const originY = this.H / 2 + this.offsetY * this.yScale;

    ctx.font = '12px sans-serif';
    const fontSize = 12;
    const margin = 8; // 文字周囲の余裕
    ctx.textBaseline = 'top';

    // 縦グリッド線
    let firstX = originX % spacingPx.x;
    for (let x = firstX; x <= this.W; x += spacingPx.x) {
      const gridX = Math.round((x - originX) / this.xScale / spacing.x) * spacing.x;
      const idx = Math.round(gridX / spacing.x);

      ctx.beginPath();
      ctx.strokeStyle = (idx % 5 === 0) ? '#aaa' : '#ddd';
      ctx.lineWidth = (idx % 5 === 0) ? 2 : 1;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.H);
      ctx.stroke();

      if (idx % 5 === 0 && Math.abs(gridX) > 1e-10) {
        ctx.fillStyle = '#000';
        const text = parseFloat(gridX.toFixed(6)).toString();
        const metrics = ctx.measureText(text);
        let tx = x + margin;
        let ty = originY + margin;

        // 文字が画面外に出ないように調整
        if (tx + metrics.width > this.W) tx = this.W - metrics.width - margin;
        if (tx < 0) tx = margin;
        if (ty + fontSize > this.H) ty = this.H - fontSize - margin;
        if (ty < 0) ty = margin;

        ctx.fillText(text, tx, ty);
      }
    }

    // 横グリッド線
    let firstY = originY % spacingPx.y;
    for (let y = firstY; y <= this.H; y += spacingPx.y) {
      const gridY = Math.round((originY - y) / this.yScale / spacing.y) * spacing.y;
      const idx = Math.round(gridY / spacing.y);

      ctx.beginPath();
      ctx.strokeStyle = (idx % 5 === 0) ? '#aaa' : '#ddd';
      ctx.lineWidth = (idx % 5 === 0) ? 2 : 1;
      ctx.moveTo(0, y);
      ctx.lineTo(this.W, y);
      ctx.stroke();

      if (idx % 5 === 0 && Math.abs(gridY) > 1e-10) {
        ctx.fillStyle = '#000';
        const text = parseFloat(gridY.toFixed(6)).toString();
        const metrics = ctx.measureText(text);
        let tx = originX + margin;
        let ty = y + margin;

        // 文字が画面外に出ないように調整
        if (tx + metrics.width > this.W) tx = this.W - metrics.width - margin;
        if (tx < 0) tx = margin;
        if (ty + fontSize > this.H) ty = this.H - fontSize - margin;
        if (ty < 0) ty = margin;

        ctx.fillText(text, tx, ty);
      }
    }

    // 0ラベル
    ctx.fillStyle = '#000';
    const originText = '0';
    const originMetrics = ctx.measureText(originText);
    let ox = originX + margin;
    let oy = originY + margin;

    if (ox + originMetrics.width > this.W) ox = this.W - originMetrics.width - margin;
    if (ox < 0) ox = margin;
    if (oy + fontSize > this.H) oy = this.H - fontSize - margin;
    if (oy < 0) oy = margin;
    let oPosX = -this.offsetX * this.xScale + this.W / 2;
    let oPosY = -this.offsetY * this.yScale + this.H / 2;
    if ((0 < oPosX && oPosX < this.W) || (0 < oPosY && oPosY < this.H)) {
      ctx.fillText(originText, ox, oy);
    }

    // 軸線は変更せず
    ctx.beginPath();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.moveTo(0, originY);
    ctx.lineTo(this.W, originY);

    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(originX, 0);
    ctx.lineTo(originX, this.H);
    ctx.stroke();
  }

  //----------------
  // グラフ描画
  //----------------
  renderGraph(graph) {
    let {
      f,
      a,
      b,
      span,
      color,
      isParametric
    } = graph;

    // dynamicモードで非パラメトリックの場合、描画範囲を現在のビューポートに合わせる
    if (this.mode === "dynamic" && !isParametric) {
      const k = this.calcRange();
      a = k.a;
      b = k.b;
      span = this.W; // 画面幅に応じて描画点を調整
    }

    const ctx = this.ctx;
    const points = [];

    for (let i = 0; i <= span; i++) {
      const t = a + (b - a) * i / span;
      let res;
      try {
        res = f(t);
      } catch {
        continue;
      }
      if (Array.isArray(res) && res.length >= 2) {
        points.push({
          x: res[0],
          y: res[1]
        });
      } else if (typeof res === "number") {
        points.push({
          x: t,
          y: res
        });
      }
    }

    if (points.length < 2) return;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    for (let i = 0; i < points.length; i++) {
      const px = this.W / 2 + (points[i].x - this.offsetX) * this.xScale;
      const py = this.H / 2 - (points[i].y - this.offsetY) * this.yScale;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }

    ctx.stroke();

    return {
      isParametric,
      graph,
    };
  }

  //----------------
  // テキスト描画
  //----------------
  drawText(text, x, y, options = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = options.color || "#fff";
    ctx.font = `${options.size || 16}px sans-serif`;
    ctx.textAlign = options.align || "left";
    ctx.textBaseline = options.baseline || "top";
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // ===== Wheel操作 =====
  onWheel(e) {
    e.preventDefault();

    // ホイールによるズーム
    const zoom = e.deltaY > 0 ? 0.9 : 1.1;
    const mx = e.clientX;
    const my = e.clientY;

    const worldBeforeX = (mx - this.W / 2) / this.xScale + this.offsetX;
    const worldBeforeY = this.offsetY - (my - this.H / 2) / this.yScale;

    this.xScale *= zoom;
    this.yScale *= zoom;

    this.offsetX = worldBeforeX - (mx - this.W / 2) / this.xScale;
    this.offsetY = worldBeforeY + (my - this.H / 2) / this.yScale;

    this.xScale = Math.min(Math.max(this.xScale, this.MIN_SCALE), this.MAX_SCALE);
    this.yScale = Math.min(Math.max(this.yScale, this.MIN_SCALE), this.MAX_SCALE);

    this.renderAll();
  }

  // ===== Wheelによるドラッグ =====
  onMouseDown(e) {
    this.isDragging = true;
    this.lastPanPos = {
      x: e.clientX,
      y: e.clientY
    };
  }
  onMouseMove(e) {
    if (this.isDragging) {
      this.offsetX -= (e.clientX - this.lastPanPos.x) / this.xScale;
      this.offsetY += (e.clientY - this.lastPanPos.y) / this.yScale;
      this.lastPanPos = {
        x: e.clientX,
        y: e.clientY
      };
      this.renderAll();
    }
  }
  onMouseUp(e) {
    this.isDragging = false;
  }

  onTouchStart(e) {
    if (e.touches.length === 1) {
      this.lastPanPos = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY
      };
    } else if (e.touches.length === 2) {
      this.lastTouchDist = this.getDist(e.touches[0], e.touches[1]);
      this.lastTouchCenter = this.getCenter(e.touches[0], e.touches[1]);
      // 2本指の方向ベクトルで軸ロック
      if (this.lastTouchDist > 20) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        this.lockAxis = null;

        if (Math.abs(dx) > Math.abs(dy) * 2) this.lockAxis = 'x';
        else if (Math.abs(dy) > Math.abs(dx) * 2) this.lockAxis = 'y';
      }

      // ピンチ開始時のワールド座標を保存
      this.pinchWorldBeforeX = (this.lastTouchCenter.x - this.W / 2) / this.xScale + this.offsetX;
      this.pinchWorldBeforeY = this.offsetY - (this.lastTouchCenter.y - this.H / 2) / this.yScale;
    }
  }

  onTouchMove(e) {
    e.preventDefault();

    // 最初にタッチの状態を厳密にチェック
    // 2本指でのピンチ操作が意図されているか？
    if (e.touches.length === 2 && this.lastTouchDist !== null && this.lastTouchCenter !== null) {
      // 2本指でのピンチ操作
      const newDist = this.getDist(e.touches[0], e.touches[1]);
      const newCenter = this.getCenter(e.touches[0], e.touches[1]);
      const zoom = newDist / this.lastTouchDist;

      if (this.lockAxis === 'x') this.xScale *= zoom;
      else if (this.lockAxis === 'y') this.yScale *= zoom;
      else {
        this.xScale *= zoom;
        this.yScale *= zoom;
      }

      // ズームとパンの複合計算
      const panX = (newCenter.x - this.lastTouchCenter.x) / this.xScale;
      const panY = (newCenter.y - this.lastTouchCenter.y) / this.yScale;

      this.offsetX -= panX;
      this.offsetY += panY;

      this.xScale = Math.min(Math.max(this.xScale, this.MIN_SCALE), this.MAX_SCALE);
      this.yScale = Math.min(Math.max(this.yScale, this.MIN_SCALE), this.MAX_SCALE);

      this.lastTouchDist = newDist;
      this.lastTouchCenter = newCenter;

    } else if (e.touches.length === 1 && this.lastPanPos !== null) {
      // 1本指でのパン操作
      const dx = e.touches[0].clientX - this.lastPanPos.x;
      const dy = e.touches[0].clientY - this.lastPanPos.y;

      this.offsetX -= dx / this.xScale;
      this.offsetY += dy / this.yScale;

      this.lastPanPos = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY
      };
    } else {
      // 予期せぬ状態の場合、すべての状態をリセットして次の操作に備える
      this.lastTouchDist = null;
      this.lastTouchCenter = null;
      this.lastPanPos = null;
      this.pinchWorldBeforeX = null;
      this.pinchWorldBeforeY = null;
      this.lockAxis = null;
    }

    this.renderAll();
  }

  onTouchEnd(e) {
    if (e.touches.length === 0) {
      // すべての指が離れた場合
      this.lastTouchDist = null;
      this.lastTouchCenter = null;
      this.pinchWorldBeforeX = null;
      this.pinchWorldBeforeY = null;
      this.lockAxis = null;
      this.lastPanPos = null;
    } else if (e.touches.length === 1) {
      // 1本指になった場合（パン操作に備えて初期化）
      this.lastTouchDist = null;
      this.lastTouchCenter = null;
      this.pinchWorldBeforeX = null;
      this.pinchWorldBeforeY = null;
      this.lockAxis = null;
      this.lastPanPos = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY
      };
    }
  }

  //----------------
  // タッチ距離取得
  //----------------
  getDist(p1, p2) {
    return Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
  }

  //----------------
  // タッチ中心取得
  //----------------
  getCenter(p1, p2) {
    return {
      x: (p1.clientX + p2.clientX) / 2,
      y: (p1.clientY + p2.clientY) / 2
    };
  }
}

CompVis.ViewThree = class {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.animation = true;

    // --- エラー表示用のコンテナ作成 ---
    this.errorContainer = document.createElement("div");
    Object.assign(this.errorContainer.style, {
      position: "absolute", top: "0", left: "0", width: "100%",
      zIndex: "1000", pointerEvents: "none", color: "red",
      backgroundColor: "rgba(0,0,0,0.8)", padding: "10px", display: "none"
    });
    this.container.appendChild(this.errorContainer);

    // --- コンテナのスタイル強制 ---
    const computedStyle = window.getComputedStyle(this.container);
    if ((!this.container.style.height || computedStyle.height === "0px") && !(options.zeroHeight ?? false)) {
      this.container.style.width = "100%";
      this.container.style.height = "400px";
    }
    this.container.style.position = "relative";
    this.container.style.overflow = "hidden";
    this.container.style.backgroundColor = "#222"; // ロード前から黒くする

    // --- 設定値 ---
    this.labelDown = options.labelDown || 0;
    this.labelSize = options.labelSize || "12px";
    this.initialCameraPosition = options.cameraPosition || { x: 15, y: 15, z: 15 }; // 少し引き気味に
    this.initialCameraTarget = options.cameraTarget || { x: 0, y: 0, z: 0 };

    this.modules = {};
    this.graphs = [];
    this.axisGroup = null;
    this.globalMaxDistance = 10; // ★重要: 初期値を0にしない（グリッドを出すため）

    // 初期化開始
    this.initPromise = this.#init().catch(err => this.showError("Init Error: " + err.message));
  }

  showError(msg) {
    console.error(msg);
    this.errorContainer.style.display = "block";
    this.errorContainer.innerHTML += `<div>${msg}</div>`;
  }

  async #init() {
    // 依存関係のロード
    const v = '0.152.2';
    const urls = {
      three: `https://esm.sh/three@${v}`,
      OrbitControls: `https://esm.sh/three@${v}/examples/jsm/controls/OrbitControls.js?deps=three@${v}`,
      CSS2DRenderer: `https://esm.sh/three@${v}/examples/jsm/renderers/CSS2DRenderer.js?deps=three@${v}`
    };

    try {
      const [threeModule, orbitModule, css2dModule] = await Promise.all([
        import(urls.three),
        import(urls.OrbitControls),
        import(urls.CSS2DRenderer)
      ]);

      this.modules.three = threeModule;
      this.modules.OrbitControls = orbitModule.OrbitControls;
      this.modules.CSS2DRenderer = css2dModule.CSS2DRenderer;
      this.modules.CSS2DObject = css2dModule.CSS2DObject;

      this.#initScene();
    } catch (e) {
      throw new Error(`Failed to load Three.js libraries. Check internet connection. (${e.message})`);
    }
  }

  #initScene() {
    try {
      const THREE = this.modules.three;
      const OrbitControls = this.modules.OrbitControls;
      const CSS2DRenderer = this.modules.CSS2DRenderer;
      
      // シーン
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x222222);

      // カメラ
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000);
      this.camera.position.set(
        this.initialCameraPosition.x,
        this.initialCameraPosition.y,
        this.initialCameraPosition.z
      );
      this.camera.lookAt(new THREE.Vector3(0,0,0));

      // WebGL Renderer
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      this.renderer.setSize(w, h);
      this.renderer.setPixelRatio(window.devicePixelRatio);
      Object.assign(this.renderer.domElement.style, { position: "absolute", top: "0", left: "0" });
      this.container.appendChild(this.renderer.domElement);

      // Label Renderer
      this.labelRenderer = new CSS2DRenderer();
      this.labelRenderer.setSize(w, h);
      Object.assign(this.labelRenderer.domElement.style, {
        position: "absolute",
        top: "0",
        left: "0",
        pointerEvents: "none", // クリックを透過させる
      });
      this.container.appendChild(this.labelRenderer.domElement);

      // Controls (OrbitControlsはWebGLRendererのキャンバスでイベントを受け取る)
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.target.set(this.initialCameraTarget.x, this.initialCameraTarget.y, this.initialCameraTarget.z);
      this.controls.update();

      // ライト
      const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
      dirLight.position.set(15, 20, 15);
      this.scene.add(dirLight);
      this.scene.add(new THREE.AmbientLight(0x888888));

      // グループ作成
      this.axisGroup = new THREE.Group();
      this.scene.add(this.axisGroup);

      // ★初期描画: 何もグラフがなくてもとりあえずグリッドを描く
      this.#updateAxesAndGrid();

      // リサイズイベント
      window.addEventListener("resize", () => this.#onResize());

      // アニメーション開始
      this.startAnimate();

    } catch (e) {
      this.showError("Scene Setup Error: " + e.message);
    }
  }

  #onResize() {
    if (!this.camera || !this.renderer) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
  }

  #makeLabel(text) {
    const CSS2DObject = this.modules.CSS2DObject;
    const div = document.createElement("div");
    div.style.color = "#aaaaaa";
    div.style.fontSize = this.labelSize;
    div.style.fontFamily = "sans-serif";
    div.textContent = text;
    div.style.userSelect = "none";
    return new CSS2DObject(div);
  }

  #calcNiceStep(range) {
    if (range <= 0) return 1;
    const exponent = Math.floor(Math.log10(range));
    const fraction = range / Math.pow(10, exponent);
    let niceFraction;
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
    return niceFraction * Math.pow(10, exponent);
  }

  #create2DGrid(size, step, plane) {
    const THREE = this.modules.three;
    const points = [];
    const n = Math.ceil(size / step);
    
    // グリッド線の座標を計算
    for (let i = -n; i <= n; i++) {
      const val = i * step;
      // 範囲外にはみ出す線はカットしてもよいが、簡易的にすべて描画
      if (plane === "XZ") {
        points.push(-size, 0, val, size, 0, val); // 横線
        points.push(val, 0, -size, val, 0, size); // 縦線
      } else if (plane === "XY") {
        points.push(-size, val, 0, size, val, 0);
        points.push(val, -size, 0, val, size, 0);
      } else if (plane === "YZ") {
        points.push(0, -size, val, 0, size, val);
        points.push(0, val, -size, 0, val, size);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    // 透明度のある線にする
    const material = new THREE.LineBasicMaterial({ color: 0x666666, transparent: true, opacity: 0.3 });
    return new THREE.LineSegments(geometry, material);
  }

  #updateAxesAndGrid() {
    try {
      if (!this.axisGroup || !this.modules.three) return;
      const THREE = this.modules.three;
      
      this.axisGroup.clear(); // 既存のオブジェクトを削除

      // グラフがない場合でも最低限のサイズ(10)を確保
      const range = Math.max(10, this.globalMaxDistance);
      const step = this.#calcNiceStep(range / 2); // 目盛りの間隔
      const size = Math.ceil(range / step) * step; // グリッド全体のサイズ

      // 軸を描画 (X:赤, Y:緑, Z:青)
      const axesData = [
        { end: [size, 0, 0], color: 0xff4444, text: "X" },
        { end: [0, size, 0], color: 0x44ff44, text: "Y" },
        { end: [0, 0, size], color: 0x4444ff, text: "Z" }
      ];

      axesData.forEach(ax => {
        // 軸線
        const points = [0, 0, 0, ...ax.end];
        const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
        const mat = new THREE.LineBasicMaterial({ color: ax.color, linewidth: 2 });
        this.axisGroup.add(new THREE.Line(geo, mat));

        // 軸ラベル
        const label = this.#makeLabel(ax.text);
        label.position.set(ax.end[0] * 1.05, ax.end[1] * 1.05, ax.end[2] * 1.05);
        this.axisGroup.add(label);
      });

      // 目盛り数値の描画
      const count = Math.ceil(size / step);
      for (let i = -count; i <= count; i++) {
        if (i === 0) continue; // 原点はスキップ
        const v = i * step;
        const txt = (Math.abs(v) < 0.0001 || Math.abs(v) > 10000) ? v.toExponential(1) : parseFloat(v.toFixed(4));
        
        // X軸上の目盛り
        let l = this.#makeLabel(txt); l.position.set(v, 0, 0); this.axisGroup.add(l);
        // Y軸上の目盛り
        l = this.#makeLabel(txt); l.position.set(0, v, 0); this.axisGroup.add(l);
        // Z軸上の目盛り
        l = this.#makeLabel(txt); l.position.set(0, 0, v); this.axisGroup.add(l);
      }

      // グリッド描画 (XZ平面、XY平面、YZ平面)
      this.axisGroup.add(this.#create2DGrid(size, step, "XZ"));
      this.axisGroup.add(this.#create2DGrid(size, step, "XY"));
      this.axisGroup.add(this.#create2DGrid(size, step, "YZ"));

    } catch (e) {
      this.showError("Grid Update Error: " + e.message);
    }
  }

  async addGraph(f, a, b, span = 100, options = {}) {
    try {
      await this.initPromise; // 初期化待ち
      const THREE = this.modules.three;

      const points = [];
      let localMax = 0;

      for (let i = 0; i <= span; i++) {
        const t = a + ((b - a) * i) / span;
        let val;
        try { val = f(t); } catch { continue; }

        let x, y, z;
        if (Array.isArray(val) && val.length >= 3) {
          [x, y, z] = val;
        } else if (typeof val === "number") {
          x = t; y = val; z = 0;
        } else {
          continue;
        }

        if (isNaN(x) || isNaN(y) || isNaN(z)) continue;

        points.push(x, y, z);
        localMax = Math.max(localMax, Math.abs(x), Math.abs(y), Math.abs(z));
      }

      if (points.length === 0) {
        console.warn("No valid points generated for graph.");
        return null;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      const material = new THREE.LineBasicMaterial({ color: options.color || 0x00ffff, linewidth: 2 });
      const line = new THREE.Line(geometry, material);

      this.scene.add(line);
      this.graphs.push(line);

      // グリッド範囲の自動更新
      if (localMax > this.globalMaxDistance) {
        this.globalMaxDistance = localMax;
        this.#updateAxesAndGrid();
        
        // カメラ自動調整 (オプションでオフに可能)
        if (!options.disableAutoCamera) {
             // カメラのターゲットは変えずに、距離だけ離す
             const vec = new THREE.Vector3().copy(this.camera.position).normalize();
             const dist = Math.max(20, this.globalMaxDistance * 2); 
             this.camera.position.copy(vec.multiplyScalar(dist));
             this.controls.update();
        }
      }

      return line;
    } catch (e) {
      this.showError("Add Graph Error: " + e.message);
    }
  }
  
  #animate() {
    // requestAnimationFrame自体がエラーを起こすとループが止まらないのでtry-catchする
    requestAnimationFrame(() => {
      try {
        if(this.hasAnimationError) return;
        if(!this.animation) return;
        this.#animateInner();
        if(this.animation) this.#animate();
      } catch(e) {
        if(!this.hasAnimationError) {
          this.showError("Animation Error: " + e.message);
          this.hasAnimationError = true;
        }
      }
    });
  }

  #animateInner() {
    if (this.hasAnimationError) return;
    if (this.controls) this.controls.update();
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
    }
  }
  
  startAnimate() {
    this.animation = true;
    this.#animate();
  }
  
  stopAnimate() {
    this.animation = false;
  }
  
  async exec(callback) {
    try {
      // 初期化が完了するのを待つ
      await this.initPromise;
      const THREE = this.modules.three;
      // コールバック関数に必要な主要オブジェクトを渡して実行
      // nullチェックをして、オブジェクトが揃っているか確認
      if (THREE && this.scene && this.camera && this.renderer && this.controls) {
        callback(THREE, this.scene, this.camera, this.renderer, this.controls);
      } else {
        console.warn("ViewThree is initialized, but some core objects (scene/camera/renderer/controls) are missing.");
      }
    } catch (e) {
      this.showError("Exec Method Error: " + e.message);
      console.error("Exec Method Error:", e);
    }
  }
}

CompVis.Matrix = class {
  constructor (A = [[0]]){
    if (A === undefined || A === null) {
      A = [[0]];  // 手動でデフォルト値を設定
    }
    if (!Array.isArray(A) || A.length == 0 || !Array.isArray(A[0]) || A[0].length == 0) {
      throw new Error("CompVisJS_Matrix-Argument error->Invalid matrix format.");
    } else {
      let columnLength = A[0].length;
      for (let i = 1; i < A.length; i++) {
        if (!Array.isArray(A[i]) || A[i].length !== columnLength) {
          throw new Error('CompVisJS_Matrix-Shape error->Invalid matrix format.');
        }
      }
      this._matrix = A;
      this._size = [A.length,columnLength];
      
    }
  }
  
  get matrix(){
    return this._matrix
  }
  get size(){
    return this._size;
  }
  get toString() {
    return JSON.stringify(this._matrix);
  }
  
  pro(B) {
    if (!(B instanceof CompVis.Matrix)) {
      throw new Error("CompVisJS_Matrix-Argument error->The argument must be a Matrix instance.");
    }
    let A = this._matrix;
    console.log(B.matrix)
    let [m, n] = this.size;
    let [p, q] = B.size;
    
    if (n !== p) {
      throw new Error("CompVisJS_Matrix-Shape error->Matrix multiplication dimension mismatch.");
    }

    let result = Array.from({ length: m }, () => Array(q).fill(0));
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < q; j++) {
        for (let k = 0; k < n; k++) {
          result[i][j] += A[i][k] * B.matrix[k][j];
        }
      }
    }

    return new CompVis.Matrix(result);
  }
  
  get _det() {
    let n = this._matrix.length;
    let A = this._matrix.map(row => [...row]); // 行列をコピー
    let det_k = 1;
    
    for (let i = 0; i < n; i++) {
      let maxRow = i;
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) {
          maxRow = k;
        }
      }
        
      if (A[maxRow][i] === 0) return 0;

      if (i !== maxRow) {
        [A[i], A[maxRow]] = [A[maxRow], A[i]];
        det_k *= -1;
      }

      det_k *= A[i][i];

      let pivot = A[i][i];
      for (let k = i + 1; k < n; k++) {
        let factor = A[k][i] / pivot;
        for (let j = i; j < n; j++) {
          A[k][j] -= factor * A[i][j];
        }
      }
    }

    return det_k;
  }
  
  get _inverse() {
    if(this.size[0] != this.size[1]) throw new Error("CompVisJS_Matrix-Shape error->Must be a square matrix.");
    let A = this._matrix;
    let n = A.length;
    let I = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
    );

    for (let i = 0; i < n; i++) {
      let pivot = A[i][i];
      if (pivot === 0) {
        for (let k = i + 1; k < n; k++) {
          if (A[k][i] !== 0) {
            [A[i], A[k]] = [A[k], A[i]];
            [I[i], I[k]] = [I[k], I[i]];
            pivot = A[i][i];
            break;
          }
        }
      }
      if (pivot === 0) throw new Error("CompVisJS_Matrix-Shape error->Singular matrix (non-invertible).");
      for (let j = 0; j < n; j++) {
        A[i][j] /= pivot;
        I[i][j] /= pivot;
      }

      for (let k = 0; k < n; k++) {
        if (k !== i) {
          let factor = A[k][i];
          for (let j = 0; j < n; j++) {
            A[k][j] -= factor * A[i][j];
            I[k][j] -= factor * I[i][j];
          }
        }
      }
    }
    return new CompVis.Matrix(I);
  }
}

CompVis._list = [
  Object.getOwnPropertyNames(CompVis),
  Object.getOwnPropertyNames(Object.getPrototypeOf(new CompVis()))
];
