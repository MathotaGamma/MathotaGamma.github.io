/**
 * DriveAPIManager v5
 *
 * ● Auth   : Implicit Flow（localStorage polling）
 *            ※ constructor / auth / signOut は動作確認済みコードをそのまま使用
 * ● 保存   : access_token → localStorage（dapi_access_token）
 * ● 戻り値 : 全メソッド { ok:boolean, ...data } or { ok:false, error, place }
 * ● Files  : JSON / text / ArrayBuffer / Blob / File 全対応
 *
 * 必須: oauth2callback.html を同一オリジンに配置すること
 */
class DriveAPIManager {

  // ─── 定数 ──────────────────────────────────────────────────────────────────
  static #DRIVE_EP   = 'https://www.googleapis.com/drive/v3';
  static #UPLOAD_EP  = 'https://www.googleapis.com/upload/drive/v3';
  static #USER_EP    = 'https://www.googleapis.com/oauth2/v3/userinfo';

  // ═══════════════════════════════════════════════════════════════════════════
  // ✅ 動作確認済み — 変更禁止ゾーン
  // ═══════════════════════════════════════════════════════════════════════════

  constructor({ clientId, redirectUri, progress }) {
    if (!clientId || !redirectUri)
      throw new Error('引数にclient_idとredirect_uriを含めてください。');

    this.progress = progress || (() => {});
    this.clientId = clientId;
    this.redirectUri = redirectUri;

    const cachedToken   = localStorage.getItem('dapi_access_token');
    const cachedExpires = parseInt(localStorage.getItem('dapi_expires_at') || '0', 10);
    const isAlive       = cachedToken && cachedExpires > Date.now();

    this.state = {
      login:     isAlive ? true  : false,
      token:     isAlive ? cachedToken : null,
      expiresAt: cachedExpires
    };

    this._authPromise = null;

    // path → Drive file ID キャッシュ（getFileId の高速化）
    this._idCache = new Map();
  }

  /**
   * 認証を実行する
   * @param {boolean} [silent=false]
   *   true  → ポップアップを開かずストレージから復元を試みる
   *   false → ポップアップでログイン
   * @returns {Promise<{ ok:boolean, token?:string, silent?:boolean, error?:string }>}
   */
  auth(silent = false) {
    if (this._authPromise) return this._authPromise;

    if (silent) {
      if (this.state.login && this.state.token && this.state.expiresAt > Date.now()) {
        this.progress('auth', 'silent:done');
        return Promise.resolve({ ok: true, token: this.state.token, silent: true });
      } else {
        this.progress('auth', 'silent:fail');
        this.signOut();
        return Promise.resolve({ ok: false, error: 'silent_auth_failed' });
      }
    }

    if (this.state.login && this.state.token && this.state.expiresAt > Date.now()) {
      this.progress('auth', 'silent:done');
      return Promise.resolve({ ok: true, token: this.state.token, silent: true });
    }

    this.progress('auth', 'start');

    const oauth2Endpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
    localStorage.removeItem('oauth_result');

    const params = {
      client_id:     this.clientId,
      redirect_uri:  this.redirectUri,
      response_type: 'token',
      scope:         'https://www.googleapis.com/auth/drive.appdata',
      state:         'debug_implicit_test'
    };

    const targetUrl = `${oauth2Endpoint}?${new URLSearchParams(params)}`;
    window.open(targetUrl, 'oauth_popup',
      'width=500,height=600,left=100,top=100,menubar=no,toolbar=no,location=no,status=no');

    this._authPromise = new Promise((resolve, reject) => {
      const pollTimer = setInterval(() => {
        const rawResult = localStorage.getItem('oauth_result');
        if (!rawResult) return;

        clearInterval(pollTimer);
        try {
          const data = JSON.parse(rawResult);
          localStorage.removeItem('oauth_result');

          if (data.error) {
            this.progress('auth', 'fail');
            this._authPromise = null;
            reject(new Error(data.error));
            return;
          }

          if (data.code) {
            const expiresAt = Date.now() + (3600 * 1000) - (5 * 60 * 1000);
            this.state.login     = true;
            this.state.token     = data.code;
            this.state.expiresAt = expiresAt;
            localStorage.setItem('dapi_access_token', data.code);
            localStorage.setItem('dapi_expires_at',   expiresAt.toString());
            this.progress('auth', 'done');
            this._authPromise = null;
            resolve({ ok: true, token: this.state.token, silent: false });
          }
        } catch (e) {
          this.progress('auth', 'fail');
          this._authPromise = null;
          reject(e);
        }
      }, 200);
    });

    return this._authPromise;
  }

  /** 明示的なログアウト */
  signOut() {
    this.state.login     = false;
    this.state.token     = null;
    this.state.expiresAt = 0;
    this._idCache.clear();
    localStorage.removeItem('dapi_access_token');
    localStorage.removeItem('dapi_expires_at');
    this.progress('signOut', 'done');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 認証状態チェック（同期）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 現在の認証状態スナップショット（API 呼び出しなし）
   * @returns {{ ok:boolean, loggedIn:boolean, expired:boolean, token:string|null }}
   */
  checker() {
    const loggedIn = this.state.login && !!this.state.token;
    const expired  = !loggedIn || this.state.expiresAt <= Date.now();
    return {
      ok:       loggedIn && !expired,
      loggedIn,
      expired,
      token:    this.state.token,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 内部ユーティリティ
  // ═══════════════════════════════════════════════════════════════════════════

  /** トークンチェック付き fetch。生の Response を返す。 */
  async #f(url, opts = {}) {
    const { ok, error } = this.checker();
    if (!ok) throw Object.assign(new Error(error ?? 'not_authenticated'), { code: 'NOT_AUTHENTICATED' });

    const headers = {
      Authorization: `Bearer ${this.state.token}`,
      ...(opts.headers ?? {}),
    };
    return fetch(url, { ...opts, headers });
  }

  /** エラーを { ok:false, error, place } に正規化 */
  #fail(e, place = '') {
    const error = e instanceof Error ? e.message
      : typeof e === 'string'        ? e
      : JSON.stringify(e);
    return { ok: false, error, place };
  }

  /** path を segments 配列に */
  #segs(path) { return path.split('/').filter(Boolean); }

  /** ランダム hex 文字列 */
  #hex(n) {
    return Array.from(crypto.getRandomValues(new Uint8Array(n)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ユーザー情報
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 認証ユーザーのメールアドレスを取得
   * @returns {Promise<{ ok:boolean, email?:string, error?:string }>}
   */
  async getEmail() {
    try {
      const res = await this.#f(DriveAPIManager.#USER_EP);
      if (!res.ok) return this.#fail(await res.text(), 'getEmail');
      const { email } = await res.json();
      return { ok: true, email };
    } catch (e) {
      return this.#fail(e, 'getEmail');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PATH RESOLUTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Drive ファイル ID → フルパス文字列
   * @param {string} fileId
   * @returns {Promise<{ ok:boolean, path?:string, error?:string }>}
   */
  async getPath(fileId) {
    try {
      const segs = [];
      let id = fileId;
      while (id && id !== 'appDataFolder') {
        const res = await this.#f(
          `${DriveAPIManager.#DRIVE_EP}/files/${id}?fields=id,name,parents&spaces=appDataFolder`
        );
        if (!res.ok) return this.#fail(await res.text(), 'getPath');
        const meta = await res.json();
        segs.unshift(meta.name);
        if (!meta.parents || meta.parents[0] === 'appDataFolder') break;
        id = meta.parents[0];
      }
      return { ok: true, path: '/' + segs.join('/') };
    } catch (e) {
      return this.#fail(e, 'getPath');
    }
  }

  /**
   * パス文字列 → Drive ファイル ID（内部キャッシュ付き）
   * @param {string} path  e.g. '/saves/slot1.json'
   * @returns {Promise<{ ok:boolean, fileId?:string, error?:string }>}
   */
  async getFileId(path) {
    try {
      if (this._idCache.has(path)) return { ok: true, fileId: this._idCache.get(path) };
      const segs = this.#segs(path);
      let pid = 'appDataFolder';

      for (let i = 0; i < segs.length; i++) {
        const sub = '/' + segs.slice(0, i + 1).join('/');
        if (this._idCache.has(sub)) { pid = this._idCache.get(sub); continue; }

        const found = await this.#findChild(pid, segs[i]);
        if (!found) return { ok: false, error: 'not_found', place: 'getFileId' };
        this._idCache.set(sub, found.id);
        pid = found.id;
      }
      return { ok: true, fileId: pid };
    } catch (e) {
      return this.#fail(e, 'getFileId');
    }
  }

  /** フォルダ直下の子を名前で検索（内部用） */
  async #findChild(parentId, name, mimes = []) {
    let q = `'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false`;
    if (mimes.length) q += ' and (' + mimes.map(m => `mimeType='${m}'`).join(' or ') + ')';
    const p = new URLSearchParams({
      spaces: 'appDataFolder', fields: 'files(id,name,mimeType)', q, pageSize: '1',
    });
    const res = await this.#f(`${DriveAPIManager.#DRIVE_EP}/files?${p}`);
    if (!res.ok) return null;
    return (await res.json()).files?.[0] ?? null;
  }

  /**
   * pathOrId を fileId に解決（パスでも ID でも受け付ける）
   * Drive ID は英数字+記号 20 文字以上・スラッシュなし
   */
  async #resolveId(pathOrId) {
    if (/^[A-Za-z0-9_-]{20,}$/.test(pathOrId)) return { ok: true, fileId: pathOrId };
    const r = await this.getFileId(pathOrId);
    if (!r.ok) return r;
    if (!r.fileId) return { ok: false, error: 'not_found', place: '#resolveId' };
    return { ok: true, fileId: r.fileId };
  }

  #evict(id) {
    for (const [k, v] of this._idCache) if (v === id) this._idCache.delete(k);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FOLDER
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * フォルダを冪等に作成（中間フォルダも自動）
   * @param {string} path  e.g. '/saves/2024/april'
   * @returns {Promise<{ ok:boolean, folderId?:string, error?:string }>}
   */
  async createFolder(path) {
    try {
      const segs = this.#segs(path);
      let pid = 'appDataFolder';

      for (let i = 0; i < segs.length; i++) {
        const sub = '/' + segs.slice(0, i + 1).join('/');
        if (this._idCache.has(sub)) { pid = this._idCache.get(sub); continue; }

        const existing = await this.#findChild(pid, segs[i], ['application/vnd.google-apps.folder']);
        if (existing) { this._idCache.set(sub, existing.id); pid = existing.id; continue; }

        const res = await this.#f(`${DriveAPIManager.#DRIVE_EP}/files`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            name: segs[i], mimeType: 'application/vnd.google-apps.folder', parents: [pid],
          }),
        });
        if (!res.ok) return this.#fail(await res.text(), 'createFolder');
        const folder = await res.json();
        this._idCache.set(sub, folder.id);
        pid = folder.id;
        this.progress('createFolder', sub);
      }
      return { ok: true, folderId: pid };
    } catch (e) {
      return this.#fail(e, 'createFolder');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FILE CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ファイルをダウンロード。戻り値の file は File オブジェクト。
   * @param {string} pathOrId  パスまたは Drive ファイル ID
   * @returns {Promise<{ ok:boolean, file?:File, error?:string }>}
   */
  async getFile(pathOrId) {
    try {
      const r = await this.#resolveId(pathOrId);
      if (!r.ok) return r;

      // メタデータ（名前・MIME）
      const metaRes = await this.#f(
        `${DriveAPIManager.#DRIVE_EP}/files/${r.fileId}?fields=name,mimeType`
      );
      if (!metaRes.ok) return this.#fail(await metaRes.text(), 'getFile > meta');
      const meta = await metaRes.json();

      // コンテンツ
      const contentRes = await this.#f(
        `${DriveAPIManager.#DRIVE_EP}/files/${r.fileId}?alt=media`
      );
      if (!contentRes.ok) return this.#fail(await contentRes.text(), 'getFile > content');

      const blob = await contentRes.blob();
      const file = new File([blob], meta.name, { type: meta.mimeType });
      return { ok: true, file };
    } catch (e) {
      return this.#fail(e, 'getFile');
    }
  }

  /**
   * ファイルを作成 or 上書き保存（multipart/related アップロード）
   * @param {string} path
   * @param {object|string|ArrayBuffer|Uint8Array|Blob|File} data
   * @param {object} [metadata]  Drive 追加メタデータ（appProperties 等）
   * @returns {Promise<{ ok:boolean, data?:object, error?:string }>}
   */
  async saveFile(path, data, metadata = {}) {
    try {
      // 1. Blob 化
      let fileBlob;
      if (data instanceof File || data instanceof Blob) {
        fileBlob = data;
      } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
        fileBlob = new Blob([data]);
      } else if (typeof data === 'string') {
        fileBlob = new Blob([data], { type: 'text/plain' });
      } else {
        fileBlob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      }

      // 2. パス解決
      const segs     = this.#segs(path);
      const fileName = segs.at(-1);
      const dirPath  = segs.slice(0, -1).join('/');
      let parentId   = 'appDataFolder';
      if (dirPath) {
        const fr = await this.createFolder('/' + dirPath);
        if (!fr.ok) return fr;
        parentId = fr.folderId;
      }

      const fileIdRet = await this.getFileId(path);
      const fileId    = fileIdRet.ok ? fileIdRet.fileId : null;

      // 3. メタデータ構築
      const finalMeta = {
        name:     fileName,
        mimeType: fileBlob.type || 'application/octet-stream',
        ...metadata,
      };
      if (!fileId) finalMeta.parents = [parentId];

      // 4. multipart/related ボディ（Blob 連結方式・バイナリセーフ）
      const boundary = `dapi_${this.#hex(8)}`;
      const bodyBlob = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        JSON.stringify(finalMeta),
        `\r\n--${boundary}\r\nContent-Type: ${finalMeta.mimeType}\r\n\r\n`,
        fileBlob,
        `\r\n--${boundary}--`,
      ], { type: `multipart/related; boundary="${boundary}"` });

      // 5. リクエスト
      const url = fileId
        ? `${DriveAPIManager.#UPLOAD_EP}/files/${fileId}?uploadType=multipart`
        : `${DriveAPIManager.#UPLOAD_EP}/files?uploadType=multipart`;

      const res = await this.#f(url, {
        method:  fileId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': `multipart/related; boundary="${boundary}"` },
        body:    bodyBlob,
      });
      if (!res.ok) return this.#fail(await res.text(), 'saveFile > fetch');

      const result = await res.json();
      this._idCache.set(path, result.id);
      this.progress('saveFile', path);
      return { ok: true, data: result };
    } catch (e) {
      return this.#fail(e, 'saveFile');
    }
  }

  /**
   * ファイルをコピー
   * @param {string} srcPathOrId
   * @param {string} destPath
   * @returns {Promise<{ ok:boolean, data?:object, error?:string }>}
   */
  async copyFile(srcPathOrId, destPath) {
    try {
      const src = await this.#resolveId(srcPathOrId);
      if (!src.ok) return src;

      const segs = this.#segs(destPath);
      const name = segs.at(-1);
      const dir  = segs.slice(0, -1).join('/');
      let pid    = 'appDataFolder';
      if (dir) {
        const fr = await this.createFolder('/' + dir);
        if (!fr.ok) return fr;
        pid = fr.folderId;
      }

      const res = await this.#f(
        `${DriveAPIManager.#DRIVE_EP}/files/${src.fileId}/copy?fields=id,name,modifiedTime`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, parents: [pid] }) }
      );
      if (!res.ok) return this.#fail(await res.text(), 'copyFile');
      const data = await res.json();
      this._idCache.set(destPath, data.id);
      return { ok: true, data };
    } catch (e) {
      return this.#fail(e, 'copyFile');
    }
  }

  /**
   * ファイルを移動 / リネーム
   * @param {string} pathOrId
   * @param {string} newPath
   * @returns {Promise<{ ok:boolean, data?:object, error?:string }>}
   */
  async moveFile(pathOrId, newPath) {
    try {
      const src = await this.#resolveId(pathOrId);
      if (!src.ok) return src;

      const metaRes = await this.#f(
        `${DriveAPIManager.#DRIVE_EP}/files/${src.fileId}?fields=parents`
      );
      if (!metaRes.ok) return this.#fail(await metaRes.text(), 'moveFile > meta');
      const { parents } = await metaRes.json();
      const oldPid = parents?.[0] ?? 'appDataFolder';

      const segs   = this.#segs(newPath);
      const name   = segs.at(-1);
      const dir    = segs.slice(0, -1).join('/');
      let newPid   = 'appDataFolder';
      if (dir) {
        const fr = await this.createFolder('/' + dir);
        if (!fr.ok) return fr;
        newPid = fr.folderId;
      }

      const url = `${DriveAPIManager.#DRIVE_EP}/files/${src.fileId}?` + new URLSearchParams({
        addParents: newPid, removeParents: oldPid, fields: 'id,name,parents',
      });
      const res = await this.#f(url, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return this.#fail(await res.text(), 'moveFile');
      const data = await res.json();
      this.#evict(src.fileId);
      this._idCache.set(newPath, src.fileId);
      return { ok: true, data };
    } catch (e) {
      return this.#fail(e, 'moveFile');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LISTING & STRUCTURE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * フォルダ直下の一覧。引数なし / '' / '/' で appDataFolder 直下。
   * @param {string} [pathOrId='']
   * @returns {Promise<{ ok:boolean, files?:object[], error?:string }>}
   */
  async listFiles(pathOrId = '') {
    try {
      let pid = 'appDataFolder';
      if (pathOrId && pathOrId !== '/') {
        const r = await this.#resolveId(pathOrId);
        if (!r.ok) return r;
        pid = r.fileId;
      }
      const files = await this.#listAll(pid, false);
      return { ok: true, files };
    } catch (e) {
      return this.#fail(e, 'listFiles');
    }
  }

  /**
   * appDataFolder 全体の再帰ツリーを返す（1 回の API で取得）
   *
   * DriveNode = {
   *   id, name,
   *   type: 'folder' | 'file',
   *   mimeType?, size?: number, modifiedTime?,
   *   children?: DriveNode[]
   * }
   *
   * @returns {Promise<{ ok:boolean, tree?:DriveNode, error?:string }>}
   */
  async getStructure() {
    try {
      this.progress('getStructure', 'start');
      const all = await this.#listAll('appDataFolder', true);

      const root = { id: 'appDataFolder', name: '/', type: 'folder', children: [] };
      if (all.length === 0) {
        this.progress('getStructure', 'empty');
        return { ok: true, tree: root };
      }

      const map = new Map();
      map.set('appDataFolder', root);
      for (const f of all) {
        map.set(f.id, {
          id:           f.id,
          name:         f.name,
          type:         f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
          mimeType:     f.mimeType,
          size:         f.size != null ? Number(f.size) : undefined,
          modifiedTime: f.modifiedTime,
          children:     f.mimeType === 'application/vnd.google-apps.folder' ? [] : undefined,
        });
      }
      for (const f of all) {
        const parent = map.get(f.parents?.[0]);
        if (parent?.children) parent.children.push(map.get(f.id));
      }

      this.progress('getStructure', `${all.length} items`);
      return { ok: true, tree: root };
    } catch (e) {
      return this.#fail(e, 'getStructure');
    }
  }

  /** ページネーション対応の全件取得（内部用） */
  async #listAll(parentId, recursive = false) {
    const results = [];
    let pageToken = null;
    const q = recursive
      ? 'trashed=false'
      : `'${parentId}' in parents and trashed=false`;

    do {
      const p = new URLSearchParams({
        spaces:   'appDataFolder',
        fields:   'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)',
        q, pageSize: '1000',
      });
      if (pageToken) p.set('pageToken', pageToken);
      const res = await this.#f(`${DriveAPIManager.#DRIVE_EP}/files?${p}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      results.push(...(data.files ?? []));
      pageToken = data.nextPageToken ?? null;
    } while (pageToken);

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEARCH
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ファイル名の部分一致検索
   * @param {string}  query
   * @param {object}  [opts]
   * @param {string}  [opts.mimeType]
   * @param {number}  [opts.limit=50]
   * @returns {Promise<{ ok:boolean, files?:object[], error?:string }>}
   */
  async search(query, opts = {}) {
    try {
      let q = 'trashed=false';
      if (query) q += ` and name contains '${query.replace(/'/g, "\\'")}'`;
      if (opts.mimeType) q += ` and mimeType='${opts.mimeType}'`;
      const p = new URLSearchParams({
        spaces: 'appDataFolder',
        fields: 'files(id,name,mimeType,size,modifiedTime,parents)',
        q, pageSize: String(opts.limit ?? 50),
      });
      const res = await this.#f(`${DriveAPIManager.#DRIVE_EP}/files?${p}`);
      if (!res.ok) return this.#fail(await res.text(), 'search');
      return { ok: true, files: (await res.json()).files ?? [] };
    } catch (e) {
      return this.#fail(e, 'search');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ファイルのメタデータを取得
   * @param {string} pathOrId
   * @param {string} [fields='id,name,mimeType,size,modifiedTime,parents']
   * @returns {Promise<{ ok:boolean, meta?:object, error?:string }>}
   */
  async getMeta(pathOrId, fields = 'id,name,mimeType,size,modifiedTime,parents') {
    try {
      const r = await this.#resolveId(pathOrId);
      if (!r.ok) return r;
      const res = await this.#f(
        `${DriveAPIManager.#DRIVE_EP}/files/${r.fileId}?fields=${encodeURIComponent(fields)}`
      );
      if (!res.ok) return this.#fail(await res.text(), 'getMeta');
      return { ok: true, meta: await res.json() };
    } catch (e) {
      return this.#fail(e, 'getMeta');
    }
  }

  /**
   * メタデータを更新（ファイル内容は変えない）
   * @param {string} pathOrId
   * @param {object} meta  name / description / appProperties 等
   * @returns {Promise<{ ok:boolean, data?:object, error?:string }>}
   */
  async updateMeta(pathOrId, meta) {
    try {
      const r = await this.#resolveId(pathOrId);
      if (!r.ok) return r;
      const res = await this.#f(
        `${DriveAPIManager.#DRIVE_EP}/files/${r.fileId}?fields=id,name,modifiedTime`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) }
      );
      if (!res.ok) return this.#fail(await res.text(), 'updateMeta');
      return { ok: true, data: await res.json() };
    } catch (e) {
      return this.#fail(e, 'updateMeta');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 1 ファイル / フォルダを削除
   * @param {string} pathOrId
   * @returns {Promise<{ ok:boolean, error?:string }>}
   */
  async remove(pathOrId) {
    try {
      const r = await this.#resolveId(pathOrId);
      if (!r.ok) return r;
      const res = await this.#f(
        `${DriveAPIManager.#DRIVE_EP}/files/${r.fileId}`, { method: 'DELETE' }
      );
      if (!res.ok && res.status !== 204) return this.#fail(await res.text(), 'remove');
      this.#evict(r.fileId);
      this.progress('remove', pathOrId);
      return { ok: true };
    } catch (e) {
      return this.#fail(e, 'remove');
    }
  }

  /**
   * appDataFolder 内を全消去 ⚠ 不可逆
   * @returns {Promise<{ ok:boolean, deleted?:number, failed?:object[], error?:string }>}
   */
  async removeAll() {
    try {
      const all = await this.#listAll('appDataFolder', true);
      this.progress('removeAll', `deleting ${all.length} items`);

      const failed = [];
      // 10 並列で削除
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(10, all.length) }, async () => {
        while (i < all.length) {
          const f = all[i++];
          const res = await this.#f(
            `${DriveAPIManager.#DRIVE_EP}/files/${f.id}`, { method: 'DELETE' }
          );
          if (!res.ok && res.status !== 204) {
            failed.push({ id: f.id, name: f.name, error: await res.text() });
          } else {
            this.progress('removeAll', `deleted: ${f.name}`);
          }
        }
      }));

      this._idCache.clear();
      this.progress('removeAll', 'done');
      return { ok: true, deleted: all.length - failed.length, failed };
    } catch (e) {
      return this.#fail(e, 'removeAll');
    }
  }
}

export default DriveAPIManager;
