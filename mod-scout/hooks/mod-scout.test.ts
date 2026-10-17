import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { buildDigest, humanFromEvents, parseProposals, redact } from './lib'

// 測試底下沒有引擎，把 mod 會用到的引擎功能補上
let clock: ReturnType<typeof mock.clock>
let picks: (string | null)[] = []
const asked: string[] = []
const toasts: string[] = []
const written: Record<string, string> = {}
const submitted: string[] = []

const LOCAL = {
  sessions: [
    {
      id: 'aaa',
      title: '[影片] 上片',
      project: '/Users/ricky/Documents/shorts_studio',
      start: '2026-10-16T05:00',
      messages: [{ at: '2026-10-16T05:01', text: '回覆我也說過都是回中文 也講過了' }],
    },
  ],
  inventory: { hooks: ['SessionStart'], pluginDirs: ['/home/user/jev'], skills: [] },
}

const EVENTS = {
  ccr: {
    data: [
      { created_at: '2026-10-17T11:14:00Z', user: { internal_anthropic_catchall: { client_platform: 'desktop_app', message: { role: 'user', content: '不是應該就取消了 為啥也一直跑' } } } },
      { created_at: '2026-10-17T11:15:00Z', user: { internal_anthropic_catchall: { message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } } } },
    ],
    has_more: false,
  },
}

const SESSIONS = {
  ccr: {
    data: [
      { id: 'session_me', title: '[Mod] Mod 探勘' },
      { id: 'session_other', title: '[Mod] 一鍵交接', created_at: '2026-10-17T08:25:00Z', session_context: { sources: [{ git_repository: { url: 'https://github.com/ricky94511/claude-mods' } }] } },
    ],
  },
}

const text = (data: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false } }) as never

function engine(on: On, { remote = true, python = true } = {}) {
  clock = mock.clock(on)
  mock.store(on)
  picks = []
  for (const list of [asked, toasts, submitted]) list.length = 0
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = String((e as unknown as { questions: { question: string }[] }).questions[0]?.question)
    asked.push(question)
    const pick = picks.shift() ?? null
    if (pick === null) return { isError: true, result: 'dismissed', text: 'dismissed' } as never
    return { result: { questions: (e as never as { questions: unknown }).questions, answers: { [question]: pick } }, text: pick } as never
  })
  on('session.id', () => ({ value: 'local-id' }) as never)
  on('env.get', () => ({ value: '/home/test' }) as never)
  on('process.run', () =>
    ({ value: python ? { exitCode: 0, stdout: JSON.stringify(LOCAL), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } : { exitCode: 127, stdout: '', stderr: 'python3: not found', isStdoutTruncated: false, isStderrTruncated: false } }) as never,
  )
  on('mcp.call', ($, e) => {
    const { tool } = e as unknown as { tool: string }
    if (!remote) throw new Error('no server')
    if (tool === 'get_session') return text({ ccr: { id: 'session_me' } })
    if (tool === 'list_sessions') return text(SESSIONS)
    return text(EVENTS)
  })
  on('fs.write', ($, e) => {
    const { path, text: body } = e as unknown as { path: string; text: string }
    written[path] = body
    return { value: undefined } as never
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text } as never
  })
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    toasts.push(String((e as { text?: string }).text ?? ''))
    return { value: undefined } as never
  })
}

const turn = (answer: string) => ({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' }) as never

const settle = async (done: () => boolean) => {
  await clock.advance(100)
  for (let i = 0; i < 500 && !done(); i++) await Promise.resolve()
}

const REPORT = `## 不需要 mod
- 回中文：CLAUDE.md 就好

<<<Mod 提案開始>>>
### 提案 1：**交接取消守門**
內容
### 提案 2：推 code 前確認
內容
<<<Mod 提案結束>>>`

test('遮蔽金鑰：token 和密碼不會出現在整理檔', () => {
  expect(redact('我的 key 是 sk-abcdefghijklmnop1234')).toBe('我的 key 是 <已遮蔽>')
  expect(redact('password=hunter2 走')).toBe('<已遮蔽> 走')
  expect(redact('先合併')).toBe('先合併')
})

test('雲端事件：只留人打的字，tool_result 和外掛送的不算', () => {
  const messages = humanFromEvents(EVENTS.ccr.data as never)
  expect(messages).toEqual([{ at: '2026-10-17T11:14', text: '不是應該就取消了 為啥也一直跑' }])
})

test('解析提案：抓名稱、拿掉粗體；沒有段落回傳 null', () => {
  expect(parseProposals(REPORT)).toEqual([
    { number: 1, name: '交接取消守門' },
    { number: 2, name: '推 code 前確認' },
  ])
  expect(parseProposals('沒有提案')).toBeNull()
})

test('整理檔：每句帶日期與專案，列出已有的 Hook', () => {
  const digest = buildDigest([{ ...LOCAL.sessions[0]!, source: '本機' }], LOCAL.inventory, [])
  expect(digest).toContain('2026-10-16｜shorts_studio｜[影片] 上片（本機）')
  expect(digest).toContain('- 2026-10-16 05:01｜回覆我也說過都是回中文')
  expect(digest).toContain('設定裡的 Hook 事件：SessionStart')
})

test('/mod-scout：合併本機和雲端紀錄、排除自己這個對話，再送出分析', async ($, on) => {
  engine(on)
  const result = await $.command.run({ command: 'mod-scout', args: '' } as never)
  expect(result.text).toContain('開始整理最近 30 次對話')
  await settle(() => submitted.length > 0)
  const digest = written['/home/test/.claude/mod-scout/digest-1970-01-01.md'] ?? ''
  expect(digest).toContain('回覆我也說過都是回中文')
  expect(digest).toContain('claude-mods｜[Mod] 一鍵交接（雲端）')
  expect(digest).not.toContain('Mod 探勘（雲端）')
  expect(submitted[0]).toContain('digest-1970-01-01.md')
  expect(submitted[0]).toContain('<<<Mod 提案開始>>>')
})

test('沒有 python、也連不到雲端：說明找不到紀錄，不會卡住', async ($, on) => {
  engine(on, { remote: false, python: false })
  await $.command.run({ command: 'mod-scout', args: '' } as never)
  await settle(() => toasts.length > 0)
  expect(toasts[0]).toContain('找不到任何對話紀錄')
  expect(submitted).toEqual([])
  const again = await $.command.run({ command: 'mod-scout', args: '' } as never)
  expect(again.text).toContain('開始整理')
})

test('報告出來後問要做哪一個，選了就送出「幫我做第 N 個」', async ($, on) => {
  engine(on)
  await $.command.run({ command: 'mod-scout', args: '' } as never)
  await settle(() => submitted.length > 0)
  picks = ['2. 推 code 前確認']
  await $.turn.complete(turn(REPORT))
  await settle(() => submitted.length > 1)
  expect(asked[0]).toContain('要做哪一個')
  expect(submitted[1]).toContain('幫我做第 2 個 Mod 提案「推 code 前確認」')
  expect(submitted[1]).toContain('要不要永久保存')
})

test('選「先不做」：之後用 /mod-scout 做 N 接著做', async ($, on) => {
  engine(on)
  await $.command.run({ command: 'mod-scout', args: '' } as never)
  await settle(() => submitted.length > 0)
  picks = ['先不做']
  await $.turn.complete(turn(REPORT))
  await settle(() => toasts.length > 0)
  expect(submitted).toHaveLength(1)

  const later = await $.command.run({ command: 'mod-scout', args: '做 1' } as never)
  expect(later.text).toContain('交接取消守門')
  await settle(() => submitted.length > 1)
  expect(submitted[1]).toContain('幫我做第 1 個')
})

test('一般對話的回合結束不會跳出詢問', async ($, on) => {
  engine(on)
  await $.turn.complete(turn(REPORT))
  await settle(() => false)
  expect(asked).toEqual([])
})
