/*
 userがファイルを指定してもらうメソッド openPicker を追加。
*/
class DriveAPIManager {
  static ver = "6.1";
  
  constructor({ clientId, redirectUri, progress, space = 'appdata' }) {
    if (!clientId || !redirectUri)
      throw new Error('引数にclient_idとredirect_uriを含めてください。');
    
    if (space !== 'appdata' && space !== 'drive' && space !== 'file')
      throw new Error("spaceは'appdata'、'drive'、または'file'を指定してください。");
    
    this.progress = progress || (() => {});
    this.clientId = clientId;
    this.redirectUri = redirectUri;
    
    // 'appdata' : 専用の隠しフォルダ(appDataFolder)のみを操作する
    // 'drive'   : マイドライブ全体(root以下)をフルアクセスで操作する
    // 'file'    : このアプリが作成/開いたファイルのみをマイドライブ等(root以下)で操作する
    this.space = space;
    this.rootId = space === 'appdata' ? 'appDataFolder' : 'root';
    this.spacesParam = space === 'appdata' ? 'appDataFolder' : 'drive';
    this.authScope = space === 'drive'
      ? 'https://www.googleapis.com/auth/drive'
      : space === 'file'
        ? 'https://www.googleapis.com/auth/drive.file'
        : 'https://www.googleapis.com/auth/drive.appdata';
    
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

  // userにファイルを選んでもらう(Google Picker API)
  async openPicker({ mimeType = null, title = '選択してください' } = {}) {
    // 1. ログイン状態とトークンのチェック
    if (!this.state.loggedIn || !this.state.token) {
      throw new Error('Pickerを開く前に auth() でログインを完了してください。');
    }

    this.progress('openPicker', 'loading_scripts');

    // 2. Google API (gapi) のクライアントスクリプトを動的ロード
    await new Promise((resolve, reject) => {
      if (window.gapi) return resolve();
      const script = document.createElement('script');
      script.src = 'https://apis.google.com/js/api.js';
      script.onload = () => resolve();
      script.onerror = (e) => reject(new Error('Google API スクリプトの読み込みに失敗しました。'));
      document.head.appendChild(script);
    });

    // 3. picker ライブラリをロード
    await new Promise((resolve) => {
      window.gapi.load('picker', { callback: resolve });
    });

    this.progress('openPicker', 'showing_ui');

    // 4. ピッカーを構築して表示
    return new Promise((resolve) => {
      // 表示するビューの制限（デフォルトはマイドライブ）
      const viewId = mimeType === 'application/vnd.google-apps.folder' 
        ? window.google.picker.ViewId.FOLDERS 
        : window.google.picker.ViewId.DOCS;
        
      const view = new window.google.picker.View(viewId);
      if (mimeType) {
        view.setMimeTypes(mimeType); // 💡特定のMIMEタイプ（フォルダなど）のみに絞り込む
      }

      const picker = new window.google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(this.state.token) // 💡クラス内にある現在のアクセストークンを流用
        .setTitle(title)
        .setCallback((data) => {
          // ユーザーがアクションを起こした時のコールバック
          if (data.action === window.google.picker.Action.PICKED) {
            const doc = data.docs[0];
            
            // 💡 取得したIDを内部キャッシュに自動登録しておく（あとで getPath や saveFile で使えるように）
            this._idCache[doc.name] = doc.id; 
            
            this.progress('openPicker', 'picked');
            resolve({
              id: doc.id,
              name: doc.name,
              mimeType: doc.mimeType
            });
          } else if (data.action === window.google.picker.Action.CANCEL) {
            this.progress('openPicker', 'canceled');
            resolve(null); // キャンセル時は null を返す
          }
        })
        .build();

      picker.setVisible(true);
    });
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
    
    const baseUrl = options.origin ? `https://www.googleapis.com/${path}` : `https://www.googleapis.com/drive/v3/${path}`;
    const urlObj = new URL(baseUrl);
    
    if (options.params) {
      Object.keys(options.params).forEach(key => {
        if (options.params[key] !== undefined && options.params[key] !== null) {
          urlObj.searchParams.append(key, options.params[key]);
        }
      });
    }
    const url = urlObj.toString();
    
    this.progress(`request:${upperMethod}`, `${url}:start`);

    const fetchOptions = {
      method: upperMethod,
      headers: {
        'Authorization': `Bearer ${this.state.token}`,
        ...options.headers
      }
    };

    if (options.body) {
      if (typeof options.body === 'object' && !(options.body instanceof FormData) && !(options.body instanceof Blob)) {
        fetchOptions.headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(options.body);
      } else {
        fetchOptions.body = options.body;
      }
    }
    
    try {
      const res = await fetch(url, fetchOptions);

      if (res.status === 401) {
        this.signOut();
        throw new Error('認証エラー(401): セッションが破棄されました。');
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(`Drive API Error [${res.status}]: ${errData.error?.message || res.statusText}`);
      }

      const contentType = res.headers.get('content-type') || '';
      
      let data;
      if (res.status === 204) {
        data = { ok: true };
      } else if (contentType.includes('application/json')) {
        data = await res.text();
        if (data !== '') data = JSON.parse(data);
        
      } else {
        data = await res.text();
      }
      
      this.progress(`request:${upperMethod}`, `${url}:done`);
      return data;
    } catch (e) {
      this.progress(`request:${upperMethod}`, `${url}:fail`);
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
      scope: this.authScope,
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
     
  async createFolder({path, fileId}) {
    const resolved = await this.integration({path, fileId});
    let currentPath = resolved.path;

    const parts = currentPath.split('/').filter(Boolean);
    if (parts.length === 0) return this.rootId;
    if (this._idCache[currentPath]) return this._idCache[currentPath];
    
    this.progress('createFolder', 'start');
    
    let lastId = this.rootId;
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
  
  async createFile({parentPath, parentId, name, mimeType, description=''}) {
    const resolved = await this.integration({path: parentPath, fileId: parentId});
    const _parentId = resolved.fileId;
    const _parentPath = resolved.path;

    if ((_parentPath !== "" && !_parentPath) || !name || !mimeType) return null;
    
    const meta = {
      name,
      mimeType,
      parents: [_parentId],
      description
    };
    
    return await this.request('POST', 'files', { body: meta });
  }
  
  async getFileId({path}) {
    const cleanPath = this.filterPath({path});
    const parts = cleanPath.split('/').filter(Boolean);
    if (parts.length === 0) return this.rootId;
    if (this._idCache[cleanPath]) return this._idCache[cleanPath];

    let parentId = this.rootId;

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
        params: { q, spaces: this.spacesParam, fields: 'files(id)' }
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
    if (!fileId || fileId === this.rootId) return '';
    const names = [];
    let currentId = fileId;
    
    try {
      do {
        const res = await this.request('GET', `files/${currentId}`, {
          params: { fields: 'name, parents' }
        });
        
        if (!res) break;
        names.unshift(res.name);
        
        if (res.parents && res.parents.length > 0) {
          currentId = res.parents[0];
        } else {
          currentId = null;
        }
      } while(currentId && currentId !== this.rootId);
      
      return names.join('/');
    } catch (e) {
      console.error('[getPath] エラー:', e);
      return '';
    }
  }
  
  async integration({path, fileId}) {
    const cleanPath = path !== undefined && path !== null ? this.filterPath({path}) : null;
    
    let _path = cleanPath;
    let id = fileId;
    if (_path === null && id) {
      _path = await this.getPath({fileId: id});
    } else if (_path !== null && !id) {
      id = await this.getFileId({path: _path});
    }
    
    return { path: _path, fileId: id };
  }
  
  async getParentId({path, id}) {
    if (path !== undefined && path !== null) {
      const cleanPath = this.filterPath({path});
      if (cleanPath === "") return null;
      const _path = cleanPath.split('/').slice(0, -1).join('/');
      const parentId = await this.getFileId({path: _path});
      return parentId ? [parentId] : [];
    }
    const resolved = await this.integration({path, fileId: id});
    const targetPath = resolved.path;
    const targetId = resolved.fileId;

    const res = await this.request('GET', `files/${targetId}`, {
      params: { fields: 'parents' }
    });
    
    if (targetPath && targetId) {
      this._idCache[targetPath] = targetId;
    }
    
    return res.parents ?? [];
  }
  
  async getFileInfo({path, fileId, fields='id, name, mimeType'}) {
    const resolved = await this.integration({path, fileId});
    const targetId = resolved.fileId;
    
    return await this.request('GET', `files/${targetId}`, {
      params: { fields }
    });
  }
  
  async listFiles({path, fileId}) {
    const resolved = await this.integration({path, fileId});
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
        spaces: this.spacesParam,
        fields: fields,
        pageSize: 100 // パフォーマンス向上のため一括取得件数を引き上げ
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
    const resolved = await this.integration({path, fileId});
    const targetPath = resolved.path;
    const targetId = resolved.fileId;
    
    if (!targetId || targetId === this.rootId) {
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
     
  async saveFile({path, fileId, data, mimeType="application/json"}) {
    const cleanPath = this.filterPath({path});
    if (!cleanPath) return { ok: false };
    
    const {fileId: _fileId} = await this.integration({path, fileId});
    let _mimeType = mimeType;
    
    let bodyData = data;
    if (typeof data === "object" && !(data instanceof Blob) && !(data instanceof ArrayBuffer)) {
      bodyData = JSON.stringify(data);
      _mimeType = "application/json";
    }
    
    this.progress('saveFile', 'start');
    
    if (_fileId && _fileId !== this.rootId) {
      const res = await this.request('PATCH',
        `upload/drive/v3/files/${_fileId}`,
        {
          origin: true,
          params: { uploadType: 'media' },
          headers: { 'Content-Type': _mimeType },
          body: bodyData
        }
      );
      
      this.progress('saveFile', 'update:done');
      return res;
    } else {
      const list = cleanPath.split('/');
      const name = list.pop();
      let parentId = (await this.getParentId({path: cleanPath}))?.[0] ?? null;
      if(!parentId)
        parentId = await this.createFolder({path: list.join('/')});
      
      const created = await this.createFile({
        parentId,
        name,
        mimeType: _mimeType
      });
      
      const res = await this.request(
        'PATCH',
        `upload/drive/v3/files/${created.id}`,
        {
          origin: true,
          params: { uploadType: 'media' },
          headers: { 'Content-Type': _mimeType },
          body: bodyData
        }
      );
      
      console.log('file size:', bodyData.length ?? bodyData.size ?? 0);
      
      this.progress('saveFile', 'create:done');
      return res;
    }
  }
  
  async getFile({path, fileId}) {
    const _fileId = fileId ?? await this.getFileId({path});
    if (!_fileId) {
      console.log('ファイルが見つかりません');
      return null;
    }
    this.progress('getInfo', await this.getFileInfo({fileId: _fileId}));
    const res = await this.request('GET', `files/${_fileId}`, {
      params: {alt: 'media'}
    });
    return res;
  }
  
  async #miniGetStructure({parentPath, parentId}) {
    if (!parentId) return null;
    const q = `'${parentId}' in parents and trashed = false`;
    const fields = 'nextPageToken, files(id, name, mimeType, size)';
    let structure = {};
    let pageToken = null;
    
    do {
      const params = {
        q,
        spaces: this.spacesParam,
        fields: fields,
        pageSize: 100
      };
      
      if (pageToken) params.pageToken = pageToken;
      
      const res = await this.request('GET', 'files', { params });
      
      if (res.files && res.files.length > 0) {
        for (let file of res.files) {
          const childPath = parentPath ? `${parentPath}/${file.name}` : file.name;
          this._idCache[childPath] = file.id;
          
          if (file.mimeType === 'application/vnd.google-apps.folder') {
            structure[file.name] = await this.#miniGetStructure({parentPath: childPath, parentId: file.id});
          } else {
            structure[file.name] = {
              end: true,
              mimeType: file.mimeType,
              fileId: file.id,
              size: file.size
            };
          }
        }
      }
      
      pageToken = res.nextPageToken;
    } while (pageToken);
    
    return structure;
  }
  
  async getStructure() {
    const parentPath = '';
    const parentId = this.rootId;
    
    return structuredClone(await this.#miniGetStructure({parentPath, parentId}));
  }
  
  async search({path, id, name}) {
    if (path === undefined && id === undefined && name === undefined) return;
    // 必要に応じて拡張可能
  }
}

export default DriveAPIManager;
