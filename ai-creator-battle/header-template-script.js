// ============================================================
// 
// 使い方:
//   import { createHeader } from './header_template_script.js';
//
//   const header = createHeader({
//     title: 'AI Creator Battle',
//     transition: {
//       label: 'このモデルで試す',
//       disabled: true,
//       onClick: () => { ... }
//     },
//     drive: {
//       // Google連携状態をチェックする処理(呼び出し元で実装)。
//       // { ok, loggedIn, expired } 相当の情報を返す想定。
//       onCheck: async () => { ... },
//       // Sign Inボタンが押された時の処理
//       onSignIn: async () => { ... },
//       // Sign Outボタンが押された時の処理
//       onSignOut: async () => { ... },
//       // ユーザー情報(displayName, photoLink)を取得する処理
//       getUserInfo: async () => { ... }
//     }
//   });
//
//   document.querySelector('.some-container').appendChild(header.element);
//   header.updateGoogleUI(); // 初期表示の更新
// ============================================================

export function createHeader({
  title = '',
  transition = null,
  drive = {}
} = {}) {
  const {
    onCheck = null,
    onSignIn = null,
    onSignOut = null,
    getUserInfo = null
  } = drive;

  let isDropdownOpen = false;

  // ===== DOM構築 =====
  const headerElem = document.createElement('header');
  headerElem.classList.add('app-header');

  const leftContainer = document.createElement('div');
  leftContainer.classList.add('app-header-left-container');

  const breadcrumbNav = document.createElement('nav');
  breadcrumbNav.classList.add('breadcrumb');
  leftContainer.appendChild(breadcrumbNav);

  const leftMiniContainer = document.createElement('div');
  leftMiniContainer.classList.add('app-header-left-mini-container');

  const titleDiv = document.createElement('div');
  titleDiv.classList.add('app-header-title');
  titleDiv.innerHTML = title;
  leftMiniContainer.appendChild(titleDiv);

  let transitionBtn = null;
  if (transition) {
    transitionBtn = document.createElement('button');
    transitionBtn.innerHTML = transition.label ?? '';
    transitionBtn.disabled = !!transition.disabled;
    if (typeof transition.onClick === 'function')
      transitionBtn.addEventListener('click', transition.onClick);
    leftMiniContainer.appendChild(transitionBtn);
  }

  leftContainer.appendChild(leftMiniContainer);
  headerElem.appendChild(leftContainer);

  const userInfoContainer = document.createElement('div');
  userInfoContainer.classList.add('app-header-user-info-container');

  const userNameDiv = document.createElement('div');
  userNameDiv.classList.add('app-header-user-name-div');
  userNameDiv.innerHTML = '未ログイン';
  userInfoContainer.appendChild(userNameDiv);

  const userPhotoImg = document.createElement('img');
  userPhotoImg.classList.add('app-header-user-photo-img');
  userInfoContainer.appendChild(userPhotoImg);

  const dropdownContainer = document.createElement('div');
  dropdownContainer.classList.add('app-header-user-info-dropdown-container');

  const driveCheckBtn = document.createElement('button');
  driveCheckBtn.innerHTML = '連携状態チェック';
  dropdownContainer.appendChild(driveCheckBtn);

  const signInBtn = document.createElement('button');
  signInBtn.innerHTML = 'Sign In';
  dropdownContainer.appendChild(signInBtn);

  const signOutBtn = document.createElement('button');
  signOutBtn.classList.add('app-header-sign-out-btn');
  signOutBtn.innerHTML = 'Sign Out';
  signOutBtn.disabled = true;
  dropdownContainer.appendChild(signOutBtn);

  userInfoContainer.appendChild(dropdownContainer);
  headerElem.appendChild(userInfoContainer);

  // ===== ドロップダウン開閉 =====
  function toggleDropdown() {
    isDropdownOpen = !isDropdownOpen;
    dropdownContainer.classList.toggle('show', isDropdownOpen);
  }

  function closeDropdown() {
    isDropdownOpen = false;
    dropdownContainer.classList.remove('show');
  }

  userPhotoImg.addEventListener('click', toggleDropdown);
  userNameDiv.addEventListener('click', toggleDropdown);

  // ===== Google連携まわりの関数(呼び出し元のロジックをつなぐ) =====

  // 現在の連携状態に合わせてUI(ユーザー名、写真、Sign Outボタン)を更新する。
  async function updateGoogleUI() {
    if (typeof getUserInfo !== 'function') {
      userNameDiv.innerHTML = '---';
      userPhotoImg.removeAttribute('src');
      signOutBtn.disabled = true;
      return;
    }
    try {
      const info = await getUserInfo();
      if (info == null) {
        userNameDiv.innerHTML = '---';
        userPhotoImg.removeAttribute('src');
        signOutBtn.disabled = true;
        return;
      }
      userNameDiv.innerHTML = info.displayName ?? '---';
      if (info.photoLink)
        userPhotoImg.src = info.photoLink;
      else
        userPhotoImg.removeAttribute('src');
      signOutBtn.disabled = false;
    } catch (err) {
      console.error('updateGoogleUI error:', err);
      userNameDiv.innerHTML = '---';
      userPhotoImg.removeAttribute('src');
      signOutBtn.disabled = true;
    }
  }

  // 連携状態チェック(ボタン押下時、および外部からも呼べる)
  async function driveCheck() {
    if (typeof onCheck !== 'function') {
      alert('連携状態チェックの処理が設定されていません。');
      return null;
    }
    const status = await onCheck();
    await updateGoogleUI();
    return status;
  }

  driveCheckBtn.addEventListener('click', async () => {
    const status = await driveCheck();
    if (status)
      alert(`Google連携状態...${status.ok ? 'OK' : 'No'}
loggedIn...${status.loggedIn}
expired...${status.expired}`);
  });

  signInBtn.addEventListener('click', async () => {
    if (typeof onSignIn === 'function')
      await onSignIn();
    await updateGoogleUI();
    closeDropdown();
  });

  signOutBtn.addEventListener('click', async () => {
    if (signOutBtn.disabled)
      return;
    if (typeof onSignOut === 'function')
      await onSignOut();
    await updateGoogleUI();
    closeDropdown();
  });

  // ===== Title設定用関数 =====
  function setTitle(newTitle) {
    titleDiv.innerHTML = newTitle;
  }

  // ===== transitionボタン制御用関数 =====
  function setTransitionDisabled(bool) {
    if (transitionBtn)
      transitionBtn.disabled = bool;
  }

  return {
    element: headerElem,
    // Title
    setTitle,
    // Googleアカウント関連
    updateGoogleUI,
    driveCheck,
    closeDropdown,
    // transitionボタン
    setTransitionDisabled,
    // 内部要素(細かい制御が必要な場合用)
    elements: {
      titleDiv,
      userNameDiv,
      userPhotoImg,
      dropdownContainer,
      driveCheckBtn,
      signInBtn,
      signOutBtn,
      transitionBtn
    }
  };
}
