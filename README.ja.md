# fast-jev-compaction (日本語版ガイド)

**fast-jev-compaction** は、Claude Code セッションにおける過去のコンテキスト（対話履歴）を要約ではなく、判定モデル（TypeSafe Jev またはローカルオープンソースの **Laya**）を用いて選択的に短縮・削除するコンパクション（文脈圧縮）プラグインおよび Node.js ライブラリです。

---

## 特徴とメリット

### 1. 原文（Verbatim）のまま保持するコンパクション
通常のコンパクション（要約）では、過去のやり取りを言語モデルで要約するため、ファイルパス、正確なエラーログ、特定のコマンド、制約条件などの重要な詳細が失われるリスクがあります。  
`fast-jev-compaction` は**テキストの書き換えや要約を一切行いません**。過去のツール呼び出し (`tool_use`) と実行結果 (`tool_result`) のうち、**「不要になったものだけを削除・短縮」** し、必要な発言やログは原文のまま残します。

### 2. ローカル Laya アドオン対応 (クラウド API コストゼロ & 完全プライベート)
本フォークでは、外部クラウド API (`https://api.typesafe.ai/v1/systemone`) の代わりに、ローカルの高速判定エンジン **[Laya](https://github.com/NandhaKishorM/laya)** (ModernBERT/mmBERT ベースのオープンソースモデル) を呼び出すアドオンを搭載しています。
- API キー不要、API 従量課金ゼロ
- 1 判定あたり約 33 ms の超高速レスポンス (GPU 時)
- ローカル環境内で処理が完結するため機密データの送信なし

---

## 仕組み

1. **ツールのペアリングと保護**:
   - `tool_use` と `tool_result` を `tool_use_id` でペアリングします。
   - 最初のメッセージおよび最新の `preserveRecentMessages`（デフォルト 6 件）に含まれるツール呼出は保護され、変更されません。
2. **State（状況）の構築とフィッティング**:
   - ツール結果を除いた会話全体の履歴（State）を作成します。
   - Token 数の上限（`maxStateTokens`: デフォルト 25,000）に合わせて調整されます。
3. **Laya / Jev による判定**:
   - 各ツール呼出に対して「呼出自体を残すべきか (keepCall)」「実行結果を原文のまま残すべきか (keepResult)」を確率スコア (`noul`) で判定します。
4. **決定と切り詰め**:
   - 閾値 (`keepThreshold`: デフォルト 0.5) に基づき判定します：
     - `keepResult ≥ threshold`: 呼出も結果もそのまま保持。
     - `keepCall ≥ threshold`: 呼出を残し、結果のテキストを冒頭 `truncateHeadChars` 文字＋省略注記に短縮。
     - 双方未満: ツール呼出と結果を完全に削除。

---

## Claude Code での使い方

### Step 1: ローカル Laya サーバーの起動 (Python)

事前に `laya` をインストールし、付属のローカル HTTP API サーバーを起動します。

```bash
# Laya のインストール
pip install laya

# Laya サーバーの起動 (デフォルト 8000 ポート)
python3 laya_addon/laya_server.py --port 8000
```

> **TIP**: バックグラウンドで常駐させる場合:
> ```bash
> nohup python3 laya_addon/laya_server.py --port 8000 > laya_server.log 2>&1 &
> ```

---

### Step 2: このマシンへのプラグインインストール

このリポジトリはすでに本マシンの Claude Code にインストール済みです。手動で再インストール・更新する場合は以下のコマンドを実行します。

```bash
# 1. ローカルリポジトリをマーケットプレイスに追加
claude plugin marketplace add /Volumes/SSD_USB_1/AntiGravitiRoot/Loya/fast-jev-compaction

# 2. プラグインをインストール
claude plugin install fast-jev-compaction
```

インストール状況は `claude plugin list` で確認できます。

---

### Step 3: プラグインの設定 (Configuration)

Claude Code 内で `/plugin configure fast-jev-compaction` を実行するか、環境変数または設定ファイルでパラメータを設定します。

#### 主な設定項目

| 設定キー | デフォルト値 | 説明 |
|---|---|---|
| `provider` | `"laya"` | 判定プロバイダ (`"laya"` = ローカルLaya, `"jev"` = クラウドAPI) |
| `baseUrl` | `"http://localhost:8000/v1/systemone"` | Laya サーバーのエンドポイント URL |
| `compactAtPercent` | `60` | コンテキスト領域の使用率(%)がこの値を超えたら自動でコンパクションを発火 |
| `keepThreshold` | `0.5` | ツール呼び出し・結果を保持する最小確率閾値 |
| `preserveRecentMessages` | `6` | 保護する最新メッセージの件数 |
| `minReductionRatio` | `0.25` | 最低削減率（25%未満の削減量にしかならない場合はスキップ） |

#### 環境変数での設定例
`LAYA_BASE_URL` に加えて、公式SDKの標準環境変数 `TYPESAFE_BASE_URL` もサポートしています。
```bash
export LAYA_BASE_URL=http://localhost:8000/v1/systemone
# または公式SDK標準の環境変数を使用可能:
export TYPESAFE_BASE_URL=http://localhost:8000/v1/systemone
```

---

### Step 4: 動作確認とログの確認

1. Claude Code でセッションを進行し、トークン消費が `compactAtPercent` (60%) に達すると、自動的にコンパクションが発火します。
2. コンソールログに以下のような判定ログが出力されます：
   ```text
   decisions: t1:Read:keep/call=0.92/result=0.85 t2:Bash:drop_result/call=0.75/result=0.12 t3:Grep:drop_call/call=0.10/result=0.05
   ```
3. UI に削減割合（例: `38% reduction; 2 kept, 1 results truncated, 1 call_dropped`）の通知が表示されます。

---

## Node.js / TypeScript ライブラリとしての使い方

ライブラリとして Node.js プロジェクトに組み込んで使用することも可能です。

```ts
import { compact, LayaClient, LayaSubprocessAsker, type Message } from 'fast-jev-compaction';

const messages: Message[] = [
  { role: 'user', text: 'テストを実行してください', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'c1', tool: 'Bash', input: { command: 'npm test' } }],
  },
  {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [{ tool_use_id: 'c1', text: 'PASS tests/laya.test.ts ... (長大なログ)' }],
  },
];

// 方法 A: HTTP サーバー経由 (高速・推奨)
const client = new LayaClient({ baseUrl: 'http://localhost:8000/v1/systemone' });
const result = await compact(messages, client);

// 方法 B: Python サブプロセス直呼び出し (サーバー事前起動不要)
const bridge = new LayaSubprocessAsker();
const result2 = await compact(messages, bridge);

console.log(`メッセージ数: ${messages.length} -> ${result.messages.length}`);
console.log('判定結果:', result.decisions);
```

---

## ライセンス

MIT License
