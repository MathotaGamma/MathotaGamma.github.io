window.onload = () => {
  async function getSitemap() {
    try {
      const response = await fetch('./sitemap.json');
      if (!response.ok) throw new Error("Network response was not ok");
      const sitemap = await response.json();
      return sitemap;
    } catch (error) {
      console.error('Sitemap fetch error:', error);
      return null;
    }
  }
  
  async function initBreadcrumb() {
    const sitemap = await getSitemap();
    if (!sitemap) return;
    const breadcrumb = document.getElementById("breadcrumb");

    let endSlash = false;

    let pathList = window.location.pathname.split("/");
    if(pathList[pathList.length-1] === "") {
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
      if(!currentSitemap) {
        breadcrumb.innerHTML = "---";
        return;
      }
      const span = document.createElement("span");
      let name = "";

      if (ind != pathList.length-1) {
        path += pathList[ind]+"/";
        name = currentSitemap.index;
      } else {
        path += pathList[ind]+(endSlash?"/":"");
        name = currentSitemap.index;
        if(!name) name = currentSitemap;
      }
      console.log(name)
      if (!name) {
        console.log("a")
        breadcrumb.innerHTML = "---";
        return;
      }
      span.innerHTML = name;
      span.dataset.path = path;
      if(ind != pathList.length-1) {
        span.style.color = "#008"
        span.addEventListener("click", (e) => {
          window.location.href = e.target.dataset.path;
        });
      }
      breadcrumb.appendChild(span);
      if (ind != pathList.length-1) breadcrumb.appendChild(splitter.cloneNode(true));
    }
  }
  
  initBreadcrumb();

  // スムーズスクロール（目次）
  document.querySelectorAll('.anchor').forEach(anchor => {
    anchor.addEventListener('click', e => {
      e.preventDefault();
      const target = document.getElementById(anchor.getAttribute('href').slice(1));
      const container = document.querySelector('article.article');
      if (target && container) {
        container.scrollTo({ top: target.offsetTop, behavior: 'smooth' });
      }
    });
  });

  // モバイル用目次トグル
  document.querySelector('.toc-toggle').addEventListener('click', () => {
    document.querySelector('.toc-wrapper').classList.toggle('active');
  });

  // ドロップダウン展開処理
  document.querySelectorAll('.dropdown-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const content = btn.nextElementSibling;
      if (content && content.classList.contains('dropdown-content')) {
        content.style.display = (content.style.display === 'block') ? 'none' : 'block';
      }
    });
  });
}
