/**
 * DriveAPIManager
 * Google Drive appdata scope manager
 * Auth: PKCE OAuth2 (client-only, no secret)
 * Storage: localStorage token persistence
 * Files: JSON / text / binary (ArrayBuffer / Blob)
 */
class DriveAPIManager {
  // ─── Constants ────────────────────────────────────────────────────────────
  static #TOKEN_KEY   = 'drive_api_token';
  static #AUTH_EP     = 'https://accounts.google.com/o/oauth2/v2/auth';
  static #TOKEN_EP    = 'https://oauth2.googleapis.com/token';
  static #REVOKE_EP   = 'https://oauth2.googleapis.com/revoke';
  static #DRIVE_EP    = 'https://www.googleapis.com/drive/v3';
  static #UPLOAD_EP   = 'https://www.googleapis.com/upload/drive/v3';
  static #USERINFO_EP = 'https://www.googleapis.com/oauth2/v3/userinfo';
  static #POPUP_W     = 520;
  static #POPUP_H     = 620;

  // ─── Constructor ──────────────────────────────────────────────────────────
  /**
   * @param {object}   [opts]
   * @param {string}   opts.clientId      - OAuth2 Client ID
   * @param {string}   [opts.redirectUri] - defaults to current origin
   * @param {string}   [opts.scope]       - OAuth2 scope
   * @param {Function} [opts.progress]    - progress callback (phase, detail)
   */
  constructor(opts = {}) {
    this.CLIENT_ID   = opts.clientId   ?? 'API_ID';
    this.REDIRECT_URI = opts.redirectUri ?? `${location.origin}/oauth2callback`;
    this.SCOPES      = opts.scope ?? 'https://www.googleapis.com/auth/drive.appdata';
    this.progress    = opts.progress ?? (() => {});

    // in-memory token cache (mirrors localStorage)
    this._token = null;

    // path → id cache to reduce API round-trips
    this._idCache = new Map();

    // single in-flight auth promise (prevents double popups)
    this._authPromise = null;

    this._loadTokenFromStorage();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTH
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Main auth entry-point.
   * silent=true  → try refresh / storage first, never show popup
   * silent=false → force interactive popup if needed
   *
   * @param {boolean} [silent=true]
   * @returns {Promise<string>} valid access token
   */
  async auth(silent = true) {
    // Deduplicate concurrent calls
    if (this._authPromise) return this._authPromise;

    this._authPromise = this._authInternal(silent).finally(() => {
      this._authPromise = null;
    });
    return this._authPromise;
  }

  async _authInternal(silent) {
    this.progress('auth', 'start');

    // 1. Valid cached token?
    if (this._token && !this._isTokenExpired()) {
      this.progress('auth', 'token_cached');
      return this._token.access_token;
    }

    // 2. Refresh token available?
    if (this._token?.refresh_token) {
      try {
        this.progress('auth', 'refreshing');
        await this._refreshToken();
        return this._token.access_token;
      } catch (e) {
        this.progress('auth', 'refresh_failed');
        this._clearToken();
        if (silent) throw this.#normalizeError(e, 'REFRESH_FAILED');
      }
    }

    if (silent) throw this.#normalizeError(null, 'NOT_AUTHENTICATED');

    // 3. Interactive PKCE popup
    return this._pkceFlow();
  }

  /** Full PKCE OAuth2 popup flow */
  async _pkceFlow() {
    this.progress('auth', 'pkce_start');

    const verifier  = this._pkceVerifier();
    const challenge = await this._pkceChallenge(verifier);
    const state     = this._randomHex(16);

    const url = this._buildAuthUrl(challenge, state);
    const code = await this._openPopupAndWaitForCode(url, state);

    this.progress('auth', 'exchanging_code');
    await this._exchangeCode(code, verifier);

    this.progress('auth', 'done');
    return this._token.access_token;
  }

  /** Build Google authorization URL */
  _buildAuthUrl(challenge, state) {
    const p = new URLSearchParams({
      client_id:             this.CLIENT_ID,
      redirect_uri:          this.REDIRECT_URI,
      // サーバーを使う場合、response_typeは'code'に！！
      response_type:         'token',
      scope:                 this.SCOPES,
      /*code_challenge:        challenge,
      code_challenge_method: 'S256',*/
      state,
      access_type:           'offline',
      prompt:                'consent',
    });
    return `${DriveAPIManager.#AUTH_EP}?${p}`;
  }

  /**
   * Open popup and wait for redirect with authorization code.
   * Handles: same-origin postMessage OR polling location.
   */
  _openPopupAndWaitForCode(url, state) {
    return new Promise((resolve, reject) => {
      const left = Math.round(screen.width  / 2 - DriveAPIManager.#POPUP_W / 2);
      const top  = Math.round(screen.height / 2 - DriveAPIManager.#POPUP_H / 2);
      const popup = window.open(
        url,
        'google_oauth',
        `width=${DriveAPIManager.#POPUP_W},height=${DriveAPIManager.#POPUP_H},left=${left},top=${top}`
      );

      if (!popup) {
        reject(this.#normalizeError(null, 'POPUP_BLOCKED'));
        return;
      }

      let done = false;
      const finish = (codeOrErr, isErr = false) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMessage);
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        try { popup.close(); } catch (_) {}
        isErr ? reject(codeOrErr) : resolve(codeOrErr);
      };

      // --- Method A: postMessage from redirect page ---
      // Your /oauth2callback page should call:
      //   window.opener.postMessage({ type:'oauth_callback', code, state }, origin)
      const onMessage = (ev) => {
        if (ev.origin !== location.origin) return;
        const d = ev.data;
        if (!d || d.type !== 'oauth_callback') return;
        if (d.state !== state) {
          finish(this.#normalizeError(null, 'STATE_MISMATCH'), true);
          return;
        }
        if (d.error) {
          finish(this.#normalizeError(new Error(d.error), 'AUTH_DENIED'), true);
          return;
        }
        finish(d.code);
      };
      window.addEventListener('message', onMessage);

      // --- Method B: poll popup URL (same-origin only) ---
      const pollTimer = setInterval(() => {
        if (popup.closed && !done) {
          finish(this.#normalizeError(null, 'POPUP_CLOSED'), true);
          return;
        }
        try {
          const pu = new URL(popup.location.href);
          if (pu.origin !== location.origin) return; // cross-origin, wait
          const err = pu.searchParams.get('error');
          if (err) { finish(this.#normalizeError(new Error(err), 'AUTH_DENIED'), true); return; }
          const s = pu.searchParams.get('state');
          if (s && s !== state) { finish(this.#normalizeError(null, 'STATE_MISMATCH'), true); return; }
          const c = pu.searchParams.get('code');
          if (c) finish(c);
        } catch (_) { /* cross-origin read, ignore */ }
      }, 300);

      // Timeout (5 minutes)
      const timeoutTimer = setTimeout(() => {
        finish(this.#normalizeError(null, 'AUTH_TIMEOUT'), true);
      }, 5 * 60 * 1000);
    });
  }

  /** Exchange authorization code for tokens */
  async _exchangeCode(code, verifier) {
    const res = await fetch(DriveAPIManager.#TOKEN_EP, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     this.CLIENT_ID,
        redirect_uri:  this.REDIRECT_URI,
        grant_type:    'authorization_code',
        code,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) throw this.#normalizeError(await res.json(), 'TOKEN_EXCHANGE_FAILED');
    this._saveToken(await res.json());
  }

  /** Refresh access token using stored refresh token */
  async _refreshToken() {
    const res = await fetch(DriveAPIManager.#TOKEN_EP, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     this.CLIENT_ID,
        grant_type:    'refresh_token',
        refresh_token: this._token.refresh_token,
      }),
    });
    if (!res.ok) throw this.#normalizeError(await res.json(), 'REFRESH_FAILED');
    const fresh = await res.json();
    // Google does not always return a new refresh_token; keep the old one
    this._saveToken({ ...fresh, refresh_token: this._token.refresh_token });
  }

  // ─── PKCE helpers ─────────────────────────────────────────────────────────

  _pkceVerifier() {
    const arr = new Uint8Array(64);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode(...arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async _pkceChallenge(verifier) {
    const data   = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  _randomHex(bytes) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ─── Token storage ────────────────────────────────────────────────────────

  _saveToken(tokenData) {
    tokenData.expires_at = Date.now() + (tokenData.expires_in ?? 3600) * 1000;
    this._token = tokenData;
    try {
      localStorage.setItem(DriveAPIManager.#TOKEN_KEY, JSON.stringify(tokenData));
    } catch (_) {}
  }

  _loadTokenFromStorage() {
    try {
      const raw = localStorage.getItem(DriveAPIManager.#TOKEN_KEY);
      if (raw) this._token = JSON.parse(raw);
    } catch (_) {
      this._token = null;
    }
  }

  _clearToken() {
    this._token = null;
    this._idCache.clear();
    try { localStorage.removeItem(DriveAPIManager.#TOKEN_KEY); } catch (_) {}
  }

  _isTokenExpired(marginMs = 60_000) {
    return !this._token?.expires_at || Date.now() > this._token.expires_at - marginMs;
  }

  // ─── Authed fetch wrapper ─────────────────────────────────────────────────

  /**
   * Fetch with automatic token injection + 401 retry-once logic.
   * @param {string|URL} url
   * @param {RequestInit} [opts]
   * @param {boolean} [retried]
   */
  async _fetch(url, opts = {}, retried = false) {
    const token = await this.auth(true);
    const headers = { Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) };

    const res = await fetch(url, { ...opts, headers });
    if (res.status === 401 && !retried) {
      // Token may have been revoked; force refresh then retry once
      this._clearToken();
      return this._fetch(url, opts, true);
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ message: res.statusText }));
      throw this.#normalizeError(errBody, `HTTP_${res.status}`);
    }
    return res;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS & IDENTITY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check current authentication state.
   * @returns {{ loggedIn: boolean, expired: boolean, hasRefresh: boolean }}
   */
  checker() {
    return {
      loggedIn:   !!this._token,
      expired:    this._isTokenExpired(),
      hasRefresh: !!this._token?.refresh_token,
    };
  }

  /**
   * Get the email address of the authenticated user.
   * @returns {Promise<string>}
   */
  async getEmail() {
    const res  = await this._fetch(DriveAPIManager.#USERINFO_EP);
    const info = await res.json();
    return info.email;
  }

  /**
   * Sign out: revoke token server-side and clear local state.
   */
  async signOut() {
    if (this._token?.access_token) {
      await fetch(`${DriveAPIManager.#REVOKE_EP}?token=${this._token.access_token}`, {
        method: 'POST',
      }).catch(() => {});
    }
    this._clearToken();
    this.progress('auth', 'signed_out');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PATH RESOLUTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Normalize a path string to ['seg1','seg2',...] segments.
   * Accepts both '/foo/bar' and 'foo/bar' forms.
   */
  #parsePath(path) {
    return path.split('/').filter(Boolean);
  }

  /**
   * Resolve a file/folder ID to its full path string.
   * @param {string} fileId
   * @returns {Promise<string>} e.g. '/documents/notes.json'
   */
  async getPath(fileId) {
    const segments = [];
    let id = fileId;

    while (id && id !== 'appDataFolder') {
      const res  = await this._fetch(
        `${DriveAPIManager.#DRIVE_EP}/files/${id}?fields=id,name,parents`
      );
      const meta = await res.json();
      segments.unshift(meta.name);
      id = meta.parents?.[0] ?? null;
    }
    return '/' + segments.join('/');
  }

  /**
   * Resolve a virtual path to a Drive file ID.
   * Uses an in-memory cache; traverses folder hierarchy on cache miss.
   * @param {string} path - e.g. '/documents/notes.json'
   * @returns {Promise<string|null>} file ID or null if not found
   */
  async getFileId(path) {
    if (this._idCache.has(path)) return this._idCache.get(path);

    const segments = this.#parsePath(path);
    let parentId   = 'appDataFolder';

    for (let i = 0; i < segments.length; i++) {
      const name    = segments[i];
      const isLast  = i === segments.length - 1;
      const mimes   = isLast
        ? []
        : ["application/vnd.google-apps.folder"];

      const found = await this._findChild(parentId, name, mimes);
      if (!found) return null;

      const subPath = '/' + segments.slice(0, i + 1).join('/');
      this._idCache.set(subPath, found.id);
      parentId = found.id;
    }

    return parentId === 'appDataFolder' ? null : parentId;
  }

  /** Find a direct child of parentId by name (optionally filter by mimeType) */
  async _findChild(parentId, name, mimes = []) {
    let q = `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
    if (mimes.length) {
      q += ' and (' + mimes.map(m => `mimeType = '${m}'`).join(' or ') + ')';
    }
    const url = `${DriveAPIManager.#DRIVE_EP}/files?` + new URLSearchParams({
      spaces: 'appDataFolder',
      fields: 'files(id,name,mimeType)',
      q,
      pageSize: 1,
    });
    const res   = await this._fetch(url);
    const data  = await res.json();
    return data.files?.[0] ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FOLDER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a folder (and all intermediate folders) at the given path.
   * Idempotent: skips creation if folder already exists.
   * @param {string} path - e.g. '/documents/work'
   * @returns {Promise<string>} folder ID of the deepest folder
   */
  async createFolder(path) {
    const segments = this.#parsePath(path);
    let parentId   = 'appDataFolder';

    for (let i = 0; i < segments.length; i++) {
      const name    = segments[i];
      const subPath = '/' + segments.slice(0, i + 1).join('/');

      if (this._idCache.has(subPath)) {
        parentId = this._idCache.get(subPath);
        continue;
      }

      // Check if folder already exists
      const existing = await this._findChild(parentId, name, [
        'application/vnd.google-apps.folder'
      ]);

      if (existing) {
        this._idCache.set(subPath, existing.id);
        parentId = existing.id;
        continue;
      }

      // Create it
      const res = await this._fetch(
        `${DriveAPIManager.#DRIVE_EP}/files`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            mimeType: 'application/vnd.google-apps.folder',
            parents:  [parentId],
          }),
        }
      );
      const folder = await res.json();
      this._idCache.set(subPath, folder.id);
      parentId = folder.id;
      this.progress('createFolder', subPath);
    }

    return parentId;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FILE OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Download a file by path or ID.
   *
   * Return type is determined by `as`:
   *  'json'        → parsed JSON object (default for .json files)
   *  'text'        → string
   *  'arraybuffer' → ArrayBuffer
   *  'blob'        → Blob
   *  'auto'        → sniff from filename extension (default)
   *
   * @param {string} pathOrId
   * @param {'auto'|'json'|'text'|'arraybuffer'|'blob'} [as='auto']
   * @returns {Promise<any>}
   */
  async getFile(pathOrId, as = 'auto') {
    const id  = await this._resolveId(pathOrId);
    const res = await this._fetch(
      `${DriveAPIManager.#DRIVE_EP}/files/${id}?alt=media`
    );

    const format = as === 'auto' ? this._sniffFormat(pathOrId) : as;
    switch (format) {
      case 'json':        return res.json();
      case 'text':        return res.text();
      case 'arraybuffer': return res.arrayBuffer();
      case 'blob':        return res.blob();
      default:            return res.json();
    }
  }

  /**
   * Create or update a file at a virtual path.
   *
   * @param {string} path            - e.g. '/saves/slot1.json'
   * @param {any}    data            - object, string, ArrayBuffer, or Blob
   * @param {object} [opts]
   * @param {string} [opts.mimeType] - overrides auto-detect
   * @param {object} [opts.meta]     - extra Drive file metadata fields
   * @returns {Promise<{id:string, name:string, modifiedTime:string}>}
   */
  async saveFile(path, data, opts = {}) {
    const segments  = this.#parsePath(path);
    const name      = segments.at(-1);
    const folderSeg = segments.slice(0, -1).join('/');
    const parentId  = folderSeg
      ? await this.createFolder('/' + folderSeg)
      : 'appDataFolder';

    const { body, mimeType } = this._prepareBody(data, opts.mimeType);
    const existingId = await this.getFileId(path);

    let res;
    if (existingId) {
      // PATCH (update content only, keep metadata)
      res = await this._fetch(
        `${DriveAPIManager.#UPLOAD_EP}/files/${existingId}?uploadType=multipart&fields=id,name,modifiedTime`,
        { method: 'PATCH', ...this._multipart({ name, ...opts.meta }, body, mimeType) }
      );
    } else {
      // POST (create)
      res = await this._fetch(
        `${DriveAPIManager.#UPLOAD_EP}/files?uploadType=multipart&fields=id,name,modifiedTime`,
        { method: 'POST', ...this._multipart({ name, parents: [parentId], ...opts.meta }, body, mimeType) }
      );
      const file = await res.json();
      this._idCache.set(path, file.id);
      this.progress('saveFile', path);
      return file;
    }

    const file = await res.json();
    this._idCache.set(path, file.id);
    this.progress('saveFile', path);
    return file;
  }

  /** Build multipart/related request for Drive upload */
  _multipart(meta, body, mimeType) {
    const boundary = `driveapi_${this._randomHex(8)}`;
    const metaStr  = JSON.stringify(meta);

    // Combine as ArrayBuffer for binary safety
    const enc  = new TextEncoder();
    const pre  = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaStr}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const post = enc.encode(`\r\n--${boundary}--`);

    // body might be ArrayBuffer or Uint8Array or string-encoded
    const bodyBuf = body instanceof ArrayBuffer ? body
      : body instanceof Uint8Array              ? body.buffer
      : enc.encode(body).buffer;

    const combined = new Uint8Array(pre.byteLength + bodyBuf.byteLength + post.byteLength);
    combined.set(pre,                              0);
    combined.set(new Uint8Array(bodyBuf),          pre.byteLength);
    combined.set(post,                             pre.byteLength + bodyBuf.byteLength);

    return {
      headers: { 'Content-Type': `multipart/related; boundary="${boundary}"` },
      body: combined.buffer,
    };
  }

  /** Serialize data and detect MIME type */
  _prepareBody(data, mimeTypeOverride) {
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      return { body: data, mimeType: mimeTypeOverride ?? 'application/octet-stream' };
    }
    if (data instanceof Blob) {
      return {
        body: data,
        mimeType: mimeTypeOverride ?? (data.type || 'application/octet-stream'),
      };
    }
    if (typeof data === 'string') {
      return { body: data, mimeType: mimeTypeOverride ?? 'text/plain; charset=UTF-8' };
    }
    // Object → JSON
    return { body: JSON.stringify(data), mimeType: mimeTypeOverride ?? 'application/json' };
  }

  /** Sniff response format from file extension */
  _sniffFormat(pathOrId) {
    const ext = pathOrId.split('.').at(-1)?.toLowerCase();
    if (['json'].includes(ext)) return 'json';
    if (['txt','md','csv','tsv','html','xml'].includes(ext)) return 'text';
    if (['png','jpg','jpeg','gif','webp','pdf','zip','bin'].includes(ext)) return 'arraybuffer';
    return 'json'; // default
  }

  /**
   * Copy / duplicate a file to a new path.
   * @param {string} srcPathOrId
   * @param {string} destPath
   */
  async copyFile(srcPathOrId, destPath) {
    const segments = this.#parsePath(destPath);
    const name     = segments.at(-1);
    const folder   = segments.slice(0, -1).join('/');
    const parentId = folder ? await this.createFolder('/' + folder) : 'appDataFolder';
    const srcId    = await this._resolveId(srcPathOrId);

    const res  = await this._fetch(
      `${DriveAPIManager.#DRIVE_EP}/files/${srcId}/copy?fields=id,name,modifiedTime`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parents: [parentId] }) }
    );
    const file = await res.json();
    this._idCache.set(destPath, file.id);
    return file;
  }

  /**
   * Rename / move a file or folder.
   * @param {string} pathOrId
   * @param {string} newPath
   */
  async moveFile(pathOrId, newPath) {
    const id          = await this._resolveId(pathOrId);
    const oldMeta     = await this._fileMeta(id, 'parents');
    const oldParentId = oldMeta.parents?.[0] ?? 'appDataFolder';

    const segments    = this.#parsePath(newPath);
    const newName     = segments.at(-1);
    const newFolder   = segments.slice(0, -1).join('/');
    const newParentId = newFolder ? await this.createFolder('/' + newFolder) : 'appDataFolder';

    const url = `${DriveAPIManager.#DRIVE_EP}/files/${id}?`
      + new URLSearchParams({
          addParents:    newParentId,
          removeParents: oldParentId,
          fields:        'id,name,parents',
        });

    const res  = await this._fetch(url, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: newName }),
    });
    // Invalidate old cache entry
    this._invalidateCacheForId(id);
    this._idCache.set(newPath, id);
    return res.json();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LISTING & STRUCTURE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * List direct children of a folder (by path or ID).
   * @param {string} [pathOrId=''] - '' or '/' for root appDataFolder
   * @returns {Promise<Array<{id,name,mimeType,size,modifiedTime}>>}
   */
  async listFiles(pathOrId = '') {
    const parentId = (!pathOrId || pathOrId === '/')
      ? 'appDataFolder'
      : await this._resolveId(pathOrId);

    const items = await this._listAll(parentId);
    return items;
  }

  /**
   * Return full recursive tree of all files in appDataFolder.
   * @returns {Promise<DriveNode>}
   *   DriveNode = { id, name, type:'folder'|'file', children?:DriveNode[], size?, modifiedTime? }
   */
  async getStructure() {
    // Fetch ALL files in one paginated pass (more efficient than recursive calls)
    const allFiles = await this._listAll('appDataFolder', true);

    // Build id→node map
    const nodeMap = new Map();
    nodeMap.set('appDataFolder', { id: 'appDataFolder', name: '/', type: 'folder', children: [] });

    for (const f of allFiles) {
      nodeMap.set(f.id, {
        id:           f.id,
        name:         f.name,
        type:         f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
        mimeType:     f.mimeType,
        size:         f.size ? Number(f.size) : undefined,
        modifiedTime: f.modifiedTime,
        children:     f.mimeType === 'application/vnd.google-apps.folder' ? [] : undefined,
      });
    }

    // Wire up parent→child
    for (const f of allFiles) {
      const parent = nodeMap.get(f.parents?.[0]);
      if (parent?.children) {
        parent.children.push(nodeMap.get(f.id));
      }
    }

    return nodeMap.get('appDataFolder');
  }

  /** Paginated list of all items under parentId */
  async _listAll(parentId, recursive = false) {
    const results  = [];
    let pageToken  = null;
    const q = recursive
      ? `trashed = false`
      : `'${parentId}' in parents and trashed = false`;

    do {
      const params = new URLSearchParams({
        spaces:   'appDataFolder',
        fields:   'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)',
        q,
        pageSize: '1000',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const res  = await this._fetch(`${DriveAPIManager.#DRIVE_EP}/files?${params}`);
      const data = await res.json();
      results.push(...(data.files ?? []));
      pageToken = data.nextPageToken ?? null;
    } while (pageToken);

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Trash a single file or folder (by path or ID).
   * @param {string} pathOrId
   */
  async remove(pathOrId) {
    const id = await this._resolveId(pathOrId);
    await this._fetch(
      `${DriveAPIManager.#DRIVE_EP}/files/${id}`,
      { method: 'DELETE' }
    );
    this._invalidateCacheForId(id);
    this.progress('remove', pathOrId);
  }

  /**
   * Permanently delete all files in appDataFolder.
   * ⚠ Irreversible.
   */
  async removeAll() {
    const all = await this._listAll('appDataFolder', true);
    this.progress('removeAll', `deleting ${all.length} files`);

    // Batch delete in parallel (cap at 10 concurrent)
    await this._batchRun(all.map(f => () => this._deleteById(f.id)), 10);
    this._idCache.clear();
    this.progress('removeAll', 'done');
  }

  async _deleteById(id) {
    await this._fetch(`${DriveAPIManager.#DRIVE_EP}/files/${id}`, { method: 'DELETE' });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEARCH
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Full-text / name search across appDataFolder.
   * @param {string} query       - name fragment or Drive query string
   * @param {object} [opts]
   * @param {string} [opts.mimeType]  - filter by MIME type
   * @param {number} [opts.limit=50]
   * @returns {Promise<Array>}
   */
  async search(query, opts = {}) {
    let q = `trashed = false and name contains '${query.replace(/'/g, "\\'")}'`;
    if (opts.mimeType) q += ` and mimeType = '${opts.mimeType}'`;

    const params = new URLSearchParams({
      spaces:   'appDataFolder',
      fields:   'files(id,name,mimeType,size,modifiedTime,parents)',
      q,
      pageSize: String(opts.limit ?? 50),
    });
    const res  = await this._fetch(`${DriveAPIManager.#DRIVE_EP}/files?${params}`);
    const data = await res.json();
    return data.files ?? [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get metadata for a file or folder.
   * @param {string} pathOrId
   * @param {string} [fields='id,name,mimeType,size,modifiedTime,parents']
   */
  async getMeta(pathOrId, fields = 'id,name,mimeType,size,modifiedTime,parents') {
    const id  = await this._resolveId(pathOrId);
    return this._fileMeta(id, fields);
  }

  /** Update writable metadata fields (name, description, appProperties, etc.) */
  async updateMeta(pathOrId, meta) {
    const id  = await this._resolveId(pathOrId);
    const res = await this._fetch(
      `${DriveAPIManager.#DRIVE_EP}/files/${id}?fields=id,name,modifiedTime`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) }
    );
    return res.json();
  }

  async _fileMeta(id, fields) {
    const res = await this._fetch(
      `${DriveAPIManager.#DRIVE_EP}/files/${id}?fields=${encodeURIComponent(fields)}`
    );
    return res.json();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve a path string or file ID to a Drive file ID.
   * IDs are 33-char base64url strings; everything else is treated as a path.
   */
  async _resolveId(pathOrId) {
    if (this._looksLikeId(pathOrId)) return pathOrId;
    const id = await this.getFileId(pathOrId);
    if (!id) throw this.#normalizeError(null, 'FILE_NOT_FOUND', pathOrId);
    return id;
  }

  _looksLikeId(str) {
    // Drive IDs are typically 28–44 alphanumeric/dash/underscore chars with no slashes
    return /^[A-Za-z0-9_-]{20,}$/.test(str);
  }

  /** Invalidate all cache entries that map to a given ID */
  _invalidateCacheForId(id) {
    for (const [k, v] of this._idCache) {
      if (v === id) this._idCache.delete(k);
    }
  }

  /**
   * Run an array of async thunks with at most `concurrency` in-flight at once.
   */
  async _batchRun(thunks, concurrency = 5) {
    const results = [];
    let i = 0;
    const workers = Array.from({ length: Math.min(concurrency, thunks.length) }, async () => {
      while (i < thunks.length) {
        const idx = i++;
        results[idx] = await thunks[idx]();
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * Normalize any error to a structured object.
   * @param {any}    raw    - original error or response body
   * @param {string} code   - internal error code
   * @param {string} [detail]
   * @returns {Error}
   */
  #normalizeError(raw, code, detail = '') {
    const message = raw?.error?.message
      ?? raw?.error_description
      ?? raw?.message
      ?? code;

    const err      = new Error(`[DriveAPIManager] ${code}: ${message}${detail ? ` (${detail})` : ''}`);
    err.code       = code;
    err.detail     = detail;
    err.raw        = raw;
    return err;
  }
}

// ─── OAuth callback helper (put in /oauth2callback) ───────────────────────
// If your redirect page is the SAME origin, add this snippet to that page:
//
//   const p = new URLSearchParams(location.search);
//   window.opener?.postMessage({
//     type:  'oauth_callback',
//     code:  p.get('code'),
//     state: p.get('state'),
//     error: p.get('error'),
//   }, location.origin);
//   window.close();
//
// ─────────────────────────────────────────────────────────────────────────────

export default DriveAPIManager;
