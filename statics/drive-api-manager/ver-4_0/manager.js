/**
 * DriveAPIManager v4
 *
 * ● 認証  : PKCE + client_secret（ウェブアプリタイプ対応）
 *           サーバー不要・GitHub Pages 完全動作
 * ● 保存  : access_token  → #プライベートフィールド（メモリのみ）
 *           refresh_token → AES-GCM 暗号化 → localStorage
 *           鍵導出        → PBKDF2(salt = sub + origin, 200,000 回)
 * ● 戻り値: 全メソッド { ok:boolean, ...data } or { ok:false, error, place }
 * ● ファイル: JSON / text / ArrayBuffer / Blob / File 全対応
 *
 * 必要ファイル: oauth2callback.html（同一オリジンに配置）
 *   <script>
 *     const p = new URLSearchParams(location.search);
 *     window.opener?.postMessage(
 *       { type:'oauth_callback', code:p.get('code'), state:p.get('state'), error:p.get('error') },
 *       location.origin
 *     );
 *     window.close();
 *   </script>
 */
class DriveAPIManager {

  // ─── Private fields（メモリのみ・外部から完全に不可視）─────────────────────
  #accessToken = null;
  #expiresAt   = 0;
  #sub         = null;   // Google ユーザー固有 ID（PBKDF2 salt）
  #cryptoKey   = null;   // 導出済み CryptoKey キャッシュ

  // ─── 定数 ──────────────────────────────────────────────────────────────────
  static #LS_KEY      = 'drive_enc_rt';
  static #AUTH_EP     = 'https://accounts.google.com/o/oauth2/v2/auth';
  static #TOKEN_EP    = 'https://oauth2.googleapis.com/token';
  static #REVOKE_EP   = 'https://oauth2.googleapis.com/revoke';
  static #DRIVE_EP    = 'https://www.googleapis.com/drive/v3';
  static #UPLOAD_EP   = 'https://www.googleapis.com/upload/drive/v3';
  static #USERINFO_EP = 'https://www.googleapis.com/oauth2/v3/userinfo';
  static #POPUP_W     = 520;
  static #POPUP_H     = 620;

  /**
   * @param {object}   opts
   * @param {string}   opts.clientId
   * @param {string}   [opts.clientSecret]   ウェブアプリタイプの場合に必要
   * @param {string}   [opts.redirectUri]    default: location.origin + '/oauth2callback'
   * @param {string}   [opts.scope]
   * @param {Function} [opts.progress]       (phase:string, detail:string) => void
   */
  constructor(opts = {}) {
    this.CLIENT_ID     = opts.clientId     ?? 'API_ID';
    this.CLIENT_SECRET = opts.clientSecret ?? null;
    this.REDIRECT_URI  = opts.redirectUri  ?? `${location.origin}/oauth2callback`;
    this.SCOPES        = opts.scope        ?? 'https://www.googleapis.com/auth/drive.appdata';
    this.progress      = opts.progress     ?? (() => {});

    this._idCache     = new Map();  // path → Drive file ID
    this._authPromise = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTH（公開）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 認証メインエントリ。
   *   silent=true  → ポップアップなし。取れなければ { ok:false, error:'NOT_AUTHENTICATED' }
   *   silent=false → 必要なら PKCE ポップアップを開く
   *
   * @param {boolean} [silent=true]
   * @returns {Promise<{ ok:boolean, token?:string, error?:string }>}
   */
  async auth(silent = true) {
    if (this._authPromise) return this._authPromise;
    this._authPromise = this.#authFlow(silent).finally(() => {
      this._authPromise = null;
    });
    return this._authPromise;
  }

  /**
   * 認証状態の同期スナップショット（API 呼び出しなし）。
   * @returns {{ ok:boolean, loggedIn:boolean, expired:boolean, hasRefreshToken:boolean }}
   */
  checker() {
    const hasRT = !!this.#loadEncRT();
    const loggedIn = !!this.#accessToken || hasRT;
    return {
      ok:              loggedIn,
      loggedIn,
      expired:         this.#isExpired(),
      hasRefreshToken: hasRT,
    };
  }

  /**
   * 認証ユーザーのメールアドレスを返す。
   * @returns {Promise<{ ok:boolean, email?:string, error?:string }>}
   */
  async getEmail() {
    try {
      const res  = await this.#apiFetch(DriveAPIManager.#USERINFO_EP);
      if (!res.ok) return this.#fail(await res.text(), 'getEmail');
      const info = await res.json();
      return { ok: true, email: info.email };
    } catch (e) {
      return this.#fail(e, 'getEmail');
    }
  }

  /**
   * サインアウト。サーバー側 revoke + ローカル全消去。
   * @returns {Promise<{ ok:boolean, error?:string }>}
   */
  async signOut() {
    try {
      if (this.#accessToken) {
        await fetch(
          `${DriveAPIManager.#REVOKE_EP}?token=${this.#accessToken}`,
          { method: 'POST' }
        ).catch(() => {});
      }
      this.#clearSession();
      this.progress('auth', 'signed_out');
      return { ok: true };
    } catch (e) {
      return this.#fail(e, 'signOut');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTH（内部フロー）
  // ═══════════════════════════════════════════════════════════════════════════

  async #authFlow(silent) {
    this.progress('auth', 'start');

    // 1. メモリに有効なトークン
    if (this.#accessToken && !this.#isExpired()) {
      this.progress('auth', 'memory_hit');
      return { ok: true, token: this.#accessToken };
    }

    // 2. 暗号化 RT → リフレッシュ
    const encRT = this.#loadEncRT();
    if (encRT) {
      try {
        this.progress('auth', 'refreshing');
        const rt = await this.#decryptRT(encRT);
        await this.#doRefresh(rt);
        return { ok: true, token: this.#accessToken };
      } catch (e) {
        this.progress('auth', `refresh_failed: ${e.message}`);
        this.#clearSession();
        if (silent) return { ok: false, error: 'REFRESH_FAILED', detail: e.message };
      }
    }

    if (silent) return { ok: false, error: 'NOT_AUTHENTICATED' };

    // 3. PKCE ポップアップ
    return this.#pkceFlow();
  }

  async #pkceFlow() {
    this.progress('auth', 'pkce_start');
    const verifier  = this.#makeVerifier();
    const challenge = await this.#makeChallenge(verifier);
    const state     = this.#hex(16);

    const authUrl = DriveAPIManager.#AUTH_EP + '?' + new URLSearchParams({
      client_id:             this.CLIENT_ID,
      redirect_uri:          this.REDIRECT_URI,
      response_type:         'code',
      scope:                 this.SCOPES,
      code_challenge:        challenge,
      code_challenge_method: 'S256',
      state,
      access_type:           'offline',
      prompt:                'consent',
    });

    try {
      const code = await this.#openPopup(authUrl, state);
      this.progress('auth', 'exchanging_code');
      await this.#exchangeCode(code, verifier);
      this.progress('auth', 'done');
      return { ok: true, token: this.#accessToken };
    } catch (e) {
      return { ok: false, error: e.code ?? 'AUTH_FAILED', detail: e.message };
    }
  }

  #openPopup(url, state) {
    return new Promise((resolve, reject) => {
      const left = Math.round(screen.width  / 2 - DriveAPIManager.#POPUP_W / 2);
      const top  = Math.round(screen.height / 2 - DriveAPIManager.#POPUP_H / 2);
      const win  = window.open(url, 'g_oauth',
        `width=${DriveAPIManager.#POPUP_W},height=${DriveAPIManager.#POPUP_H},left=${left},top=${top}`);
      if (!win) { reject(Object.assign(new Error('Popup blocked'), { code: 'POPUP_BLOCKED' })); return; }

      let done = false;
      const finish = (val, isErr = false) => {
        if (done) return; done = true;
        window.removeEventListener('message', onMsg);
        clearInterval(poll); clearTimeout(timer);
        try { win.close(); } catch (_) {}
        isErr ? reject(val) : resolve(val);
      };

      // A) postMessage
      const onMsg = ({ origin, data }) => {
        if (origin !== location.origin || data?.type !== 'oauth_callback') return;
        if (data.state !== state) {
          finish(Object.assign(new Error('State mismatch'), { code: 'STATE_MISMATCH' }), true); return;
        }
        if (data.error) {
          finish(Object.assign(new Error(data.error), { code: 'AUTH_DENIED' }), true); return;
        }
        finish(data.code);
      };
      window.addEventListener('message', onMsg);

      // B) URL ポーリング（フォールバック）
      const poll = setInterval(() => {
        if (win.closed && !done) {
          finish(Object.assign(new Error('Popup closed'), { code: 'POPUP_CLOSED' }), true); return;
        }
        try {
          const pu = new URL(win.location.href);
          if (pu.origin !== location.origin) return;
          const err = pu.searchParams.get('error');
          if (err) {
            finish(Object.assign(new Error(err), { code: 'AUTH_DENIED' }), true); return;
          }
          if (pu.searchParams.get('state') !== state) {
            finish(Object.assign(new Error('State mismatch'), { code: 'STATE_MISMATCH' }), true); return;
          }
          const c = pu.searchParams.get('code');
          if (c) finish(c);
        } catch (_) {}
      }, 300);

      const timer = setTimeout(
        () => finish(Object.assign(new Error('Timeout'), { code: 'AUTH_TIMEOUT' }), true),
        300_000
      );
    });
  }

  async #exchangeCode(code, verifier) {
    const params = {
      client_id:     this.CLIENT_ID,
      redirect_uri:  this.REDIRECT_URI,
      grant_type:    'authorization_code',
      code,
      code_verifier: verifier,
    };
    if (this.CLIENT_SECRET) params.client_secret = this.CLIENT_SECRET;

    const res = await fetch(DriveAPIManager.#TOKEN_EP, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams(params),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(err.error_description ?? 'Token exchange failed'), { code: 'TOKEN_EXCHANGE_FAILED', raw: err });
    }
    await this.#applyToken(await res.json());
  }

  async #doRefresh(rt) {
    const params = {
      client_id:     this.CLIENT_ID,
      grant_type:    'refresh_token',
      refresh_token: rt,
    };
    if (this.CLIENT_SECRET) params.client_secret = this.CLIENT_SECRET;

    const res = await fetch(DriveAPIManager.#TOKEN_EP, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams(params),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(err.error_description ?? 'Refresh failed'), { code: 'REFRESH_FAILED', raw: err });
    }
    const data = await res.json();
    await this.#applyToken({ ...data, refresh_token: data.refresh_token ?? rt });
  }

  async #applyToken(data) {
    this.#accessToken = data.access_token;
    this.#expiresAt   = Date.now() + (data.expires_in ?? 3600) * 1000;
    if (data.refresh_token) {
      if (!this.#sub) await this.#fetchSub();
      this.#saveEncRT(await this.#encryptRT(data.refresh_token));
    }
  }

  async #fetchSub() {
    const res  = await fetch(DriveAPIManager.#USERINFO_EP, {
      headers: { Authorization: `Bearer ${this.#accessToken}` },
    });
    const info = await res.json();
    this.#sub  = info.sub;
  }

  // ─── PKCE 計算 ─────────────────────────────────────────────────────────────

  #makeVerifier() {
    const b = new Uint8Array(64);
    crypto.getRandomValues(b);
    return btoa(String.fromCharCode(...b))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async #makeChallenge(v) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    return btoa(String.fromCharCode(...new Uint8Array(d)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  #hex(bytes) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 暗号化 / 復号  AES-256-GCM + PBKDF2
  // ═══════════════════════════════════════════════════════════════════════════

  async #getKey() {
    if (this.#cryptoKey) return this.#cryptoKey;
    const sub     = this.#sub ?? '';
    const saltStr = `${sub}:${location.origin}`;
    const base    = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(`${this.CLIENT_ID}:${saltStr}`),
      'PBKDF2', false, ['deriveKey']
    );
    this.#cryptoKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: new TextEncoder().encode(saltStr), iterations: 200_000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return this.#cryptoKey;
  }

  async #encryptRT(rt) {
    const key    = await this.#getKey();
    const iv     = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(rt));
    const buf    = new Uint8Array(12 + cipher.byteLength);
    buf.set(iv, 0); buf.set(new Uint8Array(cipher), 12);
    return btoa(String.fromCharCode(...buf));
  }

  async #decryptRT(b64) {
    const raw  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const key  = await this.#getKey();
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12)
      );
      return new TextDecoder().decode(plain);
    } catch {
      this.#clearSession();
      throw Object.assign(new Error('Decrypt failed'), { code: 'DECRYPT_FAILED' });
    }
  }

  #saveEncRT(b64)  { try { localStorage.setItem(DriveAPIManager.#LS_KEY, b64); } catch (_) {} }
  #loadEncRT()     { try { return localStorage.getItem(DriveAPIManager.#LS_KEY); } catch (_) { return null; } }

  #clearSession() {
    this.#accessToken = null;
    this.#expiresAt   = 0;
    this.#sub         = null;
    this.#cryptoKey   = null;
    this._idCache.clear();
    try { localStorage.removeItem(DriveAPIManager.#LS_KEY); } catch (_) {}
  }

  #isExpired(margin = 60_000) {
    return !this.#accessToken || Date.now() > this.#expiresAt - margin;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 認証付き fetch（内部）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 自動トークン注入 + 401 時リトライ。
   * 生の Response を返す（エラー判定は呼び出し側）。
   */
  async #apiFetch(url, opts = {}, retried = false) {
    const authResult = await this.auth(true);
    if (!authResult.ok) throw Object.assign(new Error(authResult.error), { code: authResult.error });

    const headers = { Authorization: `Bearer ${this.#accessToken}`, ...(opts.headers ?? {}) };
    const res     = await fetch(url, { ...opts, headers });

    if (res.status === 401 && !retried) {
      this.#accessToken = null;
      return this.#apiFetch(url, opts, true);
    }
    return res;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PATH RESOLUTION
  // ═══════════════════════════════════════════════════════════════════════════

  #parsePath(path) { return path.split('/').filter(Boolean); }

  /**
   * ファイル ID → フルパス文字列 ('/docs/note.json')
   * @param {string} fileId
   * @returns {Promise<{ ok:boolean, path?:string, error?:string }>}
   */
  async getPath(fileId) {
    try {
      const segs = [];
      let id = fileId;
      while (id && id !== 'appDataFolder') {
        const res = await this.#apiFetch(
          `${DriveAPIManager.#DRIVE_EP}/files/${id}?fields=id,name,parents&spaces=appDataFolder`
        );
        if (!res.ok) return this.#fail(await res.text(), 'getPath');
        const meta = await res.json();
        segs.unshift(meta.name);
        // 親が appDataFolder か存在しなければ終了
        if (!meta.parents || meta.parents[0] === 'appDataFolder') break;
        id = meta.parents[0];
      }
      return { ok: true, path: '/' + segs.join('/') };
    } catch (e) {
      return this.#fail(e, 'getPath');
    }
  }

  /**
   * パス → Drive ファイル ID（内部キャッシュ付き）
   * @param {string} path
   * @returns {Promise<{ ok:boolean, fileId?:string, error?:string }>}
   */
  async getFileId(path) {
    try {
      if (this._idCache.has(path)) return { ok: true, fileId: this._idCache.get(path) };
      const segs = this.#parsePath(path);
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

  async #findChild(parentId, name, mimes = []) {
    let q = `'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false`;
    if (mimes.length) q += ' and (' + mimes.map(m => `mimeType='${m}'`).join(' or ') + ')';
    const p = new URLSearchParams({
      spaces: 'appDataFolder', fields: 'files(id,name,mimeType)', q, pageSize: '1',
    });
    const res  = await this.#apiFetch(`${DriveAPIManager.#DRIVE_EP}/files?${p}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.files?.[0] ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FOLDER
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * フォルダを冪等に作成（中間フォルダも自動）。
   * @param {string} path  e.g. '/saves/2024/april'
   * @returns {Promise<{ ok:boolean, folderId?:string, error?:string }>}
   */
  async createFolder(path) {
    try {
      const segs = this.#parsePath(path);
      let pid = 'appDataFolder';

      for (let i = 0; i < segs.length; i++) {
        const sub = '/' + segs.slice(0, i + 1).join('/');
        if (this._idCache.has(sub)) { pid = this._idCache.get(sub); continue; }

        const existing = await this.#findChild(pid, segs[i], ['application/vnd.google-apps.folder']);
        if (existing) { this._idCache.set(sub, existing.id); pid = existing.id; continue; }

        const res = await this.#apiFetch(`${DriveAPIManager.#DRIVE_EP}/files`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ name: segs[i], mimeType: 'application/vnd.google-apps.folder', parents: [pid] }),
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
   *
   * @param {string} pathOrId  パスまたは Drive ファイル ID
   * @returns {Promise<{ ok:boolean, file?:File, error?:string }>}
   */
  async getFile(pathOrId) {
    try {
      const idResult = await this.#resolveId(pathOrId);
      if (!idResult.ok) return idResult;
      const fileId = idResult.fileId;

      // メタデータ取得（ファイル名・MIME）
      const metaRes = await this.#apiFetch(
        `${DriveAPIManager.#DRIVE_EP}/files/${fileId}?fields=name,mimeType`
      );
      if (!metaRes.ok) return this.#fail(await metaRes.text(), 'getFile > meta');
      const meta = await metaRes.json();

      // コンテンツ取得
      const contentRes = await this.#apiFetch(
        `${DriveAPIManager.#DRIVE_EP}/files/${fileId}?alt=media`
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
   * ファイルを作成 or 上書き保存。
   *
   * @param {string} path
   * @param {object|string|ArrayBuffer|Uint8Array|Blob|File} data
   * @param {object} [metadata]  Drive メタデータ追加フィールド（appProperties 等）
   * @returns {Promise<{ ok:boolean, data?:object, error?:string }>}
   */
  async saveFile(path, data, metadata = {}) {
    try {
      // 1. Blob 化
      let fileBlob;
      if (data instanceof File)        fileBlob = data;
      else if (data instanceof Blob)   fileBlob = data;
      else if (data instanceof ArrayBuffer || data instanceof Uint8Array)
                                       fileBlob = new Blob([data]);
      else if (typeof data === 'string') fileBlob = new Blob([data], { type: 'text/plain' });
      else                             fileBlob = new Blob([JSON.stringify(data)], { type: 'application/json' });

      // 2. パス解決
      const segs     = this.#parsePath(path);
      const fileName = segs.at(-1);
      const dirPath  = segs.slice(0, -1).join('/');
      let parentId   = 'appDataFolder';

      if (dirPath) {
        const folderRet = await this.createFolder('/' + dirPath);
        if (!folderRet.ok) return folderRet;
        parentId = folderRet.folderId;
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

      // 4. multipart/related ボディ（バイナリセーフ: Blob 連結方式）
      const boundary   = `dapi_${this.#hex(8)}`;
      const metaJson   = JSON.stringify(finalMeta);
      const bodyBlob   = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        metaJson,
        `\r\n--${boundary}\r\nContent-Type: ${finalMeta.mimeType}\r\n\r\n`,
        fileBlob,
        `\r\n--${boundary}--`,
      ], { type: `multipart/related; boundary="${boundary}"` });

      // 5. リクエスト
      const url = fileId
        ? `${DriveAPIManager.#UPLOAD_EP}/files/${fileId}?uploadType=multipart`
        : `${DriveAPIManager.#UPLOAD_EP}/files?uploadType=multipart`;

      const res = await this.#apiFetch(url, {
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
   * ファイルをコピー。
   * @param {string} srcPathOrId
   * @param {string} destPath
   * @returns {Promise<{ ok:boolean, data?:object, error?:string }>}
   */
  async copyFile(srcPathOrId, destPath) {
    try {
      const src = await this.#resolveId(srcPathOrId);
      if (!src.ok) return src;

      const segs   = this.#parsePath(destPath);
      const name   = segs.at(-1);
      const dir    = segs.slice(0, -1).join('/');
      let pid      = 'appDataFolder';
      if (dir) {
        const fr = await this.createFolder('/' + dir);
        if (!fr.ok) return fr;
        pid = fr.folderId;
      }

      const res = await this.#apiFetch(
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
   * ファイルを移動 / リネーム。
   * @param {string} pathOrId
   * @param {string} newPath
   * @returns {Promise<{ ok:boolean, data?:object, error?:string }>}
   */
  async moveFile(pathOrId, newPath) {
    try {
      const src     = await this.#resolveId(pathOrId);
      if (!src.ok) return src;

      const metaRes = await this.#apiFetch(
        `${DriveAPIManager.#DRIVE_EP}/files/${src.fileId}?fields=parents`
      );
      if (!metaRes.ok) return this.#fail(await metaRes.text(), 'moveFile > meta');
      const { parents } = await metaRes.json();
      const oldPid = parents?.[0] ?? 'appDataFolder';

      const segs   = this.#parsePath(newPath);
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
      const res = await this.#apiFetch(url, {
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
   * フォルダ直下の一覧。引数なし or '/' で appDataFolder 直下。
   * @param {string} [pathOrId='']
   * @returns {Promise<{ ok:boolean, files?:FileEntry[], error?:string }>}
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
   * appDataFolder 全体の再帰ツリーを返す。
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

      if (all.length === 0) {
        this.progress('getStructure', 'empty');
        return { ok: true, tree: { id: 'appDataFolder', name: '/', type: 'folder', children: [] } };
      }

      const map = new Map();
      map.set('appDataFolder', { id: 'appDataFolder', name: '/', type: 'folder', children: [] });

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
      return { ok: true, tree: map.get('appDataFolder') };
    } catch (e) {
      return this.#fail(e, 'getStructure');
    }
  }

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
        q,
        pageSize: '1000',
      });
      if (pageToken) p.set('pageToken', pageToken);
      const res  = await this.#apiFetch(`${DriveAPIManager.#DRIVE_EP}/files?${p}`);
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
   * ファイル名の部分一致検索。
   * @param {string}  query
   * @param {object}  [opts]
   * @param {string}  [opts.mimeType]
   * @param {number}  [opts.limit=50]
   * @returns {Promise<{ ok:boolean, files?:FileEntry[], error?:string }>}
   */
  async search(query, opts = {}) {
    try {
      let q = `trashed=false`;
      if (query) q += ` and name contains '${query.replace(/'/g, "\\'")}'`;
      if (opts.mimeType) q += ` and mimeType='${opts.mimeType}'`;
      const p = new URLSearchParams({
        spaces:   'appDataFolder',
        fields:   'files(id,name,mimeType,size,modifiedTime,parents)',
        q,
        pageSize: String(opts.limit ?? 50),
      });
      const res  = await this.#apiFetch(`${DriveAPIManager.#DRIVE_EP}/files?${p}`);
      if (!res.ok) return this.#fail(await res.text(), 'search');
      const data = await res.json();
      return { ok: true, files: data.files ?? [] };
    } catch (e) {
      return this.#fail(e, 'search');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ファイルのメタデータを取得。
   * @param {string} pathOrId
   * @param {string} [fields='id,name,mimeType,size,modifiedTime,parents']
   * @returns {Promise<{ ok:boolean, meta?:object, error?:string }>}
   */
  async getMeta(pathOrId, fields = 'id,name,mimeType,size,modifiedTime,parents') {
    try {
      const r = await this.#resolveId(pathOrId);
      if (!r.ok) return r;
      const res = await this.#apiFetch(
        `${DriveAPIManager.#DRIVE_EP}/files/${r.fileId}?fields=${encodeURIComponent(fields)}`
      );
      if (!res.ok) return this.#fail(await res.text(), 'getMeta');
      return { ok: true, meta: await res.json() };
    } catch (e) {
      return this.#fail(e, 'getMeta');
    }
  }

  /**
   * メタデータを更新（name, description, appProperties 等）。
   * @param {string} pathOrId
   * @param {object} meta
   * @returns {Promise<{ ok:boolean, data?:object, error?:string }>}
   */
  async updateMeta(pathOrId, meta) {
    try {
      const r = await this.#resolveId(pathOrId);
      if (!r.ok) return r;
      const res = await this.#apiFetch(
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
   * 1 ファイル / フォルダを削除。
   * @param {string} pathOrId
   * @returns {Promise<{ ok:boolean, error?:string }>}
   */
  async remove(pathOrId) {
    try {
      const r = await this.#resolveId(pathOrId);
      if (!r.ok) return r;
      const res = await this.#apiFetch(
        `${DriveAPIManager.#DRIVE_EP}/files/${r.fileId}`, { method: 'DELETE' }
      );
      // 204 No Content が成功
      if (!res.ok && res.status !== 204) return this.#fail(await res.text(), 'remove');
      this.#evict(r.fileId);
      this.progress('remove', pathOrId);
      return { ok: true };
    } catch (e) {
      return this.#fail(e, 'remove');
    }
  }

  /**
   * appDataFolder 内を全消去。⚠ 不可逆。
   * @returns {Promise<{ ok:boolean, deleted?:number, failed?:Array, error?:string }>}
   */
  async removeAll() {
    try {
      const all = await this.#listAll('appDataFolder', true);
      this.progress('removeAll', `deleting ${all.length} items`);

      const failed = [];
      await this.#batch(all.map(f => async () => {
        const res = await this.#apiFetch(
          `${DriveAPIManager.#DRIVE_EP}/files/${f.id}`, { method: 'DELETE' }
        );
        if (!res.ok && res.status !== 204) {
          failed.push({ id: f.id, name: f.name, error: await res.text() });
        } else {
          this.progress('removeAll', `deleted: ${f.name}`);
        }
      }), 10);

      this._idCache.clear();
      this.progress('removeAll', 'done');
      return { ok: true, deleted: all.length - failed.length, failed };
    } catch (e) {
      return this.#fail(e, 'removeAll');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE UTILS
  // ═══════════════════════════════════════════════════════════════════════════

  /** pathOrId を fileId に解決（どちらでも受け付ける） */
  async #resolveId(pathOrId) {
    // Drive ID は英数字+記号 20 文字以上でスラッシュなし
    if (/^[A-Za-z0-9_-]{20,}$/.test(pathOrId)) return { ok: true, fileId: pathOrId };
    const r = await this.getFileId(pathOrId);
    if (!r.ok) return r;
    if (!r.fileId) return { ok: false, error: 'not_found', place: '#resolveId' };
    return { ok: true, fileId: r.fileId };
  }

  #evict(id) {
    for (const [k, v] of this._idCache) if (v === id) this._idCache.delete(k);
  }

  async #batch(thunks, concurrency = 5) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, thunks.length) }, async () => {
      while (i < thunks.length) await thunks[i++]();
    }));
  }

  /** エラーを { ok:false, error, place } に正規化 */
  #fail(e, place = '') {
    const error = e instanceof Error ? e.message
      : typeof e === 'string'        ? e
      : JSON.stringify(e);
    return { ok: false, error, place };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// oauth2callback.html に置くスニペット
// <script>
//   const p = new URLSearchParams(location.search);
//   window.opener?.postMessage(
//     { type:'oauth_callback', code:p.get('code'), state:p.get('state'), error:p.get('error') },
//     location.origin
//   );
//   window.close();
// </script>
// ─────────────────────────────────────────────────────────────────────────────

export default DriveAPIManager;
