//変更点:グラフ描画機能のoptionの種類追加
//For more information on the _graph method, see <https://makeplayonline.onrender.com/Blog/Contents/API/CompVisJS/explanation>.

class CompVis {
  constructor(k_real, k_imag) {
    this._real = k_real;
    this._imag = k_imag;
  }
  
  static ver = '1.03.02';
  static time = '2025/7/19/15:30:00';
  
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

CompVis.View = class {
  constructor(canvasElem) {
    this.canvas = canvasElem;
    this.ctx = this.canvas.getContext("2d");
    this.dpi = window.devicePixelRatio || 1;
    this.graphs = [];
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

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

  addGraph(f, a, b, span, options = {}) {
    // optionsにautoScale, showAxisを含める
    const graph = {
      f,
      a,
      b,
      span,
      color : options.color !== undefined ? options.color : "0ff",
      //自動でscaleやらrangeやらを調整する
      autoScale: options.autoScale !== undefined ? options.autoScale : false,
      //軸を表示するか
      showAxis: options.showAxis !== undefined ? options.showAxis : false,
      //左端と右端のx座標(初期値はpxに従った座標)
      rangeX: options.rangeX !== undefined ? options.rangeX : [-this.W/2, this.W/2],
      //上端と下端のy座標(初期値はpxに従った座標)
      rangeY: options.rangeY !== undefined ? options.rangeY : [-this.H/2, this.H/2],
    };
    this.graphs.push(graph);
    this.renderGraph(graph);
    return graph;
  }

  renderAll() {
    this.ctx.clearRect(0, 0, this.W, this.H);
    for (const graph of this.graphs) {
      this.renderGraph(graph);
    }
  }

  update(graph) {
    this.renderAll();
  }

  renderGraph(graph) {
    const { f, a, b, span, color, autoScale, showAxis, rangeX, rangeY, center} = graph;
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
        points.push({ x: res[0], y: res[1] });
      } else if (typeof res === "number") {
        points.push({ x: t, y: res });
      }
    }

    if (points.length < 2) return;

    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    
    //canvasの端の値
    //5px分の余白を入れる
    let minX, maxX, minY, maxY;

    //scaleは、1px/グラフ上の1目盛り
    let xScale, yScale, offsetX, offsetY;
    
    if (autoScale) {
      minX = Math.min(...xs);
      maxX = Math.max(...xs);
      minY = Math.min(...ys);
      maxY = Math.max(...ys);
      
      xScale = (this.W - 10) / ((maxX - minX) || 1);
      yScale = (this.H - 10) / ((maxY - minY) || 1);
      
      /*offsetX = -minX;
      offsetY = -minY;*/
      offsetX = 0;
      //offsetY = -(maxY + minY) / 2;
      offsetY = 0;
    } else {
      minX = Math.min(rangeX[0], rangeX[1]);
      maxX = Math.max(rangeX[0], rangeX[1]);
      minY = Math.min(rangeY[0], rangeY[1]);
      maxY = Math.max(rangeY[0], rangeY[1]);
      
      xScale = (this.W - 10) / (maxX - minX);
      yScale = (this.H - 10) / (maxY - minY);
      //xScale = yScale = 1;
      /*offsetX = this.W/2;
      offsetY = this.H/2;*/
      offsetX = (rangeX[0] + rangeX[1]) / 2;
      offsetY = (rangeY[0] + rangeY[1]) / 2;
    }
    
    //5px分の余白を入れた端の座標
    minX -= 5/xScale;
    maxX += 5/xScale;
    minY -= 5/yScale;
    maxY += 5/yScale;

    const ctx = this.ctx;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    for (let i = 0; i < points.length; i++) {
      const px = this.W / 2 + (points[i].x - offsetX) * xScale;
      const py = this.H / 2 - (points[i].y + offsetY) * yScale;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }

    ctx.stroke();

    if (showAxis) {
      this.drawAxis(offsetX, offsetY);
    }
  }

  drawAxis(offsetX, offsetY) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = "#888";
    ctx.lineWidth = 1;

    ctx.moveTo(0, this.H / 2 + offsetY);
    ctx.lineTo(this.W, this.H / 2 + offsetY);
    
    ctx.moveTo(this.W / 2 + offsetX, 0);
    ctx.lineTo(this.W / 2 + offsetX, this.H);

    ctx.stroke();
    ctx.restore();
  }

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
