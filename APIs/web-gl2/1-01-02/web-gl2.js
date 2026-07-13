class WebGL {
  constructor(onLog = null) {
    this.programs = {};
    this.gl = null;
    this.onLog = onLog;
  }

  log(level, message) {
    if (this.onLog) this.onLog(level, message);
  }

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

  updateBufferData(buffer, data, offsetBytes = 0, target = this.gl.ARRAY_BUFFER) {
    const gl = this.gl;
    gl.bindBuffer(target, buffer);
    gl.bufferSubData(target, offsetBytes, data);
  }

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

  createVAO(program, layout, data, usage = this.gl.STATIC_DRAW) {
    const gl = this.gl;
    const typeSizes = {
      [gl.FLOAT]: 4,
      [gl.UNSIGNED_BYTE]: 1,
      [gl.BYTE]: 1,
      [gl.SHORT]: 2,
      [gl.UNSIGNED_SHORT]: 2
    };

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

  drawVAO(vaoHandle, mode, first, count) {
    const gl = this.gl;
    gl.bindVertexArray(vaoHandle.vao);
    gl.drawArrays(mode, first, count);
    gl.bindVertexArray(null);
  }

  // ------------------------------
  // 描画共通処理 / 最速行列対応
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

  drawArrays(mode, first, count, flush = false) {
    this.gl.drawArrays(mode, first, count);
    if (flush) this.gl.flush();
  }

  /**
   * [新規追加] 描画最速化用: Uniform Buffer Object (UBO) の作成
   * 毎フレーム複数のUniform行列（Proj/View/Worldなど）を個別に送るオーバーヘッドを無くし、
   * 1本のバッファ転送で全シェーダーに一括共有させます。
   */
  createUBO(program, blockName, blockBindingPoint, sizeInBytes) {
    const gl = this.gl;
    const blockIndex = gl.getUniformBlockIndex(program, blockName);
    if (blockIndex === gl.INVALID_INDEX) {
      this.log('error', `Uniform block '${blockName}' not found.`);
      return null;
    }
    gl.uniformBlockBinding(program, blockIndex, blockBindingPoint);

    const ubo = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, sizeInBytes, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);

    return ubo;
  }

  /**
   * [新規追加] UBOデータの最速更新パス
   */
  updateUBO(ubo, float32Data, blockBindingPoint) {
    const gl = this.gl;
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, float32Data);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, blockBindingPoint, ubo);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
  }


  // ------------------------------
  // GPGPU（Transform Feedback）関連 / RGBA対応
  // ------------------------------

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

  updateDataTexture(texture, width, height, data) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * [新規追加] 4チャンネル（RGBA32F）のFloatテクスチャを新規作成する（並列処理用）
   */
  createDataTextureRGBA(width, height, data) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  /**
   * [新規追加] RGBA32Fテクスチャの高速データ更新
   */
  updateDataTextureRGBA(texture, width, height, data) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  bindTexture(program, uniformName, texture, unit) {
    const gl = this.gl;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const location = gl.getUniformLocation(program, uniformName);
    gl.uniform1i(location, unit);
  }

  createGpgpuKernel(options) {
    const gl = this.gl;
    const {
      vertexShaderSource,
      fragmentShaderSource,
      varyings,
      attributes = {},
      outputSize,
      vertexCount,
      mode = gl.POINTS,
      isRGBA = false // [新規追加オプション] RGBA並列フラグ
    } = options;

    const program = this.createProgram(vertexShaderSource, fragmentShaderSource, varyings);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    this.bindAttributes(program, attributes);
    gl.bindVertexArray(null);

    const outputBuffer = gl.createBuffer();
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, outputBuffer);
    // RGBAなら1要素あたり float×4（16バイト）になる
    const elementSize = isRGBA ? 16 : 4;
    gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, outputSize * elementSize, gl.DYNAMIC_COPY);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);

    // 引数 outputSize に応じた格納先配列
    const result = new Float32Array(isRGBA ? outputSize * 4 : outputSize);
    const textures = {};
    const textureSizes = {};
    const textureUnits = {};
    let nextUnit = 0;

    const setTexture = (uniformName, width, height, data, useRGBA = isRGBA) => {
      const cached = textureSizes[uniformName];
      const sameSize = cached && cached.width === width && cached.height === height;

      if (!textures[uniformName]) {
        textures[uniformName] = useRGBA 
          ? this.createDataTextureRGBA(width, height, data) 
          : this.createDataTexture(width, height, data);
        textureUnits[uniformName] = nextUnit++;
      } else if (sameSize) {
        if (useRGBA) {
          this.updateDataTextureRGBA(textures[uniformName], width, height, data);
        } else {
          this.updateDataTexture(textures[uniformName], width, height, data);
        }
      } else {
        gl.deleteTexture(textures[uniformName]);
        textures[uniformName] = useRGBA 
          ? this.createDataTextureRGBA(width, height, data) 
          : this.createDataTexture(width, height, data);
      }

      textureSizes[uniformName] = { width, height };
      this.bindTexture(program, uniformName, textures[uniformName], textureUnits[uniformName]);
    };

    const setUniformInt = (name, value) => {
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, name), value);
    };

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

  /**
   * [新規追加] 最速GPGPU: 行列掛け算専用カーネル作成 (Matrix Multiplication)
   * 巨大な行列 A (M x K) と 行列 B (K x N) の乗算を、RGBAテクスチャフェッチと
   * Transform Feedbackを用いてGPU側で超高速に並列計算します。
   */
  createMatrixMulKernel(M, K, N) {
    // 頂点シェーダー内で、Aの行(K個のfloat = vec4がK/4個) と Bの列 を内積計算する
    // N個の列 × M個の行 ＝ 合計 M*N 個の要素を出力（RGBAならさらに4倍効率化可能だが、シンプルな位置マッピングで実装）
    const vs = `#version 300 es
      in float vertexId;
      uniform sampler2D texA; // M x ceil(K/4) [RGBA32F]
      uniform sampler2D texB; // N x ceil(K/4) [RGBA32F] (あらかじめ転置しておくと最速)
      uniform int uK;
      uniform int uN;
      out vec4 resultRGBA; // 1頂点で4成分(1つの結合された結果など)を出力可能

      void main() {
        int idx = int(vertexId);
        int row = idx / uN;
        int col = idx % uN;

        // RGBAフェッチを使い、1回につき4個の要素を同時に積算（最速のメモリアクセス局所性）
        vec4 sum = vec4(0.0);
        int blocks = (uK + 3) / 4;
        
        for(int i = 0; i < blocks; i++) {
          vec4 a = texelFetch(texA, ivec2(i, row), 0);
          vec4 b = texelFetch(texB, ivec2(i, col), 0);
          sum += a * b;
        }
        
        // 内積の合計
        float dotResult = sum.x + sum.y + sum.z + sum.w;
        resultRGBA = vec4(dotResult, 0.0, 0.0, 0.0); 
      }
    `;

    const fs = `#version 300 es
      precision mediump float;
      void main() {}
    `;

    // 頂点ID配列の準備
    const count = M * N;
    const ids = new Float32Array(count);
    for(let i = 0; i < count; i++) ids[i] = i;

    const kernel = this.createGpgpuKernel({
      vertexShaderSource: vs,
      fragmentShaderSource: fs,
      varyings: ['resultRGBA'],
      attributes: {
        vertexId: { size: 1, value: ids, type: this.gl.FLOAT }
      },
      outputSize: count,
      vertexCount: count,
      isRGBA: true
    });

    kernel.setUniformInt('uK', K);
    kernel.setUniformInt('uN', N);

    /**
     * 行列データをテクスチャ形式にパックして実行する最速ラップ関数
     * dataA: Float32Array (M * K)
     * dataB: Float32Array (K * N) -> ※あらかじめ転置(N * K)して渡すとテクスチャフェッチが連続して最速化
     */
    const execute = (dataA, dataB) => {
      const blocks = Math.ceil(K / 4);
      
      // RGBA32Fの幅にパディングしたFloat32Arrayを生成
      const packedA = new Float32Array(M * blocks * 4);
      for(let r=0; r<M; r++) {
        for(let k=0; k<K; k++) {
          packedA[(r * blocks * 4) + k] = dataA[r * K + k];
        }
      }

      const packedB = new Float32Array(N * blocks * 4);
      for(let c=0; c<N; c++) {
        for(let k=0; k<K; k++) {
          // Bが転置されている前提（N行K列）の高速アクセス
          packedB[(c * blocks * 4) + k] = dataB[c * K + k];
        }
      }

      kernel.setTexture('texA', blocks, M, packedA, true);
      kernel.setTexture('texB', blocks, N, packedB, true);
      
      const rawOut = kernel.run();
      // vec4(x, 0, 0, 0) から等間隔で結果を抽出
      const finalResult = new Float32Array(M * N);
      for(let i = 0; i < M * N; i++) {
        finalResult[i] = rawOut[i * 4];
      }
      return finalResult;
    };

    return { execute, dispose: kernel.dispose };
  }
}
