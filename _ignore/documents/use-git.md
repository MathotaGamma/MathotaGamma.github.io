# Gitの使い方
※AndroidのTermuxを使う想定。

## 初期化
1. GitHubでrepositoryを作る。このとき、Add README.mdなどには**チェックを入れない**。空のリポジトリにする。
2. Termuxで、以下のコマンドを実行する。
   ※「// ~~」はコメント。

```
# デバイス内ストレージの、.gitやファイルを置くディレクトリ指定。
cd "/storage/emulated/0/Download/GITHUB"
# git, git-lfsをインストール
# 'Continue? [Y/n]' ときたら'y'
pkg install git git-lfs
# 色々warn出るが無視
git init
# ブランチ名を main に変更
git branch -M main
# Termux特有のディレクトリ所有権エラーを回避する設定
git config --global --add safe.directory "/storage/emulated/0/Download/GITHUB/.git"
# ※ 'YOUR_TOKEN'の部分は、下記のPersonal Access Tokenで取得する`ghp_`から始まるtokenに置き換える
git remote add origin "https://YOUR_TOKEN@github.com/ユーザー名/リポジトリ名.git"
# ※ もし既に origin が登録されていてエラーになる場合は、以下のコマンドでURLを上書きする
git remote set-url origin https://YOUR_TOKEN@github.com/ユーザー名/リポジトリ名.git

# Git LFSの有効化（Termuxの環境ごとに最初の一回のみ。グローバル設定なのでリポジトリを跨いでも有効）
git lfs install
```

## Personal Access Token取得
1. [https://github.com/settings/tokens?hl=ja-JP](https://github.com/settings/tokens?hl=ja-JP)にアクセス
2. **Generate new token**から**Generate new token(classic)**をクリック
3. **Note欄**にわかりやすい名前(例:Termux)をつける
4. **スコープ(権限)一覧**から**repo**のチェックボックスにチェックを入れる
5. **expiration**は有効期限。**No expiration**は無期限
6. **Generate token**をクリック
7. *ghp_* から始まる長い文字列をコピーする(***一度画面を閉じると二度と表示されない***)

## ファイル追加(LFS経由)
```
# 1. 保存先ディレクトリを作成し、ファイルを移動する
mkdir -p PATH/
mv "元のファイルパス" PATH/

# 2. 追跡対象の指定(.gitattributesが自動生成/追記される)
git lfs track "PATH/ファイル名"

# 3. 追跡設定をコミット
# ※ .gitattributesも忘れずにaddする。これをコミットし忘れると、
#   新規cloneした環境やmigrate後の履歴でLFS管理対象が判定できなくなる
git add "PATH/ファイル名" .gitattributes
git commit -m "Track PATH/ファイル名 via LFS"

# 4. LFSマイグレーション（履歴の書き換え）
git lfs migrate import --include="PATH/ファイル名" --everything

# 5. リモートへプッシュ
git lfs push --all origin main
git push -u origin main --force
```

**⚠️ 注意事項（--force プッシュについて）**
--force を用いて強制プッシュを行うため、GitHubのWeb上で直接ファイルを編集・変更した履歴がある場合、手元のデータと競合してリモート側の変更が上書きされる恐れがある。
*基本的には自分一人での利用を前提とし、Web側と手元（Termux）での同時並行での編集は避けるようにする*。
複数端末で作業する可能性がある場合は、作業前に必ず以下のコマンドでリモートの変更を取り込んでおく。

## 変更の取得(fetch + merge)
```
git pull origin main
```