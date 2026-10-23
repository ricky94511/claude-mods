import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pending, Phase } from '../types'

const phase = atom({ plugin: 'handoff', key: 'phase' } as const, 'idle' as Phase)
// 上下文用了多少 token（最近一次回應的輸入量）
const used = atom({ plugin: 'handoff', key: 'usedTokens' } as const, null as number | null)
const isHidden = atom({ plugin: 'handoff', key: 'isHidden' } as const, false)
const pending = atom({ plugin: 'handoff', key: 'pending' } as const, null as Pending | null)
// 用到這麼多 token 時跳出詢問；null 表示用設定的門檻
const askAt = atom({ plugin: 'handoff', key: 'nextAskTokens' } as const, null as number | null)
// 交接後要保住的新標題，第一輪結束時檢查一次
const retitle = atom({ plugin: 'handoff', key: 'retitle' } as const, null as string | null)

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

const SEND = '✅ 送出並交接'
const CANCEL = '❌ 取消'
const NOW = '🔄 現在交接'
const LATER = '稍後（再多用 1.5 萬 token 時再問）'
const NEVER = '這個對話不要再問'

const USAGE = '交接指令：/handoff（開始）、/handoff 送出、/handoff 取消、/handoff 重來'

// 改標題要走 app 自己的工具：/rename 只改 Claude Code 記的名稱，桌機 app 側邊欄不會跟著變
const DESKTOP = 'ccd_session_mgmt'

type Session = { server: string; id: string; title: string } | null

// 雲端 session 用 claude-code-remote，桌機 app 用 ccd_session_mgmt；都連不到（例如純終端機）回傳 null
async function currentSession($: EngineInterface): Promise<Session> {
  const servers: [string, Record<string, unknown>][] = [
    [REMOTE, {}],
    [DESKTOP, { session_id: 'self' }],
  ]
  for (const [server, args] of servers) {
    try {
      const { content, isError } = await $.mcp.call(server, 'get_session', args)
      if (isError) continue
      const text = content.find(c => c.type === 'text' && c.text)?.text
      if (!text) continue
      const data = JSON.parse(text) as Record<string, unknown>
      const session = (data.ccr ?? data.session ?? data) as Record<string, unknown>
      const id = String(session.id ?? session.session_id ?? session.sessionId ?? '')
      if (id) return { server, id: server === DESKTOP ? 'self' : id, title: String(session.title ?? '') }
    } catch {
      // 這個環境沒有這個 server，換下一個
    }
  }
  return null
}

// 有 app 的改名工具就用它，沒有才退回 /rename；回傳 false 表示改名失敗
async function setTitle($: EngineInterface, title: string): Promise<boolean> {
  const session = await currentSession($)
  if (session) {
    try {
      const { isError } = await $.mcp.call(session.server, 'set_session_title', { session_id: session.id, title })
      if (!isError) return true
    } catch {
      // 退回 /rename
    }
  }
  try {
    await $.command.run({ command: 'rename', args: title })
    return !session
  } catch {
    return false
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


// 指令和這一輪結束的 hook 裡不能等人回答或送出 prompt：
// 指令還沒結束時送出會被擋；turn.complete 裡的工作超過 60 秒就會被丟掉（等人選對話框常常超過）。
// 所以都等 hook 結束後，用計時器另外開始。
function detach($: EngineInterface, work: () => Promise<void>) {
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

  const session = await currentSession($)
  const { title, segment } = nextTitle(session?.title || summary.title || '未命名對話')
  const text = `【交接】接續上一段對話（第 ${segment} 段）。以下是交接摘要，請先確認理解，再從「還沒做的」第一項開始。標題已經改好，不用再改。\n\n${summary.body}`

  await $.store.set('last', { title, text, at: await $.clock.now() })
  await update($, pending, () => ({ title, text }))
  $.ui.status(undefined)

  if (autoSend) {
    await handOver($)
  } else {
    await update($, phase, () => 'preview')
    await askConfirm($, title)
  }
}

// 用系統自己的詢問對話框確認（跟 fupan 一樣，雲端用桌機 app 看也會跳出來）；
// 對話框被關掉時，還是可以在對話裡說「送出」或用 /handoff 送出
async function askConfirm($: EngineInterface, title: string) {
  let choice: string
  try {
    choice = await $.ui.ask(`交接預覽在上面，新標題會是「${title}」。要送出嗎？想修改就在下方直接寫要改什麼。`, {
      header: '交接',
      options: [SEND, CANCEL],
    })
  } catch {
    return
  }
  if ((await read($, phase)) !== 'preview') return
  if (choice === SEND) return handOver($)
  if (choice === CANCEL) {
    await reset($)
    $.ui.toast('已取消交接')
    return
  }
  // 其他文字就是修改意見：請 Claude 照著重寫，寫完會再問一次
  await update($, phase, () => 'writing')
  void $.prompt.submit({
    text: `請依照這個意見修改交接預覽，重新輸出完整格式（從 ${START} 到 ${END}，最後一樣加上確認提示）：${choice}`,
  })
}

// 用量到門檻時自動跳出詢問
// 15 萬 → 「15 萬」、123456 → 「12.3 萬」
const wan = (tokens: number) => `${Number((tokens / 10000).toFixed(1))} 萬`

async function askStart($: EngineInterface, current: number, step: number) {
  await update($, askAt, () => Number.MAX_SAFE_INTEGER)
  let choice: string
  try {
    choice = await $.ui.ask(`上下文已用 ${wan(current)} token。要現在把工作交接到新對話嗎？`, {
      header: '交接',
      options: [NOW, LATER, NEVER],
    })
  } catch {
    await update($, askAt, () => current + step)
    return
  }
  if (choice === NOW) return start($)
  if (choice === NEVER) return
  await update($, askAt, () => current + step)
}

// 雲端對話不能原地 /clear：容器重啟時會接回清空前的對話，交接等於白做。
// 改成開一個新的雲端對話送出摘要，再封存舊的；開不成才退回 /clear
async function openNew($: EngineInterface, session: NonNullable<Session>, ready: Pending): Promise<boolean> {
  try {
    const { content, isError } = await $.mcp.call(REMOTE, 'create_session', { prompt: ready.text, title: ready.title })
    if (isError) return false
    const text = content.find(c => c.type === 'text' && c.text)?.text ?? ''
    const data = JSON.parse(text) as Record<string, unknown>
    const created = (data.ccr ?? data.session ?? data) as Record<string, unknown>
    if (!String(created.id ?? created.session_id ?? '')) return false
  } catch {
    return false
  }
  await reset($)
  $.ui.toast(`已開新對話「${ready.title}」，請到對話清單切過去；這個對話會封存`)
  // 封存會收掉這個容器，放在最後
  try {
    await $.mcp.call(REMOTE, 'archive_session', { session_id: session.id })
  } catch {
    $.ui.toast('舊對話沒封存成功，請手動封存')
  }
  return true
}

async function handOver($: EngineInterface) {
  const ready = await read($, pending)
  if (!ready) return
  await update($, phase, () => 'switching')
  const session = await currentSession($)
  if (session?.server === REMOTE && (await openNew($, session, ready))) return
  await $.command.run({ command: 'clear' })

  // 先送出再改標題：app 會依新對話的第一句自動取標題，先改的話可能被蓋掉
  void $.prompt.submit({ text: ready.text, asUser: true })
  if (!(await setTitle($, ready.title))) $.ui.toast(`標題沒改成功，請手動改成：${ready.title}`)
  // 這一輪結束時再檢查一次，被自動標題蓋掉就改回來
  await update($, retitle, () => ready.title)
  await reset($)
  $.ui.toast(`已交接到「${ready.title}」`)
}

async function reset($: EngineInterface) {
  await update($, phase, () => 'idle')
  await update($, pending, () => null)
  await update($, used, () => null)
  await update($, isHidden, () => false)
  $.ui.status(undefined)
}

export const register: Register = (on, options) => {
  const threshold = Number(options.thresholdTokens ?? 150000)
  const step = Math.round(threshold / 10)
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
      detach($, () => handOver($))
      return { text: '好，正在清空對話並送出摘要…' }
    }
    if (/^(取消|cancel)$/i.test(arg)) {
      await reset($)
      return { text: '已取消交接，對話保持原樣。' }
    }
    if (/^(重來|重新|reset)$/i.test(arg) || state === 'idle') {
      await reset($)
      detach($, () => start($))
      return { text: '開始交接，正在請 Claude 寫摘要…' }
    }
    if (state === 'preview') return { text: `上面已經有一份交接預覽在等確認。${USAGE}` }
    return { text: `交接正在進行中（${state}）。卡住的話用 /handoff 重來。` }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    const state = await read($, phase)

    const wanted = await read($, retitle)
    if (wanted && state === 'idle') {
      await update($, retitle, () => null)
      detach($, async () => {
        const session = await currentSession($)
        if (session && session.title !== wanted) await setTitle($, wanted)
      })
    }

    if (state === 'writing') {
      if (e.isAborted) await reset($)
      // 等這一輪真正結束再處理，hook 裡不能直接跑 /clear
      else detach($, () => finish($, e.answer, autoSend))
      return result
    }
    if (state === 'confirmed') {
      detach($, () => handOver($))
      return result
    }

    const { context } = await $.session.usage()
    const current = context.tokens ?? null
    await update($, used, () => current)
    const due = (await read($, askAt)) ?? threshold
    if (current !== null && current >= due && !e.isAborted) {
      detach($, () => askStart($, current, step))
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, used)
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
        <Text dimColor>上下文已用 {wan(current ?? 0)} token　</Text>
        <Button key="go" label="🔄 交接到新對話" variant="primary" onPress={() => start($)} />
        <Text> </Text>
        <Button key="later" label="稍後" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
