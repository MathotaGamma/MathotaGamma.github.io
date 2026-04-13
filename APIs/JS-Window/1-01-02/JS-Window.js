// 外部読み込み（メイン側）
import "https://mathotagamma.github.io/APIs/CompVisJS/1-02-02/CompVisJS.js";

class JSWindow extends HTMLElement {
  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
  }

  static version = "1.01.01";
  static CompVis_version = "1.02.02";

  connectedCallback() {
    const shadow = this.shadow;

    const textarea = document.createElement("textarea");
    textarea.rows = 5;
    textarea.cols = 40;
    textarea.value = this.textContent.trim();

    const button = document.createElement("button");
    button.textContent = "実行";

    const output = document.createElement("pre");
    output.style.cssText =
      "background:#f4f4f4;padding:10px;border:1px solid #ddd;white-space:pre-wrap;";

    button.addEventListener("click", async () => {
      const code = textarea.value
        .replace(/“|”/g, '"')
        .replace(/‘|’/g, "'");

      // 👇 外部JSをテキストとして取得
      const libText = await fetch(
        "https://mathotagamma.github.io/APIs/CompVisJS/1-02-02/CompVisJS.js"
      ).then(r => r.text());
      const fixedLib = libText.replace(/window/g, "self");

      // Workerコードに埋め込む
      const workerCode = `
        ${fixedLib}

        self.onmessage = function(event) {
          const { code } = event.data;

          const logs = [];
          const originalLog = console.log;
          console.log = (...args) => {
            logs.push(args.join(" "));
            return undefined;
          };

          try {
            const result = eval(code);

            logs.forEach(log => {
              self.postMessage({ type: "log", message: log });
            });

            self.postMessage({
              type: "result",
              success: true,
              result: result
            });

          } catch (error) {
            self.postMessage({
              type: "result",
              success: false,
              error: error.message
            });
          } finally {
            console.log = originalLog;
          }
        };
      `;

      const blob = new Blob([workerCode], {
        type: "application/javascript"
      });

      const worker = new Worker(URL.createObjectURL(blob));

      output.innerHTML = "";

      worker.onmessage = (event) => {
        const { type, success, result, error, message } = event.data;

        if (type === "log") {
          output.innerHTML += message + "<br>";
        } else if (type === "result") {
          if (success) {
            if (result !== undefined) {
              output.innerHTML += "結果: " + result + "<br>";
            }
          } else {
            output.innerHTML += "エラー: " + error + "<br>";
          }
          worker.terminate();
        }
      };

      worker.postMessage({ code });
    });

    shadow.innerHTML = "";
    shadow.appendChild(textarea);
    shadow.appendChild(document.createElement("br"));
    shadow.appendChild(button);
    shadow.appendChild(output);
  }
}

customElements.define("js-window", JSWindow);
