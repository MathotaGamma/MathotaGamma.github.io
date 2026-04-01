class DriveAPIManager {
  constructor(progress=()=>{}) {
    this.CLIENT_ID = '673216051028-hjomu6c8livrv4ga0c0f37o3i3qt0dso.apps.googleusercontent.com';
    this.SCOPES = 'https://www.googleapis.com/auth/drive.appdata';

    this.progress = progress;
    this.ready = {
      gapi: false,
      gsi: false,
      auth: false
    }

    this.authPromise = null;
  }

  checker() {
    const token = gapi.client.getToken();
    if (!token?.access_token) {
      return { ok: false, error: "not_authenticated" };
    }
    return { ok: true }
  }

  async #getEmail() {
    if (!this.accessToken) return {
      ok: false,
      error: 'no_accessToken'
    }
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    const data = await response.json();
    return {
      ok: true,
      email: data.email
    }
  }

  _handleAuth(res) {
    this.authPromise = null;

    if (res.error) {
      this._authResolve?.({ ok: false, error: res.error });
    } else {
      this.accessToken = res.access_token;
      this.ready.auth = true;
      this._authResolve?.({ ok: true });
    }
  }

  async auth(silent = true) {
    if (this.accessToken) return { ok: true };

    if (this.authPromise) return this.authPromise;

    if (!this.tokenClient) {
      return { ok: false, error: "gsi_not_ready", place: "auth" };
    }

    this.authPromise = new Promise((resolve) => {
      this.tokenClient.callback = async (response) => {
        if (response.access_token) {
          this.accessToken = response.access_token;
          
          const ret = await this.#getEmail(response.access_token);
          if (!ret.ok) {
            resolve({ ok: false, error: ret.error });
          } else {
            this.userEmail = ret.email;
            resolve({ ok: true, token: response.access_token });
          }
          this.authPromise = null;
        } else {
          resolve({ ok: false, error: "no_token", place: "auth > Promise" });
          this.authPromise = null;
        }
      };

      const requestConfig = {
        prompt: (silent ? '' : 'consent')
      };
      if (this.userEmail && silent) {
        requestConfig.hint = this.userEmail;
      }

      this.tokenClient.requestAccessToken(requestConfig);
    });

    return {
      ok: true,
      promise: this.authPromise
    };
  }

  gapiLoaded() {
    gapi.load('client', () => {
      gapi.client.init({
        discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'],
      }).then(() => {
        this.ready.gapi = true;
        this.progress("gapi_ready");
      });
    });
  }

  gsiLoaded() {
    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: this.CLIENT_ID,
      scope: this.SCOPES,
      callback: (res) => this._handleAuth(res)
    });

    this.ready.gsi = true;
    this.progress("gsi_ready");
  }

  normalizeError(e) {
    if (e instanceof Error) return e.message;
    if (typeof e === "string") return e;
    return "unknown_error";
  }

  async getPath(fileId) {
    try {
      const check = this.checker();
      if (!check.ok) return check;

      let currentId = fileId;
      const pathParts = [];

      while (currentId) {
        // ファイルのメタデータ（名前と親）を取得
        const res = await gapi.client.drive.files.get({
          fileId: currentId,
          fields: 'id, name, parents',
          // appDataFolder内のファイルを探すための指定
          spaces: 'appDataFolder' 
        });

        const file = res.result;

        // 親がいない、または親が 'appDataFolder' 自体なら終了
        if (!file.parents || file.parents.includes('appDataFolder')) {
          pathParts.unshift(file.name);
          break;
        }

        // 現在の名前を配列の先頭に追加し、親を次のターゲットにする
        pathParts.unshift(file.name);
        currentId = file.parents[0];
      }

      const fullPath = pathParts.join('/');
      return { ok: true, path: fullPath };

    } catch (error) {
      return {
        ok: false,
        error: this.normalizeError(error),
        place: "getPath"
      };
    }
  }

  async createFolder(path) {
    try {
      const check = this.checker();
      if(!check.ok) return check;
      const parts = path.split("/");
      let parent = "appDataFolder";
      for (let name of parts) {
        const res = await gapi.client.drive.files.list({
          q: `name = '${name}' and '${parent}' in parents and trashed = false`,
          spaces: 'appDataFolder',
          fields: 'files(id, name)',
        });

        if (res.result.files.length) {
          parent = res.result.files[0].id;
        } else {
          const createRes = await fetch(
            "https://www.googleapis.com/drive/v3/files",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${this.accessToken}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                name,
                mimeType: "application/vnd.google-apps.folder",
                parents: [parent]
              })
            }
          );
        
          if (!createRes.ok) {
            const err = await createRes.text();
            return { ok: false, error: err, place: "createFolder" };
          }

          const data = await createRes.json();
          parent = data.id;
        }
      }
      return { ok: true, folderId: parent };
    } catch(error) {
      return {
        ok: false,
        error: this.normalizeError(error),
        place: "createFolder > error-catch"
      }
    }
  }

  async getFileId(path) {
    try {
      const check = this.checker();
      if(!check.ok) return check;
      const parts = path.split("/");
      let parent = "appDataFolder";

      for (let ind = 0; ind < parts.length; ind++) {
        const name = parts[ind];
        const res = await gapi.client.drive.files.list({
          q: `name = '${name}' and '${parent}' in parents and trashed = false`,
          spaces: 'appDataFolder',
          fields: 'files(id, name)',
        });

        if (!res.result.files.length) return {
          ok: false,
          error: "not_found",
          place: "getFileId > res"
        };
        parent = res.result.files[0].id;
      }
      
      return {
        ok: true,
        fileId: parent
      }
    } catch(error) {
      return {
        ok: false,
        error: this.normalizeError(error),
        place: "getFileId > error-catch"
      };
    }
  }

  async getFile(pathOrId, type="path") {
    try {
      const check = this.checker();
      if(!check.ok) return check;
      
      if(type !== "path" && type !== "fileId") throw new Error('getFileの第二引数には"path"または"fileId"のどちらかを入れてください。');
      let fileId;
      if (type === "path") {
        const res = await this.getFileId(pathOrId);
        if(!res.ok) return {
          ok: false,
          error: res,
          place: "getFile > call getFileId"
        }
        fileId = res.fileId;
      }
      else fileId = pathOrId;
      const meta = await gapi.client.drive.files.get({
        fileId: fileId,
        fields: 'name, mimeType'
      });

      const content = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`
          }
        }
      );

      if (!content.ok) {
        const err = await content.text();
        return {
          ok: false,
          error: err,
          place: "getFile > content"
        }
      }
      
      const blob = await content.blob();

      // Fileとして返す
      const file = new File([blob], meta.result.name, {
        type: meta.result.mimeType
      });
      return {
        ok: true,
        file
      }
    } catch(error) {
      return {
        ok: false,
        error: this.normalizeError(error),
        place: "getFile"
      }
    }
  }

  /*async saveFile(path, data, metadata = {}) {
    try {
      const check = this.checker();
      if (!check.ok) return check;

      // 1. データのBlob化（型に応じた処理）
      let fileBlob;
      if (data instanceof Blob) {
        fileBlob = data;
      } else if (typeof data === "string") {
        fileBlob = new Blob([data], { type: "text/plain" });
      } else if (data instanceof ArrayBuffer) {
        fileBlob = new Blob([data]);
      } else if (data instanceof Object) {
        fileBlob = new Blob([JSON.stringify(data)], { type: "application/json" });
      } else {
        return { ok: false, error: "unsupported_data_type" };
      }

      // 2. パス解決とID取得
      const pathParts = path.split("/");
      const fileName = pathParts.pop();
      const folderPath = pathParts.join("/");

      let parentId = "appDataFolder";
      if (folderPath) {
        const folderRet = await this.createFolder(folderPath);
        if (!folderRet.ok) return folderRet;
        parentId = folderRet.folderId;
      }

      const fileIdRet = await this.getFileId(path);
      const fileId = fileIdRet.ok ? fileIdRet.fileId : null;

      // 3. メタデータの準備
      const finalMetadata = {
        name: fileName,
        mimeType: fileBlob.type || 'text/plain',
        ...metadata
      };
      if (!fileId) finalMetadata.parents = [parentId];

      // 4. 【重要】Blobを配列で連結して、一つの大きなBlobを作る
      const boundary = '-------314159265358979323846';
      const delimiter = `--${boundary}\r\n`;
      const closeDelim = `\r\n--${boundary}--`;

      const multipartBlob = new Blob([
        delimiter,
        'Content-Type: application/json; charset=UTF-8\r\n\r\n',
        JSON.stringify(finalMetadata),
        '\r\n',
        delimiter,
        'Content-Type: ', fileMetadata.mimeType, '\r\n\r\n',
        fileBlob, // ここでバイナリBlobをそのまま入れる
        closeDelim
      ], { type: `multipart/related; boundary=${boundary}` });

      // 5. リクエスト送信
      const url = fileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

      const res = await fetch(url, {
        method: fileId ? 'PATCH' : 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`
          // Content-TypeはmultipartBlobの型から自動で設定されるため不要（または手動指定）
        },
        body: multipartBlob
      });

      if (!res.ok) return {
        ok: false,
        error: await res.text(),
        place: "saveFile > fetch res"
      };
      return {
        ok: true,
        data: await res.json()
      };

    } catch (error) {
      return {
        ok: false,
        error: this.normalizeError(error),
        place: "saveFile > catch error"
      };
    }
  }*/

  async saveFile(path, data, metadata = {}) {
    try {
      const check = this.checker();
      if (!check.ok) return check;

      // 1. データのBlob化
      let fileBlob;
      if (data instanceof Blob) {
        fileBlob = data;
      } else if (typeof data === "string") {
        fileBlob = new Blob([data], { type: "text/plain" });
      } else if (data instanceof ArrayBuffer) {
        fileBlob = new Blob([data]);
      } else if (data instanceof Object) {
        fileBlob = new Blob([JSON.stringify(data)], { type: "application/json" });
      }

      // 2. パス解決
      const pathParts = path.split("/");
      const fileName = pathParts.pop();
      const folderPath = pathParts.join("/");

      let parentId = "appDataFolder";
      if (folderPath) {
        const folderRet = await this.createFolder(folderPath);
        if (!folderRet.ok) return folderRet;
        parentId = folderRet.folderId;
      }

      const fileIdRet = await this.getFileId(path);
      const fileId = fileIdRet.ok ? fileIdRet.fileId : null;

      // 3. メタデータの構築 (mimeTypeを明示)
      const finalMetadata = {
        name: fileName,
        mimeType: fileBlob.type || 'application/octet-stream',
        ...metadata
      };
      if (!fileId) finalMetadata.parents = [parentId];

      // 4. 【最重要】マルチパートBlobの厳密な構築
      const boundary = '-------314159265358979323846';
      const delimiter = `--${boundary}\r\n`;
      const closeDelim = `\r\n--${boundary}--`;

      // パートごとに配列にして連結（改行 \r\n を正確に入れる）
      const parts = [
        delimiter,
        'Content-Type: application/json; charset=UTF-8\r\n\r\n',
        JSON.stringify(finalMetadata),
        '\r\n',
        delimiter,
        'Content-Type: ', finalMetadata.mimeType, '\r\n\r\n',
        fileBlob,
        closeDelim
      ];

      const multipartBlob = new Blob(parts, { type: `multipart/related; boundary=${boundary}` });

      // 5. リクエスト
      const url = fileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

      const res = await fetch(url, {
        method: fileId ? 'PATCH' : 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`
          // Content-Type は指定しなくても、bodyがBlobなら自動で設定されます
        },
        body: multipartBlob
      });

      if (!res.ok) {
        const errorDetail = await res.text();
        console.error("Save Error Detail:", errorDetail);
        return { ok: false, error: errorDetail, place: "saveFile > fetch" };
      }

      const resultData = await res.json();
      console.log("Save Success:", resultData);
      return { ok: true, data: resultData };

    } catch (error) {
      return { ok: false, error: this.normalizeError(error), place: "saveFile > catch" };
    }
  }

  async getStructure() {
    try {
      const check = this.checker();
      if (!check.ok) return check;

      const res = await gapi.client.drive.files.list({
        spaces: 'appDataFolder',
        fields: 'files(id, name)',
        pageSize: 100
      });

      const files = res.result.files || [];
      return {
        ok: true,
        paths: files.map(file => this.getPath(file.id))
      }
    } catch(error) {
      return {
        ok: false,
        error: normalizeError(error),
        place: "getStructure > catch error"
      }
    }
  }

  async resetAppData() {
    try {
      const check = this.checker();
      if (!check.ok) return check;

      this.progress("reset_start");

      // 1. ファイル一覧を取得
      const res = await gapi.client.drive.files.list({
        spaces: 'appDataFolder',
        fields: 'files(id, name)',
        pageSize: 100
      });

      const files = res.result.files || [];
      this.progress(`Found ${files.length} files to delete.`);

      if (files.length === 0) {
        this.progress("reset_no_files");
        return { ok: true, message: "empty" };
      }

      const failedList = [];

      // 2. 削除実行（1つずつ確実に await する）
      for (const file of files) {
        const delRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${this.accessToken}`
          }
        });

        if (!delRes.ok) {
          const errText = await delRes.text();
          failedList.push({path: this.getPath(file.id), error: errText});
        } else {
          this.progress(`deleted: ${this.getPath(file.id)}`);
        }
      }

      this.progress("reset_complete");
      return { ok: true, failedList};

    } catch (error) {
      return { ok: false, error: this.normalizeError(error) };
    }
  }
}
