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

const band = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 } as unknown as RenderPropsOf['AbovePrompt']

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
    const low = await $.ui.mount({ plugin: 'handoff', surface, component: 'AbovePrompt', props: band })
    expect(await low.find({ key: 'go' })).toBeUndefined()

    used.value = 60
    await $.turn.complete(turn('ok'))
    const high = await $.ui.mount({ plugin: 'handoff', surface, component: 'AbovePrompt', props: band })
    expect(await high.find({ key: 'go' })).toBeDefined()
  })
}

test('自然語言觸發後，同一輪的摘要會清空對話、改標題、放進輸入框', async ($, on) => {
  engine(on, { value: 60 })
  const commands: string[] = []
  let filled = ''
  on('command.run', ($, e) => {
    commands.push(`${e.command} ${e.args}`.trim())
    return {}
  })
  on('prompt.fill', ($, e) => {
    filled = e.text
    return { isFilled: true, text: e.text } as never
  })

  const started = await $.tool.call({ tool: 'mcp__handoff__start' } as never)
  expect(JSON.stringify(started)).toContain('<<<交接開始>>>')

  await $.turn.complete(turn(ANSWER))
  for (let i = 0; i < 500 && !toasts.some(t => t.includes('已交接')); i++) await Promise.resolve()

  expect(commands).toEqual(['clear', 'rename [Mod] 一鍵交接（續2）'])
  expect(filled).toContain('第 2 段')
  expect(filled).toContain('## 還沒做的')
  expect(filled).not.toContain('標題：')
})
