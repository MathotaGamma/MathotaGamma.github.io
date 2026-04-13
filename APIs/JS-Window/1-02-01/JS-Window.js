// JS-Window.js（type="module"）
const GLOBAL_LIBS = [];
const LIB_CACHE = new Map();

export function registerLibs(urls = []) {
  GLOBAL_LIBS.length = 0;
  GLOBAL_LIBS.push(...urls);
}

async function loadLib(url) {
  if (LIB_CACHE.has(url)) return LIB_CACHE.get(url);

  const text = await fetch(url).then(r => r.text());
  const fixed = text.replace(/\bwindow\b/g, "self");
  LIB_CACHE.set(url, fixed);
  return fixed;
}

class JSWindow extends HTMLElement {
  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    this.textarea = document.createElement("textarea");
  }
  
  static get observedAttributes() {
    return ["row", "col"];
  }
  
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    this.attribute();
  }
  
  attribute() {
    const row = this.getAttribute("row") ?? "6";
    const col = this.getAttribute("col") ?? "40";
    this.textarea.rows = row;
    this.textarea.cols = col;
  }
  
  connectedCallback() {
    const textarea = this.textarea;
    this.attribute();
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

      const libTexts = await Promise.all(GLOBAL_LIBS.map(loadLib));

      const workerCode = `
        ${libTexts.join("\n")}

        function safeStringify(obj) {
          const seen = new WeakSet();
          return JSON.stringify(obj, (key, value) => {
            if (typeof value === "object" && value !== null) {
              if (seen.has(value)) return "[Circular]";
              seen.add(value);
            }
            if (typeof value === "function") {
              return "[Function " + (value.name || "anonymous") + "]";
            }
            if (value instanceof Map) return Object.fromEntries(value);
            if (value instanceof Set) return Array.from(value);
            return value;
          }, 2);
        }

        self.onmessage = async function(event) {
          const { code } = event.data;

          const originalLog = console.log;

          // リアルタイムログ
          console.log = (...args) => {
            const msg = args.map(a => {
              if (typeof a === "object" && a !== null) {
                return safeStringify(a);
              }
              return String(a);
            }).join(" ");

            self.postMessage({ type: "log", message: msg });
          };

          try {
            // async対応
            const result = await (async () => eval(code))();

            self.postMessage({
              type: "result",
              success: true,
              result:
                (typeof result === "object" && result !== null)
                  ? safeStringify(result)
                  : result
            });

          } catch (error) {
            self.postMessage({
              type: "result",
              success: false,
              error: safeStringify(error)
            });
          } finally {
            console.log = originalLog;
          }
        };
      `;

      const worker = new Worker(
        URL.createObjectURL(new Blob([workerCode], { type: "application/javascript" }))
      );

      output.textContent = "";

      worker.onmessage = (event) => {
        const { type, success, result, error, message } = event.data;

        if (type === "log") {
          output.textContent += message + "\n";
        } else {
          if (success) {
            // evalの結果を表示
            /*
            if (result !== undefined) {
              
              output.textContent += "結果: " + result + "\n";
            }
            */
          } else {
            output.textContent += "エラー: " + error + "\n";
          }
          worker.terminate();
        }
      };

      worker.postMessage({ code });
    });

    this.shadow.innerHTML = "";
    this.shadow.append(textarea, document.createElement("br"), button, output);
  }
}

customElements.define("js-window", JSWindow);
