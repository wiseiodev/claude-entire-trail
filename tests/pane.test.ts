import { expect, mock, test } from 'claude-code/testing'

const ran = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const HEAD = '4f46aa055a70dd01026d13a5d69e306a87b3a165'

const TRAIL = {
  number: 118,
  title: 'feat(messages): let teammates message each other',
  url: 'https://entire.io/gh/analysis-ai/rate-shop/trails/118',
  status: 'open',
  base: 'main',
  mergeability: {
    head_sha: HEAD,
    gates: [{ gate_key: 'approvals', status: 'passed', rationale: '1 approval(s) recorded' }],
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
      location: { filePath: 'packages/db/src/hotels.ts', startLine: 42 },
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
    if (e.argv[0] === 'git') return ran('feature-x\n')
    if (e.argv[2] === 'show') return ran(JSON.stringify(TRAIL))
    if (e.argv[2] === 'finding') return ran(JSON.stringify(FINDINGS))
    return ran('', 1, 'unexpected command')
  })
  on('process.spawn', async function* () {
    // One chunk ends mid-line, as a real pipe can.
    const lines = `${confidence('1bd0835', 78)}\n${confidence(HEAD, 80)}\n`
    yield { stream: 'stdout' as const, text: lines.slice(0, 50) }
    yield { stream: 'stdout' as const, text: lines.slice(50) }
    return { value: { code: 0, signal: null } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(runs).toContainEqual(['entire', 'trail', 'show', '--branch', 'feature-x', '--json'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })
    expect(await ui.find({ type: 'Link', text: 'Trail #118' })).toBeDefined()
    expect(await ui.find({ key: 'toggle-confidence', text: /Confidence.*▲2.*80%/ })).toBeDefined()
    expect(await ui.find({ text: '1 approval(s) recorded' })).toBeDefined()
    expect(await ui.find({ text: '1 failed · 1 passed' })).toBeDefined()
    expect(await ui.find({ text: 'Hotel hard-delete throws an unhandled FK error' })).toBeDefined()

    await ui.press({ key: 'toggle-confidence' })
    expect(await ui.find({ text: 'History by commit: 78% → 80%' })).toBeDefined()
    expect(await ui.find({ key: 'ask-confidence', text: 'Raise this with Claude' })).toBeDefined()
    await ui.press({ key: 'toggle-confidence' })
    await ui.unmount()
  }
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
