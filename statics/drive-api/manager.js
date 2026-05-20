class DriveAPIManager {
  constructor({clientId, redirectUri}) {
    if (!clientId || !redirectUri)
      throw new Error('引数にclient_idとredirect_uriを含めてください。');
    
    this.clientId = clientId;
    this.redirectUri = redirectUri;
    
    this.state = {
      login: false,
      token: null
    };

    this._progress = null;
    this._authPromise = null;
  }

  progress(method, state) {
    this._progress = {method, state}
  }
  
  auth() {
    if (this._authPromise) return this._authPromise;

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

    // 1. URLSearchParams を使って、オブジェクトから自動でクエリ文字列（エスケープ込）を生成
    const queryStrings = new URLSearchParams(params).toString();
    const targetUrl = `${oauth2Endpoint}?${queryStrings}`;

    // 2. 組み立てた完全なURLを指定して、直接別窓（別タブ）を開く
    const popupName = 'oauth_popup';
    window.open(targetUrl, popupName, 'width=500,height=600,left=100,top=100,menubar=no,toolbar=no,location=no,status=no');

    // 3. 💡 iPad対策: バックグラウンドのタブでも確実にトークンを回収するポーリングを開始
    this._authPromise = new Promise((resolve, reject) => {
      const pollTimer = setInterval(() => {
        const rawResult = localStorage.getItem('oauth_result');
      
        if (rawResult) {
          // タイマーを止める
          clearInterval(pollTimer);
          

          try {
            const data = JSON.parse(rawResult);
            localStorage.removeItem('oauth_result'); // 使用済みのデータを即時削除

            if (data.error) reject(data.error);

            if (data.code) { // Implicit Flowの場合は access_token がここに入る
              // 💡 認証成功: クラスのステートを更新
              this.state.login = true;
              this.state.token = data.code;

              resolve(this.state.token);
            }
          } catch (e) {
            reject(e);
          }
        }
      }, 200);
    });

    return { ok: true, data: this._authPromise };
  }
}

export default DriveAPIManager;
