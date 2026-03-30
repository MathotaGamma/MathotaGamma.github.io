async function getSitemap() {
  try {
    const response = await fetch('/sitemap.json');
    if (!response.ok) throw new Error("Network response was not ok");
    const sitemap = await response.json();
    return sitemap;
  } catch (error) {
    console.error('Sitemap fetch error:', error);
    return null;
  }
}

// パンくずリストを初期化する関数
async function initBreadcrumb() {
  const color = "#008";
  const breadcrumb = document.getElementById("breadcrumb");
  if (!breadcrumb) return; // 要素がない場合の安全策

  const goTop = document.createElement("span");
  goTop.innerHTML = "TOP";
  goTop.style.color = color;
  goTop.addEventListener("click", () => {
    window.location.href = "/";
  });

  const sitemap = await getSitemap();
  if (!sitemap) {
    breadcrumb.innerHTML = "";
    breadcrumb.appendChild(goTop);
    return;
  }

  let endSlash = false;
  let pathList = window.location.pathname.split("/");
  if (pathList[pathList.length - 1] === "") {
    endSlash = true;
    pathList.pop();
  }

  let currentSitemap = structuredClone(sitemap);
  let path = "";

  const splitter = document.createElement("span");
  splitter.innerHTML = ">";

  for (let ind = 0; ind < pathList.length; ind++) {
    if (ind !== 0) {
      if (currentSitemap._index == pathList[ind]) {
        break;
      } else {
        currentSitemap = structuredClone(currentSitemap[pathList[ind]]);
      }
    }
    if (!currentSitemap) {
      breadcrumb.innerHTML = "";
      breadcrumb.appendChild(goTop);
      return;
    }
    const span = document.createElement("span");
    let name = "";

    if (ind != pathList.length - 1) {
      path += pathList[ind] + "/";
      name = currentSitemap._name;
    } else {
      path += pathList[ind] + (endSlash ? "/" : "");
      name = currentSitemap._name; // jsonに続きがある場合
      if (!name) name = currentSitemap; // 末端だった場合
    }

    if (!name) {
      breadcrumb.innerHTML = "";
      breadcrumb.appendChild(goTop);
      return;
    }
    
    span.innerHTML = name;
    span.dataset.path = path+currentSitemap._index; // そのディレクトリのhomeに飛ばす
    
    if (ind != pathList.length - 1 && currentSitemap._index != null) {
      span.style.color = color;
      span.addEventListener("click", (e) => {
        window.location.href = e.target.dataset.path;
      });
    }
    if (ind != 0) breadcrumb.appendChild(splitter.cloneNode(true));
    breadcrumb.appendChild(span);
  }
}

// 実行（パンくずリスト）
initBreadcrumb();
