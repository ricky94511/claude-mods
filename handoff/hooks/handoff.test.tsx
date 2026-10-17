import type { On, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// 測試底下沒有引擎，把插件會用到的引擎功能補上
const toasts: string[] = []

let clock: ReturnType<typeof mock.clock>
// 詢問對話框的回答：依序取用；null 表示使用者把對話框關掉
let picks: (string | null)[] = []
const asked: string[] = []

function engine(on: On, used: { value: number }, surfaces: string[] = ['desktop']) {
  clock = mock.clock(on)
  on('session.surfaces', () => ({ value: surfaces }) as never)
  picks = []
  asked.length = 0
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = String((e as unknown as { questions: { question: string }[] }).questions[0]?.question)
    asked.push(question)
    const pick = picks.shift() ?? null
    if (pick === null) return { isError: true, result: 'dismissed', text: 'dismissed' } as never
    return { result: { questions: (e as never as { questions: unknown }).questions, answers: { [question]: pick } }, text: pick } as never
  })
  mock.store(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 100, tokens: used.value, percent: used.value }, rateLimits: [] } }))
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    toasts.push(String((e as { text?: string }).text ?? ''))
    return { value: undefined } as never
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

const turn = (answer: string) => ({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' }) as never

const band0 = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 } as unknown as RenderPropsOf['AbovePrompt']

const ANSWER = `好的。
<<<交接開始>>>
標題：[Mod] 一鍵交接
## 目標
做交接 mod
## 已完成
寫好 register.tsx
## 還沒做的
1. 實測
## 改過的檔案
- hooks/register.tsx：主程式
## 要注意的地方
無
<<<交接結束>>>`

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}：用量過門檻才出現交接按鈕`, async ($, on) => {
    const used = { value: 30 }
    engine(on, used)
    await $.turn.complete(turn('ok'))
    const low = await $.ui.mount({ plugin: 'handoff', surface, component: 'AbovePrompt', props: band0 })
    expect(await low.find({ key: 'go' })).toBeUndefined()

    used.value = 60
    await $.turn.complete(turn('ok'))
    const high = await $.ui.mount({ plugin: 'handoff', surface, component: 'AbovePrompt', props: band0 })
    expect(await high.find({ key: 'go' })).toBeDefined()
  })
}

for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
  test(`${surface}：摘要先在輸入框上方預覽，按送出才清空、改標題、送進新對話`, async ($, on) => {
    engine(on, { value: 60 })
    const commands: string[] = []
    let sent = ''
    on('command.run', ($, e) => {
      commands.push(`${e.command} ${e.args}`.trim())
      return {}
    })
    on('prompt.submit', ($, e) => {
      sent = e.text
      return { text: e.text } as never
    })

    const started = await $.tool.call({ tool: 'mcp__handoff__start' } as never)
    expect(JSON.stringify(started)).toContain('<<<交接開始>>>')

    await $.turn.complete(turn(ANSWER))
    await clock.advance(100)
    let band = await $.ui.mount({ plugin: 'handoff', surface, component: 'AbovePrompt', props: band0 })
    for (let i = 0; i < 500 && !(await band.find({ key: 'send' })); i++) {
      band = await $.ui.mount({ plugin: 'handoff', surface, component: 'AbovePrompt', props: band0 })
    }

    expect(await band.find({ key: 'send' })).toBeDefined()
    expect(commands).toEqual([])

    await band.press({ key: 'send' })
    for (let i = 0; i < 500 && !sent; i++) await Promise.resolve()

    expect(commands).toEqual(['clear', 'rename [Mod] 一鍵交接（續2）'])
    expect(sent).toContain('## 還沒做的')
    expect(sent).not.toContain('標題：')
  })
}

test('預覽時按取消，不會清空對話', async ($, on) => {
  engine(on, { value: 60 })
  const commands: string[] = []
  on('command.run', ($, e) => {
    commands.push(e.command)
    return {}
  })

  await $.tool.call({ tool: 'mcp__handoff__start' } as never)
  await $.turn.complete(turn(ANSWER))
  await clock.advance(100)
  let band = await $.ui.mount({ plugin: 'handoff', surface: 'desktop', component: 'AbovePrompt', props: band0 })
  for (let i = 0; i < 500 && !(await band.find({ key: 'cancel' })); i++) {
    band = await $.ui.mount({ plugin: 'handoff', surface: 'desktop', component: 'AbovePrompt', props: band0 })
  }
  await band.press({ key: 'cancel' })

  const after = await $.ui.mount({ plugin: 'handoff', surface: 'desktop', component: 'AbovePrompt', props: band0 })
  expect(await after.find({ key: 'send' })).toBeUndefined()
  expect(commands).toEqual([])
})

// 雲端對話在桌機 app 上看時沒有畫面：預覽和確認都在對話裡
function cloud(on: On, used = { value: 60 }) {
  engine(on, used, [])
  const log = { commands: [] as string[], sent: '', hints: [] as string[] }
  on('command.run', ($, e) => {
    log.commands.push(`${e.command} ${e.args}`.trim())
    return {}
  })
  on('prompt.submit', ($, e) => {
    log.sent = e.text
    log.hints.push(...(e.context ?? []))
    return { text: e.text } as never
  })
  return log
}

const settle = async (done: () => boolean) => {
  await clock.advance(100)
  for (let i = 0; i < 500 && !done(); i++) await Promise.resolve()
}

test('雲端：說「送出」由 Claude 呼叫 confirm，這一輪結束後才清空並送出', async ($, on) => {
  const log = cloud(on)
  await $.tool.call({ tool: 'mcp__handoff__start' } as never)
  await $.turn.complete(turn(ANSWER))
  await settle(() => false)
  expect(log.commands).toEqual([])

  const confirmed = await $.tool.call({ tool: 'mcp__handoff__confirm', action: 'send' } as never)
  expect(JSON.stringify(confirmed)).toContain('已確認')
  expect(log.commands).toEqual([])

  await $.turn.complete(turn('好，交接中…'))
  await settle(() => log.sent.includes('還沒做的'))
  expect(log.commands).toEqual(['clear', 'rename [Mod] 一鍵交接（續2）'])
  expect(log.sent).toContain('標題已經改好')
})

test('雲端：預覽中打 /handoff 會說明怎麼做，/handoff 取消可以退出，不會卡住', async ($, on) => {
  const log = cloud(on)
  await $.tool.call({ tool: 'mcp__handoff__start' } as never)
  await $.turn.complete(turn(ANSWER))
  await settle(() => false)

  const again = await $.command.run({ command: 'handoff' } as never)
  expect(again.text).toContain('/handoff 送出')

  const cancelled = await $.command.run({ command: 'handoff', args: '取消' } as never)
  expect(cancelled.text).toContain('已取消')

  const restart = await $.command.run({ command: 'handoff' } as never)
  expect(restart.text).toContain('開始交接')
  await clock.advance(100)
  expect(log.sent).toContain('<<<交接開始>>>')
  expect(log.commands.filter(c => c.startsWith('clear'))).toEqual([])
})

test('自動：用量過門檻時跳出詢問，選「現在交接」就開始寫摘要', async ($, on) => {
  const log = cloud(on)
  picks = ['🔄 現在交接']
  await $.turn.complete(turn('ok'))
  await settle(() => log.sent.includes('<<<交接開始>>>'))
  expect(asked[0]).toContain('上下文已用 60%')
  expect(log.sent).toContain('<<<交接開始>>>')
})

test('自動：選「稍後」就等多用 10% 再問，期間不會一直跳', async ($, on) => {
  const used = { value: 60 }
  cloud(on, used)
  picks = ['稍後（多用 10% 再問）']
  await $.turn.complete(turn('ok'))
  await settle(() => asked.length > 0)
  used.value = 65
  await $.turn.complete(turn('ok'))
  await settle(() => false)
  expect(asked).toHaveLength(1)
  used.value = 71
  await $.turn.complete(turn('ok'))
  await settle(() => asked.length > 1)
  expect(asked).toHaveLength(2)
})

test('預覽確認：對話框選「送出並交接」就清空並送出', async ($, on) => {
  const log = cloud(on)
  await $.tool.call({ tool: 'mcp__handoff__start' } as never)
  picks = ['✅ 送出並交接']
  await $.turn.complete(turn(ANSWER))
  await settle(() => log.sent.includes('還沒做的'))
  expect(asked.some(q => q.includes('一鍵交接（續2）'))).toBe(true)
  expect(log.commands).toEqual(['clear', 'rename [Mod] 一鍵交接（續2）'])
})

test('預覽確認：在對話框寫修改意見，Claude 會照著重寫', async ($, on) => {
  const log = cloud(on)
  await $.tool.call({ tool: 'mcp__handoff__start' } as never)
  picks = ['待辦再多寫一點']
  await $.turn.complete(turn(ANSWER))
  await settle(() => log.sent.includes('待辦再多寫一點'))
  expect(log.sent).toContain('請依照這個意見修改交接預覽')
  expect(log.commands).toEqual([])
})

test('雲端：/handoff 送出 等指令結束後才清空並送出摘要', async ($, on) => {
  const log = cloud(on)
  await $.tool.call({ tool: 'mcp__handoff__start' } as never)
  await $.turn.complete(turn(ANSWER))
  await settle(() => false)

  const sent = await $.command.run({ command: 'handoff', args: '送出' } as never)
  expect(sent.text).toContain('正在清空')
  await clock.advance(100)
  await settle(() => log.sent.includes('還沒做的'))
  expect(log.commands).toEqual(['clear', 'rename [Mod] 一鍵交接（續2）'])
})
