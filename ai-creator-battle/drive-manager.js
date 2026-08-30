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
//
// 更新:
//   - getFileInfo(path, fields)を追加(ファイルのメタ情報を取得できるように)
//   - getAbout / existCheck / getFileInfo / saveFile / getFile にエラーハンドリングを追加。
//     Drive API呼び出しが例外を投げた場合、呼び出し元まで例外を伝播させず、
//     onLogでエラー内容を通知した上でnullを返すようにした。

import DriveAPIManager from '/statics/drive-api/6-5/manager.js';

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
      let res = await this.drive.auth(false);

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

  // Drive API呼び出しを共通のエラーハンドリングで包むヘルパー。
  // 失敗時はonLogで通知した上でnullを返し、呼び出し元に例外を伝播させない。
  async _safeCall(label, fn) {
    try {
      return await fn();
    } catch (err) {
      this.onLog(`${label}に失敗しました: ${err.message}`, 2500);
      return null;
    }
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
    return await this._safeCall('ユーザー情報の取得', () => this.drive.getAbout(fields));
  }

  async existCheck(path) {
    if (this.isGuest || !this.hasDriveConnection || this.drive == null)
      return null;
    const fullPath = this.appDataDirectory + path;
    return await this._safeCall('存在確認', () => this.drive.existCheck({ path: fullPath }));
  }

  // ファイルのメタ情報を取得する(id, name, mimeType等)。
  // fields省略時はDriveAPIManager側の既定値('id, name, mimeType')が使われる。
  async getFileInfo({ path, fields } = {}) {
    if (this.isGuest || !this.hasDriveConnection || this.drive == null)
      return null;
    const fullPath = this.appDataDirectory + path;
    return await this._safeCall('ファイル情報の取得', () =>
      this.drive.getFileInfo({ path: fullPath, ...(fields ? { fields } : {}) })
    );
  }

  // ===== AppDataへの保存・取得 =====
  // pathはappDataDirectoryからの相対パス(例: 'entirely-layers-info.json')
  // mimeTypeの種類
  /*
    TXT: 'text/plain;charset=utf-8'
    JSON: 'application/json'
    未定義: 'application/octet-stream'
  */
  async saveFile({ path, data, mimeType="application/json" }) {
    if (this.isGuest || !this.hasDriveConnection || this.drive == null)
      return null;
    const fullPath = this.appDataDirectory + path;
    return await this._safeCall('ファイルの保存', () =>
      this.drive.saveFile({ path: fullPath, data, mimeType })
    );
  }

  async getFile({ path }) {
    if (this.isGuest || !this.hasDriveConnection || this.drive == null)
      return null;
    const fullPath = this.appDataDirectory + path;
    return await this._safeCall('ファイルの取得', () =>
      this.drive.getFile({ path: fullPath })
    );
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
