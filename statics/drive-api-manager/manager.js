/**
 * DriveAPIManager v4 (Fully Loaded)
 *
 * ● 認証方式: OAuth2 Authorization Code Flow with PKCE + client_secret
 * ● 保存管理: accessToken はメモリ内(#)保持。refreshToken は暗号化(AES-GCM)して localStorage に保存。
 * ● 暗号化鍵: ログインユーザーの固有 ID (sub) と現在の origin から PBKDF2 (200,000回) で動的導出。
 * ● レスポンス: 全てのパブリックメソッドは `{ ok: true, ... }` または `{ ok: false, error, place }` を返却。
 * ● 進捗通知: コンストラクタで指定された `progress(phase, detail)` コールバックにより進捗をリアルタイム通知。
 */
class DriveAPIManager {
  // ─── プライベートフィールド（メモリ内保持・外部から不可視） ───────────────────
  #clientId     = null;
  #clientSecret = null;
  #redirectUri  = null;
  #progress     = null;

  #accessToken  = null;
  #expiresAt    = 0;
  #sub          = null;
  #cryptoKey    = null;

  // ─── 定数定義 ──────────────────────────────────────────────────────────────
  static #LS_KEY   = 'drive_enc_rt';
  static #AUTH_EP  = 'https://accounts.google.com/o/oauth2/v2/auth';
  static #TOKEN_EP = 'https://oauth2.googleapis.com/token';
  static #DRIVE_EP = 'https://www.googleapis.com/drive/v3/files';
  static #UPLOAD_EP= 'https://www.googleapis.com/upload/drive/v3/files';
  static #USER_EP  = 'https://www.googleapis.com/oauth2/v3/userinfo';

  // ─── キャッシュ用マップ ────────────────────────────────────────────────────
  _idCache    = new Map(); // path -> fileId
  _pathCache  = new Map(); // fileId -> path

  /**
   * コンストラクタ
   * @param {Object} config
   * @param {string} config.clientId - Google Cloud Console の クライアントID
   * @param {string} [config.clientSecret] - クライアントシークレット（ウェブアプリタイプで必要）
   * @param {string} config.redirectUri - 承認済みのリダイレクトURI
   * @param {Function} [config.progress] - 進捗通知用コールバック (phase, detail) => void
   */
  constructor({ clientId, clientSecret = null, redirectUri, progress = null }) {
    if (!clientId || !redirectUri) {
      throw new Error('DriveAPIManager: clientId と redirectUri は必須パラメータです。');
    }
    this.#clientId     = clientId;
    this.#clientSecret = clientSecret;
    this.#redirectUri  = redirectUri;
    this.#progress     = progress;
  }

  get CLIENT_ID() { return this.#clientId; }
  get REDIRECT_URI() { return this.#redirectUri; }

  /** 内部進捗を通知するトリガー関数 */
  #notify(phase, detail = '') {
    if (typeof this.#progress === 'function') {
      try { this.#progress(phase, detail); } catch (e) { console.error('Progress callback error:', e); }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. 認証・認可関連メソッド (AUTH)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 認証の実行、または既存セッションの復元を行う
   * @param {boolean} silent - true の場合は保存されたリフレッシュトークンからの復元のみを試みる。
   * @returns {Promise<Object>} { ok: true, type: 'memory'|'refresh'|'flow_started' } 
   */
  async auth(silent = false) {
    this.#notify('auth:start');

    // 1. メモリ内に有効なアクセストークンがある場合
    if (this.#accessToken && Date.now() < this.#expiresAt) {
      this.#notify('auth:memory_hit');
      return { ok: true, type: 'memory' };
    }

    // 2. localStorage からリフレッシュトークンを復元して更新を試みる
    const hasSavedToken = !!localStorage.getItem(DriveAPIManager.#LS_KEY);
    if (hasSavedToken) {
      this.#notify('auth:refreshing');
      const refreshRet = await this.#refreshAccessToken();
      if (refreshRet.ok) {
        this.#notify('auth:done', 'restored');
        return { ok: true, type: 'refresh' };
      }
    }

    // サイレントモード指定、またはトークン不足でサイレント失敗時
    if (silent) {
      this.#notify('auth:fail', 'silent_mode_active');
      return { ok: false, error: 'silent_auth_failed', place: 'auth' };
    }

    // 3. 新規に OAuth2 ポップアップフローを開始
    try {
      this.#notify('auth:popup_open');
      const authCode = await this.#openAuthPopup();
      
      this.#notify('auth:exchanging');
      const exchangeRet = await this.#exchangeCodeForTokens(authCode);
      if (!exchangeRet.ok) return exchangeRet;

      this.#notify('auth:done', 'new_login');
      return { ok: true, type: 'flow_started' };
    } catch (err) {
      this.#notify('auth:fail', err.message);
      return this.#fail(err, 'auth');
    }
  }

  /** 現在の内部認証状態のスナップショットを同期的に取得する */
  checker() {
    const hasRt = !!localStorage.getItem(DriveAPIManager.#LS_KEY);
    const hasAt = !!this.#accessToken;
    const isExpired = Date.now() >= this.#expiresAt;

    return {
      initialized: true,
      hasRefreshTokenInStorage: hasRt,
      hasAccessTokenInMemory: hasAt,
      accessTokenExpired: hasAt ? isExpired : null,
      expiresInAt: hasAt ? Math.max(0, this.#expiresAt - Date.now()) : 0,
      cacheSize: { id: this._idCache.size, path: this._pathCache.size }
    };
  }

  /** サインアウト処理（メモリの消去および localStorage 内のリフレッシュトークンの削除） */
  async signOut() {
    this.#notify('signOut:start');
    this.#accessToken = null;
    this.#expiresAt = 0;
    this.#sub = null;
    this.#cryptoKey = null;
    this._idCache.clear();
    this._pathCache.clear();
    localStorage.removeItem(DriveAPIManager.#LS_KEY);
    this.#notify('signOut:done');
    return { ok: true };
  }

  /** ログイン中のユーザーのメールアドレスを取得する */
  async getEmail() {
    this.#notify('getEmail:start');
    const tokenRet = await this.#ensureValidToken();
    if (!tokenRet.ok) return tokenRet;

    try {
      const res = await fetch(DriveAPIManager.#USER_EP, {
        headers: { 'Authorization': `Bearer ${this.#accessToken}` }
      });
      if (!res.ok) throw new Error(`UserInfo HTTP ${res.status}`);
      const data = await res.json();
      this.#notify('getEmail:done', data.email);
      return { ok: true, email: data.email };
    } catch (e) {
      return this.#fail(e, 'getEmail');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. パス・フォルダ操作関連メソッド (PATH & FOLDER)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 与えられたフルパスに対応する Google Drive の File ID を解決する
   * @param {string} path - 例: "/saves/slot1.json"
   * @returns {Promise<Object>} { ok: true, fileId: string }
   */
  async getFileId(path) {
    const normPath = this.#normalizePath(path);
    if (normPath === '' || normPath === '/') return { ok: true, fileId: 'appDataFolder' };
    if (this._idCache.has(normPath)) return { ok: true, fileId: this._idCache.get(normPath) };

    const tokenRet = await this.#ensureValidToken();
    if (!tokenRet.ok) return tokenRet;

    try {
      const parts = normPath.split('/').filter(Boolean);
      let currentParentId = 'appDataFolder';

      for (const part of parts) {
        const q = `name = '${part.replace(/'/g, "\\'")}' and '${currentParentId}' in parents and trashed = false`;
        const url = `${DriveAPIManager.#DRIVE_EP}?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=files(id,mimeType)`;
        
        const res = await fetch(url, {
          headers: { 'Authorization': `Bearer ${this.#accessToken}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} on resolving part "${part}"`);
        const data = await res.json();

        if (!data.files || data.files.length === 0) {
          return { ok: false, error: 'not_found', path: normPath, missingPart: part, place: 'getFileId' };
        }
        currentParentId = data.files[0].id;
      }

      this._idCache.set(normPath, currentParentId);
      this._pathCache.set(currentParentId, normPath);
      return { ok: true, fileId: currentParentId };
    } catch (e) {
      return this.#fail(e, 'getFileId');
    }
  }

  /**
   * 与えられた Google Drive の File ID から、ルートからのフルパスを復元する
   * @param {string} fileId - 解決対象の Drive ID
   * @returns {Promise<Object>} { ok: true, path: string }
   */
  async getPath(fileId) {
    if (fileId === 'appDataFolder') return { ok: true, path: '/' };
    if (this._pathCache.has(fileId)) return { ok: true, path: this._pathCache.get(fileId) };

    const tokenRet = await this.#ensureValidToken();
    if (!tokenRet.ok) return tokenRet;

    try {
      let currentId = fileId;
      let pathParts = [];

      while (currentId && currentId !== 'appDataFolder') {
        const url = `${DriveAPIManager.#DRIVE_EP}/${currentId}?fields=id,name,parents`;
        const res = await fetch(url, {
          headers: { 'Authorization': `Bearer ${this.#accessToken}` }
        });
        if (!res.ok) {
          if (res.status === 404) return { ok: false, error: 'not_found', fileId: currentId, place: 'getPath' };
          throw new Error(`HTTP ${res.status} on file ${currentId}`);
        }
        const meta = await res.json();
        pathParts.unshift(meta.name);

        if (meta.parents && meta.parents.length > 0) {
          currentId = meta.parents[0];
        } else {
          // 親階層が取れず、appDataFolder にも到達していない場合は孤立ファイル
          break;
        }
      }

      const fullPath = '/' + pathParts.join('/');
      this._idCache.set(fullPath, fileId);
      this._pathCache.set(fileId, fullPath);
      return { ok: true, path: fullPath };
    } catch (e) {
      return this.#fail(e, 'getPath');
    }
  }

  /**
   * 階層的なフォルダパスを中間フォルダも含めて再帰的に作成する
   * @param {string} path - 作成したいフォルダのフルパス (例: "/saves/nested/folder")
   * @returns {Promise<Object>} { ok: true, folderId: string }
   */
  async createFolder(path) {
    this.#notify('createFolder:start', path);
    const normPath = this.#normalizePath(path);
    if (normPath === '' || normPath === '/') return { ok: true, folderId: 'appDataFolder' };

    const checkExist = await this.getFileId(normPath);
    if (checkExist.ok) {
      this.#notify('createFolder:done', 'already_exists');
      return { ok: true, folderId: checkExist.fileId };
    }

    const tokenRet = await this.#ensureValidToken();
    if (!tokenRet.ok) return tokenRet;

    try {
      const parts = normPath.split('/').filter(Boolean);
      let currentParentId = 'appDataFolder';
      let currentAccumulatedPath = '';

      for (const part of parts) {
        currentAccumulatedPath += '/' + part;
        const cachedId = this._idCache.get(currentAccumulatedPath);

        if (cachedId) {
          currentParentId = cachedId;
        } else {
          // 存在確認
          const q = `name = '${part.replace(/'/g, "\\'")}' and '${currentParentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
          const queryUrl = `${DriveAPIManager.#DRIVE_EP}?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=files(id)`;
          const queryRes = await fetch(queryUrl, {
            headers: { 'Authorization': `Bearer ${this.#accessToken}` }
          });
          const queryData = await queryRes.json();

          if (queryData.files && queryData.files.length > 0) {
            currentParentId = queryData.files[0].id;
          } else {
            // 新規作成
            const createRes = await fetch(DriveAPIManager.#DRIVE_EP, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${this.#accessToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                name: part,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [currentParentId]
              })
            });
            if (!createRes.ok) throw new Error(`Failed to create directory "${part}". HTTP ${createRes.status}`);
            const createdFolder = await createRes.json();
            currentParentId = createdFolder.id;
          }
          this._idCache.set(currentAccumulatedPath, currentParentId);
          this._pathCache.set(currentParentId, currentAccumulatedPath);
        }
      }

      this.#notify('createFolder:done', currentParentId);
      return { ok: true, folderId: currentParentId };
    } catch (e) {
      return this.#fail(e, 'createFolder');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. ファイルの単体読み書き・操作関連メソッド (FILE CRUD)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ファイルの内容を取得（ダウンロード）する
   * @param {string} pathOrId - フルパス、または Google Drive の File ID
   * @returns {Promise<Object>} { ok: true, file: Blob }
   */
  async getFile(pathOrId) {
    this.#notify('getFile:start', pathOrId);
    const resolveRet = await this.#resolveId(pathOrId);
    if (!resolveRet.ok) return resolveRet;

    const tokenRet = await this.#ensureValidToken();
    if (!tokenRet.ok) return tokenRet;

    try {
      const url = `${DriveAPIManager.#DRIVE_EP}/${resolveRet.fileId}?alt=media`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.#accessToken}` }
      });
      if (!res.ok) {
        if (res.status === 404) return { ok: false, error: 'not_found', target: pathOrId, place: 'getFile' };
        throw new Error(`HTTP Error ${res.status}`);
      }

      const blob = await res.blob();
      this.#notify('getFile:done', pathOrId);
      return { ok: true, file: blob };
    } catch (e) {
      return this.#fail(e, 'getFile');
    }
  }

  /**
   * ファイルを新規作成または上書き保存する（マルチパートアップロード方式）
   * @param {string} path - 保存先フルパス (例: "/gamedata/slot1.json")
   * @param {string|Blob|ArrayBuffer|Object} data - ファイルデータ本体（オブジェクトの場合は自動的にJSON文字列化）
   * @param {Object} [extraMetadata] - 追加のメタデータ (appPropertiesなど、任意)
   * @returns {Promise<Object>} { ok: true, fileId: string }
   */
  async saveFile(path, data, extraMetadata = {}) {
    this.#notify('saveFile:start', path);
    const normPath = this.#normalizePath(path);
    
    // 親ディレクトリパスの自動導出と作成
    const lastSlashIdx = normPath.lastIndexOf('/');
    if (lastSlashIdx > 0) {
      const parentPath = normPath.substring(0, lastSlashIdx);
      const folderRet = await this.createFolder(parentPath);
      if (!folderRet.ok) return folderRet;
    }

    const tokenRet = await this.#ensureValidToken();
    if (!tokenRet.ok) return tokenRet;

    try {
      // 既存ファイルの有無をチェック
      const existCheck = await this.getFileId(normPath);
      const isUpdate = existCheck.ok;
      const fileId = isUpdate ? existCheck.fileId : null;

      // データの正規化
      let bodyBlob;
      let detectedMime = 'application/octet-stream';

      if (data instanceof Blob) {
        bodyBlob = data;
        if (data.type) detectedMime = data.type;
      } else if (data instanceof ArrayBuffer) {
        bodyBlob = new Blob([data]);
      } else if (typeof data === 'object') {
        bodyBlob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        detectedMime = 'application/json';
      } else {
        bodyBlob = new Blob([String(data)], { type: 'text/plain' });
        detectedMime = 'text/plain';
      }

      // メタデータの構築
      const filename = normPath.split('/').pop();
      const metadata = {
        name: filename,
        ...extraMetadata
      };

      if (!isUpdate) {
        // 新規作成時のみ親を指定
        const parentPath = normPath.substring(0, lastSlashIdx) || '/';
        const parentIdRet = await this.getFileId(parentPath);
        if (!parentIdRet.ok) return parentIdRet;
        metadata.parents = [parentIdRet.fileId];
      }
      if (!metadata.mimeType) metadata.mimeType = detectedMime;

      // マルチパートの境界線の生成
      const boundary = '-------DriveAPIManagerMultipartBoundary';
      const delimiter = `\n--${boundary}\n`;
      const closeDelimiter = `\n--${boundary}--`;

      const reader = new FileReader();
      const base64DataPromise = new Promise((resolve) => {
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(bodyBlob);
      });
      const base64Data = await base64DataPromise;

      const multipartRequestBody =
        delimiter +
        'Content-Type: application/json; charset=UTF-8\n\n' +
        JSON.stringify(metadata) +
        delimiter +
        `Content-Type: ${metadata.mimeType}\n` +
        'Content-Transfer-Encoding: base64\n\n' +
        base64Data +
        closeDelimiter;

      const url = isUpdate 
        ? `${DriveAPIManager.#UPLOAD_EP}/${fileId}?uploadType=multipart`
        : `${DriveAPIManager.#UPLOAD_EP}?uploadType=multipart`;

      const res = await fetch(url, {
        method: isUpdate ? 'PATCH' : 'POST',
        headers: {
          'Authorization': `Bearer ${this.#accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartRequestBody
      });

      if (!res.ok) throw new Error(`Upload HTTP ${res.status}`);
      const resData = await res.json();

      this._idCache.set(normPath, resData.id);
      this._pathCache.set(resData.id, normPath);

      this.#notify('saveFile:done', normPath);
      return { ok: true, fileId: resData.id };
    } catch (e) {
      return this.#fail(e, 'saveFile');
    }
  }

  /**
   * ファイルを別のパスへコピーする
   * @param {string} srcPathOrId - コピー元ファイルのフルパス、または File ID
   * @param {string} destFullPath - コピー先として作成するファイルの完全なフルパス
   * @returns {Promise<Object>} { ok: true, fileId: string } 新しく作成されたファイルのID
   */
  async copyFile(srcPathOrId, destFullPath) {
    this.#notify('copyFile:start', { from: srcPathOrId, to: destFullPath });
    const srcIdRet = await this.#resolveId(srcPathOrId);
    if (!srcIdRet.ok) return srcIdRet;

    const normDest = this.#normalizePath(destFullPath);
    const lastSlashIdx = normDest.lastIndexOf('/');
    const destParentPath = normDest.substring(0, lastSlashIdx) || '/';
    const destFilename = normDest.split('/').pop();

    // コピー先親フォルダの解決・生成
    const parentFolderRet = await this.createFolder(destParentPath);
    if (!parentFolderRet.ok) return parentFolderRet;

    const tokenRet = await this.#ensureValidToken();
    if (!tokenRet.ok) return tokenRet;

    try {
      const url = `${DriveAPIManager.#DRIVE_EP}/${srcIdRet.fileId}/copy`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.#accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: destFilename,
          parents: [parentFolderRet.folderId]
        })
      });

      if (!res.ok) throw new Error(`Copy HTTP ${res.status}`);
      const data = await res.json();

      this._idCache.set(normDest, data.id);
      this._pathCache.set(data.id, normDest);

      this.#notify('copyFile:done', normDest);
      return { ok: true, fileId: data.id };
    } catch (e) {
      return this.#fail(e, 'copyFile');
    }
  }

  /**
   * ファイルまたはフォルダの格納先を移動（リネーム含む）する
   * @param {string} srcPathOrId - 移動元のフルパス、または File ID
   * @param {string} destFullPath - 移動先の完全なフルパス
   * @returns {Promise<Object>} { ok: true }
   */
  async moveFile(srcPathOrId, destFullPath) {
    this.#notify('moveFile:start', { from: srcPathOrId, to: destFullPath });
    
    // 移動元データの特定
    const srcIdRet = await this.#resolveId(srcPathOrId);
    if (!srcIdRet.ok) return srcIdRet;

    // 移動元の親およびメタデータ取得
    const metaRet = await this.getMeta(srcIdRet.fileId, 'parents,name');
    if (!metaRet.ok) return metaRet;
    const oldParents = metaRet.meta.parents ? metaRet.meta.parents.join(',') : 'appDataFolder';

    // 移動先のパス解析
    const normDest = this.#normalizePath(destFullPath);
    const lastSlashIdx = normDest.lastIndexOf('/');
    const destParentPath = normDest.substring(0, lastSlashIdx) || '/';
    const destFilename = normDest.split('/').pop();

    // 移動先の親フォルダID取得
    const parentFolderRet = await this.createFolder(destParentPath);
    if (!parentFolderRet.ok) return parentFolderRet;

    const tokenRet = await this.#ensureValidToken();
    if (!tokenRet.ok) return tokenRet;

    try {
      // 親の差し替え (addParents / removeParents) および名前変更 (name)
      const url = `${DriveAPIManager.#DRIVE_EP}/${srcIdRet.fileId}?addParents=${parentFolderRet.folderId}&removeParents=${oldParents}`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${this.#accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: destFilename
        })
      });

      if (!res.ok) throw new Error(`Move HTTP ${res.status}`);
      
      // 移動前後の古いキャッシュをクリーンアップして再登録
      if (typeof srcPathOrId === 'string' && srcPathOrId.startsWith('/')) {
        this.#evictCacheByPath(srcPathOrId);
      }
      this.#evictCacheById(srcIdRet.fileId);

      this._idCache.set(normDest, srcIdRet.fileId);
      this._pathCache.set(srcIdRet.fileId, normDest);

      this.#notify('moveFile:done', normDest);
      return { ok: true };
    } catch (e) {
      return this.#fail(e, 'moveFile');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. 一覧・メタデータ・検索・削除関連メソッド (LIST, SEARCH & DELETE)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 指定したフォルダ直下にあるファイル・子フォルダの一覧を取得する
   * @param {string} [pathOrId] - ターゲットフォルダのフルパスまたは ID (空欄時は appDataFolder 直下)
   * @returns {Promise<Object>} { ok: true, files: Array }
   */
  async listFiles(pathOrId = '') {
    this.#notify('listFiles:start', pathOrId);
    let folderId = 'appDataFolder';

    if (pathOrId) {
      const resolveRet = await this.#resolveId(pathOrId);
      if (!resolveRet.ok) return resolveRet;
      folderId = resolveRet.fileId;
    }

    const tokenRet = await this.#ensureValidToken();
    if (!tokenRet.ok) return tokenRet;

    try {
      const q = `'${folderId}' in parents and trashed = false`;
      const fields = 'files(id,name,mimeType,size,modifiedTime,appProperties)';
      const url = `${DriveAPIManager.#DRIVE_EP}?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}`;

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.#accessToken}` }
      });
      if (!res.ok) throw new Error(`List Files HTTP ${res.status}`);
      const data = await res.json();

      this.#notify('listFiles:done', `${data.files?.length || 0} items`);
      return { ok: true, files: data.files || [] };
    } catch (e) {
      return this.#fail(e, 'listFiles');
    }
  }

  /**
   * 任意のクエリ文やMIMEタイプを指定して appDataFolder 内のファイルをフラットに検索する
   * @param {string} textQuery - ファイル名等に対する部分一致検索テキスト
   * @param {Object} [options]
   * @param {string} [options.mimeType] - MIMEタイプを制限する場合に指定
   * @returns {Promise<Object>} { ok: true, files: Array }
   */
  async search(textQuery, options = {}) {
    this.#notify('search:start', textQuery);
    const tokenRet = await this.#ensureValidToken();
    if (!tokenRet.ok) return tokenRet;

    try {
      let qParts = ['trashed = false'];
      if (textQuery) {
        qParts.push(`name contains '${textQuery.replace(/'/g, "\\'")}'`);
      }
      if (options.mimeType) {
        qParts.push(`mimeType = '${options.mimeType}'`);
      }

      const q = qParts.join(' and ');
      const fields = 'files(id,name,mimeType,size,modifiedTime,parents)';
      const url = `${DriveAPIManager.#DRIVE_EP}?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}`;

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.#accessToken}` }
      });
      if (!res.ok) throw new Error(`Search HTTP ${res.status}`);
      const data = await res.json();

      this.#notify('search:done', `${data.files?.length || 0} results`);
      return { ok: true, files: data.files || [] };
    } catch (e) {
      return this.#fail(e, 'search');
    }
  }

  /**
   * 対象オブジェクトの詳細なメタデータを取得する
   * @param {string} pathOrId - 対象のフルパスまたは File ID
   * @param {string} [fields] - 取得したいフィールド群 (デフォルトは主要情報一式)
   * @returns {Promise<Object>} { ok: true, meta: Object }
   */
  async getMeta(pathOrId, fields = 'id,name,mimeType,size,createdTime,modifiedTime,parents,appProperties') {
    const resolveRet = await this.#resolveId(pathOrId);
    if (!resolveRet.ok) return resolveRet;

    const tokenRet = await this.#ensureValidToken();
    if (!tokenRet.ok) return tokenRet;

    try {
      const url = `${DriveAPIManager.#DRIVE_EP}/${resolveRet.fileId}?fields=${encodeURIComponent(fields)}`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.#accessToken}` }
      });
      if (!res.ok) {
        if (res.status === 404) return { ok: false, error: 'not_found', target: pathOrId, place: 'getMeta' };
        throw new Error(`HTTP ${res.status}`);
      }
      const meta = await res.json();
      return { ok: true, meta };
    } catch (e) {
      return this.#fail(e, 'getMeta');
    }
  }

  /**
   * 指定したファイルまたはフォルダ（配下含む）を完全に削除する
   * @param {string} pathOrId - 削除したいフルパス、または File ID
   * @returns {Promise<Object>} { ok: true }
   */
  async remove(pathOrId) {
    this.#notify('remove:start', pathOrId);
    const resolveRet = await this.#resolveId(pathOrId);
    if (!resolveRet.ok) return resolveRet;

    const tokenRet = await this.#ensureValidToken();
    if (!tokenRet.ok) return tokenRet;

    try {
      const url = `${DriveAPIManager.#DRIVE_EP}/${resolveRet.fileId}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.#accessToken}` }
      });

      if (!res.ok) {
        if (res.status === 404) return { ok: false, error: 'not_found', target: pathOrId, place: 'remove' };
        throw new Error(`Delete HTTP ${res.status}`);
      }

      // キャッシュのパージ
      if (typeof pathOrId === 'string' && pathOrId.startsWith('/')) {
        this.#evictCacheByPath(pathOrId);
      }
      this.#evictCacheById(resolveRet.fileId);

      this.#notify('remove:done', pathOrId);
      return { ok: true };
    } catch (e) {
      return this.#fail(e, 'remove');
    }
  }

  /** appDataFolder 内のすべてのファイル・フォルダを完全に抹消する（危険） */
  async removeAll() {
    this.#notify('removeAll:start');
    const tokenRet = await this.#ensureValidToken();
    if (!tokenRet.ok) return tokenRet;

    try {
      // ルート(appDataFolder直下)のファイル群を取得
      const rootItems = await this.listFiles('');
      if (!rootItems.ok) return rootItems;

      const tasks = rootItems.files.map(item => {
        return async () => {
          const url = `${DriveAPIManager.#DRIVE_EP}/${item.id}`;
          const res = await fetch(url, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${this.#accessToken}` }
          });
          if (!res.ok && res.status !== 404) {
            throw new Error(`Failed to delete ${item.name} (${item.id})`);
          }
        };
      });

      // 最大5並列で一括削除実行
      await this.#batch(tasks, 5);

      this._idCache.clear();
      this._pathCache.clear();

      this.#notify('removeAll:done', 'All appData entries evicted');
      return { ok: true };
    } catch (e) {
      return this.#fail(e, 'removeAll');
    }
  }

  /**
   * appDataFolder 内の全ファイル・全フォルダ構造を再帰的にスキャンしてツリーを再構築する
   * @returns {Promise<Object>} { ok: true, tree: Object, flat: Array }
   */
  async getStructure() {
    this.#notify('getStructure:start');
    const tokenRet = await this.#ensureValidToken();
    if (!tokenRet.ok) return tokenRet;

    try {
      // スケールを考慮し、全件を一度にフラットに引き出す
      let allFiles = [];
      let pageToken = null;
      
      do {
        const fields = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)';
        let url = `${DriveAPIManager.#DRIVE_EP}?spaces=appDataFolder&q=${encodeURIComponent('trashed = false')}&fields=${encodeURIComponent(fields)}&pageSize=100`;
        if (pageToken) url += `&pageToken=${pageToken}`;

        const res = await fetch(url, {
          headers: { 'Authorization': `Bearer ${this.#accessToken}` }
        });
        if (!res.ok) throw new Error(`Fetch structure list HTTP ${res.status}`);
        const data = await res.json();
        
        if (data.files) allFiles = allFiles.concat(data.files);
        pageToken = data.nextPageToken;
      } while (pageToken);

      // キャッシュのリフレッシュ、およびツリーの組み換え
      this._idCache.clear();
      this._pathCache.clear();

      const itemMap = new Map();
      allFiles.forEach(f => {
        itemMap.set(f.id, { ...f, children: [] });
      });

      const rootNodes = [];

      itemMap.forEach(node => {
        const parentId = node.parents ? node.parents[0] : null;
        if (!parentId || parentId === 'appDataFolder') {
          rootNodes.push(node);
        } else {
          const parentNode = itemMap.get(parentId);
          if (parentNode) {
            parentNode.children.push(node);
          } else {
            // 親がリスト漏れしている場合は便宜上ルートへ
            rootNodes.push(node);
          }
        }
      });

      // 各アイテムの仮想絶対フルパスをディープ確定、同時にキャッシュへ再注入
      const finalizePaths = (nodes, currentParentPath) => {
        nodes.forEach(node => {
          const resolvedPath = currentParentPath + '/' + node.name;
          this._idCache.set(resolvedPath, node.id);
          this._pathCache.set(node.id, resolvedPath);
          if (node.children && node.children.length > 0) {
            finalizePaths(node.children, resolvedPath);
          }
        });
      };
      finalizePaths(rootNodes, '');

      const treeStructure = {
        name: 'Root (appDataFolder)',
        id: 'appDataFolder',
        mimeType: 'application/vnd.google-apps.folder',
        children: rootNodes
      };

      this.#notify('getStructure:done', `${allFiles.length} nodes structured`);
      return { ok: true, tree: treeStructure, flat: allFiles };
    } catch (e) {
      return this.#fail(e, 'getStructure');
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // 5. 内部用プライベート補助メソッド (PRIVATE UTILS)
  // ═══════════════════════════════════════════════════════════════════════════

  /** クエリ共通処理: 文字列パス、または File ID のいずれかを受け取って ID を解決 */
  async #resolveId(pathOrId) {
    if (!pathOrId || pathOrId === '/') return { ok: true, fileId: 'appDataFolder' };
    // Google Drive の固有ID形式（スラッシュなしの英数字+記号の組み合わせ）か判定
    if (/^[A-Za-z0-9_-]{20,}$/.test(pathOrId) && !pathOrId.includes('/')) {
      return { ok: true, fileId: pathOrId };
    }
    return this.getFileId(pathOrId);
  }

  /** パスの表記揺れを整形、先頭と末尾のスラッシュを処理 */
  #normalizePath(path) {
    if (typeof path !== 'string') return '';
    let p = path.trim().replace(/\/+/g, '/'); // 連続するスラッシュを1つに
    if (!p.startsWith('/')) p = '/' + p;
    if (p.endsWith('/') && p.length > 1) p = p.substring(0, p.length - 1);
    return p === '/' ? '' : p;
  }

  /** キャッシュの個別削除 */
  #evictCacheByPath(path) {
    const p = this.#normalizePath(path);
    if (this._idCache.has(p)) {
      const id = this._idCache.get(p);
      this._idCache.delete(p);
      this._pathCache.delete(id);
    }
  }
  #evictCacheById(id) {
    if (this._pathCache.has(id)) {
      const p = this._pathCache.get(id);
      this._pathCache.delete(id);
      this._idCache.delete(p);
    }
  }

  /** 非同期処理の最大同時実行数を制御するセマフォ実装 */
  async #batch(thunks, concurrency = 5) {
    let i = 0;
    const worker = async () => {
      while (i < thunks.length) {
        const currentIdx = i++;
        await thunks[currentIdx]();
      }
    };
    const workers = Array.from({ length: Math.min(concurrency, thunks.length) }, worker);
    await Promise.all(workers);
  }

  /** エラー構造を一律 `{ ok: false, error, place }` に揃えるラッパー */
  #fail(e, place = '') {
    const error = e instanceof Error ? e.message : (typeof e === 'string' ? e : JSON.stringify(e));
    console.error(`[DriveAPIManager Exception at #${place}]`, e);
    return { ok: false, error, place };
  }

  /** 必要に応じてアクセストークンの鮮度を担保するバリデーター */
  async #ensureValidToken() {
    if (this.#accessToken && Date.now() < this.#expiresAt) {
      return { ok: true };
    }
    this.#notify('auth:refreshing');
    return this.#refreshAccessToken();
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // 6. 暗号化および低レイヤOAuth2通信ロジック
  // ═══════════════════════════════════════════════════════════════════════════

  /** PKCE用のランダム文字列（Verifier）生成 */
  #genVerifier() {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')
      .replace(/[=+ \n\r]/g, '');
  }

  /** Verifier から SHA-256 チャレンジを生成 */
  async #genChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** PBKDF2による決定論的な AES-GCM 鍵の暗号化キーを導出 */
  async #deriveCryptoKey() {
    if (this.#cryptoKey) return this.#cryptoKey;
    if (!this.#sub) {
      // サブIDがなければまず取得を試みる
      const res = await fetch(DriveAPIManager.#USER_EP, {
        headers: { 'Authorization': `Bearer ${this.#accessToken}` }
      });
      const data = await res.json();
      this.#sub = data.sub;
    }

    const encoder = new TextEncoder();
    const baseMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(this.#clientId), 'PBKDF2', false, ['deriveKey']
    );

    // sub と現在の origin をソルトにして安全性を確保
    const salt = encoder.encode(this.#sub + location.origin);

    this.#cryptoKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
      baseMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return this.#cryptoKey;
  }

  /** リフレッシュトークンを AES-GCM で暗号化して保存 */
  async #saveEncryptedRefreshToken(rt) {
    const key = await this.#deriveCryptoKey();
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(rt)
    );

    const payload = {
      iv: btoa(String.fromCharCode(...iv)),
      data: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
      sub: this.#sub
    };
    localStorage.setItem(DriveAPIManager.#LS_KEY, JSON.stringify(payload));
  }

  /** 保存されている暗号化リフレッシュトークンを復号化 */
  async #loadDecryptedRefreshToken() {
    const rawLs = localStorage.getItem(DriveAPIManager.#LS_KEY);
    if (!rawLs) return null;

    try {
      const payload = JSON.parse(rawLs);
      this.#sub = payload.sub;

      const key = await this.#deriveCryptoKey();
      const iv = new Uint8Array(atob(payload.iv).split('').map(c => c.charCodeAt(0)));
      const encryptedData = new Uint8Array(atob(payload.data).split('').map(c => c.charCodeAt(0)));

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        encryptedData
      );
      return new TextDecoder().decode(decrypted);
    } catch (e) {
      console.error('RefreshToken decryption failure. Clearing corrupted storage.', e);
      localStorage.removeItem(DriveAPIManager.#LS_KEY);
      return null;
    }
  }

  /** Google 認可エンドポイントを別ウィンドウ(ポップアップ)で開いて認可コードを待機 */
  async #openAuthPopup() {
    const verifier = this.#genVerifier();
    sessionStorage.setItem('dapi_p_verifier', verifier);

    const challenge = await this.#genChallenge(verifier);
    const state = crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
    sessionStorage.setItem('dapi_p_state', state);

    const params = new URLSearchParams({
      client_id: this.#clientId,
      redirect_uri: this.#redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/drive.appdata openid email',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: state,
      prompt: 'select_account'
    });

    const url = `${DriveAPIManager.#AUTH_EP}?${params.toString()}`;
    const targetName = 'oauth2_popup_window';
    const popup = window.open(url, targetName, 'width=550,height=650,left=150,top=100,status=no,menubar=no');
    
    if (!popup) {
      throw new Error('ポップアップブロックが有効です。許可した上でもう一度お試しください。');
    }

    return new Promise((resolve, reject) => {
      const listener = async (e) => {
        if (e.origin !== new URL(this.#redirectUri).origin) return;
        if (e.data && e.data.type === 'oauth_callback') {
          window.removeEventListener('message', listener);
          
          if (e.data.error) {
            reject(new Error(`Google OAuth Error: ${e.data.error}`));
            return;
          }
          if (e.data.state !== sessionStorage.getItem('dapi_p_state')) {
            reject(new Error('OAuth State Mismatch (セキュリティ警告)'));
            return;
          }
          resolve(e.data.code);
        }
      };
      window.addEventListener('message', listener);
    });
  }

  /** 認可コードから実際のトークンセットへ交換 */
  async #exchangeCodeForTokens(code) {
    const verifier = sessionStorage.getItem('dapi_p_verifier');
    const params = {
      client_id: this.#clientId,
      redirect_uri: this.#redirectUri,
      grant_type: 'authorization_code',
      code: code,
      code_verifier: verifier
    };
    if (this.#clientSecret) params.client_secret = this.#clientSecret;

    try {
      const res = await fetch(DriveAPIManager.#TOKEN_EP, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params)
      });
      if (!res.ok) throw new Error(`Token exchange HTTP ${res.status}`);
      const data = await res.json();

      this.#accessToken = data.access_token;
      this.#expiresAt   = Date.now() + (data.expires_in * 1000) - 60000; // 1分前安全圏

      if (data.refresh_token) {
        await this.#saveEncryptedRefreshToken(data.refresh_token);
      }
      
      sessionStorage.removeItem('dapi_p_verifier');
      sessionStorage.removeItem('dapi_p_state');
      return { ok: true };
    } catch (e) {
      return this.#fail(e, 'exchangeCode');
    }
  }

  /** リフレッシュトークンを使用してアクセストークンを無停止サイレント更新 */
  async #refreshAccessToken() {
    try {
      const rt = await this.#loadDecryptedRefreshToken();
      if (!rt) return { ok: false, error: 'no_refresh_token_available' };

      const params = {
        client_id: this.#clientId,
        grant_type: 'refresh_token',
        refresh_token: rt
      };
      if (this.#clientSecret) params.client_secret = this.#clientSecret;

      const res = await fetch(DriveAPIManager.#TOKEN_EP, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params)
      });

      if (!res.ok) {
        if (res.status === 400) {
          // リフレッシュトークン自体がGoogle側で失効している場合
          localStorage.removeItem(DriveAPIManager.#LS_KEY);
        }
        throw new Error(`Refresh Request HTTP ${res.status}`);
      }

      const data = await res.json();
      this.#accessToken = data.access_token;
      this.#expiresAt   = Date.now() + (data.expires_in * 1000) - 60000;

      // 新しいリフレッシュトークンが返ってきた場合は再暗号化して保存
      if (data.refresh_token) {
        await this.#saveEncryptedRefreshToken(data.refresh_token);
      }

      return { ok: true };
    } catch (e) {
      return this.#fail(e, 'refreshAccessToken');
    }
  }
}

export default DriveAPIManager;
