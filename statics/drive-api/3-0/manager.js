class DriveAPIManager {
  static ver = "3.0";
  
  constructor({ clientId, redirectUri, progress }) {
    if (!clientId || !redirectUri)
      throw new Error('引数にclient_idとredirect_uriを含めてください。');
    
    // progressが渡されていたらクラスのメソッドとして登録、なければ空の関数にしておく
    this.progress = progress || (() => {});
    
    this.clientId = clientId;
    this.redirectUri = redirectUri;
    
    // 💡 起動時に前回のトークンが localStorage に残っていれば自動で復元
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
    /* _idCache
      例: {'app/test': id, 'app/test/index/_data.json': id}
    */
    this._idCache = {};
  }
  
  checker() {
    return {
      ok: this.state.loggedIn && !!this.state.token && this.state.expiresAt > Date.now(),
      loggedIn: this.state.loggedIn && !!this.state.token,
      expired: !this.state.loggedIn || this.state.expiresAt <= Date.now(),
      token: this.state.token
    }
  }
  
  getCache(key=null) {
    const cache = {
      id: this._idCache
    }
    if (key) return cache[key];
    return cache;
  }

  /* ==================================================
     共通
     ================================================== */
  
  async request(method = 'GET', path = '', options = {}) {
    // 💡 認証状態とトークンの生存チェック
    if (!this.state.loggedIn || !this.state.token) {
      throw new Error('ログインしていません。先に auth() を実行してください。');
    }
    if (this.state.expiresAt && Date.now() > this.state.expiresAt) {
      this.signOut();
      throw new Error('アクセストークンの有効期限が切れています。再ログインが必要です。');
    }

    const upperMethod = method.toUpperCase();
    this.progress(`request:${upperMethod}`, `${path}:start`);

    // 💡 クエリパラメータの処理
    let url = `https://www.googleapis.com/drive/v3/${path}`;
    if (options.params) {
      const q = new URLSearchParams(options.params).toString();
      if (q) url += `?${q}`;
    }

    // 💡 Fetch オプションの組み立て
    const fetchOptions = {
      method: upperMethod,
      headers: {
        'Authorization': `Bearer ${this.state.token}`,
        'Accept': 'application/json',
        ...options.headers // 外部からのカスタムヘッダーを結合
      }
    };

    // BODYの処理（オブジェクトなら自動でJSON文字列化、FormDataなどはそのまま通す）
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

      // トークン無効（401 Unauthorized）の場合はステートをクリア
      if (res.status === 401) {
        this.signOut();
        throw new Error('認証エラー(401): セッションが破棄されました。');
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(`Drive API Error [${res.status}]: ${errData.error?.message || res.statusText}`);
      }

      // DELETEなどレスポンスボディが空のパターンを考慮
      const data = res.status === 204 ? { ok: true } : await res.json();
      
      this.progress(`request:${upperMethod}`, `${path}:done`);
      return data;
    } catch (e) {
      this.progress(`request:${upperMethod}`, `${path}:fail`);
      throw e;
    }
  }

  /* ==================================================
     auth
     ================================================== */
  
  /**
   * 認証を実行する
   * @param {Object} options
   * @param {boolean} options.silent - trueの場合、ポップアップを開かずストレージの有効期限から復元を試みる
   */
  auth(silent=false, prompt=null) {
    // すでに認証処理（Promise）が走っている場合はそれをそのまま返す（多重起動防止）
    if (this._authPromise) return this._authPromise;

    // 💡 【silent: true の場合】
    if (silent) {
      if (this.state.loggedIn && this.state.token && this.state.expiresAt > Date.now()) {
        this.progress('auth', 'silent:done');
        return Promise.resolve({ ok: true, token: this.state.token, silent: true });
      } else {
        // 期限切れ、またはトークンがない場合は即座に失敗として返す
        this.progress('auth', 'silent:fail');
        this.signOut(); // ステートとストレージを安全にクリア
        return Promise.resolve({ ok: false, error: 'silent_auth_failed' });
      }
    }

    if (this.state.loggedIn && this.state.token && this.state.expiresAt > Date.now()) {
      this.progress('auth', 'silent:done');
      return Promise.resolve({ ok: true, token: this.state.token, silent: true });
    }

    // ─── 【silent: false の場合】ここから通常のポップアップログイン ───
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

    // Promise を生成して保持する
    this._authPromise = new Promise((resolve, reject) => {
      const pollTimer = setInterval(() => {
        const rawResult = localStorage.getItem('oauth_result');
      
        if (rawResult) {
          clearInterval(pollTimer); // ポーリングを停止

          try {
            const data = JSON.parse(rawResult);
            localStorage.removeItem('oauth_result'); // 使用済みのデータを即時削除

            if (data.error) {
              this.progress('auth', 'fail');
              this._authPromise = null;
              reject(new Error(data.error));
              return;
            }

            if (data.token) {
              // Googleの通常有効期限1時間(3600秒)から、安全のために5分引いた終了時刻(ミリ秒)を計算
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

    // 💡 Promise自体を返すことで、外側で await drive.auth() と1行で書けるようになります
    return this._authPromise;
  }

  /** 明示的なログアウト（ステートとストレージのクリア） */
  signOut() {
    this.state.loggedIn = false;
    this.state.token = null;
    this.state.expiresAt = 0;
    this.state.email = null;
    localStorage.removeItem('dapi_access_token');
    localStorage.removeItem('dapi_expires_at');
    this.progress('signOut', 'done');
  }

  /* ==================================================
     Google Drive自体
     ================================================== */

  /**
   * ユーザー情報やドライブの状態（About）を取得する
   */
  /* 
    fieldsに取得したいデータを記述する。
    例: ユーザー名、メールアドレス、アバター、Driveの容量情報
      fields: 'user(displayName,emailAddress,photoLink),storageQuota'
  */
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
     File系
     ================================================== */
     
  async createFolder(path) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return 'appDataFolder';
    if (this._idCache[path]) return this._idCache[path];
    
    let fileId = null;
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const parent = parts.slice(0, i).join('/');
      
      fileId = this._idCache[parent+'/'+part];
      if (fileId) continue;
      fileId = await this.getFileId(parent+'/'+part);
      if (fileId) continue;
      fileId = await this.createFile(parent, part, 'application/vnd.google-apps.folder');
    }
    
    return fileId;
  }
  
  async createFile(path, name, mimeType, description='') {
    if ((path !== "" && !path) || !name || !mimeType) return null;
    
    const _path = this.filterPath(path);
    const parentId = await this.getFileId(_path);
    
    const meta = {
      name,
      mimeType,
      parents: [parentId],
      description
    };
    
    // メタデータ（POST）を実行してファイルを枠だけ作る
    return this.request('POST', 'files', { body: meta });
  }
  
  async getFileId(path) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return 'appDataFolder';
    if (this._idCache[path])
      return this._idCache[path];

    let parentId = 'appDataFolder';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      
      const _path = parts.slice(0,i+1).join('/');
      const id = this._idCache[_path];
      if (id) {
        parentId = id;
        continue;
      }
      
      const isLast = i === parts.length - 1;
      
      // フォルダかファイルかでクエリを出し分ける（最後以外は必ずフォルダ）
      let q = `'${parentId}' in parents and name = '${part}' and trashed = false`;
      if (!isLast) {
        q += ` and mimeType = 'application/vnd.google-apps.folder'`;
      }

      const res = await this.request('GET', 'files', {
        params: { q, spaces: 'appDataFolder', fields: 'files(id)' }
      });

      if (!res.files || res.files.length === 0) {
        return null; // 途中の階層、またはファイルが見つからなければ null
      }
      parentId = res.files[0].id;
    }
    
    this._idCache[parts.join('/')] = parentId;
    
    return parentId;
  }
  
  filterPath(path) {
    return path.split('/').filter(Boolean).join('/');
  }
  
  async removeFile(path) {
    // 💡 綺麗にパースしてフルパスの形を揃える (例: "/app/test/" -> "app/test")
    const cleanPath = this.filterPath(path);
    if (!cleanPath) return null;

    const fileId = await this.getFileId(cleanPath);
    
    // 💡 対策1: ファイルが見つからない場合は、APIを叩かずに安全に帰る
    if (!fileId) {
      console.warn(`[removeFile] パスが見つかりません: ${cleanPath}`);
      return null; 
    }

    const file = await this.request('PATCH', `files/${fileId}`, {
      body: {
        trashed: true
      }
    });
    
    if (file) {
      // 💡 対策2: 削除したパス自身、およびその配下にある全子階層のキャッシュをすべて一撃で消去
      const cacheKeys = Object.keys(this._idCache);
      for (const key of cacheKeys) {
        // key が "app/blog" 自体、または "app/blog/" から始まる子パスだったら削除
        if (key === cleanPath || key.startsWith(`${cleanPath}/`)) {
          delete this._idCache[key];
        }
      }
    }
    
    return file;
  }
  
  async getParentId(path) {
    const fileId = await this.getFileId(path);
    const res = this.request('GET', `files/${fileId}`, {
      params: {
        fields: 'parents'
      }
    });
  
    // parents は配列で返ってくる（ルート直下の場合は未定義なことがあるため空配列を担保）
    return res
  }
  
  async getFileInfo(path, fields='files(id, name, mimeType)') {
    const fileId = await this.getFileId(path);
    return this.request('GET', `files/${fileId}`, {
      params: {
        fields: 'parents'
      }
    });
  }
  
  async listFiles(path) {
    path = this.filterPath(path);
    const parentId = await this.getFileId(path);
    if (!parentId) return null
    const q = `'${parentId}' in parents and trashed = false`;
    const fields = 'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime)'
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
      
      if (pageToken)
        params.pageToken = pageToken;
      
      const res = await this.request('GET', 'files', { params });
      
      if (res.files && res.files.length > 0) {
        for (let file of res.files) {
          this._idCache[path+'/'+file.name] = file.id;
        }
        children = children.concat(res.files);
      }
      
      pageToken = res.nextPageToken;
      if (pageToken) this.progress('listFiles', 'fetching_next_page');
    } while (pageToken);
    this.progress('listFiles', `done: total ${children.length} items`);
    return children;
  }
}

export default DriveAPIManager;
