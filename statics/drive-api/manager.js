class DriveAPIManager {
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
      login: isAlive ? true : false,
      token: isAlive ? cachedToken : null,
      expiresAt: cachedExpires
    };

    this._authPromise = null;
  }

  /* ==================================================
     共通
     ================================================== */
  
  async request(method = 'GET', path = '', options = {}) {
    // 💡 認証状態とトークンの生存チェック
    if (!this.state.login || !this.state.token) {
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
  auth(silent=false) {
    // すでに認証処理（Promise）が走っている場合はそれをそのまま返す（多重起動防止）
    if (this._authPromise) return this._authPromise;

    // 💡 【silent: true の場合】
    if (silent) {
      if (this.state.login && this.state.token && this.state.expiresAt > Date.now()) {
        this.progress('auth', 'silent:done');
        return Promise.resolve({ ok: true, token: this.state.token, silent: true });
      } else {
        // 期限切れ、またはトークンがない場合は即座に失敗として返す
        this.progress('auth', 'silent:fail');
        this.signOut(); // ステートとストレージを安全にクリア
        return Promise.resolve({ ok: false, error: 'silent_auth_failed' });
      }
    }

    if (this.state.login && this.state.token && this.state.expiresAt > Date.now()) {
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
              this._authPromise = null; // クリーンアップ
              reject(new Error(data.error));
              return;
            }

            if (data.token) {
              // Googleの通常有効期限1時間(3600秒)から、安全のために5分引いた終了時刻(ミリ秒)を計算
              const expiresAt = Date.now() + (3600 * 1000) - (5 * 60 * 1000);

              // クラスのステートを更新
              this.state.login = true;
              this.state.token = data.token;
              this.state.expiresAt = expiresAt;

              // 💡 次回の silent: true での復元のために localStorage に永続化
              localStorage.setItem('dapi_access_token', data.token);
              localStorage.setItem('dapi_expires_at', expiresAt.toString());

              this.progress('auth', 'done');
              this._authPromise = null; // 成功したので次回のためにクリーンアップ
              
              // 利用側が扱いやすいようにオブジェクトで解決する
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
    this.state.login = false;
    this.state.token = null;
    this.state.expiresAt = 0;
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
}

export default DriveAPIManager;
