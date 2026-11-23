import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'

import type { CleanViewChecklist, CleanViewTask, CleanViewWait } from '../types'

const PLUGIN = 'clean-view'
const PLAN_TOOL = `mcp__${PLUGIN}__plan_steps`
const PROGRESS_TOOL = `mcp__${PLUGIN}__report_progress`
const ALWAYS_ALLOWED = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion'])
/** Tools after which Claude comes back on its own: a watcher, a wake-up, a scheduled check, a background workflow. */
const WAIT_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'Workflow'])
/** An alarm another service delivers later, so nothing shows as running here. */
const ALARM_TOOL = /__sveglia$/

const MAX_NAME = 40
const TICK_MS = 250
const COLLAPSE_MS = 5000

export const EMPTY: CleanViewChecklist = {
  jobId: 0,
  title: '',
  phase: 'idle',
  tasks: [],
  isPlanned: false,
  needsYouReason: null,
  stuckReason: null,
  startedAt: null,
  finishedAt: null,
  isCollapsed: false,
  failures: 0,
  isWaitingOnBackground: false,
}

export const enabled = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
export const checklist = atom({ plugin: 'clean-view', key: 'checklist' } as const, EMPTY)
export const tick = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)
const NO_WAIT: CleanViewWait = { armed: false, armedAlarm: false, fromWaiting: false, inFlight: null }
/** What this turn did about waking Claude up later; in the session's state, so a reload of the mod mid-turn keeps it. */
export const waitSignals = atom({ plugin: 'clean-view', key: 'wait' } as const, NO_WAIT)

export const REASONS = {
  permission: 'Claude needs your OK to continue',
  question: 'Claude has a question for you',
  waiting: 'Claude is waiting for your reply',
  saidNo: 'you said no to a step, so Claude paused',
  keepsFailing: 'a step keeps failing, Claude is trying another way',
  refusal: "Claude couldn't help with that request",
  rateLimit: 'you hit your usage limit, try again a little later',
  overloaded: "Claude's servers are busy, try again in a minute",
  tooLong: 'type /compact and try again',
  network: 'the internet connection dropped',
  auth: 'type /login',
  unknown: 'something went wrong, try again',
} as const

const GUIDE = [
  'Clean View is on: the person sees a simple checklist of your plan instead of tool calls.',
  `- For every request, even a quick question, first call ${PLAN_TOOL} with every step of the job in order (2 to 8 steps). If it is deferred, load it with ToolSearch first.`,
  `- Then call ${PROGRESS_TOOL} as real progress happens, and with percent 100 the moment a step finishes.`,
  '- Write every step name in plain English a non-technical person understands, under 40 characters, starting with a verb, like "Build the pricing section".',
  '- Never put file paths, file names, commands, code or tool names in a step name.',
  '- If this session has TodoWrite or TaskCreate, you may use your to-do list as the plan instead.',
  '- When the person must answer or choose before you can go on, ask with AskUserQuestion, one question per point, not only in your reply text: with Clean View on, a question left in the text is easy to miss.',
].join('\n')

// ---------------------------------------------------------------- plain names

const CODE_FILE =
  /\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|ps1|bat|json|ya?ml|toml|ini|md|html?|css|scss|sass|less|sql|xml|lock|env|vue|svelte|dart|lua|ipynb|gradle|tf)\b/gi

/** The one cleaner every name passes through. */
export function cleanName(raw: unknown, max = MAX_NAME): string {
  let text = String(raw ?? '')
    .replace(/`[^`]*`/g, ' ')
    .replace(/`/g, ' ')
  text = text
    .split(/\s+/)
    .filter(word => !word.includes('/') && !word.includes('\\'))
    .join(' ')
  text = text.replace(CODE_FILE, ' ').replace(/\s+/g, ' ').trim()
  text = text.replace(/^[\s,;:.\-–—]+|[\s,;:\-–—]+$/g, '').trim()
  if (text === '') {
    return 'Working on it'
  }
  text = text.charAt(0).toUpperCase() + text.slice(1)
  if (text.length > max) {
    let cut = text.slice(0, max - 1)
    const space = cut.lastIndexOf(' ')
    if (space > 0) {
      cut = cut.slice(0, space)
    }
    text = cut.replace(/[\s,;:.\-–—]+$/, '') + '…'
  }

  return text
}

/** A job name: the cleaner, then at most six words. */
export function cleanTitle(raw: unknown): string {
  const firstLine = String(raw ?? '').trim().split('\n')[0] ?? ''
  const unquoted = firstLine.replace(/^["'*#\s]+|["'*.\s]+$/g, '')
  const words = cleanName(unquoted, 60).replace(/…$/, '').split(' ').slice(0, 6).join(' ')

  return cleanName(words)
}

export function clampPercent(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    return 0
  }

  return Math.max(0, Math.min(100, Math.round(n)))
}

export function errorReason(kindOrText: string): string {
  const s = kindOrText.toLowerCase()
  if (/rate.?limit|429|usage limit|billing/.test(s)) return REASONS.rateLimit
  if (/overload|529|server_error|50[0-9]/.test(s)) return REASONS.overloaded
  if (/too long|context|max_output_tokens|invalid_request/.test(s)) return REASONS.tooLong
  if (/network|econn|enotfound|fetch failed|socket|timed? ?out|connection/.test(s)) return REASONS.network
  if (/auth|oauth|401|403|login|api key|credential|verification|account_on_hold/.test(s)) return REASONS.auth

  return REASONS.unknown
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

// ---------------------------------------------------------- checklist changes

function uniqueId(tasks: readonly CleanViewTask[], name: string): string {
  const base = `step:${name.toLowerCase()}`
  let id = base
  for (let n = 2; tasks.some(t => t.id === id); n += 1) {
    id = `${base}#${n}`
  }

  return id
}

function isLive(list: CleanViewChecklist): boolean {
  return list.phase === 'working' || list.phase === 'needs-you' || list.phase === 'stuck'
}

export function startJob(list: CleanViewChecklist, now: number): CleanViewChecklist {
  return {
    ...EMPTY,
    jobId: list.jobId + 1,
    title: 'Working on your request',
    phase: 'working',
    startedAt: now,
    tasks: [
      { id: 'placeholder:understand', name: 'Understand your request', status: 'active', percent: 0, hasReported: false },
      { id: 'placeholder:plan', name: 'Plan the steps', status: 'upcoming', percent: 0, hasReported: false },
    ],
  }
}

function ensureJob(list: CleanViewChecklist, now: number): CleanViewChecklist {
  return isLive(list) ? list : { ...startJob(list, now), tasks: [] }
}

export function planSteps(list: CleanViewChecklist, steps: readonly unknown[], now: number): CleanViewChecklist {
  const base = ensureJob(list, now)
  const tasks: CleanViewTask[] = []
  for (const step of steps.slice(0, 8)) {
    const name = cleanName(step)
    tasks.push({
      id: uniqueId(tasks, name),
      name,
      status: tasks.length === 0 ? 'active' : 'upcoming',
      percent: 0,
      hasReported: false,
    })
  }

  return { ...base, tasks, isPlanned: true }
}

export function reportProgress(
  list: CleanViewChecklist,
  rawName: unknown,
  rawPercent: unknown,
  now: number,
): CleanViewChecklist {
  const base = ensureJob(list, now)
  const name = cleanName(rawName)
  const percent = clampPercent(rawPercent)
  const tasks = base.isPlanned ? [...base.tasks] : []
  let at = tasks.findIndex(t => t.name.toLowerCase() === name.toLowerCase())

  if (at < 0) {
    const active = tasks.findIndex(t => t.status === 'active')
    const upcoming = tasks.findIndex(t => t.status === 'upcoming')
    at = active >= 0 ? active : upcoming >= 0 ? upcoming : tasks.length
    tasks.splice(at, 0, { id: uniqueId(tasks, name), name, status: 'upcoming', percent: 0, hasReported: false })
  }

  const next = tasks.map((t, i): CleanViewTask => {
    if (i < at) return { ...t, status: 'done', percent: 100 }
    if (i > at && t.status === 'active') return { ...t, status: 'upcoming' }
    return t
  })

  const reported = next.map((t, i): CleanViewTask => {
    if (i !== at) return t
    return percent >= 100
      ? { ...t, status: 'done', percent: 100, hasReported: true }
      : { ...t, status: 'active', percent, hasReported: true }
  })
  const following = percent >= 100 ? reported.findIndex((t, i) => i > at && t.status === 'upcoming') : -1
  const tasksAfter = reported.map((t, i): CleanViewTask => (i === following ? { ...t, status: 'active' } : t))

  return { ...base, tasks: tasksAfter, isPlanned: true }
}

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

export function fromTodos(list: CleanViewChecklist, todos: readonly Todo[], now: number): CleanViewChecklist {
  const base = ensureJob(list, now)
  const tasks: CleanViewTask[] = []
  for (const todo of todos) {
    const name = cleanName(todo.content)
    const before = base.tasks.find(t => t.name === name)
    const status = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'active' : 'upcoming'
    tasks.push({
      id: uniqueId(tasks, name),
      name,
      status,
      percent: status === 'done' ? 100 : status === 'active' && before?.hasReported ? before.percent : 0,
      hasReported: status === 'active' ? before?.hasReported ?? false : status === 'done',
    })
  }

  return { ...base, tasks, isPlanned: true }
}

export function taskCreated(list: CleanViewChecklist, taskId: string, subject: string, now: number): CleanViewChecklist {
  const base = ensureJob(list, now)
  const tasks = base.isPlanned ? [...base.tasks] : []
  tasks.push({ id: `task:${taskId}`, name: cleanName(subject), status: 'upcoming', percent: 0, hasReported: false })

  return { ...base, tasks, isPlanned: true }
}

export function taskUpdated(
  list: CleanViewChecklist,
  taskId: string,
  fields: { subject?: string; status?: string },
): CleanViewChecklist {
  const id = `task:${taskId}`
  if (!list.tasks.some(t => t.id === id)) {
    return list
  }
  if (fields.status === 'deleted') {
    return { ...list, tasks: list.tasks.filter(t => t.id !== id) }
  }

  return {
    ...list,
    tasks: list.tasks.map((t): CleanViewTask => {
      if (t.id !== id) return t
      const name = fields.subject === undefined ? t.name : cleanName(fields.subject)
      if (fields.status === 'completed') return { ...t, name, status: 'done', percent: 100 }
      if (fields.status === 'in_progress') return { ...t, name, status: 'active' }
      if (fields.status === 'pending') return { ...t, name, status: 'upcoming' }
      return { ...t, name }
    }),
  }
}

export function needsYou(list: CleanViewChecklist, reason: string): CleanViewChecklist {
  return isLive(list) ? { ...list, phase: 'needs-you', needsYouReason: reason, isWaitingOnBackground: false } : list
}

export function backToWork(list: CleanViewChecklist): CleanViewChecklist {
  if (list.phase === 'needs-you' || list.phase === 'stuck') {
    return { ...list, phase: 'working', needsYouReason: null, stuckReason: null, isWaitingOnBackground: false }
  }

  return list.isWaitingOnBackground ? { ...list, isWaitingOnBackground: false } : list
}

export function stuck(list: CleanViewChecklist, reason: string): CleanViewChecklist {
  return list.phase === 'idle'
    ? list
    : { ...list, phase: 'stuck', stuckReason: reason, needsYouReason: null, isWaitingOnBackground: false }
}

/** True when Claude stopped to wait for something that wakes it up, not for the person. */
export function isWaitingOnBackground(signals: CleanViewWait): boolean {
  if (signals.armedAlarm) return true
  const inFlight = signals.inFlight ?? signals.armed

  return inFlight && (signals.armed || signals.fromWaiting)
}

/** A job paused on the person's reply becomes a job waiting on its own when something will wake Claude, and a finished job when nothing will. */
export function settleWait(list: CleanViewChecklist, isWaiting: boolean, now: number): CleanViewChecklist {
  const isPaused = list.phase === 'needs-you' && list.needsYouReason === REASONS.waiting
  if (isWaiting && isPaused) {
    return { ...list, phase: 'working', needsYouReason: null, isWaitingOnBackground: true }
  }
  // ponytail: nothing will wake Claude and the reply asks nothing, so the job is over: its last step is usually the reply itself, never reported
  if (!isWaiting && (isPaused || (list.phase === 'working' && list.isWaitingOnBackground))) {
    return finished(list, now)
  }

  return list
}

function finished(list: CleanViewChecklist, now: number): CleanViewChecklist {
  return {
    ...list,
    phase: 'done',
    finishedAt: now,
    needsYouReason: null,
    stuckReason: null,
    isWaitingOnBackground: false,
    tasks: list.tasks.map((t): CleanViewTask => ({ ...t, status: 'done', percent: 100 })),
  }
}

export function toolFailed(list: CleanViewChecklist, isSaidNo: boolean): CleanViewChecklist {
  const failures = list.failures + 1
  if (isSaidNo) return stuck({ ...list, failures }, REASONS.saidNo)
  if (failures >= 3) return stuck({ ...list, failures }, REASONS.keepsFailing)

  return { ...list, failures }
}

export function toolSucceeded(list: CleanViewChecklist): CleanViewChecklist {
  const cleared = list.phase === 'stuck' ? backToWork(list) : list

  return { ...cleared, failures: 0 }
}

export type TurnEnd = {
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
  errorText: string
}

export function turnEnded(live: CleanViewChecklist, end: TurnEnd, now: number): CleanViewChecklist {
  if (!isLive(live)) {
    return live
  }
  const list = { ...live, isWaitingOnBackground: false }
  if (end.reason === 'error') {
    return stuck(list, errorReason(end.errorText))
  }
  if (end.reason === 'refusal') {
    return stuck(list, REASONS.refusal)
  }
  if (end.reason === 'aborted') {
    if (list.phase === 'stuck' && list.stuckReason === REASONS.saidNo) return list
    return { ...list, phase: 'stopped', finishedAt: now, needsYouReason: null }
  }
  // ponytail: a question in the reply does not hold the job open: every turn ends on the person's move, and replies here close with «Cosa fai tu»
  if (list.isPlanned && list.tasks.some(t => t.status !== 'done')) {
    return { ...list, phase: 'needs-you', needsYouReason: REASONS.waiting }
  }

  return finished(list, now)
}

// ------------------------------------------------------------------- drawing

export const COLORS = {
  accent: '#e0457b',
  done: '#2f8f4e',
  doneText: '#5fbf7a',
  track: '#3a2030',
  title: ['#e8504f', '#d0479a', '#9a5fd0', '#6f86e0'],
  overall: ['#c9562f', '#d94a3f', '#e0457b'],
  sweep: ['#3a1a28', '#7a2846', '#e0457b'],
} as const

/** One colored cell of a bar: a block, or a blank where the bar is empty. */
export type Cell = { char: string; color?: string }

function hex(color: string): [number, number, number] {
  const n = Number.parseInt(color.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** A color `t` (0 to 1) of the way along a list of stops. */
export function blend(stops: readonly string[], t: number): string {
  if (stops.length === 1) return stops[0] ?? '#ffffff'
  const at = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(at))
  const [r1, g1, b1] = hex(stops[i] ?? '#000000')
  const [r2, g2, b2] = hex(stops[i + 1] ?? '#000000')
  const f = at - i
  const mix = (a: number, b: number) => Math.round(a + (b - a) * f).toString(16).padStart(2, '0')

  return `#${mix(r1, r2)}${mix(g1, g2)}${mix(b1, b2)}`
}

export function meterWidth(bodyColumns: number): number {
  return Math.max(10, Math.min(24, bodyColumns - 2 - 4 - 30 - 10))
}

/** The cells of one step's meter: full green when done, a fill to the percent, a moving sweep while no percent is known. */
export function meterCells(task: CleanViewTask, frame: number, width: number): Cell[] {
  if (task.status === 'done') {
    return Array.from({ length: width }, () => ({ char: '█', color: COLORS.done }))
  }
  if (task.status === 'upcoming') {
    return Array.from({ length: width }, () => ({ char: ' ' }))
  }
  if (!task.hasReported) {
    const span = Math.max(3, Math.round(width / 3))
    const head = frame % (width + span)
    return Array.from({ length: width }, (_, i) => {
      const back = head - i
      return back >= 0 && back < span ? { char: '█', color: blend(COLORS.sweep, 1 - back / span) } : { char: ' ' }
    })
  }
  const filled = Math.round((task.percent / 100) * width)

  return Array.from({ length: width }, (_, i) =>
    i < filled ? { char: '█', color: blend(COLORS.sweep, filled <= 1 ? 1 : i / (filled - 1)) } : { char: ' ' },
  )
}

/** The whole job's progress: finished steps plus the share of the current one. */
export function overallPercent(tasks: readonly CleanViewTask[]): number {
  if (tasks.length === 0) return 0
  const sum = tasks.reduce((acc, t) => acc + (t.status === 'done' ? 100 : t.status === 'active' ? t.percent : 0), 0)

  return Math.round(sum / tasks.length)
}

export function overallCells(percent: number, width: number): Cell[] {
  const filled = Math.round((percent / 100) * width)

  return Array.from({ length: width }, (_, i) =>
    i < filled ? { char: '█', color: blend(COLORS.overall, filled <= 1 ? 1 : i / (filled - 1)) } : { char: ' ' },
  )
}

export function fit(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(0, width))
  if (text.length > width) return text.slice(0, width - 1) + '…'

  return text.padEnd(width, ' ')
}

export function rowLabels(tasks: readonly CleanViewTask[]): string[] {
  const firstUpcoming = tasks.findIndex(t => t.status === 'upcoming')

  return tasks.map((t, i) => {
    if (t.status === 'done') return 'Done'
    if (t.status === 'active') return t.hasReported ? `${t.percent}%` : 'Working'
    return i === firstUpcoming ? 'Next' : 'Up next'
  })
}

// ------------------------------------------------------------------ the hooks

let ticker: Timer | undefined
let lastError = ''

function syncTicker($: EngineInterface, list: CleanViewChecklist): void {
  const shouldTick = list.phase === 'working' || list.phase === 'needs-you'
  if (shouldTick && ticker === undefined) {
    ticker = $.clock.every(TICK_MS, () => void update($, tick, n => n + 1))
  } else if (!shouldTick && ticker !== undefined) {
    ticker.cancel()
    ticker = undefined
  }
}

async function change(
  $: EngineInterface,
  fn: (list: CleanViewChecklist) => CleanViewChecklist,
): Promise<CleanViewChecklist> {
  const list = await update($, checklist, fn)
  syncTicker($, list)

  return list
}

async function setEnabled($: EngineInterface, isOn: boolean): Promise<void> {
  await update($, enabled, () => isOn)
  await $.store.set('cleanViewEnabled', isOn)
  $.ui.toast(isOn ? 'Clean View is on: technical details are hidden' : 'Clean View is off: every detail is showing')
}

async function nameJob($: EngineInterface, jobId: number, prompt: string): Promise<void> {
  const answer = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    maxTokens: 30,
    timeoutMs: 20000,
    prompt:
      'Name this job in 2 to 6 plain English words that start with a verb, like "Build my landing page". ' +
      'No file names, paths, commands or code. Reply with the name only.\n\nRequest:\n' +
      prompt.slice(0, 2000),
  })
  if (!answer.isAnswered) return
  const title = cleanTitle(answer.text)
  await change($, list => (list.jobId === jobId ? { ...list, title } : list))
}

export function registerCleanView(on: On): void {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'plan_steps',
      description:
        'Lay out every step of the job up front so the person can follow along: 2 to 8 short plain-English names in order, each under 40 characters and starting with a verb. The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
        },
        required: ['steps'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'report_progress',
      description:
        'Report progress on the current step of the plan, 0 to 100. Use 100 the moment a step finishes; the next one starts by itself. A name not in the plan becomes a new step.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          percent: { type: 'number', minimum: 0, maximum: 100 },
        },
        required: ['task', 'percent'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'simple',
      description: 'Turn Clean View on or off (no argument flips it)',
      argumentHint: 'on|off',
    })
    const saved = await $.store.get('cleanViewEnabled')
    await update($, enabled, () => saved !== false)
    syncTicker($, await read($, checklist))

    return next(e)
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== '' && arg !== 'on' && arg !== 'off') {
      return { text: 'Use /simple on, /simple off, or /simple to flip it.' }
    }
    const isOn = arg === '' ? !(await read($, enabled)) : arg === 'on'
    await setEnabled($, isOn)

    return { text: isOn ? 'Clean View is on.' : 'Clean View is off.' }
  })

  on('turn.start', async ($, e, next) => {
    const text = e.text.trim()
    const now = await $.clock.now()
    const list = await read($, checklist)
    // a wake-up or a reply while Claude waits on its own goes on with the same job
    const isWaitingOnReply = list.phase === 'needs-you' || list.phase === 'stuck' || list.isWaitingOnBackground === true
    if (e.agentId === undefined) {
      await update($, waitSignals, () => ({ ...NO_WAIT, fromWaiting: list.isWaitingOnBackground === true }))
    }

    if (text !== '' && !text.startsWith('/') && !isWaitingOnReply) {
      lastError = ''
      const started = await change($, l => startJob(l, now))
      const jobId = started.jobId
      $.clock.after(0, () => void nameJob($, jobId, text))
    } else if (isWaitingOnReply) {
      lastError = ''
      await change($, backToWork)
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>
    const now = await $.clock.now()

    if (tool === PLAN_TOOL) {
      const steps = Array.isArray(args.steps) ? args.steps : []
      if (steps.length === 0) return { deny: 'plan_steps needs at least one step name.' }
      const list = await change($, l => backToWork(planSteps(l, steps, now)))
      return { result: `Planned ${list.tasks.length} ${list.tasks.length === 1 ? 'step' : 'steps'}. The first one has started.` }
    }
    if (tool === PROGRESS_TOOL) {
      const percent = clampPercent(args.percent)
      await change($, l => backToWork(reportProgress(l, args.task, percent, now)))
      return { result: `Progress noted: ${percent}%.` }
    }
    if (e.agentId !== undefined) {
      return next(e)
    }

    const isOn = await read($, enabled)
    const before = await read($, checklist)
    if (isOn && isLive(before) && !before.isPlanned && !ALWAYS_ALLOWED.has(tool)) {
      return {
        deny: `Clean View: call ${PLAN_TOOL} first to lay out the plan in plain steps (load it with ToolSearch if it is deferred), then try again.`,
      }
    }

    if (tool === 'AskUserQuestion') {
      await change($, l => needsYou(l, REASONS.question))
    } else if (before.phase === 'needs-you') {
      await change($, backToWork)
    }

    const ran = await next(e)

    if (ran.deny !== undefined) {
      return ran
    }
    if (ran.isError === true) {
      const isSaidNo = /doesn't want to proceed|tool use was rejected|user (?:rejected|denied|declined)/i.test(ran.text ?? '')
      await change($, l => toolFailed(backToWork(l), isSaidNo))
      return ran
    }

    await change($, l => toolSucceeded(l.phase === 'needs-you' ? backToWork(l) : l))
    // ponytail: a background command does not arm the wait: without the engine's Stop, which skips installed mods where an organization manages Claude Code, one finished long ago looks still running
    if (WAIT_TOOLS.has(tool)) {
      await update($, waitSignals, w => ({ ...w, armed: true }))
    }
    if (ALARM_TOOL.test(tool)) {
      await update($, waitSignals, w => ({ ...w, armedAlarm: true }))
    }
    if (e.tool === 'TodoWrite') {
      await change($, l => fromTodos(l, e.todos, now))
    } else if (e.tool === 'TaskCreate') {
      const id = /#?(\d+)/.exec(ran.text ?? '')?.[1] ?? e.subject
      await change($, l => taskCreated(l, id, e.subject, now))
    } else if (e.tool === 'TaskUpdate') {
      await change($, l => taskUpdated(l, e.taskId, { subject: e.subject, status: e.status }))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    const wait = await read($, waitSignals)
    const list = await change($, l =>
      settleWait(
        turnEnded(l, { reason: e.reason, errorText: lastError !== '' ? lastError : e.answer }, now),
        isWaitingOnBackground(wait),
        now,
      ),
    )
    if (list.phase === 'done' && !list.isCollapsed) {
      const jobId = list.jobId
      $.clock.after(COLLAPSE_MS, () => {
        void change($, l => (l.jobId === jobId && l.phase === 'done' ? { ...l, isCollapsed: true } : l))
      })
    }

    return next(e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    return next({ ...e, props: { ...e.props, hint: '' } })
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const isOn = await read($, enabled)
    const others = e.props.modes.join(' & ')

    return (
      <Box flexDirection="row">
        {others !== '' && <Text dimColor>{`${others} & `}</Text>}
        <Button
          key="toggle"
          plain
          dimColor
          label={isOn ? '●' : '○'}
          onPress={() => setEnabled($, !isOn)}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const isOn = await read($, enabled)
    const list = await read($, checklist)
    if (!isOn || list.phase === 'idle') return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const frame = await read($, tick)
    const now = await $.clock.now()
    const engine = await next(e)

    const width = Math.max(30, e.props.bodyColumns)
    const inner = width - 2
    const nameWidth = Math.max(6, Math.min(42, inner - 2 - 2 - meterWidth(inner) - 2 - 8))
    const elapsed = formatDuration((list.finishedAt ?? now) - (list.startedAt ?? now))
    const isPaused = list.phase === 'needs-you'

    const drawCells = (cells: readonly Cell[]) => {
      const runs: Cell[] = []
      for (const cell of cells) {
        const last = runs[runs.length - 1]
        if (last !== undefined && last.color === cell.color) last.char += cell.char
        else runs.push({ ...cell })
      }
      return runs.map(run => <Text color={run.color}>{run.char}</Text>)
    }

    const titleWidth = Math.max(4, inner - elapsed.length - 6)
    const title = fit(list.title, titleWidth).trimEnd()
    const gradientTitle = Array.from(title).map((char, i, all) => ({
      char,
      color: blend(COLORS.title, all.length <= 1 ? 0 : i / (all.length - 1)),
    }))

    let lead
    if (list.phase === 'needs-you') {
      lead = (
        <Text wrap="truncate">
          <Text inverse bold color="warning">
            {' Needs you '}
          </Text>
          {` ${list.needsYouReason ?? REASONS.waiting}`}
        </Text>
      )
    } else if (list.phase === 'stuck') {
      lead = <Text wrap="truncate" color="warning">{`⚠ Stuck: ${list.stuckReason ?? REASONS.unknown}`}</Text>
    } else if (list.phase === 'stopped') {
      lead = <Text wrap="truncate">{`■ Stopped · ${list.title} · you pressed Esc`}</Text>
    } else if (list.phase === 'done') {
      lead = (
        <Text wrap="truncate">
          <Text color={COLORS.doneText}>✓ All done</Text>
          <Text dimColor>{` · ${list.title} · took ${elapsed}`}</Text>
        </Text>
      )
    } else {
      lead = (
        <Text wrap="truncate">
          <Text bold>{drawCells(gradientTitle)}</Text>
        </Text>
      )
    }

    const header = (
      <Box key="header" flexDirection="row" justifyContent="space-between">
        <Box width={inner - elapsed.length - 1}>{lead}</Box>
        {list.phase !== 'done' && <Text dimColor>{elapsed}</Text>}
      </Box>
    )

    // in fullscreen lo slot in basso è al massimo metà terminale, e la lista degli agenti sotto il prompt lo riempie:
    // se la lista intera non entra in maxRows, solo le righe che contano, invece di una lista tagliata e "n more"
    const draw = (full: (typeof header)[], short: (typeof header)[]) => (
      <Box flexDirection="column">
        {/* margine sinistro di 2 colonne, come il testo delle risposte di Claude Code; a destra basta lo spazio del [-] */}
        <Box paddingLeft={2} flexDirection="column" width={width}>
          {full.length <= e.props.maxRows ? full : short.slice(0, Math.max(1, e.props.maxRows))}
        </Box>
        {engine}
      </Box>
    )

    if (list.phase === 'done' && list.isCollapsed) return draw([header], [header])

    const total = list.tasks.length
    const active = list.tasks.findIndex(t => t.status === 'active')
    const doneCount = list.tasks.filter(t => t.status === 'done').length
    const stepNumber = active >= 0 ? active + 1 : Math.min(total, doneCount + (doneCount < total ? 1 : 0))
    const percent = overallPercent(list.tasks)
    const stepLabel = `Step ${stepNumber} of ${total} `
    const percentLabel = `${percent}%`
    const labels = rowLabels(list.tasks)
    const labelWidth = Math.max(percentLabel.length, ...labels.map(label => label.length))
    const overallWidth = Math.max(4, inner - stepLabel.length - 1 - labelWidth)
    const barWidth = Math.max(4, inner - 2 - nameWidth - 2 - 1 - labelWidth)

    const summary = (
      <Box key="summary" flexDirection="row" justifyContent="space-between">
        <Text>
          <Text dimColor>{stepLabel}</Text>
          {drawCells(overallCells(percent, overallWidth))}
        </Text>
        <Text color={COLORS.accent}>{percentLabel}</Text>
      </Box>
    )

    const rows = list.tasks.map((task, i) => {
      const isDone = task.status === 'done'
      const isActive = task.status === 'active'
      const icon = isDone ? '✓' : isActive ? (isPaused ? '‖' : '●') : '○'
      return (
        <Box key={task.id} flexDirection="row">
          <Text color={isDone ? COLORS.doneText : isActive ? COLORS.accent : undefined} dimColor={!isDone && !isActive}>
            {`${icon} `}
          </Text>
          <Text wrap="truncate" bold={isActive} dimColor={!isActive}>
            {fit(task.name, nameWidth)}
          </Text>
          <Text>{'  '}</Text>
          <Text>{drawCells(meterCells(task, frame, barWidth))}</Text>
          <Text>{' '}</Text>
          <Text color={isActive ? COLORS.accent : undefined} dimColor={!isActive}>
            {(labels[i] ?? '').padStart(labelWidth)}
          </Text>
        </Box>
      )
    })

    const lines = total > 0 ? [header, summary] : [header]
    const activeRow = rows[active]
    return draw([...lines, ...rows], activeRow ? [...lines, activeRow] : lines)
  })
}
