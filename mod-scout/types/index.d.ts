export type Phase = 'idle' | 'collecting' | 'analyzing'

export type Proposal = { number: number; name: string }

declare module 'claude-code' {
  interface PluginState {
    'mod-scout': {
      phase: Phase
    }
  }
}
