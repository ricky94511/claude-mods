import type { On, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// 測試底下沒有引擎，把插件會用到的引擎功能補上
const toasts: string[] = []

function engine(on: On, used: { value: number }) {
  mock.clock(on)
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
    let band = await $.ui.mount({ plugin: 'handoff', surface, component: 'AbovePrompt', props: band0 })
    for (let i = 0; i < 500 && !(await band.find({ key: 'send' })); i++) {
      band = await $.ui.mount({ plugin: 'handoff', surface, component: 'AbovePrompt', props: band0 })
    }

    expect(await band.find({ key: 'send' })).toBeDefined()
    expect(await band.find({ text: /第 2 段/ })).toBeDefined()
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
  let band = await $.ui.mount({ plugin: 'handoff', surface: 'desktop', component: 'AbovePrompt', props: band0 })
  for (let i = 0; i < 500 && !(await band.find({ key: 'cancel' })); i++) {
    band = await $.ui.mount({ plugin: 'handoff', surface: 'desktop', component: 'AbovePrompt', props: band0 })
  }
  await band.press({ key: 'cancel' })

  const after = await $.ui.mount({ plugin: 'handoff', surface: 'desktop', component: 'AbovePrompt', props: band0 })
  expect(await after.find({ key: 'send' })).toBeUndefined()
  expect(commands).toEqual([])
})
