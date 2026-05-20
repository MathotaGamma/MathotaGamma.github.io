class DriveAPIManager {
  constructor() {
    this.state = {
      login: false,
      token: null
    }
  }
  
  oauthSignIn(client_id, redirect_url) {
    const oauth2Endpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
    
    if (!client_id || !redirect_url) return {
      ok: false,
      message: '引数にclient_idとredirect_uriを含めてください。'
    }
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
  }
}
