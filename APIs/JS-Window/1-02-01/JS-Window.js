// JS-Window.js（type="module"で読み込む）
/*
<script type="module">
  import { registerLibs } from "https://mathotagamma.github.io/APIs/JS-Window/1-02-01/JS-Window.js";

  // Library登録。
  registerLibs([
    "https://mathotagamma.github.io/APIs/CompVisJS/1-02-02/CompVisJS.js",
    "https://mathotagamma.github.io/APIs/Physics/1-01-01/Physics.js"
  ]);
</script>
*/

// ===== グローバル管理 =====
const GLOBAL_LIBS = [];
const LIB_CACHE = new Map();

// ライブラリ登録（headerで1回だけ呼ぶ）
export function registerLibs(urls = []) {
  GLOBAL_LIBS.length = 0;
  GLOBAL_LIBS.push(...urls);
}

// ライブラリ読み込み（キャッシュ付き）
async function loadLib(url) {
  if (LIB_CACHE.has(url)) return LIB_CACHE.get(url);

  const text = await fetch(url).then(r => r.text());
  const fixed = text.replace(/window/g, "self"); // Worker用
  LIB_CACHE.set(url, fixed);
  return fixed;
}

// ===== Custom Element =====
class JSWindow extends HTMLElement {
  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
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

      // 登録済みライブラリ取得
      const libTexts = await Promise.all(
        GLOBAL_LIBS.map(loadLib)
      );

      const workerCode = `
        ${libTexts.join("\n")}

        self.onmessage = function(event) {
          const { code } = event.data;

          const logs = [];
          const originalLog = console.log;
          console.log = (...args) => {
            logs.push(args.join(" "));
          };

          try {
            const result = eval(code);

            logs.forEach(log => {
              self.postMessage({ type: "log", message: log });
            });

            self.postMessage({
              type: "result",
              success: true,
              result
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

    this.shadow.innerHTML = "";
    this.shadow.appendChild(textarea);
    this.shadow.appendChild(document.createElement("br"));
    this.shadow.appendChild(button);
    this.shadow.appendChild(output);
  }
}

customElements.define("js-window", JSWindow);
