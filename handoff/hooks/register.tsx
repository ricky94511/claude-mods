import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pending, Phase } from '../types'

const phase = atom({ plugin: 'handoff', key: 'phase' } as const, 'idle' as Phase)
const percent = atom({ plugin: 'handoff', key: 'percent' } as const, null as number | null)
const isHidden = atom({ plugin: 'handoff', key: 'isHidden' } as const, false)
const pending = atom({ plugin: 'handoff', key: 'pending' } as const, null as Pending | null)
const isNotified = atom({ plugin: 'handoff', key: 'isNotified' } as const, false)

const START = '<<<交接開始>>>'
const END = '<<<交接結束>>>'
const REMOTE = 'claude-code-remote'

const SUMMARY_PROMPT = `請為這段對話寫一份交接摘要，接下來會清空對話，把摘要當成新對話的第一句，所以要讓沒看過前文的你也能直接接手。

照下面這個格式輸出，前面不要加任何文字：

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

在 ${END} 後面另起一行，原樣寫：「👆 這是交接預覽。沒問題就說「送出」（或輸入 /handoff 送出），要取消就說「取消」。」

要求：精簡但不要漏掉關鍵細節（指令、路徑、錯誤訊息照原文），全部用繁體中文。`

const USAGE = '交接指令：/handoff（開始）、/handoff 送出、/handoff 取消、/handoff 重來'

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


// 雲端對話用桌機 app 看時，mod 畫不出任何畫面（surfaces 是空的），預覽和確認都要在對話裡進行
async function hasSurface($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

// 指令（/handoff）的 hook 還沒結束前不能送出 prompt 或跑 /clear，要等它結束再做
function afterCommand($: EngineInterface, work: () => Promise<void>) {
  $.clock.after(50, () => void work().catch(() => $.ui.toast('交接中途出錯，可以用 /handoff 重來')))
}

async function start($: EngineInterface) {
  await update($, phase, () => 'writing')
  $.ui.status('交接：正在寫摘要…')
  void $.prompt.submit({ text: SUMMARY_PROMPT })
}

// 摘要寫好後先停在預覽：對話裡看得到摘要，輸入框上方也有按鈕（有畫面時）；確認了才清空並交接
async function finish($: EngineInterface, answer: string, autoSend: boolean) {
  const summary = extract(answer)
  if (!summary) {
    await reset($)
    $.ui.toast('交接失敗：找不到摘要格式，可以用 /handoff 重來')
    return
  }

  const remote = await remoteSession($)
  const { title, segment } = nextTitle(remote?.title || summary.title || '未命名對話')
  const text = `【交接】接續上一段對話（第 ${segment} 段）。以下是交接摘要，請先確認理解，再從「還沒做的」第一項開始。標題已經改好，不用再改。\n\n${summary.body}`

  await $.store.set('last', { title, text, at: await $.clock.now() })
  await update($, pending, () => ({ title, text }))
  $.ui.status(undefined)

  if (autoSend) {
    await handOver($)
  } else {
    await update($, phase, () => 'preview')
  }
}

async function handOver($: EngineInterface) {
  const ready = await read($, pending)
  if (!ready) return
  await update($, phase, () => 'switching')
  await $.command.run({ command: 'clear' })

  try {
    const remote = await remoteSession($)
    if (remote) {
      await $.mcp.call(REMOTE, 'set_session_title', { session_id: remote.id, title: ready.title })
    } else {
      await $.command.run({ command: 'rename', args: ready.title })
    }
  } catch {
    $.ui.toast(`標題沒改成功，請手動改成：${ready.title}`)
  }

  void $.prompt.submit({ text: ready.text, asUser: true })
  await reset($)
  $.ui.toast(`已交接到「${ready.title}」`)
}

async function reset($: EngineInterface) {
  await update($, phase, () => 'idle')
  await update($, pending, () => null)
  await update($, percent, () => null)
  await update($, isHidden, () => false)
  await update($, isNotified, () => false)
  $.ui.status(undefined)
}

export const register: Register = (on, options) => {
  const threshold = Number(options.threshold ?? 55)
  const autoSend = options.autoSend === true

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'handoff', description: '一鍵交接：寫摘要 → 預覽 → 清空對話並送出', argumentHint: '[送出|取消|重來]' })
    await $.tool.register({
      name: 'start',
      description:
        '使用者要求把目前工作交接到新對話時呼叫：各種說法都算，例如「幫我交接」「交接一下」「開新對話接續」「換個對話繼續」「context 快滿了換一個」。' +
        '只是在討論交接功能本身（例如寫或修改這個 mod）時不要呼叫。呼叫後，照回傳的格式把交接摘要寫在這一輪最後的回覆裡。',
    })
    await $.tool.register({
      name: 'confirm',
      description:
        '只在剛寫完交接預覽、正在等使用者確認時呼叫。使用者同意送出（「送出」「好」「OK」「可以」「沒問題」「交接吧」等）用 action=send；' +
        '使用者不要了（「取消」「先不要」「算了」「不用了」等）用 action=cancel。使用者是要修改摘要內容時不要呼叫，直接照他說的重寫一份完整的交接預覽。',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['send', 'cancel'] } },
        required: ['action'],
      },
    })
    return next(e)
  })

  // 使用者用自然語言說要交接：由 Claude 判斷意圖後呼叫，摘要直接寫在同一輪的回覆
  on('tool.call', { tool: 'mcp__handoff__start' }, async $ => {
    try {
      const state = await read($, phase)
      if (state === 'preview') return { result: '已經有一份交接預覽在等確認。請提醒使用者說「送出」或「取消」，或用 /handoff 重來。' }
      if (state !== 'idle' && state !== 'writing') return { result: '交接正在進行中，不用再呼叫。' }
      await update($, phase, () => 'writing')
      $.ui.status('交接：正在寫摘要…')
      return { result: SUMMARY_PROMPT }
    } catch {
      return { isError: true, result: '交接啟動失敗，請改用 /handoff' }
    }
  })

  on('tool.call', { tool: 'mcp__handoff__confirm' }, async ($, e) => {
    try {
      if ((await read($, phase)) !== 'preview') return { result: '現在沒有等確認的交接預覽，不用呼叫。' }
      if (e.action === 'cancel') {
        await reset($)
        return { result: '已取消交接，對話保持原樣。請用一句話告訴使用者已取消。' }
      }
      // 這一輪結束後才清空：turn.complete 會接手
      await update($, phase, () => 'confirmed')
      return { result: '已確認。這一輪結束後會清空對話、改標題並送出摘要。請只回一句「好，交接中…」。' }
    } catch {
      return { isError: true, result: '確認失敗，請改用 /handoff 送出' }
    }
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    const state = await read($, phase)

    if (/^(送出|確認|好|ok|send)$/i.test(arg)) {
      if (state !== 'preview') return { text: `現在沒有等確認的交接預覽。${USAGE}` }
      afterCommand($, () => handOver($))
      return { text: '好，正在清空對話並送出摘要…' }
    }
    if (/^(取消|cancel)$/i.test(arg)) {
      await reset($)
      return { text: '已取消交接，對話保持原樣。' }
    }
    if (/^(重來|重新|reset)$/i.test(arg) || state === 'idle') {
      await reset($)
      afterCommand($, () => start($))
      return { text: '開始交接，正在請 Claude 寫摘要…' }
    }
    if (state === 'preview') return { text: `上面已經有一份交接預覽在等確認。${USAGE}` }
    return { text: `交接正在進行中（${state}）。卡住的話用 /handoff 重來。` }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    const state = await read($, phase)

    if (state === 'writing') {
      if (e.isAborted) await reset($)
      // 等這一輪真正結束再處理，hook 裡不能直接跑 /clear
      else void finish($, e.answer, autoSend).catch(() => $.ui.toast('交接中途出錯，可以用 /handoff 重來'))
      return result
    }
    if (state === 'confirmed') {
      void handOver($).catch(() => $.ui.toast('交接中途出錯，可以用 /handoff 重來'))
      return result
    }

    const { context } = await $.session.usage()
    await update($, percent, () => context.percent ?? null)
    return result
  })

  // 沒有畫面可以放按鈕時，用量過門檻就請 Claude 在回覆裡提醒一次
  on('prompt.submit', async ($, e, next) => {
    const current = await read($, percent)
    const isDue = current !== null && current >= threshold && (await read($, phase)) === 'idle' && !(await read($, isNotified))
    if (!isDue || e.origin?.kind === 'plugin' || (await hasSurface($))) return next(e)
    await update($, isNotified, () => true)
    const hint = `（handoff 提醒）上下文已用 ${current}%。請在這次回覆的最後另起一行提醒使用者：上下文已用 ${current}%，要交接可以說「幫我交接」或輸入 /handoff。`
    return next({ ...e, context: [...(e.context ?? []), hint] })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, percent)
    const state = await read($, phase)
    const isQuiet =
      e.props.hasSurvey ||
      (state === 'idle' && (current === null || current < threshold || (await read($, isHidden))))

    if (isQuiet) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    if (state === 'preview') {
      return (
        <Box>
          <Text>交接預覽在上面　</Text>
          <Button key="send" label="✅ 送出並交接" variant="primary" onPress={() => handOver($)} />
          <Text> </Text>
          <Button key="cancel" label="取消" onPress={() => reset($)} />
        </Box>
      )
    }

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
