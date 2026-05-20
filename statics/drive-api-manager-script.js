/**
 * DriveAPIManager v3
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  mode: 'client' (デフォルト)                                         │
 * │    PKCE OAuth2 — サーバー不要、GitHub Pages 対応                      │
 * │    access_token  → #プライベートフィールド（メモリのみ）                │
 * │    refresh_token → AES-GCM 暗号化 → localStorage                    │
 * │    鍵導出        → PBKDF2 (salt = Google sub + origin)               │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  mode: 'server'                                                      │
 * │    Authorization Code Flow — CLIENT_SECRET はサーバー側で管理         │
 * │    access_token  → #プライベートフィールド（メモリのみ）                │
 * │    refresh_token → サーバーが保持（クライアントには渡さない）            │
 * │    サーバーエンドポイント: tokenUrl / refreshUrl / revokeUrl           │
 * └─────────────────────────────────────────────────────────────────────┘
 * Files : JSON / text / ArrayBuffer / Blob 全対応
 */
class DriveAPIManager {

  // ─── Private fields ────────────────────────────────────────────────────────
  #accessToken = null;   // メモリのみ（どちらのモードも共通）
  #expiresAt   = 0;      // ms epoch
  #sub         = null;   // Google ユーザー ID（client モードの PBKDF2 salt）
  #cryptoKey   = null;   // 導出済み CryptoKey キャッシュ（client モードのみ）

  // ─── Constants ─────────────────────────────────────────────────────────────
  static ver          = '3.0';
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
   * @param {object}   [opts]
   * @param {string}   opts.clientId
   * @param {string}   [opts.redirectUri]   default: location.origin + '/oauth2callback'
   * @param {string}   [opts.scope]
   * @param {Function} [opts.progress]      (phase: string, detail: string) => void
   *
   * @param {'client'|'server'} [opts.mode='client']
   *   'client' : PKCE フロー（サーバー不要）
   *   'server' : Authorization Code Flow（CLIENT_SECRET はサーバー管理）
   *              以下のサーバーエンドポイントが必要:
   *
   * @param {string}   [opts.tokenUrl]      POST code → {access_token, expires_in}
   *                                          body: { code, redirect_uri }
   * @param {string}   [opts.refreshUrl]    POST → {access_token, expires_in}
   *                                          body: {} (セッション Cookie 等でユーザー特定)
   * @param {string}   [opts.revokeUrl]     POST → 200
   *                                          body: {} (セッション Cookie 等でユーザー特定)
   *
   * ─── server モードのサーバー側実装例 (Express) ────────────────────────────
   *
   *   app.post('/auth/token', async (req, res) => {
   *     const { code, redirect_uri } = req.body;
   *     const r = await fetch('https://oauth2.googleapis.com/token', {
   *       method: 'POST',
   *       headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
   *       body: new URLSearchParams({
   *         client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
   *         grant_type: 'authorization_code', code, redirect_uri,
   *       }),
   *     });
   *     const data = await r.json();
   *     req.session.refresh_token = data.refresh_token; // サーバー側で保持
   *     res.json({ access_token: data.access_token, expires_in: data.expires_in });
   *   });
   *
   *   app.post('/auth/refresh', async (req, res) => {
   *     const rt = req.session.refresh_token;
   *     if (!rt) return res.status(401).json({ error: 'not_authenticated' });
   *     const r = await fetch('https://oauth2.googleapis.com/token', {
   *       method: 'POST',
   *       headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
   *       body: new URLSearchParams({
   *         client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
   *         grant_type: 'refresh_token', refresh_token: rt,
   *       }),
   *     });
   *     const data = await r.json();
   *     res.json({ access_token: data.access_token, expires_in: data.expires_in });
   *   });
   *
   *   app.post('/auth/revoke', async (req, res) => {
   *     const rt = req.session.refresh_token;
   *     if (rt) await fetch(`https://oauth2.googleapis.com/revoke?token=${rt}`, { method: 'POST' });
   *     req.session.destroy();
   *     res.json({ ok: true });
   *   });
   * ──────────────────────────────────────────────────────────────────────────
   */
  constructor(opts = {}) {
    this.CLIENT_ID     = opts.clientId     ?? 'API_ID';
    this.CLIENT_SECRET = opts.clientSecret ?? null;   // ウェブアプリタイプ用（省略可）
    this.REDIRECT_URI  = opts.redirectUri  ?? `${location.origin}/oauth2callback`;
    this.SCOPES        = opts.scope        ?? 'https://www.googleapis.com/auth/drive.appdata';
    this.progress      = opts.progress     ?? (() => {});

    // ─── モード設定 ────────────────────────────────────────────────────────
    this.MODE         = opts.mode        ?? 'client';   // 'client' | 'server'

    if (this.MODE === 'server') {
      // server モード必須オプション
      this._tokenUrl   = opts.tokenUrl   ?? '/auth/token';
      this._refreshUrl = opts.refreshUrl ?? '/auth/refresh';
      this._revokeUrl  = opts.revokeUrl  ?? '/auth/revoke';
    }

    this._idCache     = new Map();  // path → Drive file ID
    this._authPromise = null;       // 同時呼び出し dedup
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 公開 AUTH API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * メイン認証エントリ。
   *   silent=true  → ポップアップを出さない。取れなければ throw。
   *   silent=false → 必要なら PKCE ポップアップを開く。
   *
   * @param {boolean} [silent=true]
   * @returns {Promise<string>} 有効な access_token
   */
  async auth(silent = true) {
    if (this._authPromise) return this._authPromise;
    this._authPromise = this.#authFlow(silent).finally(() => {
      this._authPromise = null;
    });
    return this._authPromise;
  }

  /**
   * 現在の認証状態スナップショット（同期）。
   * @returns {{ loggedIn:boolean, expired:boolean, hasRefreshToken:boolean, mode:string }}
   */
  checker() {
    // server モードは refresh_token をサーバー側で持つので localStorage を見ない
    const hasRT = this.MODE === 'server' ? !!this.#accessToken : !!this.#loadEncRT();
    return {
      loggedIn:        !!this.#accessToken || hasRT,
      expired:         this.#isExpired(),
      hasRefreshToken: hasRT,
      mode:            this.MODE,
    };
  }

  /**
   * 認証ユーザーのメールアドレス。
   * @returns {Promise<string>}
   */
  async getEmail() {
    const res  = await this.#fetch(DriveAPIManager.#USERINFO_EP);
    const info = await res.json();
    return info.email;
  }

  /**
   * サインアウト。
   * client モード: サーバー側 revoke + localStorage 消去
   * server モード: サーバーエンドポイント経由で revoke
   */
  async signOut() {
    if (this.MODE === 'server') {
      await fetch(this._revokeUrl, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => {});
    } else {
      if (this.#accessToken) {
        await fetch(
          `${DriveAPIManager.#REVOKE_EP}?token=${this.#accessToken}`,
          { method: 'POST' }
        ).catch(() => {});
      }
    }
    this.#clearSession();
    this.progress('auth', 'signed_out');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 内部 AUTH フロー
  // ═══════════════════════════════════════════════════════════════════════════

  async #authFlow(silent) {
    this.progress('auth', 'start');

    // 1. メモリに有効なトークンがある（どちらのモードも共通）
    if (this.#accessToken && !this.#isExpired()) {
      this.progress('auth', 'memory_hit');
      return this.#accessToken;
    }

    // 2. リフレッシュ試行
    if (this.MODE === 'server') {
      // server モード: サーバーエンドポイントに投げる（RT はサーバー管理）
      try {
        this.progress('auth', 'refreshing');
        await this.#doServerRefresh();
        return this.#accessToken;
      } catch (e) {
        this.progress('auth', `refresh_failed: ${e.message}`);
        this.#clearSession();
        if (silent) throw this.#err(e, 'REFRESH_FAILED');
      }
    } else {
      // client モード: 暗号化 RT を localStorage から復号してリフレッシュ
      const encRT = this.#loadEncRT();
      if (encRT) {
        try {
          this.progress('auth', 'refreshing');
          const rt = await this.#decryptRT(encRT);
          await this.#doClientRefresh(rt);
          return this.#accessToken;
        } catch (e) {
          this.progress('auth', `refresh_failed: ${e.message}`);
          this.#clearSession();
          if (silent) throw this.#err(e, 'REFRESH_FAILED');
        }
      } else if (silent) {
        throw this.#err(null, 'NOT_AUTHENTICATED');
      }
    }

    if (silent) throw this.#err(null, 'NOT_AUTHENTICATED');

    // 3. インタラクティブポップアップ（どちらのモードも Google 認可画面は同じ）
    return this.MODE === 'server' ? this.#serverAuthFlow() : this.#pkceFlow();
  }

  // ─── server モード フロー ──────────────────────────────────────────────────

  async #serverAuthFlow() {
    this.progress('auth', 'server_auth_start');
    const state   = this.#hex(16);

    // server モードは code_challenge なし（サーバーが CLIENT_SECRET で交換する）
    const authUrl = DriveAPIManager.#AUTH_EP + '?' + new URLSearchParams({
      client_id:     this.CLIENT_ID,
      redirect_uri:  this.REDIRECT_URI,
      response_type: 'code',
      scope:         this.SCOPES,
      state,
      access_type:   'offline',
      prompt:        'consent',
    });

    const code = await this.#openPopup(authUrl, state);
    this.progress('auth', 'exchanging_code_via_server');
    await this.#doServerExchange(code);
    this.progress('auth', 'done');
    return this.#accessToken;
  }

  /** code → サーバーエンドポイント経由でトークン取得 */
  async #doServerExchange(code) {
    const res = await fetch(this._tokenUrl, {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ code, redirect_uri: this.REDIRECT_URI }),
    });
    if (!res.ok) throw this.#err(await res.json().catch(() => ({})), 'SERVER_TOKEN_FAILED');
    const data = await res.json();
    // サーバーは access_token と expires_in だけ返す（refresh_token はサーバー保持）
    this.#accessToken = data.access_token;
    this.#expiresAt   = Date.now() + (data.expires_in ?? 3600) * 1000;
  }

  /** サーバーエンドポイント経由で access_token をリフレッシュ */
  async #doServerRefresh() {
    const res = await fetch(this._refreshUrl, {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
    });
    // 401 = サーバー側にも RT がない → 再ログインが必要
    if (res.status === 401) throw this.#err(null, 'NOT_AUTHENTICATED');
    if (!res.ok) throw this.#err(await res.json().catch(() => ({})), 'SERVER_REFRESH_FAILED');
    const data = await res.json();
    this.#accessToken = data.access_token;
    this.#expiresAt   = Date.now() + (data.expires_in ?? 3600) * 1000;
  }

  // ─── PKCE ─────────────────────────────────────────────────────────────────

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
      prompt:                'consent',   // refresh_token を確実に受け取る
    });

    const code = await this.#openPopup(authUrl, state);
    this.progress('auth', 'exchanging_code');
    await this.#exchangeCode(code, verifier);
    this.progress('auth', 'done');
    return this.#accessToken;
  }

  /** ポップアップを開いて認可コードを待つ */
  #openPopup(url, state) {
    return new Promise((resolve, reject) => {
      const left = Math.round(screen.width  / 2 - DriveAPIManager.#POPUP_W / 2);
      const top  = Math.round(screen.height / 2 - DriveAPIManager.#POPUP_H / 2);
      const win  = window.open(url, 'g_oauth',
        `width=${DriveAPIManager.#POPUP_W},height=${DriveAPIManager.#POPUP_H},left=${left},top=${top}`);

      if (!win) { reject(this.#err(null, 'POPUP_BLOCKED')); return; }

      let done = false;
      const finish = (val, isErr = false) => {
        if (done) return; done = true;
        window.removeEventListener('message', onMsg);
        clearInterval(poll); clearTimeout(timer);
        try { win.close(); } catch (_) {}
        isErr ? reject(val) : resolve(val);
      };

      // A) postMessage（redirect ページが同一オリジンなら /oauth2callback に snippet を置く）
      const onMsg = ({ origin, data }) => {
        if (origin !== location.origin || data?.type !== 'oauth_callback') return;
        if (data.state !== state) { finish(this.#err(null, 'STATE_MISMATCH'), true); return; }
        if (data.error) { finish(this.#err(new Error(data.error), 'AUTH_DENIED'), true); return; }
        finish(data.code);
      };
      window.addEventListener('message', onMsg);

      // B) URL ポーリング（フォールバック）
      const poll = setInterval(() => {
        if (win.closed && !done) { finish(this.#err(null, 'POPUP_CLOSED'), true); return; }
        try {
          const pu = new URL(win.location.href);
          if (pu.origin !== location.origin) return;
          const e = pu.searchParams.get('error');
          if (e) { finish(this.#err(new Error(e), 'AUTH_DENIED'), true); return; }
          if (pu.searchParams.get('state') !== state) { finish(this.#err(null, 'STATE_MISMATCH'), true); return; }
          const c = pu.searchParams.get('code');
          if (c) finish(c);
        } catch (_) {}
      }, 300);

      const timer = setTimeout(() => finish(this.#err(null, 'AUTH_TIMEOUT'), true), 300_000);
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
    // ウェブアプリタイプの場合は client_secret が必要
    if (this.CLIENT_SECRET) params.client_secret = this.CLIENT_SECRET;

    const res = await fetch(DriveAPIManager.#TOKEN_EP, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams(params),
    });
    if (!res.ok) throw this.#err(await res.json(), 'TOKEN_EXCHANGE_FAILED');
    await this.#applyToken(await res.json());
  }

  async #doClientRefresh(rt) {
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
    if (!res.ok) throw this.#err(await res.json(), 'REFRESH_FAILED');
    const data = await res.json();
    // Google は refresh 時に refresh_token を省略することがある → 旧 RT を引き継ぐ
    await this.#applyToken({ ...data, refresh_token: data.refresh_token ?? rt });
  }

  /** トークンをメモリに保存し、refresh_token があれば暗号化して localStorage へ */
  async #applyToken(data) {
    this.#accessToken = data.access_token;
    this.#expiresAt   = Date.now() + (data.expires_in ?? 3600) * 1000;

    if (data.refresh_token) {
      if (!this.#sub) await this.#fetchSub();
      const enc = await this.#encryptRT(data.refresh_token);
      this.#saveEncRT(enc);
    }
  }

  /** userinfo から sub を取得（PBKDF2 salt に使用） */
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

  async #makeChallenge(verifier) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
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

  /**
   * PBKDF2 で AES-GCM 鍵を導出。
   *   passphrase = clientId + ':' + sub + ':' + origin
   *   salt       = sub + ':' + origin  （TextEncoder でバイト列化）
   *
   * sub が取れていない場合は '' で代用（ログイン前リフレッシュ試行時のみ）。
   * 鍵は #cryptoKey にキャッシュ。
   */
  async #getKey() {
    if (this.#cryptoKey) return this.#cryptoKey;

    const sub      = this.#sub ?? '';
    const saltStr  = `${sub}:${location.origin}`;
    const passStr  = `${this.CLIENT_ID}:${saltStr}`;

    const base = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(passStr), 'PBKDF2', false, ['deriveKey']
    );
    this.#cryptoKey = await crypto.subtle.deriveKey(
      {
        name:       'PBKDF2',
        salt:       new TextEncoder().encode(saltStr),
        iterations: 200_000,
        hash:       'SHA-256',
      },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return this.#cryptoKey;
  }

  /** refresh_token 文字列 → Base64(IV + ciphertext) */
  async #encryptRT(rt) {
    const key    = await this.#getKey();
    const iv     = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, new TextEncoder().encode(rt)
    );
    const buf = new Uint8Array(12 + cipher.byteLength);
    buf.set(iv, 0);
    buf.set(new Uint8Array(cipher), 12);
    return btoa(String.fromCharCode(...buf));
  }

  /** Base64(IV + ciphertext) → refresh_token 文字列 */
  async #decryptRT(b64) {
    const raw  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const iv   = raw.slice(0, 12);
    const body = raw.slice(12);
    const key  = await this.#getKey();
    let plain;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body);
    } catch {
      this.#clearSession();
      throw this.#err(null, 'DECRYPT_FAILED');
    }
    return new TextDecoder().decode(plain);
  }

  // ─── localStorage（暗号化済みデータのみ書く） ───────────────────────────────

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
  // 認証付き fetch ラッパー
  // ═══════════════════════════════════════════════════════════════════════════

  async #fetch(url, opts = {}, retried = false) {
    const token   = await this.auth(true);
    const headers = { Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) };
    const res     = await fetch(url, { ...opts, headers });

    // 401: トークン無効 → リフレッシュして 1 回だけリトライ
    if (res.status === 401 && !retried) {
      this.#accessToken = null;
      return this.#fetch(url, opts, true);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: res.statusText }));
      throw this.#err(body, `HTTP_${res.status}`);
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
   * @returns {Promise<string>}
   */
  async getPath(fileId) {
    const segs = [];
    let id = fileId;
    while (id && id !== 'appDataFolder') {
      const meta = await this.#fileMeta(id, 'id,name,parents');
      segs.unshift(meta.name);
      id = meta.parents?.[0] ?? null;
    }
    return '/' + segs.join('/');
  }

  /**
   * パス → Drive ファイル ID（キャッシュ付き、なければ API 探索）
   * @param {string} path
   * @returns {Promise<string|null>}
   */
  async getFileId(path) {
    if (this._idCache.has(path)) return this._idCache.get(path);
    const segs = this.#parsePath(path);
    let pid = 'appDataFolder';

    for (let i = 0; i < segs.length; i++) {
      const sub = '/' + segs.slice(0, i + 1).join('/');
      if (this._idCache.has(sub)) { pid = this._idCache.get(sub); continue; }
      const found = await this.#findChild(pid, segs[i]);
      if (!found) return null;
      this._idCache.set(sub, found.id);
      pid = found.id;
    }
    return pid === 'appDataFolder' ? null : pid;
  }

  async #findChild(parentId, name, mimes = []) {
    let q = `'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false`;
    if (mimes.length) q += ' and (' + mimes.map(m => `mimeType='${m}'`).join(' or ') + ')';
    const p = new URLSearchParams({
      spaces: 'appDataFolder', fields: 'files(id,name,mimeType)', q, pageSize: '1',
    });
    const res  = await this.#fetch(`${DriveAPIManager.#DRIVE_EP}/files?${p}`);
    const data = await res.json();
    return data.files?.[0] ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FOLDER
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * フォルダを冪等に作成（中間フォルダも含む）。
   * @param {string} path  e.g. '/saves/slot1'
   * @returns {Promise<string>} 末端フォルダの Drive ID
   */
  async createFolder(path) {
    const segs = this.#parsePath(path);
    let pid = 'appDataFolder';

    for (let i = 0; i < segs.length; i++) {
      const sub = '/' + segs.slice(0, i + 1).join('/');
      if (this._idCache.has(sub)) { pid = this._idCache.get(sub); continue; }

      const existing = await this.#findChild(pid, segs[i], ['application/vnd.google-apps.folder']);
      if (existing) { this._idCache.set(sub, existing.id); pid = existing.id; continue; }

      const res    = await this.#fetch(`${DriveAPIManager.#DRIVE_EP}/files`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: segs[i], mimeType: 'application/vnd.google-apps.folder', parents: [pid] }),
      });
      const folder = await res.json();
      this._idCache.set(sub, folder.id);
      pid = folder.id;
      this.progress('createFolder', sub);
    }
    return pid;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FILE CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ファイルをダウンロード。
   *
   * @param {string} pathOrId
   * @param {'auto'|'json'|'text'|'arraybuffer'|'blob'} [as='auto']
   *   'auto' → 拡張子で自動判定
   * @returns {Promise<object|string|ArrayBuffer|Blob>}
   */
  async getFile(pathOrId, as = 'auto') {
    const id  = await this.#resolveId(pathOrId);
    const res = await this.#fetch(`${DriveAPIManager.#DRIVE_EP}/files/${id}?alt=media`);
    const fmt = as === 'auto' ? this.#sniff(pathOrId) : as;
    switch (fmt) {
      case 'json':        return res.json();
      case 'text':        return res.text();
      case 'arraybuffer': return res.arrayBuffer();
      case 'blob':        return res.blob();
      default:            return res.json();
    }
  }

  /**
   * ファイルを作成 or 上書き保存。
   *
   * @param {string} path                              e.g. '/saves/slot1.json'
   * @param {object|string|ArrayBuffer|Uint8Array|Blob} data
   * @param {object} [opts]
   * @param {string} [opts.mimeType]                  省略時は data の型から自動判定
   * @param {object} [opts.meta]                      Drive メタデータ追加フィールド
   * @returns {Promise<{id:string, name:string, modifiedTime:string}>}
   */
  async saveFile(path, data, opts = {}) {
    const segs     = this.#parsePath(path);
    const name     = segs.at(-1);
    const dir      = segs.slice(0, -1).join('/');
    const pid      = dir ? await this.createFolder('/' + dir) : 'appDataFolder';
    const existing = await this.getFileId(path);

    const { body, mimeType } = this.#prepBody(data, opts.mimeType);
    const meta  = existing
      ? { name, ...opts.meta }
      : { name, parents: [pid], ...opts.meta };
    const ep    = existing
      ? `${DriveAPIManager.#UPLOAD_EP}/files/${existing}?uploadType=multipart&fields=id,name,modifiedTime`
      : `${DriveAPIManager.#UPLOAD_EP}/files?uploadType=multipart&fields=id,name,modifiedTime`;

    const res  = await this.#fetch(ep, { method: existing ? 'PATCH' : 'POST', ...this.#mp(meta, body, mimeType) });
    const file = await res.json();
    this._idCache.set(path, file.id);
    this.progress('saveFile', path);
    return file;
  }

  /**
   * ファイルをコピー。
   * @param {string} srcPathOrId
   * @param {string} destPath
   */
  async copyFile(srcPathOrId, destPath) {
    const segs  = this.#parsePath(destPath);
    const name  = segs.at(-1);
    const dir   = segs.slice(0, -1).join('/');
    const pid   = dir ? await this.createFolder('/' + dir) : 'appDataFolder';
    const srcId = await this.#resolveId(srcPathOrId);

    const res  = await this.#fetch(
      `${DriveAPIManager.#DRIVE_EP}/files/${srcId}/copy?fields=id,name,modifiedTime`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parents: [pid] }) }
    );
    const file = await res.json();
    this._idCache.set(destPath, file.id);
    return file;
  }

  /**
   * ファイルを移動 / リネーム。
   * @param {string} pathOrId
   * @param {string} newPath
   */
  async moveFile(pathOrId, newPath) {
    const id      = await this.#resolveId(pathOrId);
    const oldMeta = await this.#fileMeta(id, 'parents');
    const oldPid  = oldMeta.parents?.[0] ?? 'appDataFolder';
    const segs    = this.#parsePath(newPath);
    const newName = segs.at(-1);
    const newDir  = segs.slice(0, -1).join('/');
    const newPid  = newDir ? await this.createFolder('/' + newDir) : 'appDataFolder';

    const url = `${DriveAPIManager.#DRIVE_EP}/files/${id}?` + new URLSearchParams({
      addParents: newPid, removeParents: oldPid, fields: 'id,name,parents',
    });
    const res = await this.#fetch(url, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    this.#evict(id);
    this._idCache.set(newPath, id);
    return res.json();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LISTING & STRUCTURE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * フォルダ直下の一覧。'' or '/' で appDataFolder 直下。
   * @param {string} [pathOrId='']
   */
  async listFiles(pathOrId = '') {
    const pid = (!pathOrId || pathOrId === '/') ? 'appDataFolder' : await this.#resolveId(pathOrId);
    return this.#listAll(pid);
  }

  /**
   * appDataFolder 全体の再帰ツリー。
   *
   * DriveNode = {
   *   id, name,
   *   type: 'folder' | 'file',
   *   mimeType?, size?: number, modifiedTime?,
   *   children?: DriveNode[]   // folder のみ
   * }
   *
   * @returns {Promise<DriveNode>}
   */
  async getStructure() {
    const all  = await this.#listAll('appDataFolder', true);
    const map  = new Map();
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
    return map.get('appDataFolder');
  }

  async #listAll(parentId, recursive = false) {
    const results = [];
    let pageToken = null;
    const q = recursive
      ? 'trashed=false'
      : `'${parentId}' in parents and trashed=false`;

    do {
      const p = new URLSearchParams({
        spaces: 'appDataFolder',
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)',
        q, pageSize: '1000',
      });
      if (pageToken) p.set('pageToken', pageToken);
      const res  = await this.#fetch(`${DriveAPIManager.#DRIVE_EP}/files?${p}`);
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
   * ファイル名部分一致検索。
   * @param {string}  query
   * @param {object}  [opts]
   * @param {string}  [opts.mimeType]
   * @param {number}  [opts.limit=50]
   */
  async search(query, opts = {}) {
    let q = `trashed=false and name contains '${query.replace(/'/g, "\\'")}'`;
    if (opts.mimeType) q += ` and mimeType='${opts.mimeType}'`;
    const p = new URLSearchParams({
      spaces: 'appDataFolder',
      fields: 'files(id,name,mimeType,size,modifiedTime,parents)',
      q, pageSize: String(opts.limit ?? 50),
    });
    const res  = await this.#fetch(`${DriveAPIManager.#DRIVE_EP}/files?${p}`);
    const data = await res.json();
    return data.files ?? [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ファイルメタデータを取得。
   * @param {string} pathOrId
   * @param {string} [fields='id,name,mimeType,size,modifiedTime,parents']
   */
  async getMeta(pathOrId, fields = 'id,name,mimeType,size,modifiedTime,parents') {
    const id = await this.#resolveId(pathOrId);
    return this.#fileMeta(id, fields);
  }

  /**
   * 書き込み可能なメタデータを更新（name, description, appProperties 等）。
   */
  async updateMeta(pathOrId, meta) {
    const id  = await this.#resolveId(pathOrId);
    const res = await this.#fetch(
      `${DriveAPIManager.#DRIVE_EP}/files/${id}?fields=id,name,modifiedTime`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) }
    );
    return res.json();
  }

  async #fileMeta(id, fields) {
    const res = await this.#fetch(
      `${DriveAPIManager.#DRIVE_EP}/files/${id}?fields=${encodeURIComponent(fields)}`
    );
    return res.json();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 1 ファイル / フォルダを削除。
   * @param {string} pathOrId
   */
  async remove(pathOrId) {
    const id = await this.#resolveId(pathOrId);
    await this.#fetch(`${DriveAPIManager.#DRIVE_EP}/files/${id}`, { method: 'DELETE' });
    this.#evict(id);
    this.progress('remove', pathOrId);
  }

  /**
   * appDataFolder 内を全消去。⚠ 不可逆。
   */
  async removeAll() {
    const all = await this.#listAll('appDataFolder', true);
    this.progress('removeAll', `deleting ${all.length} items`);
    await this.#batch(
      all.map(f => () => this.#fetch(`${DriveAPIManager.#DRIVE_EP}/files/${f.id}`, { method: 'DELETE' })),
      10
    );
    this._idCache.clear();
    this.progress('removeAll', 'done');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE UTILS
  // ═══════════════════════════════════════════════════════════════════════════

  async #resolveId(pathOrId) {
    if (/^[A-Za-z0-9_-]{20,}$/.test(pathOrId)) return pathOrId;
    const id = await this.getFileId(pathOrId);
    if (!id) throw this.#err(null, 'FILE_NOT_FOUND', pathOrId);
    return id;
  }

  #evict(id) {
    for (const [k, v] of this._idCache) if (v === id) this._idCache.delete(k);
  }

  /** multipart/related ボディ（バイナリセーフ）を返す */
  #mp(meta, body, mimeType) {
    const boundary = `dapi_${this.#hex(8)}`;
    const enc      = new TextEncoder();
    const pre  = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
      + `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const post = enc.encode(`\r\n--${boundary}--`);
    const bb   = body instanceof ArrayBuffer ? body
      : body instanceof Uint8Array           ? body.buffer
      : enc.encode(typeof body === 'string'  ? body : JSON.stringify(body)).buffer;

    const out = new Uint8Array(pre.byteLength + bb.byteLength + post.byteLength);
    out.set(pre, 0);
    out.set(new Uint8Array(bb), pre.byteLength);
    out.set(post, pre.byteLength + bb.byteLength);
    return {
      headers: { 'Content-Type': `multipart/related; boundary="${boundary}"` },
      body:    out.buffer,
    };
  }

  #prepBody(data, mimeOverride) {
    if (data instanceof ArrayBuffer || data instanceof Uint8Array)
      return { body: data, mimeType: mimeOverride ?? 'application/octet-stream' };
    if (data instanceof Blob)
      return { body: data, mimeType: mimeOverride ?? (data.type || 'application/octet-stream') };
    if (typeof data === 'string')
      return { body: data, mimeType: mimeOverride ?? 'text/plain; charset=UTF-8' };
    return { body: JSON.stringify(data), mimeType: mimeOverride ?? 'application/json' };
  }

  #sniff(pathOrId) {
    const ext = (pathOrId.split('.').at(-1) ?? '').toLowerCase();
    if (ext === 'json')                                                return 'json';
    if (['txt','md','csv','tsv','html','xml'].includes(ext))          return 'text';
    if (['png','jpg','jpeg','gif','webp','pdf','zip','bin'].includes(ext)) return 'arraybuffer';
    return 'json';
  }

  async #batch(thunks, concurrency = 5) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, thunks.length) }, async () => {
      while (i < thunks.length) await thunks[i++]();
    }));
  }

  #err(raw, code, detail = '') {
    const msg = raw?.error?.message ?? raw?.error_description ?? raw?.message ?? code;
    const e   = new Error(`[DriveAPIManager] ${code}: ${msg}${detail ? ` (${detail})` : ''}`);
    e.code = code; e.detail = detail; e.raw = raw;
    return e;
  }
}

// ─── /oauth2callback に置くスニペット ────────────────────────────────────────
//
//   <script>
//     const p = new URLSearchParams(location.search);
//     window.opener?.postMessage({
//       type:  'oauth_callback',
//       code:  p.get('code'),
//       state: p.get('state'),
//       error: p.get('error'),
//     }, location.origin);
//     window.close();
//   </script>
//
// ─────────────────────────────────────────────────────────────────────────────

export default DriveAPIManager;
