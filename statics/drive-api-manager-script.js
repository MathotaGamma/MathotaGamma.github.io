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

  async auth(silent=true) {
    if (this.accessToken) return { ok: true };

    if (this.authPromise) return this.authPromise;

    if (!this.tokenClient) {
      return { ok: false, error: "gsi_not_ready" };
    }
    
    this.authPromise = new Promise((resolve) => {
      this._authResolve = resolve;
      this.tokenClient.requestAccessToken({prompt: (silent?'':'consent')});
    });
    
    return this.authPromise;
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

  async createFolder(path) {
    try {
      const parts = path.split("/");
      const parent = "appDataFolder";
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
            return { ok: false, error: err };
          }

          const data = await createRes.json();
          parent = data.id;
        }
      }
      return { ok: true, folderId: parent };
    } catch(error) {
      return {
        ok: false,
        error: this.normalizeError(error)
      }
    }
  }

  async getFileId(path) {
    try {
      if (!this.accessToken) return { ok: false, error: "auth同意を得ていません。" };
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
          error: "not_found"
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
        error: this.normalizeError(error)
      };
    }
  }

  async getFile(pathOrId, type="path") {
    try {
      if (!this.accessToken) return { ok: false, error: "auth同意を得ていません。" };
      if(type !== "path" && type !== "id") throw new Error("getFileの第二引数にはpathまたはidのどちらかを入れてください。");
      let fileId;
      if (type === "path") {
        const ret = await this.getFileId(pathOrId);
        if(!ret.ok) return {
          ok: false,
          error: ret.error
        }
        fileId = ret.fileId;
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
        const err = await res.text();
        return {
          ok: false,
          error: err
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
        error: this.normalizeError(error)
      }
    }
  }

  async saveFile(path, data, metadata={}) {
    try {
      if (!this.accessToken) return { ok: false, error: "auth同意を得ていません。" };
      

      let file;
      if (data instanceof Blob) {
      file = data;
      } else if (typeof data === "string") {
        file = new Blob([data], { type: "text/plain" });
      } else if (data instanceof ArrayBuffer) {
        file = new Blob([data]);
      } else if (data instanceof Object) {
        file = new Blob([JSON.stringify(data)], { type: "application/json" });
      } else {
        return { ok: false, error: "unsupported_data_type" };
      }
        
      const formData = new FormData();
      formData.append(
        'metadata',
        new Blob([JSON.stringify(metadata)], { type: 'application/json' })
      );
      formData.append('file', file);

      const ret = await this.getFileId(path);
      const fileId = ret.ok ? ret.fileId : null;
    
      const url = fileId 
        ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
        
      const method = fileId ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`
        },
        body: formData
      });
      
      if (!res.ok) {
        return {
          ok: false,
          error: await res.text()
        };
      }
      
      return {
        ok: true,
        data: await res.json()
      };
    } catch(error) {
      return {
        ok: false,
        error: this.normalizeError(error)
      }
    }
  }
}
