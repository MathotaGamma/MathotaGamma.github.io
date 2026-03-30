async function getSitemap() {
  try {
    const response = await fetch('/statics/sitemap.json');
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
      currentSitemap = structuredClone(currentSitemap[pathList[ind]]);
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
      name = currentSitemap.index;
    } else {
      path += pathList[ind] + (endSlash ? "/" : "");
      name = currentSitemap.index;
      if (!name) name = currentSitemap;
    }

    if (!name) {
      breadcrumb.innerHTML = "";
      breadcrumb.appendChild(goTop);
      return;
    }
    span.innerHTML = name;
    span.dataset.path = path;
    if (ind != pathList.length - 1) {
      span.style.color = color;
      span.addEventListener("click", (e) => {
        window.location.href = e.target.dataset.path;
      });
    }
    breadcrumb.appendChild(span);
    if (ind != pathList.length - 1) breadcrumb.appendChild(splitter.cloneNode(true));
  }
}

// 実行（パンくずリスト）
initBreadcrumb();
