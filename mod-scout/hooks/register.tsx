import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Phase, Proposal } from '../types'
import {
  analysisPrompt,
  buildDigest,
  buildPrompt,
  humanFromEvents,
  parseJson,
  parseProposals,
  pickNumber,
  projectOf,
  type Inventory,
  type Session,
} from './lib'

const phase = atom({ plugin: 'mod-scout', key: 'phase' } as const, 'idle' as Phase)

const REMOTE = 'claude-code-remote'
const DAY = 24 * 60 * 60 * 1000
// 一次對話最多翻幾頁（每頁 100 筆，tool_result 也算在內）
const MAX_PAGES = 8
const SKIP = '先不做'
const USAGE = '用法：/mod-scout（開始探勘）、/mod-scout 做 N（做上次報告的第 N 個提案）'

type Report = { at: number; proposals: Proposal[] }

// 指令和 turn.complete 的 hook 裡不能等人回答或送出 prompt，等 hook 結束後再用計時器開始
function detach($: EngineInterface, work: () => Promise<void>) {
  $.clock.after(50, () =>
    void work().catch(async error => {
      await update($, phase, () => 'idle')
      $.ui.status(undefined)
      $.ui.toast(`Mod 探勘中途出錯：${String(error).slice(0, 200)}`)
    }),
  )
}

async function mcpJson($: EngineInterface, tool: string, args: Record<string, unknown>) {
  const { content, isError } = await $.mcp.call(REMOTE, tool, args)
  if (isError) return null
  const text = content.find(c => c.type === 'text' && c.text)?.text
  if (!text) return null
  const data = parseJson(text)
  return (data?.ccr ?? data) as Record<string, unknown> | null
}

// 本機：~/.claude/projects/ 底下的紀錄檔可能超過 $.fs 的 4 MiB 上限，交給腳本逐行讀
async function collectLocal($: EngineInterface, limit: number, exclude: string) {
  const script = `${$.plugin.root}/scripts/collect.py`
  const run = await $.process.run(['python3', script, '--limit', String(limit), '--exclude', exclude], { timeoutMs: 120_000 })
  if (run.exitCode !== 0 || run.isStdoutTruncated) throw new Error(run.stderr.slice(0, 300) || '本機紀錄讀取失敗')
  const data = JSON.parse(run.stdout) as { sessions: Omit<Session, 'source'>[]; inventory: Inventory }
  return { sessions: data.sessions.map(s => ({ ...s, source: '本機' as const })), inventory: data.inventory }
}

async function remoteSession($: EngineInterface, session: Record<string, unknown>): Promise<Session | null> {
  const id = String(session.id)
  const messages = []
  let before: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await mcpJson($, 'list_events', { session_id: id, kinds: ['user'], limit: 100, ...(before ? { before_id: before } : {}) })
    if (!data) break
    messages.unshift(...humanFromEvents((data.data ?? []) as never[]))
    if (!data.has_more || !data.first_id) break
    before = String(data.first_id)
  }
  if (messages.length === 0) return null
  return {
    id,
    title: String(session.title ?? ''),
    project: projectOf(session),
    start: String(session.created_at ?? '').slice(0, 16),
    source: '雲端',
    messages,
  }
}

// 雲端：用 claude-code-remote 讀自己帳號的其他對話；沒有這個 server（例如純本機終端機）就略過
async function collectRemote($: EngineInterface, limit: number, exclude: string) {
  let listed: Record<string, unknown> | null
  try {
    listed = await mcpJson($, 'list_sessions', { limit: Math.min(limit + 10, 100), mine: true })
  } catch {
    return null
  }
  if (!listed) return null
  const rows = ((listed.data ?? []) as Record<string, unknown>[]).filter(s => s.id !== exclude).slice(0, limit)
  const sessions: Session[] = []
  for (let i = 0; i < rows.length; i += 4) {
    $.ui.status(`Mod 探勘：讀雲端對話 ${Math.min(i + 4, rows.length)}/${rows.length}…`)
    const batch = await Promise.all(rows.slice(i, i + 4).map(row => remoteSession($, row).catch(() => null)))
    for (const session of batch) if (session) sessions.push(session)
  }
  return sessions
}

async function currentRemoteId($: EngineInterface) {
  try {
    const data = await mcpJson($, 'get_session', {})
    return data?.id ? String(data.id) : ''
  } catch {
    return ''
  }
}

async function scout($: EngineInterface, limit: number) {
  $.ui.status('Mod 探勘：整理本機對話紀錄…')
  const notes: string[] = []
  const localId = await $.session.id()
  let local: Awaited<ReturnType<typeof collectLocal>> | null = null
  try {
    local = await collectLocal($, limit, localId)
  } catch (error) {
    notes.push(`本機紀錄沒讀到（${String(error).slice(0, 120)}），只用雲端對話。`)
  }

  const remote = await collectRemote($, limit, await currentRemoteId($))
  if (remote === null) notes.push('這個環境連不到雲端對話（claude-code-remote），只用本機紀錄。')

  // 遠端遙控的本機對話會同時出現在兩邊：第一句的時間和內容一樣就當同一個
  const seen = new Set((local?.sessions ?? []).flatMap(s => s.messages.slice(0, 3).map(m => `${m.at}|${m.text.slice(0, 40)}`)))
  const remoteOnly = (remote ?? []).filter(s => !s.messages.slice(0, 3).some(m => seen.has(`${m.at}|${m.text.slice(0, 40)}`)))
  const sessions = [...(local?.sessions ?? []), ...remoteOnly]
    .sort((a, b) => (b.messages.at(-1)?.at ?? b.start).localeCompare(a.messages.at(-1)?.at ?? a.start))
    .slice(0, limit)

  if (sessions.length === 0) {
    await update($, phase, () => 'idle')
    $.ui.status(undefined)
    $.ui.toast('Mod 探勘：找不到任何對話紀錄，先累積一些對話再來')
    return
  }

  const home = (await $.env.get('HOME')) ?? ''
  const date = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const digest = `${home}/.claude/mod-scout/digest-${date}.md`
  await $.fs.write(digest, buildDigest(sessions, local?.inventory ?? null, notes))

  await update($, phase, () => 'analyzing')
  $.ui.status(`Mod 探勘：分析 ${sessions.length} 次對話中…`)
  await $.prompt.submit({ text: analysisPrompt(digest, sessions.length) })
}

async function build($: EngineInterface, proposal: Proposal) {
  $.ui.status(undefined)
  await $.prompt.submit({ text: buildPrompt(proposal) })
}

async function choose($: EngineInterface, report: Report) {
  if (report.proposals.length === 0) {
    $.ui.toast('Mod 探勘：這次沒有需要做成 Mod 的，報告在對話裡')
    return
  }
  const options = [...report.proposals.slice(0, 3).map(p => `${p.number}. ${p.name}`), SKIP]
  let choice: string
  try {
    choice = await $.ui.ask('提案出來了，要做哪一個？（其他編號可以直接打數字）', { header: 'Mod 探勘', options })
  } catch {
    return
  }
  const number = choice === SKIP ? null : pickNumber(choice)
  const proposal = report.proposals.find(p => p.number === number)
  if (!proposal) {
    $.ui.toast('之後想做的話，輸入 /mod-scout 做 N')
    return
  }
  await build($, proposal)
}

export const register: Register = (on, options) => {
  const limit = Number(options.sessions ?? 30)
  const remindDays = Number(options.remindDays ?? 90)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'mod-scout',
      description: 'Mod 探勘：讀最近的對話，提出最多 5 個值得做的 Mod（附原話證據）',
      argumentHint: '[做 N]',
    })
    const last = (await $.store.get('last')) as Report | undefined
    const now = await $.clock.now()
    if (remindDays > 0 && last && now - last.at > remindDays * DAY) {
      $.ui.toast(`上次 Mod 探勘是 ${Math.floor((now - last.at) / DAY)} 天前，可以輸入 /mod-scout 再跑一次`)
    }
    return result
  })

  on('command.run', { command: 'mod-scout' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'help' || args === '說明') return { text: USAGE }

    if (args) {
      const number = pickNumber(args)
      const last = (await $.store.get('last')) as Report | undefined
      const proposal = last?.proposals.find(p => p.number === number)
      if (!proposal) return { text: `找不到第 ${number ?? '?'} 個提案。先輸入 /mod-scout 跑一次探勘。\n${USAGE}` }
      detach($, () => build($, proposal))
      return { text: `接著做第 ${proposal.number} 個提案：${proposal.name}` }
    }

    if ((await read($, phase)) !== 'idle') {
      await update($, phase, () => 'idle')
      $.ui.status(undefined)
      return { text: '上一次探勘還沒結束（或卡住了），已重設。再輸入一次 /mod-scout 重新開始。' }
    }
    await update($, phase, () => 'collecting')
    detach($, () => scout($, limit))
    return { text: `Mod 探勘：開始整理最近 ${limit} 次對話，整理完會自動送出分析。` }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || (await read($, phase)) !== 'analyzing') return result
    await update($, phase, () => 'idle')
    $.ui.status(undefined)
    if (e.reason !== 'answer') return result
    const proposals = parseProposals(e.answer)
    if (proposals === null) {
      $.ui.toast('Mod 探勘：沒找到提案段落，報告直接看對話；要做的話說「幫我做第 N 個」')
      return result
    }
    const report: Report = { at: await $.clock.now(), proposals }
    await $.store.set('last', report)
    detach($, () => choose($, report))
    return result
  })
}
