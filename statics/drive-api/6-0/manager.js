/*
 userが指定したフォルダのみにアクセスする、space(=file)を追加し、
 space==fileに対応させた。
*/
class DriveAPIManager {
  static ver = "6.0";
  
  constructor({ clientId, redirectUri, progress, space = 'appdata' }) {
    if (!clientId || !redirectUri)
      throw new Error('引数にclient_idとredirect_uriを含めてください。');
    
    // 💡 'file' を選択肢に追加
    if (space !== 'appdata' && space !== 'drive' && space !== 'file')
      throw new Error("spaceは'appdata'、'drive'、または'file'を指定してください。");
    
    this.progress = progress || (() => {});
    this.clientId = clientId;
    this.redirectUri = redirectUri;
    
    // 'appdata' : 専用の隠しフォルダ(appDataFolder)のみを操作する
    // 'drive'   : マイドライブ全体(root以下)をフルアクセスで操作する
    // 'file'    : このアプリが作成/開いたファイルのみをマイドライブ等(root以下)で操作する 💡追加
    this.space = space;
    
    // 💡 'file' スコープも 'drive' と同様に通常の root フォルダを起点にします
    this.rootId = space === 'appdata' ? 'appDataFolder' : 'root';
    
    // 💡 APIリクエスト時の spaces パラメータの割り振り
    // drive.file スコープの対象は 'drive' 領域（マイドライブ等）です
    this.spacesParam = space === 'appdata' ? 'appDataFolder' : 'drive';
    
    // 💡 スコープを3分岐に変更
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

  // ーーー 以降のメソッド（request, auth, saveFile 等）は変更なしでそのまま動きます ーーー
