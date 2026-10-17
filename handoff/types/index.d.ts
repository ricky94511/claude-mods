export type Phase = 'idle' | 'writing' | 'preview' | 'confirmed' | 'switching'

export type Pending = { title: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    handoff: {
      phase: Phase
      usedTokens: number | null
      isHidden: boolean
      pending: Pending | null
      nextAskTokens: number | null
    }
  }
}
