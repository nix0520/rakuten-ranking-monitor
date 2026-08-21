# 楽天ランキングモニター

楽天市場の Bra / ショーツ関連17ジャンルについて、日次ランキングを各ジャンル最大1000位まで取得し、前日比と7日・30日トレンドをGitHub Pagesで確認する静的サイトです。

## 主な機能

- Bra / ショーツのグループ切替、ジャンル絞り込み
- 商品名・商品コード・ショップ名検索
- 現在順位、前日比、新規ランクイン表示
- 商品画像、価格、レビュー件数、評価
- 7日 / 30日の順位スパークライン
- 通常表示は各ジャンル上位100位、検索・CSV出力は最大1000位
- 日本時間18:15の自動取得
- GitHub Pagesへの自動デプロイ

## 構成

- `config/categories.json`: 監視対象17ジャンル
- `scripts/fetch_rankings.py`: 楽天API取得・正規化・履歴更新
- `data/latest.json`: 最新ランキング
- `data/history.json`: 日別履歴ファイルのインデックス
- `data/history/YYYY-MM-DD.json`: 日別の順位履歴（30日保持）
- `index.html`, `assets/`: GitHub Pages用フロントエンド
- `scripts/windows_fetch.ps1`: Windowsからランキング取得・データ更新
- `scripts/install_windows_task.ps1`: 日本時間18:15の日次Windowsタスク登録
- `.github/workflows/ranking-pages.yml`: テスト・Pages公開

## ローカル確認

```bash
python3 -m unittest discover -s tests -v
python3 scripts/fetch_rankings.py --fixture tests/fixtures/api_page.json --output-dir /tmp/rakuten-ranking-test
python3 -m http.server 8000
```

ブラウザで `http://localhost:8000` を開きます。

## Windows自動取得

Git for WindowsとPython 3をインストールし、GitHubへ認証済みの状態でこのリポジトリの`main`ブランチをクローンします。楽天APIの許可IPアドレスにWindows PCのグローバルIPv4アドレスを登録したうえで、リポジトリ直下の管理者PowerShellから次を実行します。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install_windows_task.ps1
```

画面上でApplication IDとAccess Keyを入力すると、認証情報をWindowsユーザー環境変数に保存し、タスクスケジューラへ「Rakuten Ranking Monitor」を登録します。PCのローカルタイムゾーンを基準に日本時間 `18:15` 相当へ自動換算します。

タスクはログイン中のみ実行されます。実行時は最新の`main`を取得してランキングデータを更新し、`data/latest.json`、`data/history.json`、`data/history/`だけをコミット・プッシュします。そのプッシュを受けてGitHub ActionsがPagesを公開します。

## GitHub設定

Repository Settings → Pages → Build and deployment の Source は **GitHub Actions** を選択します。

## データ保持

最新商品情報は `data/latest.json` に保存し、順位履歴は日付別ファイルに分割して30日分だけ保持します。同じ日に再実行した場合は当日分を置き換え、順位変動は前日のデータと比較します。APIキーはWindowsユーザー環境変数から実行時だけ読み込み、生成物やログには書き込みません。
