# AGENTS.md（謝礼金取りまとめアプリ larus-sharei）

このリポジトリでAIエージェント（Codex等）が作業するときの手引きです。機能の詳しい説明は `README.md` を参照してください。

## 概要

- KESEN LARUS BASKETBALL CLUB の帯同審判・コミッショナー・その他従事者への謝礼金（規程第5条・第6条ほか）を取りまとめるWebアプリ
- 利用者は日本語話者。画面表示・印刷物・コミットメッセージ・README はすべて日本語で書く
- スタッフの交通費は別アプリ（交通費取りまとめアプリのリポジトリ）で管理している。**こちらへの依頼をあちらに、あちらへの依頼をこちらに勝手に適用しない**
- 規程の原本は `交通費等及び謝礼金支給規程.docx`

## 構成

ビルド工程のない素のHTML/CSS/JavaScriptで、GitHub Pages（`main` ブランチ）から配信している。

| ファイル | 役割 |
|---|---|
| `index.html` | 画面（入力・一覧・ダッシュボード）と印刷用の空コンテナ |
| `app.js` | アプリ本体。支給額の計算、一覧、CSV取込・Excel出力、精算書・封筒の印刷 |
| `style.css` | 画面と印刷のスタイル |
| `xlsx-writer.js` | 依存ライブラリなしの簡易 .xlsx 書き出し |
| `firebase-entry.js` | Firebase初期化と `window.FirebaseData` API |
| `firebase-bundle.js` | `firebase-entry.js` をesbuildでまとめた生成物。**直接編集しない**（再ビルド手順は README） |
| `logo.png` / `icon.png` / `apple-touch-icon.png` | クラブロゴとアイコン |
| `.github/workflows/version-assets.yml` | `main` へのpush時に `index.html` の読み込みURLへ `?v=日時` を自動付与（キャッシュ対策）。この自動コミットがあるので、push前に必ず `git pull` する |

## データ

- Firebase（Firestore + Authentication）。コレクションは `sharei_records`（謝礼の記録）と `sharei_meta`（`roster`＝よく依頼する対象者、`contacts`＝精算書用の住所・電話）
- 同じFirebaseプロジェクトとログイン用アカウントを交通費アプリ（`records` / `contacts`）も使っている。コレクション名・ログイン方式・`firebaseConfig` は両アプリに影響するので、勝手に変えない
- 合言葉（パスワード）はリポジトリに書かない

## 動作確認

- `python3 -m http.server` で配信して `index.html` を開く。実データを見るには合言葉でのログインが必要
- ログインなしで画面や印刷を確かめるときは、`firebase-bundle.js` の代わりに `window.FirebaseData` を同じ形で返すモックを読み込ませ、テスト用の記録を流し込む（Playwright の `page.route` で差し替えると楽）
- 印刷の確認は、印刷ボタンを押したあとに Playwright の `page.pdf({ preferCSSPageSize: true })` でPDF化し、**ページ数と用紙サイズ**まで確認する（見た目が正しくても白紙ページが混ざることがある）
- 精算書は区分（帯同審判／コミッショナー／その他）で中身が変わるので、各区分と、開催地が長い場合の記録で確かめる

## 印刷まわりの注意（過去に実際に起きた不具合）

- 用紙サイズは `printWithPageSize('210mm 148mm')` のように、印刷直前に `@page` を差し込み、印刷後に取り除く。精算書はA5横、封筒は長形3号（120×235mm）。CSSに `@page` を固定で書くと、もう一方の印刷物と競合する
- 精算書と封筒は印刷用の領域を別々に持つ。描画関数の最初で**もう一方の領域を空にする**（CSSだけで隠すと、前に印刷した内容が重なって出る）
- `@media print` ではアプリ本体（`.app-header, .tabs, main, #toast, #chart-tooltip, #login-overlay`）を `display: none` にしている。`visibility: hidden` だけにすると高さが残り、余分な白紙ページが出る
- 開催地を1行に収める自動縮小（`fitReceiptVenueText`）は、通常は非表示の印刷領域を一時的に表示してから幅を測る。非表示のままだと幅が0になり、縮小されない
- A5は余白が少ないので、要素を足すときは高さが用紙を超えないか、PDFのページ数で確かめる
- 日付は和暦（「令和8年8月15日」）で表示する。`reiwaYearOf` / `formatEraDate` を使う

## 進め方の約束

- 印刷物や画面の**見た目を変える依頼**は、実装後にプレビュー画像（PDFを画像化したもの）を見せ、利用者から「実装」と返事をもらってから `main` にpushする
- `main` へのpushはそのまま本番（GitHub Pages）に反映される
- 依頼された範囲だけを変更する。金額のルールは規程に合わせ、勝手に変えない
- 機能を変えたら `README.md` の該当箇所も更新する
