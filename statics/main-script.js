// nav class="breadcrumb"にパンくずリストを設定する。
/*
navの属性で色を指定できる。
data-bg-color: "背景色"
data-color-able: "リンクで飛べる階層の文字" (default: "#008")
data-color-disable: "リンクで飛べない階層の文字&エラー番号の色" (default: "black")
data-color-splitter: "「<」の色" (default: "black")

付属のstylesheetを読み込んだ場合、
class="breadcrumb default-bg"でクリーム色の背景色になる。
*/

async function getSitemap() {
  try {
    const res = await fetch('/statics/sitemap.json');
    
    if (!res.ok) throw new Error();
    return await res.json();
  } catch (e) {
    console.error(e);
    return null;
  }
}

async function initBreadcrumb(href=null) {
  const breadcrumbs = document.getElementsByClassName("breadcrumb");
  if (!breadcrumbs) return;
  
  let error = null;
  const errorList = {
    "#0": "不明なエラー",
    "#1": "sitemapが見つかりません。",
    "#2": "暗黙のPathであるが、_indexが空文字でない。",
    "#3": "暗黙のpathではなく、index.htmlではないファイルがエンドに来ている状態で、sitemap.jsonの記述がエンドの形状になっていない(valueがString型でない)。",
    "#4": ""
  }

  const sitemap = await getSitemap();
  if (!sitemap) error = "#1";
  
  const goTop = document.createElement("span");
  goTop.innerHTML = "TOP";
  
  function getList(paths) {
    try {
      const pathList = [];
      const nameList = [];
      const stateList = []; // この関数の最後以外では、エンドのパスでもtrueを入れる。
      let currentPath = "";
      let currentSitemap = sitemap;
  
      stateList.push(true);
      pathList.push("/"+currentSitemap._index);
      nameList.push(currentSitemap._name)
  
      let preIndex = currentSitemap._index;
      
      for(let ind = 0; ind < paths.length; ind++) {
        const path = paths[ind];
        if(!Object.keys(currentSitemap).includes(path)) {
          error = "#2";
          return;
        }
        currentSitemap = currentSitemap[path];
        currentPath += "/"+path;
        if (ind == paths.length-1) {
          if (implicit) {
            if (!Object.keys(currentSitemap).includes("_index") || currentSitemap._index === "") {
              stateList.push(true);
              pathList.push(currentPath+"/");
              if(Object.keys(currentSitemap).includes("_name")) nameList.push(currentSitemap._name);
              else nameList.push(currentSitemap);
            } else {
              error = "#3";
              return;
            }
          } else {
            if (path != preIndex) {
              if (typeof currentSitemap === "string") {
                stateList.push(true);
                pathList.push(currentPath);
                nameList.push(currentSitemap)
              } else {
                error = "#4";
                return;
              }
            }
          }
        } else {
          preIndex = currentSitemap._index;
          nameList.push(currentSitemap._name);
          if (currentSitemap._index == null) {
            pathList.push("null");
            stateList.push(false);
          } else {
            stateList.push(true);
            pathList.push(currentPath+"/"+currentSitemap._index);
          }
        }
      }
      stateList[stateList.length-1] = false;
      return {stateList, pathList, nameList}
    } catch(e) {
      console.log(e.message);
      error = "#0";
      return;
    }
  }
  
  async function apply(breadcrumb) {
    const color = {
      able: breadcrumb.dataset.colorAble ?? "#008",
      disable: breadcrumb.dataset.colorDisable ?? "black",
      splitter: breadcrumb.dataset.colorSplitter ?? "black",
      bg: breadcrumb.dataset.bgColor
    };
    
    breadcrumb.style.display = "inline-block";
    if (color.bg) breadcrumb.style.backgroundColor = color.bg;
    if (error != null) {
      breadcrumb.innerHTML = "";
      const clone = goTop.cloneNode(true);
      clone.style.color = color.able;
      const errorSpan = document.createElement("span");
      errorSpan.innerHTML = error;
      errorSpan.style.marginLeft = "5px";
      errorSpan.style.fontSize = "12px";
      errorSpan.style.color = color.disable;
      clone.addEventListener("click", () => {
        window.location.href = "/";
      });
      breadcrumb.appendChild(clone);
      breadcrumb.appendChild(errorSpan.cloneNode(true));
    } else {
      const {stateList, pathList, nameList} = res;
      const splitter = document.createElement("span");
      splitter.innerHTML = "<";
      splitter.style.color = color.splitter;
      for (let ind = 0; ind < stateList.length; ind++) {
        const span = document.createElement("span");
        span.innerHTML = nameList[ind];
        span.dataset.path = pathList[ind];
        span.style.color = color.disable;
        if (stateList[ind]) {
          span.style.color = color.able;
          span.addEventListener("click", (e) => {
            window.location.href = e.target.dataset.path;
          });
        }
      
        if (ind != 0) breadcrumb.appendChild(splitter.cloneNode(true));
        breadcrumb.appendChild(span);
      }
    }
    
    return true;
  }
  
  // パス分解
  const paths = (href??location.pathname).split("/");
  paths.shift();
  let implicit = false;
  if (paths[paths.length-1] == "") {
    implicit = true;
    paths.pop();
  }
      
  const res = await getList(paths);
  
  for (let breadcrumb of breadcrumbs) {
    await apply(breadcrumb);
  }
}
if (document.getElementById('breadcrumb')) alert('code: #1');
initBreadcrumb();



// フロートエリアを表示する。
// 使い方は下のコード参照してください。
/*
  ⚠️一方向しか動かせない(戻れない)場合、
  heightやwidthが内容物のサイズに合わせるよう設定されている可能性が高いです。
  px指定などを試してください。
*/
// 使い方例
// ⚠️float-left/right-barにはdata-height指定が必須です。また、float-◯-barの書く順序に注意！
/*
 - TOP(上側) (data-heightの指定は任意)
  <div class="float-top-area" data-height="200px">
    <div class="float-content">
      <p>ここがドラッグ移動可能なコンテンツエリアです。</p>
    </div>
    
    <div class="float-top-bar"></div>
  </div>

 - BOTTOM(下側) (data-heightの指定は任意)
  <div class="float-bottom-area" data-height="200px">
    <div class="float-bottom-bar"></div>
    
    <div class="float-content">
      <p>ここがドラッグ移動可能なコンテンツエリアです。</p>
    </div>
  </div>

 - LEFT(左側) (⚠️data-widthの指定が必須)
  <div class="float-left-area" data-width="200px">
    <div class="float-content">
      <p>ここがドラッグ移動可能なコンテンツエリアです。</p>
    </div>
    
    <div class="float-left-bar"></div>
  </div>

 - RIGHT(右側) (⚠️data-widthの指定が必須)
  <div class="float-right-area" data-width="200px">
    <div class="float-right-bar"></div>
    
    <div class="float-content">
      <p>ここがドラッグ移動可能なコンテンツエリアです。</p>
    </div>
  </div>
*/
// ダブルタップ判定用ヘルパー関数
const setupDoubleTap = (element, onDoubleTap) => {
  let lastTapTime = 0;
  // pointerupだと指を離した判定になるため、スマホではこちらが確実
  element.addEventListener('touchend', (e) => {
    const currentTime = new Date().getTime();
    const tapLength = currentTime - lastTapTime;
    if (tapLength < 300 && tapLength > 0) {
      onDoubleTap(e);
      // ブラウザ標準のダブルタップズーム等を防止
      if (e.cancelable) e.preventDefault();
    }
    lastTapTime = currentTime;
  });
};


// ==========================================
//  TOP 用
// ==========================================
document.querySelectorAll('.float-top-bar').forEach((bar) => {
  const areaClass = bar.className.match(/float-(top|bottom)-bar/)[0].replace('-bar', '-area');
  const area = bar.closest(`.${areaClass}`) || document.querySelector(`.${areaClass}`);
  if (!area) return;
  
  if ('height' in area.dataset)
    area.style.height = area.dataset.height;

  let isDragging = false;
  let offsetY = 0;
  let hasMoved = false;

  function getTop(clientY) {
    const pageY = clientY + window.pageYOffset;
    let newTopPage = pageY - offsetY;
    let newTop = newTopPage - window.pageYOffset;

    const rect = area.getBoundingClientRect();

    // 移動範囲制限
    // minTop: 完全にバーだけが一番上に引っかかる位置 ( - (領域の高さ - バーの高さ) )
    // maxTop: 展開して一番上にぴったりつく位置 ( 0px )
    const areaHeight = rect.bottom - rect.top;
    const minTop = -(areaHeight - bar.offsetHeight);
    const maxTop = 0;

    newTop = Math.max(minTop, Math.min(newTop, maxTop));

    return `${newTop}px`;
  }

  bar.addEventListener('pointerdown', (e) => {
    if (area.classList.contains('is-collapsed')) return;

    isDragging = true;
    hasMoved = false;
    bar.setPointerCapture(e.pointerId);

    const rect = area.getBoundingClientRect();
    const clientY = e.clientY;
    const pageY = clientY + window.pageYOffset;
    offsetY = pageY - (rect.top + window.pageYOffset);

    area.style.transition = 'none';
    area.style.top = getTop(e.clientY);
    area.style.bottom = 'auto';
  });

  bar.addEventListener('pointermove', (e) => {
    if (!isDragging) return;

    if (area.classList.contains('is-collapsed')) {
      stopDrag(e);
      return;
    }

    const clientY = e.clientY;
    if (!hasMoved && Math.abs(e.movementY) > 1) hasMoved = true;

    const newTop = getTop(clientY);
    area.style.top = newTop;
  });

  const stopDrag = (e) => {
    if (!isDragging) return;
    isDragging = false;
    area.style.transition = '';
    if (bar.hasPointerCapture(e.pointerId)) {
      bar.releasePointerCapture(e.pointerId);
    }
  };

  bar.addEventListener('pointerup', stopDrag);
  bar.addEventListener('pointercancel', stopDrag);

  const toggleCollapse = (e) => {
    if (hasMoved) return;

    area.classList.toggle('is-collapsed');

    const rect = area.getBoundingClientRect();
    const areaHeight = rect.bottom - rect.top;

    if (area.classList.contains('is-collapsed'))
      // 格納時: バーの30pxだけ残して上に引き上げる
      area.style.top = String(-(areaHeight - bar.offsetHeight)) + 'px';
    else
      // 展開時: 0px（トップ画面端ぴったり）
      area.style.top = '0px';
  };

  bar.addEventListener('dblclick', toggleCollapse);
  setupDoubleTap(bar, toggleCollapse);
});


// ==========================================
//  BOTTOM 用
// ==========================================
document.querySelectorAll('.float-bottom-bar').forEach((bar) => {
  const areaClass = bar.className.match(/float-(top|bottom)-bar/)[0].replace('-bar', '-area');
  const area = bar.closest(`.${areaClass}`) || document.querySelector(`.${areaClass}`);
  if (!area) return;
  
  if ('height' in area.dataset)
    area.style.height = area.dataset.height;
    

  let isDragging = false;
  let offsetY = 0; // 指とバーの相対距離
  let hasMoved = false;

  function getTop(clientY) {
    const pageY = clientY + window.pageYOffset;
    let newTopPage = pageY - offsetY;

    // viewport基準の座標に戻す
    let newTop = newTopPage - window.pageYOffset;

    const rect = area.getBoundingClientRect();

    // 移動範囲制限（0px 〜 画面最下端からバーの高さ分上まで）
    const maxTop = window.innerHeight - bar.offsetHeight;

    // areaの高さ分
    const minTop = window.innerHeight - (rect.bottom - rect.top);

    newTop = Math.max(0, minTop, Math.min(newTop, maxTop));

    return `${newTop}px`;
  }

  bar.addEventListener('pointerdown', (e) => {
    // 既に格納済みの場合はドラッグさせない
    if (area.classList.contains('is-collapsed')) return;

    isDragging = true;
    hasMoved = false;
    bar.setPointerCapture(e.pointerId);

    const rect = area.getBoundingClientRect();

    // 【バグ修正】
    // スマホのスクロール分(pageYOffset)を考慮した正確なオフセットを計算
    // これにより、タッチした瞬間に要素がジャンプするのを防ぎます
    const clientY = e.clientY;
    const pageY = clientY + window.pageYOffset;
    offsetY = pageY - (rect.top + window.pageYOffset);

    area.style.transition = 'none'; // ドラッグ中はアニメーションをオフ
    area.style.top = getTop(e.clientY);
    area.style.bottom = 'auto'; // bottom指定を解除しtop制御へ
  });

  bar.addEventListener('pointermove', (e) => {
    if (!isDragging) return;

    // 格納クラスが何らかの理由でついていたらドラッグ中止
    if (area.classList.contains('is-collapsed')) {
      stopDrag(e);
      return;
    }

    const clientY = e.clientY;
    // わずかな移動はドラッグとみなさない（タップ判定のため）
    if (!hasMoved && Math.abs(e.movementY) > 1) hasMoved = true;

    const newTop = getTop(clientY);
    area.style.top = newTop;
  });

  const stopDrag = (e) => {
    if (!isDragging) return;
    isDragging = false;
    area.style.transition = ''; // アニメーションを元に戻す
    if (bar.hasPointerCapture(e.pointerId)) {
      bar.releasePointerCapture(e.pointerId);
    }
  };

  bar.addEventListener('pointerup', stopDrag);
  bar.addEventListener('pointercancel', stopDrag);

  // 格納トグル関数
  const toggleCollapse = (e) => {
    // ドラッグ移動した場合はトグルしない
    if (hasMoved) return;

    area.classList.toggle('is-collapsed');

    const rect = area.getBoundingClientRect();
    if (area.classList.contains('is-collapsed'))
      area.style.top = String(window.innerHeight - bar.offsetHeight) + 'px';
    else
      area.style.top = String(Math.max(0, window.innerHeight - (rect.bottom - rect.top))) + 'px';
  };

  // PC用
  bar.addEventListener('dblclick', toggleCollapse);
  // スマホ用
  setupDoubleTap(bar, toggleCollapse);
});


// ==========================================
//  LEFT 用
// ==========================================
document.querySelectorAll('.float-left-bar').forEach((bar) => {
  const areaClass = bar.className.match(/float-(left|right)-bar/)[0].replace('-bar', '-area');
  const area = bar.closest(`.${areaClass}`) || document.querySelector(`.${areaClass}`);
  if (!area) return;
  
  if (!('width' in area.dataset)) {
    alert('float-left-areaにdata-widthを指定してください。例: <div class="float-left-area" data-width="200px">');
    return;
  }
  area.style.width = area.dataset.width;

  let isDragging = false;
  let offsetX = 0;
  let hasMoved = false;

  function getLeft(clientX) {
    const pageX = clientX + window.pageXOffset;
    let newLeftPage = pageX - offsetX;
    let newLeft = newLeftPage - window.pageXOffset;

    const rect = area.getBoundingClientRect();
    const areaWidth = rect.right - rect.left;

    // 移動範囲制限
    // minLeft: バーだけを残して左へ隠す位置 ( -(領域幅 - バー幅) )
    // maxLeft: 左端ぴったりに展開する位置 ( 0px )
    const minLeft = -(areaWidth - bar.offsetWidth);
    const maxLeft = 0;

    newLeft = Math.max(minLeft, Math.min(newLeft, maxLeft));

    return `${newLeft}px`;
  }

  bar.addEventListener('pointerdown', (e) => {
    if (area.classList.contains('is-collapsed')) return;

    isDragging = true;
    hasMoved = false;
    bar.setPointerCapture(e.pointerId);

    const rect = area.getBoundingClientRect();
    const clientX = e.clientX;
    const pageX = clientX + window.pageXOffset;
    offsetX = pageX - (rect.left + window.pageXOffset);

    area.style.transition = 'none';
    area.style.left = getLeft(e.clientX);
    area.style.right = 'auto';
  });

  bar.addEventListener('pointermove', (e) => {
    if (!isDragging) return;

    if (area.classList.contains('is-collapsed')) {
      stopDrag(e);
      return;
    }

    const clientX = e.clientX;
    if (!hasMoved && Math.abs(e.movementX) > 1) hasMoved = true;

    const newLeft = getLeft(clientX);
    area.style.left = newLeft;
  });

  const stopDrag = (e) => {
    if (!isDragging) return;
    isDragging = false;
    area.style.transition = '';
    if (bar.hasPointerCapture(e.pointerId)) {
      bar.releasePointerCapture(e.pointerId);
    }
  };

  bar.addEventListener('pointerup', stopDrag);
  bar.addEventListener('pointercancel', stopDrag);

  const toggleCollapse = (e) => {
    if (hasMoved) return;

    area.classList.toggle('is-collapsed');

    const rect = area.getBoundingClientRect();
    const areaWidth = rect.right - rect.left;

    if (area.classList.contains('is-collapsed'))
      // 格納時: バー幅だけ残して左側へ隠す
      area.style.left = String(-(areaWidth - bar.offsetWidth)) + 'px';
    else
      // 展開時: 左端ぴったり
      area.style.left = '0px';
  };

  bar.addEventListener('dblclick', toggleCollapse);
  setupDoubleTap(bar, toggleCollapse);
});


// ==========================================
//  RIGHT 用
// ==========================================
document.querySelectorAll('.float-right-bar').forEach((bar) => {
  const areaClass = bar.className.match(/float-(left|right)-bar/)[0].replace('-bar', '-area');
  const area = bar.closest(`.${areaClass}`) || document.querySelector(`.${areaClass}`);
  if (!area) return;
  
  if (!('width' in area.dataset)) {
    alert('float-right-areaにdata-widthを指定してください。例: <div class="float-right-area" data-width="200px">');
    return;
  }
  area.style.width = area.dataset.width;

  let isDragging = false;
  let offsetX = 0;
  let hasMoved = false;

  function getLeft(clientX) {
    const pageX = clientX + window.pageXOffset;
    let newLeftPage = pageX - offsetX;
    let newLeft = newLeftPage - window.pageXOffset;

    const rect = area.getBoundingClientRect();
    const areaWidth = rect.right - rect.left;

    // 移動範囲制限
    // maxLeft: バーだけが画面右端に見える位置 ( 画面幅 - バー幅 )
    // minLeft: 右端ぴったりに全開する位置 ( 画面幅 - 領域幅 )
    const maxLeft = window.innerWidth - bar.offsetWidth;
    const minLeft = window.innerWidth - areaWidth;

    newLeft = Math.max(0, minLeft, Math.min(newLeft, maxLeft));

    return `${newLeft}px`;
  }

  bar.addEventListener('pointerdown', (e) => {
    if (area.classList.contains('is-collapsed')) return;

    isDragging = true;
    hasMoved = false;
    bar.setPointerCapture(e.pointerId);

    const rect = area.getBoundingClientRect();
    const clientX = e.clientX;
    const pageX = clientX + window.pageXOffset;
    offsetX = pageX - (rect.left + window.pageXOffset);

    area.style.transition = 'none';
    area.style.left = getLeft(e.clientX);
    area.style.right = 'auto';
  });

  bar.addEventListener('pointermove', (e) => {
    if (!isDragging) return;

    if (area.classList.contains('is-collapsed')) {
      stopDrag(e);
      return;
    }

    const clientX = e.clientX;
    if (!hasMoved && Math.abs(e.movementX) > 1) hasMoved = true;

    const newLeft = getLeft(clientX);
    area.style.left = newLeft;
  });

  const stopDrag = (e) => {
    if (!isDragging) return;
    isDragging = false;
    area.style.transition = '';
    if (bar.hasPointerCapture(e.pointerId)) {
      bar.releasePointerCapture(e.pointerId);
    }
  };

  bar.addEventListener('pointerup', stopDrag);
  bar.addEventListener('pointercancel', stopDrag);

  const toggleCollapse = (e) => {
    if (hasMoved) return;

    area.classList.toggle('is-collapsed');

    const rect = area.getBoundingClientRect();
    const areaWidth = rect.right - rect.left;

    if (area.classList.contains('is-collapsed'))
      // 格納時: バーの幅だけ右端に残す
      area.style.left = String(window.innerWidth - bar.offsetWidth) + 'px';
    else
      // 展開時: 右端ぴったりに引き出す
      area.style.left = String(Math.max(0, window.innerWidth - areaWidth)) + 'px';
  };

  bar.addEventListener('dblclick', toggleCollapse);
  setupDoubleTap(bar, toggleCollapse);
});
