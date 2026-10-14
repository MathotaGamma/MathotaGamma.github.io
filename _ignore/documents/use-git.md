# Gitの使い方
※AndroidのTermuxを使う想定。
## 初期設定（最初の一回のみ）
Termuxで、以下のコマンドを実行する。
※「# ~~」はコメント。

```
# 作業ディレクトリに移動する
cd "/storage/emulated/0/Download/GITHUB"
# GitとGit LFSをインストールする（途中でyを入力）
pkg install git git-lfs
# Gitリポジトリとして初期化する
git init
# ブランチ名をmainに変更する
git branch -M main
# Termux用のディレクトリ所有権エラーを回避する
git config --global --add safe.directory "/storage/emulated/0/Download/GITHUB/.git"
# リモートリポジトリのURLを設定する（YOUR_TOKENなどを書き換え）
git remote add origin "https://YOUR_TOKEN@github.com/ユーザー名/リポジトリ名.git"
# 既にoriginがある場合はURLを上書きする
git remote set-url origin https://YOUR_TOKEN@github.com/ユーザー名/リポジトリ名.git
# Git LFS機能を有効化する（最初の一回のみ）
git lfs install
```

## Personal Access Token取得
1. [https://github.com/settings/tokens?hl=ja-JP](https://github.com/settings/tokens?hl=ja-JP)にアクセス
2. *Generate new token*から**Generate new token(classic)**をクリック
3. **Note欄**にわかりやすい名前(例:Termux)つける
4. *スコープ(権限)一覧*から**repo**のチェックボックスにチェックを入れる
5. *expiration*は有効期限。**No expirationは無期限**
6. **Generate token**をクリック
7. **ghp_** から始まる長い文字列をコピーする(**一度画面を閉じると二度と表示されない**)

## ファイル追加(LFS経由)
作業を行う前に、必ずリモート（GitHub側）の最新状態を手元に取り込んでからファイルを追加します。
```
# 1. リモートの最新変更を安全に取り込む（競合を防ぐため）
git pull origin main

# 2. 保存先ディレクトリを作成し、ファイルをコピーする
mkdir -p PATH/
cp "元のファイルパス" PATH/

# 3. 追跡対象の指定(.gitattributesが自動生成/追記される)
git lfs track "PATH/ファイル名"

# 4. 追跡設定をコミット
# ※ .gitattributesも忘れずにaddする。これをコミットし忘れると、
#   新規cloneした環境などでLFS管理対象が判定できなくなる
git add "PATH/ファイル名" .gitattributes
git commit -m "Track and add PATH/ファイル名 via LFS"

# 5. リモートへ通常プッシュ
git push origin main
```

**⚠️ 注意事項**
- 通常の git push origin main を行います。
- もしプッシュ時に「diverged（履歴の乖離）」やエラーが出た場合は、git pull origin main --rebase を実行してから再度プッシュしてください
