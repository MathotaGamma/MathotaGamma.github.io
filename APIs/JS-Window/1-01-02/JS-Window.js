class JSWindow extends HTMLElement {
  constructor() {
    super();
    // Shadow DOMを作成
    this.shadow = this.attachShadow({ mode: "open" });
  }

  static version = "1.01.02";
  static CompVis_version = "1.02.02";

  connectedCallback() {
    const shadow = this.shadow;

    // テキストエリア
    const textarea = document.createElement("textarea");
    textarea.rows = 5;
    textarea.cols = 40;
    textarea.value = this.textContent.trim(); // ← 修正

    // 実行ボタン
    const button = document.createElement("button");
    button.textContent = "実行";

    // 結果表示
    const output = document.createElement("pre");
    output.style.cssText =
      "background: #f4f4f4; padding: 10px; border: 1px solid #ddd; white-space: pre-wrap;";

    // Worker用のコード（そのまま）
    const workerCode = `
      importScripts('https://mathotagamma.github.io/APIs/CompVisJS/1-02-02/CompVisJS.js');

      self.onmessage = function(event) {
        const { code } = event.data;

        const logs = [];
        const originalLog = console.log;
        console.log = function(...args) {
          logs.push(args.join(" "));
        };

        try {
          const result = eval(code);
          logs.forEach(log => self.postMessage({ type: 'log', message: log }));
          self.postMessage({ type: 'result', success: true, result: result });
        } catch (error) {
          self.postMessage({ type: 'result', success: false, error: error.message });
        } finally {
          console.log = originalLog;
        }
      };
    `;

    const blob = new Blob([workerCode], { type: "application/javascript" });
    const workerUrl = URL.createObjectURL(blob);

    // ボタン処理
    button.addEventListener("click", () => {
      const code = textarea.value
        .replace(/“|”/g, '"')
        .replace(/‘|’/g, "'");

      const worker = new Worker(workerUrl);
      let isTimeout = false;

      const timeout = setTimeout(() => {
        isTimeout = true;
        worker.terminate();
        output.innerHTML += "タイムアウト: コードの実行が長すぎます。<br>";
      }, 3000);

      worker.onmessage = (event) => {
        clearTimeout(timeout);
        if (isTimeout) return;

        const { type, success, result, error, message } = event.data;

        if (type === "log") {
          output.innerHTML += `${message}<br>`;
        } else if (type === "result") {
          if (success) {
            if (result != undefined) {
              output.innerHTML += `結果: ${result}<br>`;
            }
          } else {
            output.innerHTML += `エラー: ${error}<br>`;
          }
          worker.terminate();
        }
      };

      output.innerHTML = "";
      worker.postMessage({ code });
    });

    // 初期化（重複防止）
    shadow.innerHTML = "";
    shadow.appendChild(textarea);
    shadow.appendChild(document.createElement("br"));
    shadow.appendChild(button);
    shadow.appendChild(output);
  }
}

// 登録（moduleでもOK）
customElements.define("js-window", JSWindow);
