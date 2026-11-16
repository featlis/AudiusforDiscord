# Audius Together — Discord Activity (同期再生の雛形)

Audius の曲を、Discord の VC / DM で開ける **アクティビティ（Embedded App）** として
みんなで同じキュー・同じ再生位置で聴くための雛形プロジェクト。

Bot が VC に参加する方式ではありません。実体は Web アプリで、各参加者の
Discord クライアント内 iframe で `<audio>` 再生し、再生状態を WebSocket で同期します。

## 構成

```
client/  Vite + TypeScript + @discord/embedded-app-sdk
  src/discord.ts  ready -> authorize -> /api/token -> authenticate、モックモード
  src/sync.ts     WebSocket クライアント（自動再接続）
  src/main.ts     検索/トレンド、キュー、同期再生 UI、ズレ補正
server/  Node (Express + ws)
  src/index.js
    POST /api/token              Discord OAuth コード交換（secret はサーバーだけ）
    GET  /api/audius/search      Audius 検索の代理（x-api-key はサーバーだけ）
    GET  /api/audius/trending    トレンドの代理
    GET  /api/audius/stream/:id  音声ストリームの代理（Range 対応＝シーク可）
    GET  /api/image?url=...      アートワーク画像の代理（CSP 回避用）
    WS   /ws                     同期ルーム（部屋ID = Discord の instanceId）
    本番では client/dist も配信する（単一オリジン＝URL Mapping が1つで済む）
```

### 同期の仕組み
- ルームの状態（キュー、再生中の曲、再生/停止、再生位置）は**サーバーが正本**。
- 再生位置は `positionBase + (サーバー時刻 - startedAt)` で全員が同じ値を計算する。
- クライアントは 0.5 秒ごとに自分の `audio.currentTime` とのズレを見て、
  2.5 秒以上ズレたら補正する（細かいズレは音が途切れるので触らない）。
- 曲の終了は全員が同時に送るので、サーバー側で二重スキップを防止している。
- 音量は同期しない（各自の好み）。

## セットアップ

### 1. Discord Developer Portal
1. New Application を作成し、**Application ID (= Client ID)** を控える
2. OAuth2: Redirect に `https://127.0.0.1` を追加（アクティビティの認証用）
3. **Activities** を有効化し、Supported Platforms で使う端末にチェック
4. Installation: **User Install** と **Guild Install** の両方を有効化
   （DM / グループDM で使うには User Install が必要）
5. URL Mappings（手順 4 のトンネル/デプロイ先が決まってから設定）:
   - Prefix `/` → Target = 公開ホスト名（`https://` なし）

### 2. Audius API キー
audius.co の Settings / API Plans で開発者アプリを作り、API Key を控える。
読み取りだけなら Key のみでよい。Secret はサーバー以外に置かないこと。

### 3. 環境変数
```bash
cp .env.example .env               # DISCORD_CLIENT_ID / SECRET、AUDIUS_API_KEY を記入
cp client/.env.example client/.env # VITE_DISCORD_CLIENT_ID に同じ Client ID
```

### 4. ローカル開発（Discord 外＝モックモード）
```bash
cd server && npm install && npm run dev   # http://localhost:3001
cd client && npm install && npm run dev   # http://localhost:5173
```
ブラウザで `http://localhost:5173` を**2つのタブ/ウィンドウ**で開くと、
同じ dev-room に入り、片方でキューに入れた曲がもう片方でも再生される同期が確認できる。

### 5. Discord 内で動かす（開発）
```bash
cloudflared tunnel --url http://localhost:5173
# 例: https://xxxx.trycloudflare.com が発行される
```
Portal の URL Mappings で `/` → `xxxx.trycloudflare.com` に設定し、
Discord で開発者モードを有効にして Activity Shelf から起動する。
Vite が `/api` と `/ws` をサーバーへプロキシするので、トンネルは1本でよい。

### 6. 本番
```bash
npm run build          # client/dist を生成
cd server && npm start # サーバーが dist も配信する
```
公開ホスト（VPS、Render、Railway など）に server を置き、
URL Mappings の `/` をそのホスト名に向ける。

## 検証済み（2026-11-16、キー未設定の状態でも動作確認）
- クライアントの TypeScript ビルド成功
- `/api/audius/trending` が実データを返す
- `/api/audius/stream/:id` が audio/mpeg を返す（Range/シーク対応）
- `/api/image` がアートワーク (image/jpeg) を返す
- WebSocket: 2クライアントが同じ部屋で memberCount=2、片方の enqueue が
  もう片方へ即時反映され、再生状態が同期する

## 既知の制限・次にやること
- ルーム状態はメモリ上のみ。サーバー再起動でキューは消える（永続化は未実装）。
- 操作権限は全員平等（誰でも一時停止/スキップできる）。仕様として決めること。
- `/api/image` は https の画像なら通す雛形実装。公開前に許可ドメインを絞ること。
- ブラウザの自動再生制限で、初回は再生ボタンの操作が必要な場合がある。
- Audius API キー未設定でも読み取りは動いたが、本番では必ず設定すること
  （レート制限: 無料プラン 10 req/秒・月50万リクエスト）。
