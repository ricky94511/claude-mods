import type { Proposal } from '../types'

export type Message = { at: string; text: string }
export type Session = { id: string; title: string; project: string; start: string; source: '本機' | '雲端'; messages: Message[] }
export type Inventory = { hooks: string[]; pluginDirs: string[]; skills: string[] }

export const START = '<<<Mod 提案開始>>>'
export const END = '<<<Mod 提案結束>>>'
const MAX_CHARS = 500

// 跟 scripts/collect.py 的 SECRET 同一套：金鑰、token、密碼先遮掉，模型看不到原文
const SECRET = new RegExp(
  [
    'sk-[A-Za-z0-9_\\-]{12,}',
    'gh[pousr]_[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    'xox[abprs]-[A-Za-z0-9\\-]{10,}',
    'AKIA[0-9A-Z]{16}',
    'AIza[0-9A-Za-z_\\-]{30,}',
    'eyJ[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}',
    '[Bb]earer\\s+[A-Za-z0-9._\\-]{16,}',
    '(?:[Pp]assword|[Pp]asswd|[Ss]ecret|[Tt]oken|[Aa]pi[_-]?[Kk]ey)\\s*[:=]\\s*\\S+',
    '\\b[A-Fa-f0-9]{32,}\\b',
    '\\b[A-Za-z0-9+/]{40,}={0,2}',
  ].join('|'),
  'g',
)

export const redact = (text: string) => text.replace(SECRET, '<已遮蔽>')

// 系統或外掛塞進對話的內容，不是使用者打的
const NOISE = ['<', 'Caveat:', '[Request interrupted', 'This is how Claude Code surfaces', 'The handoff plugin sent']

export function cleanHuman(text: string): string | null {
  const plain = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (!plain || NOISE.some(prefix => plain.startsWith(prefix))) return null
  return redact(plain).slice(0, MAX_CHARS)
}

// MCP 回傳的文字可能被包在說明文字裡，取最外層的 JSON
export function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

type Event = { created_at?: string; user?: { internal_anthropic_catchall?: Record<string, unknown> } }

// list_events（kinds: user）的一頁：tool_result 也算 user，只留人打的字
export function humanFromEvents(events: readonly Event[]): Message[] {
  const out: Message[] = []
  for (const event of events) {
    const row = event.user?.internal_anthropic_catchall
    if (!row || row.isSynthetic || row.isMeta) continue
    const origin = row.origin as { kind?: string } | undefined
    if (origin?.kind && origin.kind !== 'human') continue
    const content = (row.message as { content?: unknown } | undefined)?.content
    let text: string | null = null
    if (typeof content === 'string') text = content
    else if (Array.isArray(content) && !content.some(b => (b as { type?: string })?.type === 'tool_result')) {
      text = content
        .filter(b => (b as { type?: string })?.type === 'text')
        .map(b => String((b as { text?: unknown }).text ?? ''))
        .join('\n')
    }
    const clean = text === null ? null : cleanHuman(text)
    if (clean) out.push({ at: String(event.created_at ?? '').slice(0, 16), text: clean })
  }
  return out
}

// 「https://github.com/ricky94511/shorts-studio」→「shorts-studio」；沒有 repo 就用標題的 [類別]
export function projectOf(session: Record<string, unknown>): string {
  const context = session.session_context as { sources?: { git_repository?: { url?: string } }[] } | undefined
  const url = context?.sources?.[0]?.git_repository?.url
  if (url) return url.replace(/\.git$/, '').split('/').pop() ?? url
  const category = String(session.title ?? '').match(/^\[([^\]]+)\]/)
  return category ? category[1]! : '（無專案）'
}

// 本機路徑只留最後一段，比較好讀
const shortProject = (project: string) => project.split(/[\\/]/).filter(Boolean).pop() ?? project

export function buildDigest(sessions: readonly Session[], inventory: Inventory | null, notes: readonly string[]): string {
  const lines = [
    '# Mod 探勘：最近對話的原話整理',
    '',
    `共 ${sessions.length} 次對話、${sessions.reduce((n, s) => n + s.messages.length, 0)} 句使用者訊息。只收使用者親手打的字；金鑰、token、密碼已遮蔽成 <已遮蔽>。`,
    '每句格式：`- 日期時間｜原話`，標題列有專案與來源。',
    ...notes.map(note => `> ${note}`),
    '',
  ]
  if (inventory) {
    lines.push('## 已經有的 Hook／外掛／Skill（提案不要跟這些重複）', '')
    lines.push(`- 設定裡的 Hook 事件：${inventory.hooks.join('、') || '（無）'}`)
    lines.push(`- 載入的外掛：${inventory.pluginDirs.map(shortProject).join('、') || '（無）'}`)
    lines.push(`- 使用者的 Skill：${inventory.skills.join('、') || '（無）'}`, '')
  }
  for (const session of sessions) {
    lines.push(`## ${session.start.slice(0, 10)}｜${shortProject(session.project)}｜${session.title || '（無標題）'}（${session.source}）`, '')
    for (const message of session.messages) lines.push(`- ${message.at.replace('T', ' ')}｜${message.text.replace(/\s*\n\s*/g, ' / ')}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function analysisPrompt(digestPath: string, count: number): string {
  return `請幫我找出最值得做的 Claude Code mod。不要寫任何程式，只做分析。

1. 讀我最近 ${count} 次對話的原話整理：${digestPath}（Mod 探勘已經從對話紀錄抽好，只有我親手打的字；整份讀完再分析）。
2. 找三種訊號：
 - 我一直重複交代的事：同一個提醒或要求出現 3 次以上（不能只用關鍵字精確比對，同義和變體說法要算同一件，例如「我說過」「我也說過」「講過了」）
 - 讓我緊張的動作：我要求你先停下來、先給我看、或事後追問「你剛剛刪了什麼」的動作，例如刪檔、推 code、改設定
 - 我檢查成果的固定動作：例如每次都叫你跑測試、問花了多少、問改了哪些檔
3. 每個訊號先判斷：用 Hook 或 Skill 能不能做到？能的話列在「不需要 mod」，說明用哪個就好、為什麼。整理檔開頭列了我已經有的 Hook／外掛／Skill，已經解決的不要再提。
4. 剩下的，提出最多 5 個 mod 提案，每個寫：
 - 名稱與一句話功能
 - 證據：引用 2 句以上我在對話裡說過的原話，標明是哪一天、哪個專案
 - 插手位置：動作前／取代動作／動作後／前後包住，以及插手後要放行、改內容再放行、還是擋下
 - 用到的能力：在畫面上多一塊／記得前面發生的事／停下來問我／改掉你的輸出或行為
 - 為什麼 Hook 或 Skill 做不到
 - 資料要不要跨對話保存
5. 依「每週能幫我省下幾次重複動作」排序，每個提案寫出估計的次數。

讀紀錄時遇到金鑰、密碼、token 這類內容，不要引用也不要列出。

格式：先寫「不需要 mod」那一段，再把提案整段放在 ${START} 和 ${END} 之間，每個提案用「### 提案 N：名稱」當標題（N 從 1 開始）。全部用繁體中文。寫完就停，先不要做任何一個，我挑了再做。`
}

export function buildPrompt(proposal: Proposal): string {
  return `幫我做第 ${proposal.number} 個 Mod 提案「${proposal.name}」，內容照上面 Mod 探勘報告裡的提案。

- 先載入 plugin-authoring skill，先給我設計稿（畫面、資料存哪、什麼時候插手），我確認後再寫
- 對話標題改成「[Mod] ${proposal.name}」，加 mod、claude-設定 標籤
- 寫完要跑 validate 和測試，結果照實跟我說
- 做完之後，用選項問我要不要永久保存（推到 GitHub 的 claude-mods repo，雲端 setup script 也要加上），我說要才推`
}

export function parseProposals(answer: string): Proposal[] | null {
  const start = answer.indexOf(START)
  const end = answer.indexOf(END, start + START.length)
  if (start < 0 || end < 0) return null
  const proposals: Proposal[] = []
  for (const match of answer.slice(start + START.length, end).matchAll(/^#{2,4}\s*提案\s*(\d+)\s*[:：]\s*(.+?)\s*$/gm)) {
    const name = match[2]!.replace(/[*`]/g, '').trim()
    if (name) proposals.push({ number: Number(match[1]), name })
  }
  return proposals.slice(0, 5)
}

// 「做 3」「3」「第3個」→ 3
export function pickNumber(args: string): number | null {
  const match = args.match(/(\d+)/)
  return match ? Number(match[1]) : null
}
