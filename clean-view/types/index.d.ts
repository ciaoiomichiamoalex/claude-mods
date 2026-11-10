export type CleanViewTaskStatus = 'done' | 'active' | 'upcoming'

export type CleanViewTask = {
  id: string
  name: string
  status: CleanViewTaskStatus
  percent: number
  hasReported: boolean
}

export type CleanViewPhase = 'idle' | 'working' | 'needs-you' | 'stuck' | 'stopped' | 'done'

export type CleanViewChecklist = {
  /** Grows by one for every new job, so late answers for an old job are ignored. */
  jobId: number
  title: string
  phase: CleanViewPhase
  tasks: CleanViewTask[]
  /** True once a real plan (plan_steps, a to-do list or a progress report) replaced the placeholders. */
  isPlanned: boolean
  needsYouReason: string | null
  stuckReason: string | null
  startedAt: number | null
  finishedAt: number | null
  isCollapsed: boolean
  /** Failed tool calls in a row. */
  failures: number
  /** True while Claude has paused on its own, waiting for a timer or for work in the background to wake it: nothing is asked of the person. */
  isWaitingOnBackground: boolean
}

/** What the end of a turn knows about work that will wake Claude up again; reset at every turn start. */
export type CleanViewWait = {
  /** Claude started a watcher, a wake-up, a scheduled check or background work in this turn. */
  armed: boolean
  /** Claude set an alarm that another service delivers later. */
  armedAlarm: boolean
  /** The turn began while the job was already waiting on its own. */
  fromWaiting: boolean
  /** Background work or scheduled wake-ups still in flight; null until the engine says. */
  inFlight: boolean | null
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      cleanViewEnabled: boolean
      checklist: CleanViewChecklist
      tick: number
      /** Kept in the session's state, not in the module, so a reload of the mod in the middle of a turn does not forget it. */
      wait: CleanViewWait
    }
  }
}
