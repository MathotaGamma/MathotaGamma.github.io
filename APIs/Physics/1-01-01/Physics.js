window.Physics = class {
  constructor(dimension) {
    if (dimension !== "2d" && dimension !== "3d") throw new Error("constructor");
    this.dimension = dimension;
  }

  static ver = "1.01.01";
}

Physics.Vec3 = class {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  get e() {
    return [this.x, this.y, this.z];
  }

  add(v) {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  sub(v) {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  scale(s) {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  clone() {
    return new Physics.Vec3(...this.e);
  }

  copy(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  length() {
    return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z);
  }

  lengthSq() {
    return this.s*this.x+this.y*this.y+this.z*this.z;
  }

  normalize() {
    this.scale(1/this.length());
    return this;
  }

  negate() {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  dot(v) {
    return this.x*v.x+this.y*v.y+this.z*v.z;
  }

  lerp(v, k) {
    this.add((v.clone().sub(this).scale(k)));
    return this;
  }

  equal(v) {
    return this.x === v.x && this.y === v.y && this.z === v.z;
  }

  angle(v) {
    return Math.acos(this.dot(v)/this.length()/v.length());
  }

  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  cross(v) {
    this.set(
      this.y*v.z-this.z*v.y,
      this.z*v.x-this.x*v.z,
      this.x*v.y-this.y*v.x
    );
    return this;
  }
}

Physics.Matrix = class {
  constructor(list) {
    this.set(list);
  }

  clone() {
    return new Physics.Matrix(structuredClone(this.matrix));
  }

  copy(B) {
    this.set(B.matrix);
  }

  set(list) {
    this.matrix = structuredClone(list);
    this.row = list.length;
    this.col = list[0].length;

    const rowNum = this.row, colNum = this.col;

    for (let row = 1; row < rowNum; row++) {
      if (list[row].length !== colNum) throw new Error("Error: Matrix-constructor or set");
    }
  }

  at(row, col) {
    return this.matrix[row][col];
  }

  put(row, col, val) {
    this.matrix[row][col] = val;
    return this;
  }

  static Zero(row, col) {
    return new Physics.Matrix(Array.from({ length: row }, () => Array(col).fill(0)));
  }

  static Identity(size) {
    const A = Physics.Matrix.Zero(size, size);
    for (let k = 0; k < size; k++) A.put(k,k,1); 
    return A;
  }

  add(B) {
    for (let row = 0; row < this.row; row++) {
      for (let col = 0; col < this.col; col++) {
        this.put(row, col, this.at(row, col)+B.at(row, col));
      }
    }
    return this;
  }

  sub(B) {
    for (let row = 0; row < this.row; row++) {
      for (let col = 0; col < this.col; col++) {
        this.put(row, col, this.at(row, col)-B.at(row, col));
      }
    }
    return this;
  }

  pro(B) {
    if (B instanceof Physics.Vec3) {
      // rowも3でないと、Vec3で返せない。3以外のサイズなら行列でベクトルを表現して。
      if (this.col !== 3 || this.row !== 3) throw new Error("Error: matrix-pro");
      const list = this.matrix;
      return new Physics.Vec3(
        list[0][0]*B.x+list[0][1]*B.y+list[0][2]*B.z,
        list[1][0]*B.x+list[1][1]*B.y+list[1][2]*B.z,
        list[2][0]*B.x+list[2][1]*B.y+list[2][2]*B.z
      );
    }
    if (this.col !== B.row) throw new Error("Error: matrix-pro");

    const C = Physics.Matrix.Zero(this.row, B.col);
    const size = this.col;
    for (let row = 0; row < this.row; row++) {
      for (let col = 0; col < B.col; col++) {
        let val = 0;
        for (let k = 0; k < size; k++) val += this.at(row, k)*B.at(k, col);
        C.put(row, col, val);
      }
    }
    this.copy(C);
    return this;
  }

  proLeft(B) {
    if (B.col !== this.row) throw new Error("Error: matrix-pro");

    const C = Physics.Matrix.Zero(B.row, this.col);
    const size = B.col;
    for (let row = 0; row < B.row; row++) {
      for (let col = 0; col < this.col; col++) {
        let val = 0;
        for (let k = 0; k < size; k++) val += B.at(row, k)*this.at(k, col);
        C.put(row, col, val);
      }
    }
    this.copy(C);
    return this;
  }

  #rowConvert(row, targetRow, scale) {
    const B = Physics.Matrix.Zero(this.row, this.col);
    B.matrix[targetRow] = this.clone().matrix[row].map(col => col*scale);
    return B.clone();
  }

  inverse() {
    const size = this.row;
    if (size !== this.col) throw new Error("Error: Matrix-inverse");
    
    const A = this.clone();
    const B = Physics.Matrix.Identity(size, size);

    const threshold = 1e-7;

    for (let k = 0; k < size; k++) {
      let pivot = k;
      for (let i = k + 1; i < size; i++) {
        if (Math.abs(A.at(i, k)) > Math.abs(A.at(pivot, k))) pivot = i;
      }
      // 行を入れ替える。
      [A.matrix[k], A.matrix[pivot]] = [A.matrix[pivot], A.matrix[k]];
      [B.matrix[k], B.matrix[pivot]] = [B.matrix[pivot], B.matrix[k]];
      
      const val = A.at(k,k);
      if (val < threshold && -threshold < val) return null;
      const scale = 1/A.at(k,k);
      A.matrix[k] = A.matrix[k].map(e => e*scale);
      B.matrix[k] = B.matrix[k].map(e => e*scale);

      // 行を係数倍して他の行に足す。
      for (let row = 0; row < size; row++) {
        if (k === row) continue;
        // 係数
        const factor = -A.at(row, k)
        for (let j = 0; j < size; j++) {
          A.matrix[row][j] += A.matrix[k][j] * factor;
          B.matrix[row][j] += B.matrix[k][j] * factor;
        }
      }
    }
    return B;
  }

  determinant() {
    const size = this.row;
    if (size !== this.col) throw new Error("Matrix-determinant");

    // 小さい行列はハードコードした方が圧倒的に速い
    const list = this.matrix;
    if (size === 1) return list[0][0];
    if (size === 2) return list[0][0]*list[1][1]-list[0][1]*list[1][0];
    if (size === 3) return list[0][0]*list[1][1]*list[2][2]+list[1][1]*list[1][2]*list[2][0]+list[0][2]*list[1][0]*list[2][1]-list[0][2]*list[1][1]*list[2][0]-list[0][1]*list[1][0]*list[2][2]-list[0][0]*list[1][2]*list[2][1];

    const A = this.clone();
    let det = 1;
    let sign = 1;

    for (let k = 0; k < size; k++) {
      // 1. ピボット選択（絶対値が最大のものを選ぶ）
      let pivot = k;
      for (let i = k + 1; i < size; i++) {
        if (Math.abs(A.matrix[i][k]) > Math.abs(A.matrix[pivot][k])) pivot = i;
      }

      // 行を入れ替えたら行列式の符号を反転させる
      if (pivot !== k) {
        [A.matrix[k], A.matrix[pivot]] = [A.matrix[pivot], A.matrix[k]];
        sign *= -1;
      }

      const val = A.matrix[k][k];
    
      // 対角成分がほぼ0なら行列式は0（特異行列）
      if (Math.abs(val) < 1e-12) return 0;

      det *= val;

      // 下三角成分を消去
      for (let i = k + 1; i < size; i++) {
        const factor = A.matrix[i][k] / val;
        for (let j = k + 1; j < size; j++) {
          A.matrix[i][j] -= factor * A.matrix[k][j];
        }
      }
    }

    return det * sign;
  }
}

Physics.Three = class {
  
}
