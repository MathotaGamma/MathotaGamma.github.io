export default class Matrix {
  // コンストラクタは空
  constructor() {}

  // staticメソッド: 指定されたサイズ(N x M)のFloat32Arrayをランダム生成して返す
  static randomGenerate(N, M) {
    const arr = new Float32Array(N * M);
    for (let i = 0; i < N * M; i++) {
      arr[i] = Math.random();
    }
    return arr;
  }

  // staticメソッド: 外部から行列とサイズを受け取って計算
  static pro(matrixA, matrixB, N, K, M) {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;

    // --- 1. シェーダーのコンパイルとリンク ---
    const vsSource = `#version 300 es
        in vec2 position; void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

    // Kの値を動的にシェーダーへ埋め込む（ループ上限のため）
    const fsSource = `#version 300 es
        precision highp float;
        uniform sampler2D u_texA; uniform sampler2D u_texB; uniform int u_N;
        out vec4 fragColor;
        void main() {
            int out_col = int(gl_FragCoord.x);
            int row = int(gl_FragCoord.y);
            int base_col = out_col * 4;
            vec4 sum = vec4(0.0);
            for(int i = 0; i < ${K}; i++) { // Kの数だけループ
                float a = texelFetch(u_texA, ivec2(i, row), 0).r;
                sum.r += a * texelFetch(u_texB, ivec2(base_col,     i), 0).r;
                sum.g += a * texelFetch(u_texB, ivec2(base_col + 1, i), 0).r;
                sum.b += a * texelFetch(u_texB, ivec2(base_col + 2, i), 0).r;
                sum.a += a * texelFetch(u_texB, ivec2(base_col + 3, i), 0).r;
            }
            fragColor = sum;
        }`;

    function createShader(gl, type, src) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); 
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }

    const glProgram = gl.createProgram();
    gl.attachShader(glProgram, createShader(gl, gl.VERTEX_SHADER, vsSource));
    gl.attachShader(glProgram, createShader(gl, gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(glProgram);

    gl.useProgram(glProgram);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);

    // --- 2. リソースの作成 ---
    const glTA = gl.createTexture();
    const glTB = gl.createTexture();
    const glTC = gl.createTexture();
    const glFB = gl.createFramebuffer();

    const positions = new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]);
    const glBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(glProgram, 'position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(glProgram, "u_N"), N);

    // 出力バッファのサイズ計算 (列数Mを4本のRGBAにパックするため M / 4)
    const outW = M / 4; 
    const outH = N;
    const outRaw = new Float32Array(outW * outH * 4);

    // --- 3. テクスチャのデータ転送と描画 ---
    gl.bindTexture(gl.TEXTURE_2D, glTA);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, K, N, 0, gl.RED, gl.FLOAT, matrixA); // Aは N行 K列
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.bindTexture(gl.TEXTURE_2D, glTB);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, M, K, 0, gl.RED, gl.FLOAT, matrixB); // Bは K行 M列
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, glFB);
    gl.bindTexture(gl.TEXTURE_2D, glTC);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, outW, outH, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glTC, 0);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, glTA);
    gl.uniform1i(gl.getUniformLocation(glProgram, "u_texA"), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, glTB);
    gl.uniform1i(gl.getUniformLocation(glProgram, "u_texB"), 1);
    
    gl.viewport(0, 0, outW, outH);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.FLOAT, outRaw); 

    // --- 4. クリーンアップとデータ詰め替え ---
    gl.deleteTexture(glTA);
    gl.deleteTexture(glTB);
    gl.deleteTexture(glTC);
    gl.deleteFramebuffer(glFB);
    gl.deleteBuffer(glBuffer);
    gl.deleteProgram(glProgram);

    const finalData = new Float32Array(N * M);
    for (let i = 0; i < outW * outH; i++) {
        finalData[i * 4 + 0] = outRaw[i * 4 + 0];
        finalData[i * 4 + 1] = outRaw[i * 4 + 1];
        finalData[i * 4 + 2] = outRaw[i * 4 + 2];
        finalData[i * 4 + 3] = outRaw[i * 4 + 3];
    }

    return finalData;
  }
}

/*
// --- 外部での実行・計測コード例 ---
(async () => {
  const N = 1024, K = 1024, M = 1024;

  // 1. staticメソッドで外部からデータを生成して保持
  const myMatrixA = Matrix.randomGenerate(N, K);
  const myMatrixB = Matrix.randomGenerate(K, M);
  
  await new Promise(r => setTimeout(r, 50)); 
  
  // 2. 外部からデータを渡して実行時間を計測
  const start = performance.now();
  const res = Matrix.pro(myMatrixA, myMatrixB, N, K, M);
  const end = performance.now();

  console.log(`計算完了: ${(end - start).toFixed(2)} ms`);
  console.log(`出力結果データ:`, res);
})();
*/
