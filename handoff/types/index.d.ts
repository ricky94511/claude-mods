export type Phase = 'idle' | 'writing' | 'switching'

declare module 'claude-code' {
  interface PluginState {
    handoff: { phase: Phase; percent: number | null; isHidden: boolean }
  }
}
