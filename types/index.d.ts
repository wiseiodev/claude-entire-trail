export type TrailPoint = {
  sha: string
  percent_value: number | null
  boolean_value: boolean | null
  // small, medium or large, for a score whose value type is size.
  size_value: string | null
}

// An agent's latest run on the change, which can be newer than its last score.
export type TrailRun = { status: string; sha: string; error: string | null }

export type TrailMonitor = TrailPoint & {
  key: string
  label: string
  value_type: string
  polarity: string
  rationale: string
  history: TrailPoint[]
  // Set for a score from an agent set up on Entire, not from a runner file.
  agentId?: string
  run?: TrailRun | null
}

export type TrailRunnerMonitor = { key: string; label: string; value_type: string; polarity: string }

// An enabled runner from the repository's `.entire/runners/*.json`.
export type TrailRunner = {
  id: string
  name: string
  file: string
  // The score it reports, or null for a runner that reports review comments or a summary.
  monitor: TrailRunnerMonitor | null
}

export type TrailGate = {
  key: string
  status: string
  rationale: string | null
  runnerIds: string[]
}

export type TrailCheck = { name: string; status: string; conclusion: string | null; app: string }

export type TrailFinding = {
  severity: string
  title: string
  file: string | null
  line: number | null
  // The runner that posted it, or null for a person's or an agent's finding.
  runnerId: string | null
  // The review that posted it, which names the agent whose run made it.
  reviewId: string | null
  // Why it was resolved or dismissed, as recorded on the finding.
  reason: string | null
}

export type TrailFindings = { count: number; items: TrailFinding[] }

export type Trail = {
  // The change number, which the trail's repository numbers like a pull request.
  number: number
  // `<repo>/<number>`, which per-change `entire trail` commands take.
  selector: string
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
      resolved: TrailFindings | null
      runners: TrailRunner[]
      // The change's agents on Entire, each with its latest score.
      agents: TrailMonitor[]
      // The agent name for each review whose run Entire returned.
      reviewers: Record<string, string>
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
