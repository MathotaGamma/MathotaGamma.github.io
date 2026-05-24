class DriveAPIManager {
  static ver = "4.0";
  
  constructor({ clientId, redirectUri, progress }) {
    if (!clientId || !redirectUri)
      throw new Error('引数にclient_idとredirect_uriを含めてください。');
    
    this.progress = progress || (() => {});
    this.clientId = clientId;
    this.redirectUri = redirectUri;
    
    const cachedToken = localStorage.getItem('dapi_access_token');
    const cachedExpires = parseInt(localStorage.getItem('dapi_expires_at') || '0', 10);
    const isAlive = cachedToken && cachedExpires > Date.now();

    this.state = {
      loggedIn: isAlive ? true : false,
      token: isAlive ? cachedToken : null,
      expiresAt: cachedExpires,
      email: null
    };
    
    this._authPromise = null;
    this._idCache = {};
  }
  
  checker() {
    return {
      ok: this.state.loggedIn && !!this.state.token && this.state.expiresAt > Date.now(),
      loggedIn: this.state.loggedIn && !!this.state.token,
      expired: !this.state.loggedIn || this.state.expiresAt <= Date.now(),
      token: this.state.token
    };
  }
  
  getCache(key=null) {
    const cache = {
      id: this._idCache
    };
    if (key) return cache[key];
    return cache;
  }

  /* ==================================================
     共通
     ================================================== */
  
  async request(method = 'GET', path = '', options = {}) {
    if (!this.state.loggedIn || !this.state.token) {
      throw new Error('ログインしていません。先に auth() を実行してください。');
    }
    if (this.state.expiresAt && Date.now() > this.state.expiresAt) {
      this.signOut();
      throw new Error('アクセストークンの有効期限が切れています。再ログインが必要です。');
    }

    const upperMethod = method.toUpperCase();
    this.progress(`request:${upperMethod}`, `${path}:start`);

    // URLの組み立て
    const baseUrl = `https://www.googleapis.com/drive/v3/${path}`;
    const urlObj = new URL(baseUrl);
    
    if (options.params) {
      Object.keys(options.params).forEach(key => {
        if (options.params[key] !== undefined && options.params[key] !== null) {
          urlObj.searchParams.append(key, options.params[key]);
        }
      });
    }
    const url = urlObj.toString();

    // 💡 拡張性を殺さないシンプルなヘッダー結合
    // 各メソッド側から渡された options.headers が最優先で適用されます
    const fetchOptions = {
      method: upperMethod,
      headers: {
        'Authorization': `Bearer ${this.state.token}`,
        ...options.headers
      }
    };

    // 💡 危ない自動変換ロジックを排除
    // 呼び出し側（各メソッド）が用意した body をそのまま fetch に渡す
    if (options.body !== undefined) {
      fetchOptions.body = options.body;
    }
    
    try {
      this.progress('request', url + '\n' + JSON.stringify(fetchOptions));
      const res = await fetch(url, fetchOptions);

      if (res.status === 401) {
        this.signOut();
        throw new Error('認証エラー(401): セッションが破棄されました。');
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(`Drive API Error [${res.status}]: ${errData.error?.message || res.statusText}`);
      }

      if (res.status === 204) {
        return { ok: true };
      }

      // 💡 レスポンス処理の最適化
      // alt=media（ファイルの中身取得）の場合は、ContentTypeに関わらず確実に text として返す
      if (options.params && options.params.alt === 'media') {
        return await res.text();
      }

      // それ以外（メタデータの取得など）は、Content-Type を見て JSON パースを判断する
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const text = await res.text();
        return text !== '' ? JSON.parse(text) : {};
      }
      
      return await res.text();
    } catch (e) {
      this.progress(`request:${upperMethod}`, `${path}:fail`);
      throw e;
    }
  }
  
  /* ==================================================
     auth
     ================================================== */
  
  auth(silent=false, prompt=null) {
    if (this._authPromise) return this._authPromise;

    if (silent) {
      if (this.state.loggedIn && this.state.token && this.state.expiresAt > Date.now()) {
        this.progress('auth', 'silent:done');
        return Promise.resolve({ ok: true, token: this.state.token, silent: true });
      } else {
        this.progress('auth', 'silent:fail');
        this.signOut(); 
        return Promise.resolve({ ok: false, error: 'silent_auth_failed' });
      }
    }

    if (this.state.loggedIn && this.state.token && this.state.expiresAt > Date.now()) {
      this.progress('auth', 'silent:done');
      return Promise.resolve({ ok: true, token: this.state.token, silent: true });
    }

    this.progress('auth', 'start');
    
    const oauth2Endpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
    localStorage.removeItem('oauth_result');

    const params = {
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'token',
      scope: 'https://www.googleapis.com/auth/drive.appdata',
      state: 'debug_implicit_test'
    };
    
    if (prompt) params.prompt = prompt;

    const queryStrings = new URLSearchParams(params).toString();
    const targetUrl = `${oauth2Endpoint}?${queryStrings}`;

    const popupName = `oauth_popup_${Date.now()}`;
    window.open(targetUrl, popupName, 'width=500,height=600,left=100,top=100,menubar=no,toolbar=no,location=no,status=no');

    this._authPromise = new Promise((resolve, reject) => {
      const pollTimer = setInterval(() => {
        const rawResult = localStorage.getItem('oauth_result');
      
        if (rawResult) {
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

            if (data.token) {
              const expiresAt = Date.now() + (3600 * 1000) - (5 * 60 * 1000);
              
              this.state.loggedIn = true;
              this.state.token = data.token;
              this.state.expiresAt = expiresAt;
              
              localStorage.setItem('dapi_access_token', data.token);
              localStorage.setItem('dapi_expires_at', expiresAt.toString());

              this.progress('auth', 'done');
              this._authPromise = null;
              
              resolve({ ok: true, token: data.token, silent: false });
            }
          } catch (e) {
            this.progress('auth', 'fail');
            this._authPromise = null;
            reject(e);
          }
        }
      }, 200);
    });

    return this._authPromise;
  }

  signOut() {
    this.state.loggedIn = false;
    this.state.token = null;
    this.state.expiresAt = 0;
    this.state.email = null;
    this._idCache = {};
    localStorage.removeItem('dapi_access_token');
    localStorage.removeItem('dapi_expires_at');
    this.progress('signOut', 'done');
  }

  /* ==================================================
     Google Drive自体
     ================================================== */

  async getAbout(fields) {
    return this.request('GET', 'about', {
      params: { fields }
    });
  }

  async getEmail() {
    if (this.state.email) return this.state.email;
    const data = await this.getAbout('user(emailAddress)');
    this.state.email = data.user.emailAddress;
    return this.state.email;
  }
  
  /* ==================================================
     Folder&Path
     ================================================== */
     
  // integration, createFile, _idCacheに依存
  async createFolder({path, fileId}) {
    const resolved = await this.integration(path, fileId);
    let currentPath = resolved.path;
    let currentId = resolved.fileId;

    const parts = currentPath.split('/').filter(Boolean);
    if (parts.length === 0) return 'appDataFolder';
    if (this._idCache[currentPath]) return this._idCache[currentPath];
    
    this.progress('createFolder', 'start');
    
    let lastId = 'appDataFolder';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const parent = parts.slice(0, i).join('/');
      const fullSubPath = parent ? `${parent}/${part}` : part;
      
      let targetId = this._idCache[fullSubPath];
      if (!targetId) {
        targetId = await this.getFileId({path: fullSubPath});
      }
      
      if (!targetId) {
        this.progress('createFolder', 'new Folder Creating');
        const created = await this.createFile({parentPath: parent, name: part, mimeType: 'application/vnd.google-apps.folder'});
        targetId = created.id;
      }
      
      lastId = targetId;
      this._idCache[fullSubPath] = lastId;
    }
    
    return lastId;
  }
  
  // integration, requestに依存
  async createFile({parentPath, parentId, name, mimeType, description=''}) {
    const resolved = await this.integration(parentPath, parentId);
    const _parentId = resolved.fileId;
    const _parentPath = resolved.path;

    if ((_parentPath !== "" && !_parentPath) || !name || !mimeType) return null;
    
    const meta = {
      name,
      mimeType,
      parents: [_parentId],
      description
    };
    
    return this.request('POST', 'files', { body: JSON.stringify(meta) });
  }
  
  // filterPath, _idCache, requestに依存
  async getFileId({path}) {
    const cleanPath = this.filterPath({path});
    const parts = cleanPath.split('/').filter(Boolean);
    if (parts.length === 0) return 'appDataFolder';
    if (this._idCache[cleanPath]) return this._idCache[cleanPath];

    let parentId = 'appDataFolder';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const _path = parts.slice(0, i + 1).join('/');
      const id = this._idCache[_path];
      if (id) {
        parentId = id;
        continue;
      }
      
      const isLast = i === parts.length - 1;
      let q = `'${parentId}' in parents and name = '${part}' and trashed = false`;
      if (!isLast) {
        q += ` and mimeType = 'application/vnd.google-apps.folder'`;
      }

      const res = await this.request('GET', 'files', {
        params: { q, spaces: 'appDataFolder', fields: 'files(id)' }
      });

      if (!res.files || res.files.length === 0) {
        return null; 
      }
      parentId = res.files[0].id;
      this._idCache[_path] = parentId;
    }
    
    return parentId;
  }
  
  filterPath({path}) {
    if (path === undefined || path === null) return '';
    return path.split('/').filter(Boolean).join('/');
  }
  
  async getPath({fileId}) {
    if (!fileId || fileId === 'appDataFolder') return '';
    const names = [];
    let currentId = fileId;
    
    try {
      do {
        // API仕様に合わせて name と parents を明示的に要求
        const res = await this.request('GET', `files/${currentId}`, {
          params: { fields: 'name, parents' }
        });
        
        if (!res) break;
        names.unshift(res.name);
        
        // 親がいるかチェック。いなければ（ルートに到達したら）終了
        if (res.parents && res.parents.length > 0) {
          currentId = res.parents[0];
        } else {
          currentId = null;
        }
      } while(currentId && currentId !== 'appDataFolder');
      
      return names.join('/');
    } catch (e) {
      console.error('[getPath] エラー:', e);
      return '';
    }
  }
  
  async integration(path, fileId) {
    const cleanPath = path !== undefined && path !== null ? this.filterPath({path}) : null;
    
    let _path = cleanPath;
    let id = fileId;
    console.log(_path, id);
    if (_path === null && id) {
      _path = await this.getPath({fileId: id});
    } else if (_path !== null && !id) {
      id = await this.getFileId({path: _path});
    }
    
    return { path: _path, fileId: id };
  }
  
  async getParentId({path, id}) {
    // pathで渡された時
    if (path !== undefined && path !== null) {
      const cleanPath = this.filterPath({path});
      if (cleanPath === "") return null;
      if (cleanPath.length === 0) return 'appDataFolder';
      const _path = cleanPath.split('/').slice(0,-1).join('/');
      return this.getFileId({path: path});
    }
    const resolved = await this.integration(path, id);
    const targetPath = resolved.path;
    const targetId = resolved.fileId;

    const res = await this.request('GET', `files/${targetId}`, {
      params: { fields: 'parents' }
    });
    
    if (targetPath && targetId) {
      this._idCache[targetPath] = targetId;
    }
    
    return res.parents;
  }
  
  async getFileInfo({path, fileId, fields='id, name, mimeType, size'}) {
    const resolved = await this.integration(path, fileId);
    const targetId = resolved.fileId;
    
    return this.request('GET', `files/${targetId}`, {
      params: { fields }
    });
  }
  
  async listFiles({path, fileId}) {
    const resolved = await this.integration(path, fileId);
    const parentId = resolved.fileId;
    const parentPath = resolved.path;

    if (!parentId) return null;
    const q = `'${parentId}' in parents and trashed = false`;
    const fields = 'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime)';
    let children = [];
    let pageToken = null;
    
    this.progress('listFiles', 'start');
    
    do {
      const params = {
        q,
        spaces: 'appDataFolder',
        fields: fields,
        pageSize: 100
      };
      
      if (pageToken) params.pageToken = pageToken;
      
      const res = await this.request('GET', 'files', { params });
      
      if (res.files && res.files.length > 0) {
        for (let file of res.files) {
          const childPath = parentPath ? `${parentPath}/${file.name}` : file.name;
          this._idCache[childPath] = file.id;
        }
        children = children.concat(res.files);
      }
      
      pageToken = res.nextPageToken;
      if (pageToken) this.progress('listFiles', 'fetching_next_page');
    } while (pageToken);
    
    this.progress('listFiles', `done: total ${children.length} items`);
    return children;
  }
  
  async removeFile({path, fileId}) {
    const resolved = await this.integration(path, fileId);
    const targetPath = resolved.path;
    const targetId = resolved.fileId;
    
    if (!targetId || targetId === 'appDataFolder') {
      console.warn(`[removeFile] パスまたはIDが見つかりません: ${path || fileId}`);
      return null; 
    }

    const file = await this.request('PATCH', `files/${targetId}`, {
      body: { trashed: true }
    });
    
    if (file && targetPath) {
      const cacheKeys = Object.keys(this._idCache);
      for (const key of cacheKeys) {
        if (key === targetPath || key.startsWith(`${targetPath}/`)) {
          delete this._idCache[key];
        }
      }
    }
    
    return file;
  }
  
  async removeAllFiles() {
    const list = await this.listFiles({path: ''});
    if (!list || list.length === 0) return [];
    
    // 💡 修正: 逐次 await してログを出しつつ安全に一元管理して削除する
    const results = [];
    for (let file of list) {
      const res = await this.removeFile({fileId: file.id});
      console.log('Deleted:', file.name, res);
      results.push(res);
    }
    return results;
  }
  
  /* ==================================================
     CRUD
     ================================================== */
  
  /*async saveFile({path, fileId, data, mimeType="application/json"}) {
    const cleanPath = this.filterPath({path});
    if (!cleanPath) return { ok: false };
    
    const {path: _path, fileId: _fileId} = await this.integration(path, fileId);
    let _mimeType = mimeType;
    
    let bodyData = data;
    if (typeof data === "object" && !(data instanceof Blob) && !(data instanceof ArrayBuffer)) {
      bodyData = JSON.stringify(data);
      _mimeType = "application/json";
    }
    
    this.progress('saveFile', 'start');
    
    // 1. 既にファイルが存在する場合（既存ファイルのPATCH上書き）
    if (_fileId && _fileId !== 'appDataFolder') {
      const res = await this.request('PATCH', `files/${_fileId}`, {
        headers: { 'Content-Type': _mimeType },
        body: bodyData
      });
      this.progress('saveFile', 'update:done');
      return res;
      return res;
    } else {
      // 2. ファイルが存在しない場合（新規作成）
      const list = cleanPath.split('/');
      const name = list.pop();
      
      let parentId = await this.getParentId({cleanPath});
      if(!parentId || parentId.length === 0) {
        parentId = await this.createFolder({path: list.join('/')});
      }
      
      // 💡 修正：まずは空のファイル枠（メタデータのみ）を『await』して作成する
      const createdFile = await this.createFile({parentId, name, mimeType: _mimeType});
      
      if (!createdFile || !createdFile.id) {
        throw new Error('ファイルの新規枠作成に失敗しました。');
      }

      // 💡 修正：作成したファイルIDに対して、即座に中身（bodyData）を流し込んで上書き（PATCH）する
      // これにより、textareaの生改行やインデント付き文字列が100%安全にファイル内に書き込まれます
      const res = await this.request('PATCH', `files/${createdFile.id}`, {
        headers: { 'Content-Type': _mimeType },
        body: bodyData
      });
      
      // キャッシュに作成したファイルのIDを登録しておく
      this._idCache[cleanPath] = createdFile.id;

      this.progress('saveFile', 'create:done');
      return res;
    }
  }*/
  
  async getFile({path, fileId}) {
    const _fileId = fileId ?? await this.getFileId({path});
    if (!_fileId) {
      console.log('ファイルが見つかりません');
      return null;
    }
    
    //console.log('oi', JSON.stringify(await this.getFileInfo({fileId: _fileId})));
    const res = this.request('GET', `files/${_fileId}`, {
      params: {alt: 'media'}
    });
    return res;
  }
}

export default DriveAPIManager;
