class DriveAPIManager {
  constructor() {
    this.state = {
      login: false,
      token: null
    };
    this.pollTimer = null; // iPad対策のタイマー保持用
  }
  
  oauthSignIn(client_id, redirect_uri, callback=null) {
    const oauth2Endpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
    
    // 💡 引数の変数名を引数定義（redirect_uri）と統一
    if (!client_id || !redirect_uri) {
      return {
        ok: false,
        message: '引数にclient_idとredirect_uriを含めてください。'
      };
    }

    // 💡 念のため前回の古い認証データをクリアしておく
    localStorage.removeItem('oauth_result');

    const params = {
      client_id,
      redirect_uri,
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
    this.#startPolling(callback);

    return { ok: true, message: '認証ポップアップを開きました。' };
  }

  /** 💡 [Private Method] localStorage を毎秒監視してトークンを回収する */
  #startPolling(callback=null) {
    if (this.pollTimer) clearInterval(this.pollTimer);

    this.pollTimer = setInterval(() => {
      const rawResult = localStorage.getItem('oauth_result');
      
      if (rawResult) {
        // タイマーを止める
        clearInterval(this.pollTimer);
        this.pollTimer = null;

        try {
          const data = JSON.parse(rawResult);
          localStorage.removeItem('oauth_result'); // 使用済みのデータを即時削除

          if (data.error) {
            console.error('OAuth エラー:', data.error);
            return;
          }

          if (data.code) { // Implicit Flowの場合は access_token がここに入る
            // 💡 認証成功: クラスのステートを更新
            this.state.login = true;
            this.state.token = data.code;

            callback();
          }
        } catch (e) {
          throw new Error('パースエラー:'+e.message);
        }
      }
    }, 200); // 1秒ごとにストレージを確認
  }
}

export default DriveAPIManager;
