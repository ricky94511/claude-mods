# claude-mods

Ricky 的 Claude Code mods。

## handoff：一鍵交接

上下文用量到門檻（預設 55%）時，輸入框上方會出現「🔄 交接到新對話」按鈕。按下去之後：

1. Claude 寫一份交接摘要（目標、已完成、還沒做的、改過的檔案、要注意的地方）
2. 摘要顯示在輸入框上方預覽，按「✅ 送出並交接」才繼續，按「取消」就不交接
3. 自動 `/clear`，標題改成「原標題（續N）」
4. 摘要當成清空後的第一句送出

觸發方式：
- 自動：用量到門檻時出現按鈕
- 指令：`/handoff`
- 直接說：「幫我交接」「開新對話接續」「context 快滿了換一個」等等，由 Claude 判斷

設定（`/config` 裡的 handoff 項目）：
- `threshold`：門檻百分比，預設 55
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
