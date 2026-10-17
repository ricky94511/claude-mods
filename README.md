# claude-mods

Ricky 的 Claude Code mods。

## handoff：一鍵交接

上下文快滿時，把目前的工作整理成交接摘要，清空對話後當成第一句送出，標題自動加「（續N）」。

### 用法

1. 開始交接：說「幫我交接」（各種說法都可以，由 Claude 判斷），或輸入 `/handoff`
2. Claude 在對話裡寫出交接預覽（目標、已完成、還沒做的、改過的檔案、要注意的地方）
3. 確認：說「送出」（或 `/handoff 送出`）；不要了就說「取消」（或 `/handoff 取消`）；想改內容就直接說要改什麼
4. 確認後自動 `/clear`、改標題、把摘要送出

卡住的話用 `/handoff 重來`。

### 自動詢問

- 上下文用到門檻（預設 15 萬 token）時跳出對話框：現在交接／稍後（再多用 1.5 萬 token 時再問）／這個對話不要再問
- 摘要寫好後再跳一次：送出並交接／取消／直接寫修改意見
- 對話框在雲端（桌機 app 看雲端對話）也看得到；本機終端機另外有輸入框上方的按鈕

### 設定（`/config` 裡的 handoff 項目）

- `thresholdTokens`：門檻 token 數，預設 150000。用 token 數而不是百分比，是因為本機上限約 20 萬、雲端 100 萬，同一個百分比差很多
- `autoSend`：跳過預覽直接交接，預設關

## 安裝

### 桌機（終端機或桌面 app）

```
/plugin marketplace add ricky94511/claude-mods
/plugin install handoff@claude-mods
```

桌面 app：點輸入框旁的 + → Plugins → Add marketplace，輸入 `ricky94511/claude-mods`，再 Add plugin。

### 雲端（claude.ai/code）

雲端環境會跳過 marketplace，所以改用 setup script 把 repo clone 進容器，再用 `CLAUDE_CODE_PLUGIN_DIRS` 載入。
在環境設定的 Setup script 最後加上這段（失敗也不會讓 session 起不來）：

```bash
if [ -d /home/user/plugins/claude-mods/.git ]; then
  git -C /home/user/plugins/claude-mods fetch -q --depth 1 origin main && git -C /home/user/plugins/claude-mods reset -q --hard origin/main || true
else
  GIT_TERMINAL_PROMPT=0 git clone -q --depth 1 https://github.com/ricky94511/claude-mods /home/user/plugins/claude-mods || true
fi

if [ -d /home/user/plugins/claude-mods/handoff ]; then
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / ".claude/settings.json"
d = json.loads(p.read_text()) if p.exists() else {}
env = d.setdefault("env", {})
dirs = [x for x in env.get("CLAUDE_CODE_PLUGIN_DIRS", "").split(":") if x]
if "/home/user/plugins/claude-mods/handoff" not in dirs:
    dirs.append("/home/user/plugins/claude-mods/handoff")
env["CLAUDE_CODE_PLUGIN_DIRS"] = ":".join(dirs)
cmd = "git -C /home/user/plugins/claude-mods pull -q --ff-only origin main 2>/dev/null || true"
starts = d.setdefault("hooks", {}).setdefault("SessionStart", [])
if not any(h.get("command") == cmd for s in starts for h in s.get("hooks", [])):
    starts.append({"hooks": [{"type": "command", "command": cmd}]})
p.write_text(json.dumps(d, indent=2))
PY
fi

exit 0
```

改完開新的雲端對話才會生效。
