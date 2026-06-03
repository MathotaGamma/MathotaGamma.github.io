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
  
    // パス分解
    const paths = (href??location.pathname).split("/");
    paths.shift();
    let implicit = false;
    if (paths[paths.length-1] == "") {
      implicit = true;
      paths.pop();
    }
    
    const res = await getList(paths);
    
    breadcrumb.style.display = "inline-block";
    if (color.bg) breadcrumb.style.backgroundColor = color.bg;
    
    if (error != null) {
      const goTop = document.createElement("span");
      goTop.innerHTML = "TOP";
      goTop.style.color = color.able;
      goTop.addEventListener("click", () => {
        window.location.href = "/";
      });
      const errorSpan = document.createElement("span");
      errorSpan.innerHTML = error;
      errorSpan.style.marginLeft = "5px";
      errorSpan.style.fontSize = "12px";
      errorSpan.style.color = color.disable;
      breadcrumb.innerHTML = "";
      breadcrumb.appendChild(goTop.cloneNode(true));
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
        breadcrumb.appendChild(span.cloneNode(true));
      }
    }
    
    return true;
  }
  
  for (let breadcrumb of breadcrumbs) {
    await apply(breadcrumb);
  }
}

initBreadcrumb();
