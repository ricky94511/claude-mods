# claude-mods

Ricky 的 Claude Code mods。

## handoff：一鍵交接

上下文用量到門檻（預設 55%）時，輸入框上方會出現「🔄 交接到新對話」按鈕。按下去之後：

1. Claude 寫一份交接摘要（目標、已完成、還沒做的、改過的檔案、要注意的地方）
2. 自動 `/clear`
3. 標題改成「原標題（續N）」
4. 摘要放進輸入框，確認後按 Enter 送出（也可以設定成直接送出）

觸發方式：
- 自動：用量到門檻時出現按鈕
- 指令：`/handoff`
- 直接說：「幫我交接」「開新對話接續」「context 快滿了換一個」等等，由 Claude 判斷

設定（`/config` 裡的 handoff 項目）：
- `threshold`：門檻百分比，預設 55
- `autoSend`：交接後直接送出，預設關（先放進輸入框讓你預覽）

## 安裝

### 桌機（終端機或桌面 app）

```
/plugin marketplace add ricky94511/claude-mods
/plugin install handoff@claude-mods
```

桌面 app：點輸入框旁的 + → Plugins → Add marketplace，輸入 `ricky94511/claude-mods`，再 Add plugin。

### 雲端（claude.ai/code）

用這個 repo 開的 session 會自動載入（`.claude/settings.json` 已設定）。
其他 repo 要用的話，把下面這段加進那個 repo 的 `.claude/settings.json`：

```json
{
  "extraKnownMarketplaces": {
    "claude-mods": { "source": { "source": "github", "repo": "ricky94511/claude-mods" } }
  },
  "enabledPlugins": { "handoff@claude-mods": true }
}
```
