class WebGL {
  constructor(onLog = null) {
    this.programs = {};
    this.gl = null;
    this.onLog = onLog;
  }

  log(level, message) {
    if (this.onLog) this.onLog(level, message);
  }

  // canvasを渡せば既存のcanvasを使い、渡さなければ新規作成してbodyに追加する
  init(canvas = null) {
    this.canvas = canvas || document.createElement('canvas');
    if (!canvas) document.body.appendChild(this.canvas);
    this.gl = this.canvas.getContext('webgl2');
    if (!this.gl) throw new Error("WebGL2がサポートされていません。");
  }

  // ------------------------------
  // シェーダー / プログラム関連
  // ------------------------------

  compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    const status = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    this.log('debug', 'shader compile status: ' + status);
    if (!status) {
      const info = gl.getShaderInfoLog(shader);
      this.log('error', 'shader info: ' + info);
    }

    return shader;
  }

  // transformFeedbackVaryings: GPGPU（Transform Feedback）で使う場合、
  // フィードバックしたいvarying名の配列を渡す（例: ['result']）
  createProgram(vertexShaderSource, fragmentShaderSource, transformFeedbackVaryings = null) {
    const gl = this.gl;
    const vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);

    if (transformFeedbackVaryings) {
      gl.transformFeedbackVaryings(program, transformFeedbackVaryings, gl.SEPARATE_ATTRIBS);
    }

    gl.linkProgram(program);
    const linkStatus = gl.getProgramParameter(program, gl.LINK_STATUS);
    this.log('debug', 'link status: ' + linkStatus);
    if (!linkStatus) {
      const info = gl.getProgramInfoLog(program);
      this.log('error', 'program info: ' + info);
    }

    // リンク後はシェーダーオブジェクト自体は不要になるので破棄しておく
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    return program;
  }

  registerProgram(name, vertexShaderSource, fragmentShaderSource, transformFeedbackVaryings = null) {
    this.programs[name] = this.createProgram(vertexShaderSource, fragmentShaderSource, transformFeedbackVaryings);
    return this.programs[name];
  }

  useProgram(nameOrProgram) {
    const program = typeof nameOrProgram === 'string' ? this.programs[nameOrProgram] : nameOrProgram;
    this.gl.useProgram(program);
    return program;
  }

  // ------------------------------
  // バッファ / attribute関連
  // ------------------------------

  createBuffer(target, value, usage = this.gl.STATIC_DRAW) {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, value, usage);
    return buffer;
  }

  // 既存バッファの中身だけを差し替える（作り直さない＝最速の更新パス）
  updateBufferData(buffer, data, offsetBytes = 0, target = this.gl.ARRAY_BUFFER) {
    const gl = this.gl;
    gl.bindBuffer(target, buffer);
    gl.bufferSubData(target, offsetBytes, data);
  }

  /*
    互換用（バッファを分けて属性を結びつける汎用版）。
    毎フレーム呼ぶと属性ごとにバッファ生成が走るため遅い。
    高速に描画したい場合は下のcreateVAOを使うこと。
  */
  bindAttributes(program, list = {}) {
    const gl = this.gl;
    const buffers = {};

    for (let name in list) {
      const data = list[name];
      const size = data.size;
      const type = data.type || gl.FLOAT;
      const value = data.value;
      const usage = data.usage || gl.STATIC_DRAW;
      const normalized = data.normalized || false;

      const attribLocation = gl.getAttribLocation(program, name);
      if (attribLocation === -1) {
        this.log('error', 'attribute not found: ' + name);
        continue;
      }

      const buffer = this.createBuffer(gl.ARRAY_BUFFER, value, usage);
      gl.enableVertexAttribArray(attribLocation);
      gl.vertexAttribPointer(attribLocation, size, type, normalized, 0, 0);
      buffers[name] = buffer;
    }

    return buffers;
  }

  /*
    ------------------------------
    最速描画用: VAOキャッシュ + インターリーブ属性
    ------------------------------

    layout = [{ name, size, type }, ...]
    data はインターリーブ済みの1本の配列
      例: [x,y,z, r,g,b,a,  x,y,z, r,g,b,a, ...]

    1本のバッファに対してstride（1頂点あたりのバイト数）と
    offset（各属性の開始バイト位置）を計算し、vertexAttribPointerに渡す。
    これにより
      - バッファのbind回数が1回で済む
      - GPU側のメモリアクセスがまとまり局所性が良くなる
      - VAOに設定を焼き込むので、描画時はbindVertexArrayだけでよい
    という理由で複数バッファ方式より高速になる。

    戻り値のVAOハンドルは使い回すこと（毎フレーム作り直さない）。
  */
  createVAO(program, layout, data, usage = this.gl.STATIC_DRAW) {
    const gl = this.gl;
    const typeSizes = {
      [gl.FLOAT]: 4,
      [gl.UNSIGNED_BYTE]: 1,
      [gl.BYTE]: 1,
      [gl.SHORT]: 2,
      [gl.UNSIGNED_SHORT]: 2
    };

    // 各属性のバイトオフセットを前から積算して求める
    let stride = 0;
    const withOffsets = layout.map((attr) => {
      const type = attr.type || gl.FLOAT;
      const offset = stride;
      stride += attr.size * (typeSizes[type] || 4);
      return { name: attr.name, size: attr.size, type, offset };
    });

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const buffer = this.createBuffer(gl.ARRAY_BUFFER, data, usage);

    for (const attr of withOffsets) {
      const location = gl.getAttribLocation(program, attr.name);
      if (location === -1) {
        this.log('error', 'attribute not found: ' + attr.name);
        continue;
      }
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, attr.size, attr.type, false, stride, attr.offset);
    }

    gl.bindVertexArray(null);

    return { vao, buffer, stride, layout: withOffsets };
  }

  // 事前構築済みのVAOをbindして描画するだけ（属性の再設定をしないため最速）
  drawVAO(vaoHandle, mode, first, count) {
    const gl = this.gl;
    gl.bindVertexArray(vaoHandle.vao);
    gl.drawArrays(mode, first, count);
    gl.bindVertexArray(null);
  }

  // ------------------------------
  // 描画共通処理
  // ------------------------------

  updateSize(w, h) {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.gl.viewport(0, 0, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);
  }

  clear(r = 0, g = 0, b = 0, a = 1) {
    const gl = this.gl;
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // flushは基本的に不要（ブラウザが適切なタイミングで自動的に行う）。
  // 明示的に呼ぶとGPUとの同期待ちが発生し逆に遅くなるため、既定ではオフにしている。
  drawArrays(mode, first, count, flush = false) {
    this.gl.drawArrays(mode, first, count);
    if (flush) this.gl.flush();
  }

  // ------------------------------
  // GPGPU（Transform Feedback）関連
  // ------------------------------

  // 1チャンネル（R32F）のFloatテクスチャを新規作成する
  createDataTexture(width, height, data) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  // 既存テクスチャの中身だけを差し替える（作り直さない＝最速の更新パス）
  updateDataTexture(texture, width, height, data) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  bindTexture(program, uniformName, texture, unit) {
    const gl = this.gl;
    // uniform1iは「現在useProgramでアクティブになっているプログラム」に対して働く。
    // ここでuseProgramを呼ばずにいると、他のプログラム（描画ループの三角形用など）が
    // アクティブなタイミングで呼ばれた場合にサイレントに失敗し、
    // サンプラーがデフォルト値（0）のまま＝意図しないテクスチャユニットを参照し続ける
    // ＝計算結果が壊れる（全部0になるなど）原因になっていた。
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const location = gl.getUniformLocation(program, uniformName);
    gl.uniform1i(location, unit);
  }

  /*
    ------------------------------
    最速GPGPU用: カーネルを事前に一括構築して使い回す
    ------------------------------

    program / VAO / attribute buffer / 出力バッファ / テクスチャを
    すべて初回にまとめて作成し、以降は run() を呼ぶだけにする。
    毎フレームのcreateProgram・createTexture・createBufferを排除するのが目的。

    入力を差し替えたい場合は kernel.setTexture(name, width, height, data) を呼ぶと、
    サイズが変わらない限りtexSubImage2Dで中身だけ更新される（テクスチャ再生成なし）。

    options = {
      vertexShaderSource, fragmentShaderSource,
      varyings,               // 例 ['result']
      attributes,             // { name: {size, value} } … 通常は使い回すindexバッファなど
      outputSize,             // 出力要素数（floatの個数）
      vertexCount,            // 実行する頂点数
      mode                    // 省略時 gl.POINTS
    }
  */
  createGpgpuKernel(options) {
    const gl = this.gl;
    const {
      vertexShaderSource,
      fragmentShaderSource,
      varyings,
      attributes = {},
      outputSize,
      vertexCount,
      mode = gl.POINTS
    } = options;

    const program = this.createProgram(vertexShaderSource, fragmentShaderSource, varyings);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    this.bindAttributes(program, attributes);
    gl.bindVertexArray(null);

    // DYNAMIC_COPY: 繰り返しGPUで書き込んでCPUが読み出す用途向けのヒント
    const outputBuffer = gl.createBuffer();
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, outputBuffer);
    gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, outputSize * 4, gl.DYNAMIC_COPY);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);

    const result = new Float32Array(outputSize);
    const textures = {};
    const textureSizes = {};
    const textureUnits = {};
    let nextUnit = 0;

    // テクスチャ入力を登録／更新する（同サイズなら中身だけ差し替えて再利用）
    const setTexture = (uniformName, width, height, data) => {
      const cached = textureSizes[uniformName];
      const sameSize = cached && cached.width === width && cached.height === height;

      if (!textures[uniformName]) {
        textures[uniformName] = this.createDataTexture(width, height, data);
        textureUnits[uniformName] = nextUnit++;
      } else if (sameSize) {
        this.updateDataTexture(textures[uniformName], width, height, data);
      } else {
        gl.deleteTexture(textures[uniformName]);
        textures[uniformName] = this.createDataTexture(width, height, data);
      }

      textureSizes[uniformName] = { width, height };
      this.bindTexture(program, uniformName, textures[uniformName], textureUnits[uniformName]);
    };

    const setUniformInt = (name, value) => {
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, name), value);
    };

    // float配列をuniformとして直接渡す（頂点テクスチャフェッチに依存しない経路）
    // 環境によっては頂点シェーダでのテクスチャサンプリングが不安定なことがあるため、
    // 小〜中規模のデータはこちらの方が確実に動く
    const setUniformFloatArray = (name, data) => {
      gl.useProgram(program);
      gl.uniform1fv(gl.getUniformLocation(program, name), data);
    };

    const run = () => {
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, outputBuffer);

      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(mode);
      gl.drawArrays(mode, 0, vertexCount);
      gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);

      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindVertexArray(null);

      gl.bindBuffer(gl.ARRAY_BUFFER, outputBuffer);
      gl.getBufferSubData(gl.ARRAY_BUFFER, 0, result);
      return result;
    };

    const dispose = () => {
      for (const name in textures) gl.deleteTexture(textures[name]);
      gl.deleteBuffer(outputBuffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    };

    return { program, setTexture, setUniformInt, setUniformFloatArray, run, dispose };
  }
}
