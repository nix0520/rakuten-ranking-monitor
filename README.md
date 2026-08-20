# 楽天ランキングモニター

楽天市場の Bra / ショーツ関連17ジャンルについて、各ジャンル上位100商品を1日4回取得し、順位変動と7日・30日トレンドをGitHub Pagesで確認する静的サイトです。

## 主な機能

- Bra / ショーツのグループ切替、ジャンル絞り込み
- 商品名・商品コード・ショップ名検索
- 現在順位、前回比、新規ランクイン表示
- 商品画像、価格、レビュー件数、評価
- 7日 / 30日の順位スパークライン
- 表示中データのCSV出力
- 日本時間 00:15 / 06:15 / 12:15 / 18:15 の自動取得
- GitHub Pagesへの自動デプロイ

## 構成

- `config/categories.json`: 監視対象17ジャンル
- `scripts/fetch_rankings.py`: 楽天API取得・正規化・履歴更新
- `data/latest.json`: 最新ランキング
- `data/history.json`: 直近30日分の順位履歴
- `index.html`, `assets/`: GitHub Pages用フロントエンド
- `.github/workflows/ranking-pages.yml`: 定期取得・データ保存・Pages公開

## ローカル確認

```bash
python3 -m unittest discover -s tests -v
python3 scripts/fetch_rankings.py --fixture tests/fixtures/api_page.json --output-dir /tmp/rakuten-ranking-test
python3 -m http.server 8000
```

ブラウザで `http://localhost:8000` を開きます。実APIを使う場合は `RAKUTEN_APPLICATION_ID` と `RAKUTEN_ACCESS_KEY` を環境変数に設定してください。

## GitHub設定

Repository secrets:

- `RAKUTEN_APPLICATION_ID`
- `RAKUTEN_ACCESS_KEY`

Repository Settings → Pages → Build and deployment の Source は **GitHub Actions** を選択します。

## データ保持

最新商品情報は `data/latest.json` に保存し、順位履歴は30日を超えた取得回から自動削除します。APIキーはGitHub ActionsのSecretsから実行時だけ読み込み、生成物やログには書き込みません。
