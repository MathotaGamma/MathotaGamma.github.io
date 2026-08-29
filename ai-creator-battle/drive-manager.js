// drive-manager.js
// Google Drive (AppData) との連携処理をまとめた共通モジュール。
// 各HTMLファイルはこれをimportして、認証・保存・取得の共通処理を使い回せる。
//
// 使用例:
//   import { DriveManager, updateDriveUserInfoUI, mergeMissingKeys } from './drive-manager.js';
//
//   const driveManager = new DriveManager({
//     clientId: '673216051028-hjomu6c8livrv4ga0c0f37o3i3qt0dso.apps.googleusercontent.com',
//     redirectUri: 'https://mathotagamma.github.io/statics/drive-api/oauth2callback',
//     appDataDirectory: '/application-data/xxx/',
//     onLog: (message, duration) => logger(message, duration),
//     onLoginWithAnotherEmail: (prevEmail, newEmail) => {
//       alert(`以前とは異なるアカウントでログインしました(前回:${prevEmail})。`);
//     },
//   });
//   await driveManager.init();

import DriveAPIManager from '/statics/drive-api/6-4/manager.js';

/**
 * Google Drive AppDataとの連携を管理するクラス。
 */
export class DriveManager {
  constructor({
    clientId,
    redirectUri,
    appDataDirectory = '/',
    space = 'appdata',
    onLog = () => {},
    onLoginWithAnotherEmail = () => {},
  } = {}) {
    this.clientId = clientId;
    this.redirectUri = redirectUri;
    this.appDataDirectory = appDataDirectory;
    this.space = space;
    this.onLog = onLog;
    this.onLoginWithAnotherEmail = onLoginWithAnotherEmail;

    this.drive = null;
    this.isGuest = true;
    this.hasDriveConnection = false;
    this.emailAddress = null;
  }

  // ===== 初期化 =====
  // 埋め込み(silent)ログインを試み、失敗したらpopupログインを試みる。
  // 戻り値: 連携に成功したかどうか(boolean)
  async init() {
    this.onLog('Google Driveに接続中', 1000);
    try {
      this.drive = new DriveAPIManager({
        clientId: this.clientId,
        redirectUri: this.redirectUri,
        space: this.space,
      });

      /*
      let res = await this.drive.auth(true);
      if (!res.ok)
        res = await this.drive.auth(false);
      */
      res = await this.drive.auth(false);

      if (res.ok) {
        await this._syncEmailAddress();
        this.isGuest = false;
        this.hasDriveConnection = true;
        return true;
      } else if (res.error === 'popup_blocked') {
        alert('popupがブロックされました。');
      }
    } catch (err) {
      this.onLog(`Drive連携の初期化に失敗しました: ${err.message}`, 2500);
    }

    this.onLog(
      this.isGuest
        ? 'Googleアカウントと連携できませんでした。ゲストでプレイします。'
        : 'Googleアカウントと連携できませんでした。再度試してください。'
    );
    await this._resetToGuest();
    return false;
  }

  // emailAddressを取得し、以前と異なるアカウントであればコールバックを呼ぶ
  async _syncEmailAddress() {
    const previousEmail = this.emailAddress;
    const res = await this.drive.getAbout('user(emailAddress)');
    this.emailAddress = res?.user?.emailAddress ?? null;

    if (this.emailAddress === null)
      throw new Error('E-mailを取得できませんでした');

    if (previousEmail != null && previousEmail !== this.emailAddress)
      this.onLoginWithAnotherEmail(previousEmail, this.emailAddress);
  }

  async _resetToGuest() {
    this.isGuest = true;
    this.hasDriveConnection = false;
    if (this.drive != null)
      await this.drive.signOut();
    this.drive = null;
  }

  // ===== 連携状態チェック =====
  // 引数にfalseを渡すと、Googleへの再ログインを試みず
  // hasDriveConnectionのみ更新する。
  // 戻り値: hasDriveConnection(boolean)
  async driveCheck(tryLogIn = true) {
    if (this.drive == null) {
      if (tryLogIn)
        await this.init();
      else {
        this.hasDriveConnection = false;
        return false;
      }
    }

    if (this.drive != null) {
      const checkerRes = this.checker();
      if (checkerRes.ok) {
        this.hasDriveConnection = true;
      } else if (!this.isGuest) {
        if (tryLogIn)
          alert('Googleアカウントとの連携が途切れた もしくはアクセストークンが期限切れである可能性があります。再度ログインを試行します。');
        this.hasDriveConnection = false;
      }
    }

    if (tryLogIn && !this.isGuest && !this.hasDriveConnection)
      await this.init();

    return this.hasDriveConnection;
  }

  // checkerRes.ok, checkerRes.loggedIn, checkerRes.expired を返す
  checker() {
    if (this.drive == null)
      return { ok: false, loggedIn: false, expired: true };
    return this.drive.checker();
  }

  async signOut() {
    if (!this.hasDriveConnection || this.drive == null)
      return false;
    await this.drive.signOut();
    return true;
  }

  // ===== ユーザー情報取得 =====
  async getAbout(fields) {
    if (this.drive == null)
      return null;
    return await this.drive.getAbout(fields);
  }

  // ===== AppDataへの保存・取得 =====
  // pathはappDataDirectoryからの相対パス(例: 'entirely-layers-info.json')
  async saveFile({ path, data }) {
    if (this.isGuest || !this.hasDriveConnection || this.drive == null)
      return null;
    const fullPath = this.appDataDirectory + path;
    return await this.drive.saveFile({ path: fullPath, data });
  }

  async getFile({ path, type = 'json' }) {
    if (this.isGuest || !this.hasDriveConnection || this.drive == null)
      return null;
    const fullPath = this.appDataDirectory + path;
    return await this.drive.getFile({ path: fullPath, type });
  }
}

// ===== 汎用UI更新ヘルパー(任意) =====
// userNameElem, userPhotoElem, signOutBtn等の要素を渡すと表示を更新する。
// 要素構成が異なる場合は呼び出し側で個別に実装してもよい。
export async function updateDriveUserInfoUI(driveManager, { userNameElem, userPhotoElem, signOutBtn } = {}) {
  if (!driveManager.hasDriveConnection || driveManager.drive == null) {
    if (userNameElem) userNameElem.innerHTML = '---';
    if (userPhotoElem) userPhotoElem.removeAttribute('src');
    if (signOutBtn) signOutBtn.disabled = true;
    return;
  }
  const res = await driveManager.getAbout('user(displayName, photoLink)');
  if (userNameElem) userNameElem.innerHTML = res.user.displayName;
  if (userPhotoElem) userPhotoElem.src = res.user.photoLink;
  if (signOutBtn) signOutBtn.disabled = false;
}

// ===== targetに存在しないkeyをsourceから埋める =====
// 最上層配列はダメ。辞書型の入れ子のみ対応。
// Driveから取得したデータとデフォルト値のマージによく使う。
export function mergeMissingKeys(target, source) {
  if (
    !target || typeof target !== 'object' || Array.isArray(target) ||
    !source || typeof source !== 'object' || Array.isArray(source)
  ) {
    return target;
  }

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (!(key in target)) {
      target[key] = typeof structuredClone === 'function'
        ? structuredClone(sourceVal)
        : JSON.parse(JSON.stringify(sourceVal));
    } else if (
      targetVal && typeof targetVal === 'object' && !Array.isArray(targetVal) &&
      sourceVal && typeof sourceVal === 'object' && !Array.isArray(sourceVal)
    ) {
      mergeMissingKeys(targetVal, sourceVal);
    }
  }

  return target;
}
