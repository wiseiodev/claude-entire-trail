import { expect, mock, test } from 'claude-code/testing'

const ran = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const HEAD = '4f46aa055a70dd01026d13a5d69e306a87b3a165'

const TRAIL = {
  number: 118,
  title: 'feat(messages): let teammates message each other',
  body: 'Teammates can message each other from the hotel page.',
  url: 'https://entire.io/gh/analysis-ai/rate-shop/trails/118',
  status: 'open',
  base: 'main',
  mergeability: {
    head_sha: HEAD,
    gates: [
      { gate_key: 'approvals', status: 'passed', rationale: '1 approval(s) recorded' },
      {
        gate_key: 'findings',
        status: 'passed',
        rationale: 'Agent review found no blocking issues',
        runner_ids: ['trail-comments', 'trail-review'],
      },
    ],
    checks: {
      runs: [
        { name: 'pnpm-ci-checks', status: 'completed', conclusion: 'success', app_name: 'GitHub Actions' },
        { name: 'postgres-integration', status: 'completed', conclusion: 'failure', app_name: 'GitHub Actions' },
      ],
    },
  },
}

const FINDINGS = {
  counts: { Open: 1 },
  findings: [
    {
      severity: 'medium',
      title: 'Hotel hard-delete throws an unhandled FK error',
      actorId: 'agent:trail-comments',
      location: { filePath: 'packages/db/src/hotels.ts', startLine: 42 },
    },
  ],
}

const RESOLVED = {
  counts: { Open: 1, Resolved: 1 },
  findings: [
    {
      severity: 'low',
      body: 'The ANN-1393 comment repeats what TESTING.md records.',
      actorId: 'agent:trail-comments',
      statusReason: 'Fixed in 67549c1: deleted the comment.',
      location: { filePath: 'scripts/test/shared-worker.setup.mjs', startLine: 3 },
    },
  ],
}

const confidence = (sha: string, percent: number) =>
  JSON.stringify({
    data: {
      event_type: 'monitor.updated',
      payload: {
        monitor_key: 'confidence',
        label: 'Confidence',
        value_type: 'percent',
        polarity: 'higher_is_better',
        percent_value: percent,
        boolean_value: null,
        rationale: 'Backed by a database integration test.',
        head_sha: sha,
      },
    },
  })

const flakyTests = (sha: string, isFixed: boolean) =>
  JSON.stringify({
    data: {
      event_type: 'monitor.updated',
      payload: {
        monitor_key: 'flaky_tests',
        label: 'Flaky Tests Fixed',
        value_type: 'boolean',
        polarity: 'higher_is_better',
        percent_value: null,
        boolean_value: isFixed,
        rationale: 'A retry still hides the timing race in sync.test.ts.',
        head_sha: sha,
      },
    },
  })

const monitorRunner = (key: string, label: string, value_type: string) => ({
  enabled: true,
  output: {
    result_type: 'trail_monitor',
    trail_monitor: { key, label, value_type, polarity: 'higher_is_better' },
  },
})

// The files in /repo/.entire/runners: two score runners and a review runner that reports no score.
const RUNNERS: Record<string, unknown> = {
  'trail-comments.json': {
    id: 'trail-comments',
    display_name: 'Comment Review',
    enabled: true,
    output: { result_type: 'code_review_comments' },
  },
  'trail-confidence.json': monitorRunner('confidence', 'Confidence', 'percent'),
  'trail-flaky-tests.json': monitorRunner('flaky_tests', 'Flaky Tests Fixed', 'boolean'),
}
const runnerEntries = Object.keys(RUNNERS).map(name => ({
  name,
  kind: 'file' as const,
  size: 1,
  mtimeMs: 0,
  isLink: false,
}))
const runnerText = (path: string) => JSON.stringify(RUNNERS[path.split('/').pop() ?? ''])

const PANE = { plugin: 'entire-trail', component: 'Pane', requestId: 'entire-trail' } as const
const PROPS = {
  title: 'Entire Trail',
  isFocused: false,
  bodyColumns: 70,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

test("the pane shows the branch's trail, scores, gates, checks and findings", async ($, on) => {
  const clock = mock.clock(on)
  const runs: string[][] = []
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (e.argv[1] === 'rev-parse') return ran('/repo\n')
    if (e.argv[0] === 'git') return ran('feature-x\n')
    if (e.argv[2] === 'show') return ran(JSON.stringify(TRAIL))
    if (e.argv[2] === 'finding') {
      return ran(JSON.stringify(e.argv.includes('resolved') ? RESOLVED : FINDINGS))
    }
    return ran('', 1, 'unexpected command')
  })
  on('process.spawn', async function* () {
    // One chunk ends mid-line, as a real pipe can.
    const lines = `${confidence('1bd0835', 78)}\n${confidence(HEAD, 80)}\n`
    yield { stream: 'stdout' as const, text: lines.slice(0, 50) }
    yield { stream: 'stdout' as const, text: lines.slice(50) }
    return { value: { code: 0, signal: null } }
  })
  on('fs.list', () => ({ value: runnerEntries }))
  on('fs.read', ($, e) => ({ value: runnerText(e.path) }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(runs).toContainEqual(['entire', 'trail', 'show', '--branch', 'feature-x', '--json'])
  expect(runs).toContainEqual([
    'entire', 'trail', 'finding', '--branch', 'feature-x', '--json', '-n', '50',
    '--status', 'resolved', '--freshness', 'any',
  ])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })
    expect(await ui.find({ type: 'Link', text: 'Trail #118' })).toBeDefined()
    expect(await ui.find({ key: 'toggle-confidence', text: /Confidence.*▲2.*80%/ })).toBeDefined()
    expect(await ui.find({ text: '1 approval(s) recorded' })).toBeDefined()
    expect(await ui.find({ text: '1 failed · 1 passed' })).toBeDefined()
    expect(await ui.find({ text: 'Hotel hard-delete throws an unhandled FK error' })).toBeDefined()

    expect(await ui.find({ text: 'Teammates can message each other from the hotel page.' })).toBeUndefined()
    await ui.press({ key: 'toggle-description' })
    expect(await ui.find({ text: 'Teammates can message each other from the hotel page.' })).toBeDefined()
    await ui.press({ key: 'toggle-description' })

    await ui.press({ key: 'toggle-confidence' })
    expect(await ui.find({ text: 'History by commit: 78% → 80%' })).toBeDefined()
    expect(await ui.find({ key: 'ask-confidence', text: 'Raise this with Claude' })).toBeDefined()
    await ui.press({ key: 'toggle-confidence' })

    // A runner in .entire/runners that has not reported yet still gets its row.
    expect(await ui.find({ key: 'toggle-flaky_tests', text: /Flaky Tests Fixed.*—/ })).toBeDefined()
    await ui.press({ key: 'toggle-flaky_tests' })
    expect(await ui.find({ text: "This runner hasn't scored the trail yet." })).toBeDefined()
    expect(await ui.find({ key: 'ask-flaky_tests' })).toBeUndefined()
    await ui.press({ key: 'toggle-flaky_tests' })

    // Review runners show by name: in their gate, and on the findings they posted.
    expect(
      await ui.find({ text: 'Agent review found no blocking issues · Comment Review, trail-review' }),
    ).toBeDefined()
    expect(await ui.find({ text: 'packages/db/src/hotels.ts:42 · Comment Review' })).toBeDefined()

    expect(await ui.find({ text: '1 open · 1 resolved' })).toBeDefined()
    expect(await ui.find({ text: 'The ANN-1393 comment repeats what TESTING.md records.' })).toBeUndefined()
    await ui.press({ key: 'toggle-resolved' })
    expect(await ui.find({ text: 'The ANN-1393 comment repeats what TESTING.md records.' })).toBeDefined()
    expect(await ui.find({ text: 'Fixed in 67549c1: deleted the comment.' })).toBeDefined()
    await ui.press({ key: 'toggle-resolved' })
    await ui.unmount()
  }
})

test("a score's Claude prompt is worded from its runner and names the runner's file", async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  on('process.run', ($, e) => {
    if (e.argv[1] === 'rev-parse') return ran('/repo\n')
    if (e.argv[0] === 'git') return ran('feature-x\n')
    if (e.argv[2] === 'show') return ran(JSON.stringify(TRAIL))
    if (e.argv[2] === 'finding') return ran(JSON.stringify(FINDINGS))
    return ran('', 1, 'unexpected command')
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${flakyTests(HEAD, false)}\n` }
    return { value: { code: 0, signal: null } }
  })
  on('fs.list', () => ({ value: runnerEntries }))
  on('fs.read', ($, e) => ({ value: runnerText(e.path) }))
  on('prompt.fill', ($, e) => {
    prompts.push(e.text)
    return { isFilled: true }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  await ui.press({ key: 'toggle-flaky_tests' })
  await ui.press({ key: 'ask-flaky_tests' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain("Flaky Tests Fixed runner answered No on 4f46aa0. Change this branch so it answers Yes")
  expect(prompts[0]).toContain('Read .entire/runners/trail-flaky-tests.json for what the runner checks.')
  expect(prompts[0]).toContain('A retry still hides the timing race in sync.test.ts.')
  await ui.unmount()
})

test('a branch with no trail says so', async ($, on) => {
  const clock = mock.clock(on)
  on('process.run', ($, e) =>
    e.argv[0] === 'git' ? ran('no-trail-branch\n') : ran('', 1, 'Error: no trail found for branch'),
  )
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ text: /no-trail-branch has no trail/ })).toBeDefined()
  await ui.unmount()
})

test('/trail with a PR number shows the trail of that PR head branch', async ($, on) => {
  const clock = mock.clock(on)
  const runs: string[][] = []
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'git') return ran('Claude-Code-Mod\n')
    if (e.argv[0] === 'gh') return ran('ann-1266-team-messaging\n')
    if (e.argv[2] === 'show') return ran(JSON.stringify(TRAIL))
    if (e.argv[2] === 'finding') return ran(JSON.stringify(FINDINGS))
    return ran('', 1, 'unexpected command')
  })
  on('process.spawn', async function* () {
    return { value: { code: 0, signal: null } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const answer = await $.command.run({
    command: 'trail',
    args: '#877',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  await clock.settle()

  expect(answer.text).toContain('PR #877 (ann-1266-team-messaging)')
  expect(runs).toContainEqual(['gh', 'pr', 'view', '877', '--json', 'headRefName', '--jq', '.headRefName'])
  expect(runs).toContainEqual(['entire', 'trail', 'show', '--branch', 'ann-1266-team-messaging', '--json'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Link', text: 'Trail #118' })).toBeDefined()
  await ui.unmount()
})

test('one press of Approve approves the trail and the pane then shows it approved', async ($, on) => {
  const clock = mock.clock(on)
  const runs: string[][] = []
  const toasts: string[] = []
  let isApproved = false
  const trail = () => ({
    ...TRAIL,
    mergeability: {
      ...TRAIL.mergeability,
      gates: [{ gate_key: 'approvals', status: isApproved ? 'passed' : 'failed', rationale: null }],
    },
  })
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'git') return ran('feature-x\n')
    if (e.argv[2] === 'show') return ran(JSON.stringify(trail()))
    if (e.argv[2] === 'finding') return ran(JSON.stringify(FINDINGS))
    if (e.argv[2] === 'approve') {
      isApproved = true
      return ran('')
    }
    return ran('', 1, 'unexpected command')
  })
  on('process.spawn', async function* () {
    return { value: { code: 0, signal: null } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ key: 'approve', text: 'Approve' })).toBeDefined()
  await ui.press({ key: 'approve' })
  await clock.settle()

  expect(runs.filter(argv => argv[2] === 'approve')).toEqual([['entire', 'trail', 'approve', '118']])
  expect(toasts).toEqual(['Approved trail #118.'])
  expect(await ui.find({ key: 'approve' })).toBeUndefined()
  expect(await ui.find({ text: '✓ Approved' })).toBeDefined()
  await ui.unmount()
})

test('a behind branch gets a button that asks Claude to update it, only on its own session', async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  const behind = {
    ...TRAIL,
    mergeability: {
      ...TRAIL.mergeability,
      gates: [{ gate_key: 'up_to_date', status: 'failed', rationale: '3 commits behind main' }],
    },
  }
  on('process.run', ($, e) => {
    if (e.argv[0] === 'git') return ran('feature-x\n')
    if (e.argv[2] === 'show') return ran(JSON.stringify(behind))
    if (e.argv[2] === 'finding') return ran(JSON.stringify(FINDINGS))
    return ran('', 1, 'unexpected command')
  })
  on('process.spawn', async function* () {
    return { value: { code: 0, signal: null } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  await ui.press({ key: 'update-branch' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('feature-x is not up to date with main')
  expect(prompts[0]).toContain('3 commits behind main')
  await ui.unmount()

  // A teammate's branch pinned with /trail gets no button: this session can't update it.
  await $.command.run({
    command: 'trail',
    args: 'teammate-branch',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  await clock.settle()
  const pinned = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await pinned.find({ text: /teammate-branch/ })).toBeDefined()
  expect(await pinned.find({ key: 'update-branch' })).toBeUndefined()
  await pinned.unmount()
})
