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
