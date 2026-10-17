export type Phase = 'idle' | 'writing' | 'preview' | 'confirmed' | 'switching'

export type Pending = { title: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    handoff: {
      phase: Phase
      percent: number | null
      isHidden: boolean
      pending: Pending | null
      nextAskAt: number | null
    }
  }
}
