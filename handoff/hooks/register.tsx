import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Phase } from '../types'

const phase = atom({ plugin: 'handoff', key: 'phase' } as const, 'idle' as Phase)
const percent = atom({ plugin: 'handoff', key: 'percent' } as const, null as number | null)
const isHidden = atom({ plugin: 'handoff', key: 'isHidden' } as const, false)

const START = '<<<交接開始>>>'
const END = '<<<交接結束>>>'
const REMOTE = 'claude-code-remote'

const SUMMARY_PROMPT = `請為這段對話寫一份交接摘要，接下來會清空對話，把摘要當成新對話的第一句，所以要讓沒看過前文的你也能直接接手。

只輸出下面這個格式，前後不要加任何其他文字：

${START}
標題：[類別] 主題（沿用這個對話的主題，不要加「續」）
## 目標
## 已完成
## 還沒做的
（依優先順序，第一項就是新對話要先做的事）
## 改過的檔案
（完整路徑，每個附一句改了什麼）
## 要注意的地方
（踩過的坑、已經做的決定和原因、使用者的偏好）
${END}

要求：精簡但不要漏掉關鍵細節（指令、路徑、錯誤訊息照原文），全部用繁體中文。`

type Remote = { id: string; title: string } | null

// 雲端 session 才有 claude-code-remote；桌機呼叫會失敗，回傳 null
async function remoteSession($: EngineInterface): Promise<Remote> {
  try {
    const { content, isError } = await $.mcp.call(REMOTE, 'get_session', {})
    if (isError) return null
    const text = content.find(c => c.type === 'text' && c.text)?.text
    if (!text) return null
    const data = JSON.parse(text) as Record<string, unknown>
    const session = (data.ccr ?? data.session ?? data) as Record<string, unknown>
    const id = String(session.id ?? session.session_id ?? '')
    return id ? { id, title: String(session.title ?? '') } : null
  } catch {
    return null
  }
}

// 「[Mod] 主題（續3）」→ 主題「[Mod] 主題」、下一段是 4；沒有「續」的是第 1 段
function nextTitle(base: string): { title: string; segment: number } {
  const match = base.match(/（續(\d*)）\s*$/)
  const segment = match ? Number(match[1] || 1) + 1 : 2
  const plain = base.replace(/（續\d*）\s*$/, '').trim()
  return { title: `${plain}（續${segment}）`, segment }
}

function extract(answer: string): { title: string; body: string } | null {
  const start = answer.indexOf(START)
  const end = answer.indexOf(END, start + START.length)
  if (start < 0 || end < 0) return null
  const inner = answer.slice(start + START.length, end).trim()
  const [first = '', ...rest] = inner.split('\n')
  const titled = first.match(/^標題[:：]\s*(.+)$/)
  return titled ? { title: titled[1]!.trim(), body: rest.join('\n').trim() } : { title: '', body: inner }
}

async function start($: EngineInterface) {
  if ((await read($, phase)) !== 'idle') return
  await update($, phase, () => 'writing')
  $.ui.status('交接：正在寫摘要…')
  void $.prompt.submit({ text: SUMMARY_PROMPT })
}

async function finish($: EngineInterface, answer: string, autoSend: boolean) {
  const summary = extract(answer)
  if (!summary) {
    await update($, phase, () => 'idle')
    $.ui.status(undefined)
    $.ui.toast('交接失敗：找不到摘要格式，可以再按一次')
    return
  }
  await update($, phase, () => 'switching')

  const remote = await remoteSession($)
  const { title, segment } = nextTitle(remote?.title || summary.title || '未命名對話')
  const text = `【交接】接續上一段對話（第 ${segment} 段）。以下是交接摘要，請先確認理解，再從「還沒做的」第一項開始。\n\n${summary.body}`

  await $.store.set('last', { title, text, at: await $.clock.now() })
  await $.command.run({ command: 'clear' })

  try {
    if (remote) {
      await $.mcp.call(REMOTE, 'set_session_title', { session_id: remote.id, title })
    } else {
      await $.command.run({ command: 'rename', args: title })
    }
  } catch {
    $.ui.toast(`標題沒改成功，請手動改成：${title}`)
  }

  if (autoSend) {
    void $.prompt.submit({ text, asUser: true })
  } else {
    const { isFilled } = await $.prompt.fill({ text })
    if (!isFilled) void $.prompt.submit({ text, asUser: true })
  }

  await update($, phase, () => 'idle')
  await update($, percent, () => null)
  await update($, isHidden, () => false)
  $.ui.status(undefined)
  $.ui.toast(autoSend ? `已交接到「${title}」` : `已交接到「${title}」，摘要在輸入框，確認後按 Enter 送出`)
}

export const register: Register = (on, options) => {
  const threshold = Number(options.threshold ?? 55)
  const autoSend = options.autoSend === true

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'handoff', description: '一鍵交接：寫摘要、清空對話、送進新對話' })
    await $.tool.register({
      name: 'start',
      description:
        '使用者要求把目前工作交接到新對話時呼叫：各種說法都算，例如「幫我交接」「交接一下」「開新對話接續」「換個對話繼續」「context 快滿了換一個」。' +
        '只是在討論交接功能本身（例如寫或修改這個 mod）時不要呼叫。呼叫後，照回傳的格式把交接摘要寫在這一輪最後的回覆裡。',
    })
    return next(e)
  })

  // 使用者用自然語言說要交接：由 Claude 判斷意圖後呼叫這個工具，摘要直接寫在同一輪的回覆
  on('tool.call', { tool: 'mcp__handoff__start' }, async $ => {
    try {
      if ((await read($, phase)) !== 'idle') return { result: '交接已經在進行中，不用再呼叫。' }
      await update($, phase, () => 'writing')
      $.ui.status('交接：正在寫摘要…')
      return { result: SUMMARY_PROMPT, text: SUMMARY_PROMPT }
    } catch {
      return { isError: true, result: '交接啟動失敗，請改用 /handoff' }
    }
  })

  on('command.run', { command: 'handoff' }, async $ => {
    await start($)
    return { text: '開始交接，正在請 Claude 寫摘要…' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result

    if ((await read($, phase)) === 'writing') {
      if (e.isAborted) {
        await update($, phase, () => 'idle')
        $.ui.status(undefined)
      } else {
        // 等這一輪真正結束再清空，hook 裡不能直接跑 /clear
        void finish($, e.answer, autoSend).catch(() => $.ui.toast('交接中途出錯，可以用 /handoff 再試一次'))
      }
      return result
    }

    const { context } = await $.session.usage()
    await update($, percent, () => context.percent ?? null)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, percent)
    const state = await read($, phase)
    const isQuiet =
      e.props.hasSurvey ||
      (state === 'idle' && (current === null || current < threshold || (await read($, isHidden))))

    if (isQuiet) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    if (state !== 'idle') {
      return (
        <Box>
          <Text dimColor>{state === 'writing' ? '交接中：Claude 正在寫摘要…' : '交接中：正在切換到新對話…'}</Text>
        </Box>
      )
    }

    return (
      <Box>
        <Text dimColor>上下文已用 {current}%　</Text>
        <Button key="go" label="🔄 交接到新對話" variant="primary" onPress={() => start($)} />
        <Text> </Text>
        <Button key="later" label="稍後" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
