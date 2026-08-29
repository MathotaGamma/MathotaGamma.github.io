// ============================================================
// Sign In / Sign Out / 連携状態チェックの実行中に、
// 「進行中」「成功」「失敗」がひと目で分かるステータス表示を追加。
// 
// 使い方:
//   import { createHeader } from 'https://mathotagamma.github.io/ai-creator-battle/header-template-script.js';
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
  let statusHideTimeoutId = null;

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

  // ===== 進行状況表示用のステータス行 =====
  const statusP = document.createElement('p');
  statusP.classList.add('app-header-drive-status');
  statusP.style.display = 'none';
  dropdownContainer.appendChild(statusP);

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

  // ===== ステータス表示 =====
  // kind: 'progress' | 'success' | 'error'
  // progressは自動で消さない(次のsetStatusまたはhideStatusまで表示し続ける)。
  // success/errorは一定時間後に自動で消える。
  function setStatus(text, kind = 'info') {
    clearTimeout(statusHideTimeoutId);
    statusP.textContent = text;
    statusP.dataset.kind = kind;
    statusP.style.display = 'block';
    if (kind !== 'progress') {
      statusHideTimeoutId = setTimeout(() => {
        statusP.style.display = 'none';
      }, 3000);
    }
  }

  function hideStatus() {
    clearTimeout(statusHideTimeoutId);
    statusP.style.display = 'none';
  }

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
      setStatus('連携状態チェックの処理が設定されていません。', 'error');
      return null;
    }
    const status = await onCheck();
    await updateGoogleUI();
    return status;
  }

  // 全ボタンの有効/無効を一括制御(処理中は誤操作を防ぐため全て無効化)
  function setButtonsDisabled(bool) {
    driveCheckBtn.disabled = bool;
    signInBtn.disabled = bool;
    // signOutBtnは接続状態に応じて別途updateGoogleUI側でも制御されるため、
    // 処理中のみここでtrueにし、処理後はupdateGoogleUIの結果に委ねる。
    if (bool)
      signOutBtn.disabled = true;
  }

  driveCheckBtn.addEventListener('click', async () => {
    setStatus('連携状態を確認中...', 'progress');
    setButtonsDisabled(true);
    try {
      const stat = await driveCheck();
      setStatus(
        stat != null
          ? `確認完了: ${stat.ok ? 'OK' : 'NG'}(loggedIn: ${stat.loggedIn}, expired: ${stat.expired}）`
          : '確認できませんでした。',
        stat != null && stat.ok ? 'success' : 'error'
      );
    } catch (err) {
      console.error('driveCheck error:', err);
      setStatus('確認中にエラーが発生しました。', 'error');
    } finally {
      setButtonsDisabled(false);
      await updateGoogleUI();
    }
  });

  signInBtn.addEventListener('click', async () => {
    setStatus('サインイン処理中...', 'progress');
    setButtonsDisabled(true);
    try {
      if (typeof onSignIn === 'function')
        await onSignIn();
      await updateGoogleUI();
      setStatus('サインインしました。', 'success');
    } catch (err) {
      console.error('signIn error:', err);
      setStatus('サインインに失敗しました。', 'error');
    } finally {
      setButtonsDisabled(false);
      await updateGoogleUI();
    }
  });

  signOutBtn.addEventListener('click', async () => {
    if (signOutBtn.disabled)
      return;
    setStatus('サインアウト処理中...', 'progress');
    setButtonsDisabled(true);
    try {
      if (typeof onSignOut === 'function')
        await onSignOut();
      await updateGoogleUI();
      setStatus('サインアウトしました。', 'success');
    } catch (err) {
      console.error('signOut error:', err);
      setStatus('サインアウトに失敗しました。', 'error');
    } finally {
      setButtonsDisabled(false);
      await updateGoogleUI();
    }
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
    // ステータス表示(外部からも進行状況を出したい場合に使える)
    setStatus,
    hideStatus,
    // transitionボタン
    setTransitionDisabled,
    // 内部要素(細かい制御が必要な場合用)
    elements: {
      titleDiv,
      userNameDiv,
      userPhotoImg,
      dropdownContainer,
      statusP,
      driveCheckBtn,
      signInBtn,
      signOutBtn,
      transitionBtn
    }
  };
}
