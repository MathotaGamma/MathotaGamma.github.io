class JSWindow extends HTMLElement {
  constructor() {
    super();
    // Shadow DOMを作成
    const shadow = this.attachShadow({ mode: "open" });

    // テキストエリア
    const textarea = document.createElement("textarea");
    textarea.rows = 5;
    textarea.cols = 40;
    textarea.textContent = this.textContent.trim();

    // 実行ボタン
    const button = document.createElement("button");
    button.textContent = "実行";

    // 結果表示
    const output = document.createElement("pre");
    output.style.cssText = "background: #f4f4f4; padding: 10px; border: 1px solid #ddd; white-space: pre-wrap;";

    // Worker用のコード
    const workerCode = `
      // CompVisJSのインポート
      importScripts('https://makeplayonline.onrender.com/Static/API/CompVisJS/latest/CompVisJS.js');

      self.onmessage = function(event) {
        const { code } = event.data;

        // console.logをキャプチャする
        const logs = [];
        const originalLog = console.log;
        console.log = function(...args) {
          logs.push(args.join(" "));
        };

        try {
          // ユーザーコードを実行
          const result = eval(code);
          logs.forEach(log => self.postMessage({ type: 'log', message: log }));
          self.postMessage({ type: 'result', success: true, result: result });
        } catch (error) {
          self.postMessage({ type: 'result', success: false, error: error.message });
        } finally {
          // console.logを元に戻す
          console.log = originalLog;
        }
      };
    `;

    // WorkerをBlob URLから作成
    const blob = new Blob([workerCode], { type: "application/javascript" });
    const workerUrl = URL.createObjectURL(blob);

    // ボタン押下時の処理
    button.addEventListener("click", () => {
      // スマートクォートを通常のクォートに変換
      const code = textarea.value.replace(/“|”/g, '"').replace(/‘|’/g, "'");

      const worker = new Worker(workerUrl);
      let isTimeout = false;

      // タイムアウト設定（3秒後に停止）
      const timeout = setTimeout(() => {
        isTimeout = true;
        worker.terminate();
        output.innerHTML += "タイムアウト: コードの実行が長すぎます。<br>";
      }, 3000);

      // Workerからの結果を処理
      worker.onmessage = (event) => {
        clearTimeout(timeout); // タイムアウト解除
        if (isTimeout) return;

        const { type, success, result, error, message } = event.data;

        if (type === "log") {
          // Workerからのconsole.logの出力を追記
          output.innerHTML += `${message}<br>`;
        } else if (type === "result") {
          if (success) {
            if(result != undefined) output.innerHTML += `結果: ${result}<br>`;
          } else {
            output.innerHTML += `エラー: ${error}<br>`;
          }
          worker.terminate();
        }
      };

      // 出力をクリアしてから実行
      output.innerHTML = "";
      // Workerにコードを送信
      worker.postMessage({ code });
    });

    // 要素をShadow DOMに追加
    shadow.appendChild(textarea);
    shadow.appendChild(document.createElement("br"));
    shadow.appendChild(button);
    shadow.appendChild(output);
  }
}

// カスタム要素を登録
customElements.define("js-window", JSWindow);
