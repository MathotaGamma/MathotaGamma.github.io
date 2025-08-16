CompVis.View = class {
    
        constructor(canvasElem, options = {}) {
          this.canvas = canvasElem;
          this.ctx = this.canvas.getContext("2d");
          this.dpi = window.devicePixelRatio || 1;
          this.graphs = [];

          // 初期座標・拡大率（gridコード準拠）
          this.offsetX = 0;
          this.offsetY = 0;

           // 1単位＝100px（初期）
          this.xScale = 100;
          this.yScale = 100;
          

          // 制限値
          this.MIN_SCALE = 1e-4;
          this.MAX_SCALE = 1e6;

          // タッチ操作用変数
          this.lastTouchDist = null;
          this.lastTouchCenter = null;
          this.lastPanPos = null;

          this.resize();
          window.addEventListener("resize", () => this.resize());

          
          
          //mode -> static : mainOption適用。
          //     -> dynamic: mainoption適用しない。
          this.mode = options.mode !== undefined ? options.mode : "static";
          this.autoScale =  options.autoScale !== undefined ? options.autoScale : false;
          this.showAxis = options.showAxis !== undefined ? options.showAxis : false;
          this.rangeX = options.rangeX !== undefined ? options.rangeX : [-this.W/2, this.W/2];
          this.rangeY = options.rangeY !== undefined ? options.rangeY : [-this.H/2, this.H/2];
          
          if(this.mode == "dynamic") {
            // イベント登録
            this.canvas.addEventListener("wheel", e => this.onWheel(e));
            this.canvas.addEventListener("touchstart", e => this.onTouchStart(e), {passive:false});
            this.canvas.addEventListener("touchmove", e => this.onTouchMove(e), {passive:false});
            this.canvas.addEventListener("touchend", e => this.onTouchEnd(e));
          }
        }

        //----------------
        // resize
        //----------------
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

        //----------------
        // グラフ追加
        //----------------
        addGraph(f, a, b, span, options = {}) {
          for (let i = 0; i <= span; i++) {
            const t = a + (b - a) * i / span;
            let res;
            try {
              res = f(t);
            } catch {
              continue;
            }
            if (res instanceof Array){
              options.isParametric = true;
              break;
            }
          }
          const graph = {
            f,
            a,
            b,
            span,
            color : options.color !== undefined ? options.color : "0ff",
            isParametric : options.isParametric !== undefined ? options.isParametric : false,
          };
          this.graphs.push(graph);
          this.renderAll();
          return graph;
        }

        //----------------
        // 一括描画
        //----------------
        renderAll() {
          this.ctx.clearRect(0, 0, this.W, this.H);
          // グリッド描画
          const viewData = [];
          for (const graph of this.graphs) {
            viewData.push(this.renderGraph(graph));
          }
          
          if (this.showAxis) {
            this.drawGrid();
          }
          
          return viewData;
        }
  
        calcRange() {
          let wid = this.W / (2 * this.xScale);
          let hei = this.H / (2 * this.yScale);
          
          return { a: -wid+this.offsetX, b: wid+this.offsetX};
        }

        //----------------
        // グリッド描画（元gridコードをほぼそのまま）
        //----------------
        calcSpacing() {
          const idealPx = 15;
          let factorList = [];
          [this.xScale, this.yScale].forEach((k) => {
            const raw = idealPx / k;
            const exp = Math.floor(Math.log10(raw));
            const base = raw / Math.pow(10, exp);
            let factor;
            if (base <= 1) factor = 1;
            else if (base <= 2) factor = 2;
            else if (base <= 5) factor = 5;
            else factor = 10;
            factorList.push(factor * Math.pow(10, exp));
          });
          return {x: factorList[0], y: factorList[1]};
        }

        drawGrid() {
          const ctx = this.ctx;
          const spacing = this.calcSpacing();
          const spacingPx = { x: spacing.x * this.xScale, y: spacing.y * this.yScale };
          const originX = this.W / 2 - this.offsetX * this.xScale;
          const originY = this.H / 2 + this.offsetY * this.yScale;

          ctx.font = '12px sans-serif';
          const fontSize = 12;
          const margin = 8; // 文字周囲の余裕
          ctx.textBaseline = 'top';

          // 縦グリッド線
          let firstX = originX % spacingPx.x;
          for (let x = firstX; x <= this.W; x += spacingPx.x) {
            const gridX = Math.round((x - originX) / this.xScale / spacing.x) * spacing.x;
            const idx = Math.round(gridX / spacing.x);

            ctx.beginPath();
            ctx.strokeStyle = (idx % 5 === 0) ? '#aaa' : '#ddd';
            ctx.lineWidth = (idx % 5 === 0) ? 2 : 1;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this.H);
            ctx.stroke();

            if (idx % 5 === 0 && Math.abs(gridX) > 1e-10) {
              ctx.fillStyle = '#000';
              const text = parseFloat(gridX.toFixed(6)).toString();
              const metrics = ctx.measureText(text);
              let tx = x + margin;
              let ty = originY + margin;

              // 文字が画面外に出ないように調整
              if (tx + metrics.width > this.W) tx = this.W - metrics.width - margin;
              if (tx < 0) tx = margin;
              if (ty + fontSize > this.H) ty = this.H - fontSize - margin;
              if (ty < 0) ty = margin;

              ctx.fillText(text, tx, ty);
            }
          }

          // 横グリッド線
          let firstY = originY % spacingPx.y;
          for (let y = firstY; y <= this.H; y += spacingPx.y) {
            const gridY = Math.round((originY - y) / this.yScale / spacing.y) * spacing.y;
            const idx = Math.round(gridY / spacing.y);

            ctx.beginPath();
            ctx.strokeStyle = (idx % 5 === 0) ? '#aaa' : '#ddd';
            ctx.lineWidth = (idx % 5 === 0) ? 2 : 1;
            ctx.moveTo(0, y);
            ctx.lineTo(this.W, y);
            ctx.stroke();

            if (idx % 5 === 0 && Math.abs(gridY) > 1e-10) {
              ctx.fillStyle = '#000';
              const text = parseFloat(gridY.toFixed(6)).toString();
              const metrics = ctx.measureText(text);
              let tx = originX + margin;
              let ty = y + margin;

              // 文字が画面外に出ないように調整
              if (tx + metrics.width > this.W) tx = this.W - metrics.width - margin;
              if (tx < 0) tx = margin;
              if (ty + fontSize > this.H) ty = this.H - fontSize - margin;
              if (ty < 0) ty = margin;

              ctx.fillText(text, tx, ty);
            }
          }

          // 0ラベル
          ctx.fillStyle = '#000';
          const originText = '0';
          const originMetrics = ctx.measureText(originText);
          let ox = originX + margin;
          let oy = originY + margin;

          if (ox + originMetrics.width > this.W) ox = this.W - originMetrics.width - margin;
          if (ox < 0) ox = margin;
          if (oy + fontSize > this.H) oy = this.H - fontSize - margin;
          if (oy < 0) oy = margin;
          let oPosX = -this.offsetX * this.xScale + this.W / 2;
          let oPosY = -this.offsetY * this.yScale + this.H / 2;
          if((0 < oPosX && oPosX < this.W) || (0 < oPosY && oPosY < this.H)) {
            ctx.fillText(originText, ox, oy);
          }

          // 軸線は変更せず
          ctx.beginPath();
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 2;
          ctx.moveTo(0, originY);
          ctx.lineTo(this.W, originY);
          
          ctx.stroke();

          ctx.beginPath();
          ctx.moveTo(originX, 0);
          ctx.lineTo(originX, this.H);
          ctx.stroke();
        }






  
        

        //----------------
        // グラフ描画
        //----------------
        renderGraph(graph) {
          
          let { f, a, b, span, color, isParametric } = graph;
          if(this.mode == "dynamic" && !isParametric) {
            let k = this.calcRange();
            a = k.a;
            b = k.b;
          }
          
          const rangeX = this.rangeX;
          const rangeY = this.rangeY;
          const ctx = this.ctx;
          const spacing = this.calcSpacing();
          const spacingPx = spacing * this.scale;
          const originX = this.W / 2 + this.offsetX;
          const originY = this.H / 2 + this.offsetY;
          const oriX = this.offsetX;
          const oriY = this.offsetY;
          const points = [];
          
          

          //グラフの点を取得(普通のx,y座標)
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

          let minX, maxX, minY, maxY;
          minX = Math.min(...xs);
          maxX = Math.max(...xs);
          minY = Math.min(...ys);
          maxY = Math.max(...ys);

          //1pxを何単位にするか決定する。(scaleとoffset決定)
          if(this.mode == "static"){
            

            if (this.autoScale) {
              minX = Math.min(...xs);
              maxX = Math.max(...xs);
              minY = Math.min(...ys);
              maxY = Math.max(...ys);

              this.xScale = (this.W - 10) / ((maxX - minX) || 1);
              this.yScale = (this.H - 10) / ((maxY - minY) || 1);

              minX -= 5 / this.xScale;
              maxX += 5 / this.xScale;
              minY -= 5 / this.yScale;
              maxY += 5 / this.yScale;

              this.offsetX = (minX + maxX) / 2;
              this.offsetY = (minY + maxY) / 2;
            } else {
              minX = Math.min(rangeX[0], rangeX[1]);
              maxX = Math.max(rangeX[0], rangeX[1]);
              minY = Math.min(rangeY[0], rangeY[1]);
              maxY = Math.max(rangeY[0], rangeY[1]);

              
              this.xScale = this.W / (maxX - minX);
              this.yScale = this.H / (maxY - minY);

              this.offsetX = (rangeX[0] + rangeX[1]) / 2;
              this.offsetY = (rangeY[0] + rangeY[1]) / 2;
            }
          }
          
          
          ctx.beginPath();
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;

          for (let i = 0; i < points.length; i++) {
            const px = this.W / 2 + (points[i].x - this.offsetX) * this.xScale;
            const py = this.H / 2 - (points[i].y - this.offsetY) * this.yScale;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }

          ctx.stroke();

          

          return {
            isParametric,
            minX,
            maxX,
            minY,
            maxY,
            graph,
          };
        }

        

        //----------------
        // テキスト描画
        //----------------
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

        

        

        // ===== Wheel操作 =====
        onWheel(e) {
          e.preventDefault();

          // ホイールによるズーム
          const zoom = e.deltaY > 0 ? 0.9 : 1.1;
          const mx = e.clientX;
          const my = e.clientY;

          const worldBeforeX = (mx - this.W / 2) / this.xScale + this.offsetX;
          const worldBeforeY = this.offsetY - (my - this.H / 2) / this.yScale;

          this.xScale *= zoom;
          this.yScale *= zoom;

          this.offsetX = worldBeforeX - (mx - this.W / 2) / this.xScale;
          this.offsetY = worldBeforeY + (my - this.H / 2) / this.yScale;

          this.xScale = Math.min(Math.max(this.xScale, this.MIN_SCALE), this.MAX_SCALE);
          this.yScale = Math.min(Math.max(this.yScale, this.MIN_SCALE), this.MAX_SCALE);

          this.renderAll();
        }

        // ===== Wheelによるドラッグ =====
        onMouseDown(e) {
          this.isDragging = true;
          this.lastPanPos = { x: e.clientX, y: e.clientY };
        }
        onMouseMove(e) {
          if (this.isDragging) {
            this.offsetX -= (e.clientX - this.lastPanPos.x) / this.xScale;
            this.offsetY += (e.clientY - this.lastPanPos.y) / this.yScale;
            this.lastPanPos = { x: e.clientX, y: e.clientY };
            this.renderAll();
          }
        }
        onMouseUp(e) {
          this.isDragging = false;
        }

        // ===== タッチ操作 =====
        onTouchStart(e) {
          if (e.touches.length === 1) {
            this.lastPanPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          } else if (e.touches.length === 2) {
            this.lastTouchDist = this.getDist(e.touches[0], e.touches[1]);
            this.lastTouchCenter = this.getCenter(e.touches[0], e.touches[1]);

            console.log(this.lastTouchDist)
            // 2本指の方向ベクトルで軸ロック
            if(this.lastTouchDist > 20) {
              const dx = e.touches[0].clientX - e.touches[1].clientX;
              const dy = e.touches[0].clientY - e.touches[1].clientY;
              this.lockAxis = null;
              
              if (Math.abs(dx) > Math.abs(dy) * 2) this.lockAxis = 'x';
              else if (Math.abs(dy) > Math.abs(dx) * 2) this.lockAxis = 'y';
              console.log(this.lockAxis)
            }
            
            // ピンチ開始時のワールド座標を保存
            this.pinchWorldBeforeX = (this.lastTouchCenter.x - this.W / 2) / this.xScale + this.offsetX;
            this.pinchWorldBeforeY = this.offsetY - (this.lastTouchCenter.y - this.H / 2) / this.yScale;
          }
        }

        onTouchMove(e) {
          e.preventDefault();

          if (e.touches.length === 2) {
            const newDist = this.getDist(e.touches[0], e.touches[1]);
            const newCenter = this.getCenter(e.touches[0], e.touches[1]);
            const zoom = newDist / this.lastTouchDist;

            

            // スケール更新
            if (this.lockAxis === 'x') this.xScale *= zoom;
            else if (this.lockAxis === 'y') this.yScale *= zoom;
            else {
              this.xScale *= zoom;
              this.yScale *= zoom;
            }

            // ピンチ開始時のワールド座標を基準に補正
            this.offsetX = this.pinchWorldBeforeX - (newCenter.x - this.W / 2) / this.xScale;
            this.offsetY = this.pinchWorldBeforeY + (newCenter.y - this.H / 2) / this.yScale;

            this.offsetX -= (newCenter.x - this.lastTouchCenter.x) / this.xScale;
            this.offsetY += (newCenter.y - this.lastTouchCenter.y) / this.yScale;

            // 制限
            this.xScale = Math.min(Math.max(this.xScale, this.MIN_SCALE), this.MAX_SCALE);
            this.yScale = Math.min(Math.max(this.yScale, this.MIN_SCALE), this.MAX_SCALE);

            this.lastTouchDist = newDist;
            this.lastTouchCenter = newCenter;

          } else if (e.touches.length === 1 && this.lastPanPos) {
            const dx = e.touches[0].clientX - this.lastPanPos.x;
            const dy = e.touches[0].clientY - this.lastPanPos.y;

            this.offsetX -= dx / this.xScale;
            this.offsetY += dy / this.yScale;

            this.lastPanPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          }

          this.renderAll();
        }

        onTouchEnd(e) {
          if (e.touches.length < 2) {
            this.lastTouchDist = null;
            this.lastTouchCenter = null;
            this.pinchWorldBeforeX = null;
            this.pinchWorldBeforeY = null;
            this.lockAxis = null;
          }
          if (e.touches.length === 0) {
            this.lastPanPos = null;
          }
        }
  
        




        //----------------
        // タッチ距離取得
        //----------------
        getDist(p1, p2) {
          return Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
        }

        //----------------
        // タッチ中心取得
        //----------------
        getCenter(p1, p2) {
          return {
            x: (p1.clientX + p2.clientX) / 2,
            y: (p1.clientY + p2.clientY) / 2
          };
        }
      };
