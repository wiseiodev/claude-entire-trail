export type TrailPoint = {
  sha: string
  percent_value: number | null
  boolean_value: boolean | null
}

export type TrailMonitor = TrailPoint & {
  key: string
  label: string
  value_type: string
  polarity: string
  rationale: string
  history: TrailPoint[]
}

export type TrailGate = { key: string; status: string; rationale: string | null }

export type TrailCheck = { name: string; status: string; conclusion: string | null; app: string }

export type TrailFinding = {
  severity: string
  title: string
  file: string | null
  line: number | null
}

export type TrailFindings = { open: number; items: TrailFinding[] }

export type Trail = {
  number: number
  title: string
  description: string
  url: string
  status: string
  base: string
  headSha: string | null
  gates: TrailGate[]
  checks: TrailCheck[]
}

export type TrailView =
  | { status: 'idle' }
  | { status: 'loading'; branch: string }
  | { status: 'no-trail'; branch: string }
  | { status: 'error'; branch: string; error: string }
  | {
      status: 'ready'
      branch: string
      // True when the branch is the one this session works on, not one pinned with /trail.
      isOwnBranch: boolean
      trail: Trail
      findings: TrailFindings | null
    }

declare module 'claude-code' {
  interface PluginState {
    'entire-trail': {
      view: TrailView
      monitors: Record<string, TrailMonitor>
      expanded: string[]
      pinnedBranch: string | null
      approving: number | null
    }
  }
}
