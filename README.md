# 楽天ランキングモニター

楽天市場の Bra / ショーツ関連17ジャンルの日次ランキングとリアルタイムランキングを追跡する静的サイトです。

## 主な機能

- Bra / ショーツのグループ切替、ジャンル絞り込み
- 商品名・商品コード・ショップ名検索
- 現在順位、前日比、新規ランクイン表示
- 商品画像、価格、レビュー件数、評価
- 商品ポイント倍率、セール期間、クーポン・割引文言の手掛かり
- 09:50 / 10:00 / 10:10 / 10:30と19:50 / 20:00 / 20:10 / 20:30の観測による日榜の初回切替時刻、集計日、ページ更新時刻、順位変動、進出・退出商品の記録
- Bra 9ジャンルとショーツ8ジャンルの上位100位を20分間隔で記録
- 7日 / 30日の順位スパークライン
- 通常表示は各ジャンル上位100位、検索・CSV出力は最大1000位
- 日本時間10:30 / 20:30の完全日次取得
- GitHub Pagesへの自動デプロイ

## 構成

### 競合分析パネル

- 上昇幅順・下落幅順・新規ランクインの絞り込み（現在のジャンルと検索条件に連動）
- 商品のお気に入りはブラウザのlocalStorageに保存。ログイン不要・端末間同期なし。圏外の商品も管理欄から削除可能
- 「履歴詳細」で7日/30日の日榜順位・商品価格・商品ポイントを別々のグラフと日付別表で確認
- 日榜のグラフは楽天集計日を優先。同じ集計日は1点に集約し、古い集計日不明の記録は取得日と明示
- 価格・ポイント履歴はこの変更後の完全日榜取得から保存。旧履歴には遡及補完しない
- 詳細のリアルタイム変化ログは最新取得日の1日分をクリック時に取得。日榜のグラフと混在させない
- 日榜切替記録は実際の集計日から再判定し、最後の旧榜と最初の新榜の区間を表示。直前観測がない日は区間不明と表示
- この更新ではWindowsの取得スケジュールは変更しない

- `config/categories.json`: 監視対象17ジャンル
- `scripts/fetch_rankings.py`: 楽天API取得・正規化・履歴更新
- `data/latest.json`: 最新ランキング
- `data/history.json`: 日別履歴ファイルのインデックス
- `data/history/YYYY-MM-DD.json`: 日別の順位履歴（30日保持）
- `data/daily-update-log.json`: 日榜更新時刻の観測記録（30日保持）
- `data/realtime/latest.json`, `data/realtime/YYYY-MM-DD.json`: リアルタイム榜と価格・ポイント・販促変化
- `index.html`, `assets/`: GitHub Pages用フロントエンド
- `scripts/windows_fetch.ps1`: Windowsからランキング取得・データ更新
- `scripts/install_windows_task.ps1`: 日榜観測、完全日次取得、20分間隔リアルタイム取得のWindowsタスク登録
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

画面上でApplication IDとAccess Keyを入力すると、認証情報をWindowsユーザー環境変数に保存し、タスクスケジューラへ次の3タスクを登録します。以下はすべて日本時間（JST）で、PCのローカルタイムゾーンへ自動換算されます。09:50 / 10:00 / 10:10などは日榜の切替観測であり、リアルタイム榜の追加取得ではありません。

- `Rakuten Ranking Daily Probe`: 09:50 / 10:00 / 10:10 / 19:50 / 20:00 / 20:10 JST、17ジャンル上位30位で日榜切替を観測
- `Rakuten Ranking Daily`: 10:30 / 20:30 JST、17ジャンル最大1000位を取得
- `Rakuten Ranking Realtime`: 日本時間の毎時05分・25分・45分（20分間隔）、17ジャンル上位100位を取得

タスクはログイン中のみ実行され、PCの電源とプロキシ接続が必要です。実行時は最新の`main`を取得し、変更された`data/`をコミット・プッシュします。そのプッシュを受けてGitHub ActionsがPagesを公開します。

## GitHub設定

Repository Settings → Pages → Build and deployment の Source は **GitHub Actions** を選択します。

## データ保持

最新商品情報は `data/latest.json` に保存し、順位履歴は日付別ファイルに分割して30日分だけ保持します。同じ日に再実行した場合は当日分を置き換え、順位変動は前日のデータと比較します。APIキーはWindowsユーザー環境変数から実行時だけ読み込み、生成物やログには書き込みません。

楽天ランキングAPIは商品単位のポイント倍率・セール情報を返しますが、ショップ共通ポイントや全クーポンの専用一覧は返しません。そのためクーポン表示は商品名・キャッチコピー等に現れた文言を分析用の手掛かりとして保存するもので、完全なクーポン網羅ではありません。
