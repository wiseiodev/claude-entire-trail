import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { Trail, TrailFinding, TrailMonitor, TrailRunner, TrailView } from '../types'
import {
  GATE_LABELS,
  NO_TRAIL,
  applyMonitor,
  askVerb,
  changeInList,
  changeOnBranch,
  checkTone,
  checksSummary,
  isImprovable,
  monitorDelta,
  monitorTone,
  parseRemote,
  parseWatchLine,
  pickFindings,
  pickRunner,
  pickTrail,
  pointValue,
  runnerName,
  scorePrompt,
  scoreRows,
  shortSha,
  sortChecks,
  updatePrompt,
} from './trail'

const PANE = 'entire-trail'
const TITLE = 'Entire Trail'
const REFRESH_MS = 30_000
const EVENT_REFRESH_DEBOUNCE_MS = 1_500
const CLI_TIMEOUT_MS = 20_000

const view = atom({ plugin: 'entire-trail', key: 'view' } as const, { status: 'idle' } as TrailView)
const monitors = atom(
  { plugin: 'entire-trail', key: 'monitors' } as const,
  {} as Record<string, TrailMonitor>,
)
const expanded = atom({ plugin: 'entire-trail', key: 'expanded' } as const, [] as string[])
const pinnedBranch = atom(
  { plugin: 'entire-trail', key: 'pinnedBranch' } as const,
  null as string | null,
)
// The trail being approved, so its button reads "Approving…" and ignores another press.
const approving = atom(
  { plugin: 'entire-trail', key: 'approving' } as const,
  null as number | null,
)

const TONE_COLOR = { good: 'success', warn: 'warning', bad: 'error', muted: 'subtle' } as const
const CHECK_ICON = { bad: '✕', running: '•', good: '✓', skipped: '–' } as const
const CHECK_COLOR = { bad: 'error', running: 'warning', good: 'success', skipped: 'subtle' } as const

type Poller = {
  refresh: (isForced?: boolean) => void
  start: () => void
  stop: () => void
  approve: (trail: Trail) => Promise<void>
}

type Repo = { owner: string; name: string }

// Entire's API for one repository's trails, which `entire api` signs in to.
const trailsPath = (repo: Repo) => `/api/v1/trails/gh/${repo.owner}/${repo.name}`

export const register: Register = on => {
  // Built in session.start, so its timers and the score stream run on that hook's `$`.
  let poller: Poller | null = null

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    let branch: string | null = null
    let watch: { trail: string; stop: () => void } | null = null
    let ticker: Timer | null = null
    let eventTimer: Timer | null = null
    let isRefreshing = false
    let queued: { isForced: boolean } | null = null

    async function entireJson(args: string[]) {
      const ran = await $.process.run(['entire', ...args], { timeoutMs: CLI_TIMEOUT_MS })
      if (ran.exitCode !== 0) {
        throw new Error((ran.stderr || ran.stdout).trim() || `entire ${args.join(' ')} failed`)
      }
      return JSON.parse(ran.stdout)
    }

    // The pinned branch, else this session's; `isOwn` when it is the branch this session works on.
    async function shownBranch() {
      const ran = await $.process.run(['git', 'branch', '--show-current'])
      const own = ran.exitCode === 0 ? ran.stdout.trim() : ''
      const branch = (await read($, pinnedBranch)) ?? own
      return { branch, isOwn: branch !== '' && branch === own }
    }

    async function originRepo() {
      const ran = await $.process.run(['git', 'remote', 'get-url', 'origin'])
      return ran.exitCode === 0 ? parseRemote(ran.stdout) : null
    }

    // The branch's change: through its project trail, else the repository's trail list, which still names merged work's branch.
    async function findChange(branch: string, repo: Repo): Promise<number | null> {
      try {
        const project = await entireJson(['trail', 'show', '--branch', branch, '--json'])
        const number = changeOnBranch(project, repo.name, branch)
        if (number !== null) return number
      } catch (error) {
        if (!NO_TRAIL.test(String(error))) throw error
      }
      const listed = await entireJson(['api', '--to', 'cell', `${trailsPath(repo)}?per_page=100`])
      return changeInList(listed, branch)
    }

    // Read on every refresh, so a runner added or edited in this checkout shows without a restart.
    async function readRunners(): Promise<TrailRunner[]> {
      const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
      if (top.exitCode !== 0) return []
      const dir = `${top.stdout.trim()}/.entire/runners`
      const files = (await $.fs.list(dir))
        .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
        .map(entry => entry.name)
        .sort()
      const runners = await Promise.all(
        files.map(file =>
          $.fs
            .read(`${dir}/${file}`)
            .then(text => pickRunner(file, JSON.parse(text)))
            .catch(() => null),
        ),
      )
      return runners.filter(runner => runner !== null)
    }

    function stopWatch() {
      watch?.stop()
      watch = null
    }

    // `entire trail watch` replays every score from the start, then streams new ones as runners report.
    function startWatch(selector: string) {
      stopWatch()
      const child = $.process.spawn({
        argv: ['entire', 'trail', 'watch', selector, '--json'],
      })
      const current = { trail: selector, stop: () => void child.return({ code: null, signal: null }) }
      watch = current
      void (async () => {
        let buffer = ''
        try {
          for await (const { stream, text } of child) {
            if (watch !== current) break
            if (stream !== 'stdout') continue
            const lines = (buffer + text).split('\n')
            buffer = lines.pop() ?? ''
            const events = lines.map(parseWatchLine)
            const payloads = events.flatMap(event =>
              event && 'monitor' in event ? [event.monitor] : [],
            )
            if (payloads.length > 0) {
              await update($, monitors, scores => payloads.reduce(applyMonitor, scores))
            }
            if (events.some(event => event && 'isEvent' in event)) scheduleEventRefresh()
          }
        } catch (error) {
          $.ui.log(`trail watch ended: ${String(error)}`, { to: 'debug' })
        } finally {
          if (watch === current) watch = null
        }
      })()
    }

    // Gates, checks and findings change with other trail events, so those re-read the trail once they settle.
    function scheduleEventRefresh() {
      eventTimer?.cancel()
      eventTimer = $.clock.after(EVENT_REFRESH_DEBOUNCE_MS, () => void refresh())
    }

    async function refresh(isForced = false) {
      if (isRefreshing) {
        queued = { isForced: isForced || (queued?.isForced ?? false) }
        return
      }
      isRefreshing = true
      try {
        const { branch: current, isOwn } = await shownBranch()
        if (!current) {
          stopWatch()
          branch = null
          await update($, view, (): TrailView => ({ status: 'idle' }))
          return
        }
        if (isForced || current !== branch) {
          branch = current
          stopWatch()
          await update($, monitors, () => ({}))
          await update($, view, (): TrailView => ({ status: 'loading', branch: current }))
        }
        let trail: Trail | null
        try {
          const repo = await originRepo()
          if (!repo) throw new Error('this checkout has no GitHub origin remote')
          const number = await findChange(current, repo)
          trail =
            number === null
              ? null
              : pickTrail(
                  await entireJson(['api', '--to', 'cell', `${trailsPath(repo)}/${number}`]),
                  repo.name,
                )
        } catch (error) {
          stopWatch()
          const message = error instanceof Error ? error.message : String(error)
          await update($, view, (): TrailView => ({ status: 'error', branch: current, error: message }))
          return
        }
        if (!trail) {
          stopWatch()
          await update($, view, (): TrailView => ({ status: 'no-trail', branch: current }))
          return
        }
        const findingArgs = ['trail', 'finding', 'list', trail.selector, '--json', '-n', '50']
        const [findings, resolved, runners] = await Promise.all([
          entireJson(findingArgs).then(raw => pickFindings(raw, 'Open'), () => null),
          // A fix usually moves the code it was about, so most resolved findings are on an older code version.
          entireJson([...findingArgs, '--status', 'resolved', '--freshness', 'any']).then(
            raw => pickFindings(raw, 'Resolved'),
            () => null,
          ),
          readRunners().catch(() => []),
        ])
        await update($, view, (): TrailView => ({
          status: 'ready',
          branch: current,
          isOwnBranch: isOwn,
          trail,
          findings,
          resolved,
          runners,
        }))
        if (watch?.trail !== trail.selector) startWatch(trail.selector)
      } catch (error) {
        $.ui.log(`trail refresh failed: ${String(error)}`, { to: 'debug' })
      } finally {
        isRefreshing = false
        if (queued) {
          const again = queued
          queued = null
          void refresh(again.isForced)
        }
      }
    }

    poller = {
      refresh: isForced => void refresh(isForced),
      start: () => {
        ticker?.cancel()
        ticker = $.clock.every(REFRESH_MS, () => void refresh())
        void refresh(true)
      },
      stop: () => {
        ticker?.cancel()
        eventTimer?.cancel()
        ticker = null
        stopWatch()
      },
      approve: async ({ number: trailNumber, selector }) => {
        if ((await read($, approving)) !== null) return
        await update($, approving, () => trailNumber)
        let failure: string | null = null
        try {
          const ran = await $.process.run(['entire', 'trail', 'approve', selector], {
            timeoutMs: CLI_TIMEOUT_MS,
          })
          if (ran.exitCode !== 0) failure = (ran.stderr || ran.stdout).trim()
        } catch (error) {
          failure = String(error)
        } finally {
          await update($, approving, () => null)
        }
        $.ui.toast(
          failure === null
            ? `Approved trail #${trailNumber}.`
            : `Entire could not approve trail #${trailNumber}: ${failure}`,
        )
        // Approvals emit no watch event, so the pane reads the trail again.
        void refresh()
      },
    }

    await $.command.register({
      name: 'trail',
      description:
        "Show the Entire Trail pane for this session's branch, or for the branch or PR number you name",
      argumentHint: '[branch | PR number]',
    })
    poller.start()
    void $.ui.open({ id: PANE, title: TITLE })
    return started
  })

  on('command.run', { command: 'trail' }, async ($, e) => {
    const target = e.args.trim()
    let pinned: string | null = target || null
    let shown = pinned
    // A number is a pull request: its head branch is the one its trail follows.
    const pr = /^#?(\d+)$/.exec(target)?.[1]
    if (pr) {
      const ran = await $.process.run(
        ['gh', 'pr', 'view', pr, '--json', 'headRefName', '--jq', '.headRefName'],
        { timeoutMs: CLI_TIMEOUT_MS },
      )
      if (ran.exitCode !== 0 || !ran.stdout.trim()) {
        return { text: `GitHub could not find PR #${pr}: ${(ran.stderr || ran.stdout).trim()}` }
      }
      pinned = ran.stdout.trim()
      shown = `PR #${pr} (${pinned})`
    }
    await update($, pinnedBranch, () => pinned)
    poller?.start()
    await $.ui.open({ id: PANE, title: TITLE })
    return {
      text: shown
        ? `The Entire Trail pane shows ${shown}. Run /trail alone to follow this session's branch again.`
        : "The Entire Trail pane follows this session's branch.",
    }
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) poller?.stop()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const current = await read($, view)
    const refreshButton = (
      <Button key="refresh" label="Refresh" onPress={() => poller?.refresh(true)} />
    )

    if (current.status !== 'ready') {
      const message =
        current.status === 'idle'
          ? "Looking for this session's branch…"
          : current.status === 'loading'
            ? `Loading the trail for ${current.branch}…`
            : current.status === 'no-trail'
              ? `${current.branch} has no trail. Run /trail <branch or PR number> to show another trail.`
              : `Entire could not read the trail for ${current.branch}: ${current.error}`
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{message}</Text>
          <Box>{refreshButton}</Box>
        </Box>
      )
    }

    const { trail, findings, resolved, runners } = current
    const scores = scoreRows(runners, await read($, monitors))
    const open = await read($, expanded)
    const labelWidth = Math.max(0, ...scores.map(score => score.label.length))
    // What the row leaves for the bar after the toggle, dot, label, delta, value and spaces.
    const barWidth = Math.max(6, Math.min(30, e.props.bodyColumns - 25 - labelWidth))
    const isScored = scores.some(score => score.history.length > 0)
    const isHeadScored = scores.some(score => score.sha === trail.headSha)
    const isApproved = trail.gates.some(gate => gate.key === 'approvals' && gate.status === 'passed')
    const isApproving = (await read($, approving)) === trail.number
    const toggle = (key: string) =>
      update($, expanded, keys =>
        keys.includes(key) ? keys.filter(one => one !== key) : [...keys, key],
      )

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Link href={trail.url}>{`Trail #${trail.number}`}</Link>
          <Text dimColor>{trail.status}</Text>
        </Box>
        <Text bold>{trail.title}</Text>
        <Text dimColor wrap="truncate-end">
          {current.branch} · {shortSha(trail.headSha)} → {trail.base}
        </Text>
        <Box marginTop={1} gap={1}>
          {trail.status === 'open' &&
            (isApproved ? (
              <Text color="success">✓ Approved</Text>
            ) : (
              <Button
                key="approve"
                variant="primary"
                label={isApproving ? 'Approving…' : 'Approve'}
                onPress={() => poller?.approve(trail)}
              />
            ))}
          {refreshButton}
        </Box>
        {trail.description !== '' && (
          <Box flexDirection="column" marginTop={1}>
            <Button key="toggle-description" plain onPress={() => toggle('description')}>
              <Text dimColor>{open.includes('description') ? '▾' : '▸'}</Text> <Text bold>DESCRIPTION</Text>
            </Button>
            {open.includes('description') && (
              <Box paddingLeft={2}>
                <Text>{trail.description}</Text>
              </Box>
            )}
          </Box>
        )}

        <Box marginTop={1}>
          <Text bold>SCORES</Text>
        </Box>
        {!isScored && <Text dimColor>No runner scores yet.</Text>}
        {isScored && !isHeadScored && (
          <Text dimColor>
            Runners haven't scored {shortSha(trail.headSha)} yet. Showing the last scores.
          </Text>
        )}
        {scores.map(score => {
          const tone = TONE_COLOR[monitorTone(score)]
          const delta = monitorDelta(score)
          const filled =
            score.value_type === 'percent' && score.percent_value != null
              ? Math.round((Math.max(0, Math.min(100, score.percent_value)) / 100) * barWidth)
              : 0
          const isOpen = open.includes(score.key)
          return (
            <Box key={`score-${score.key}`} flexDirection="column">
              <Button key={`toggle-${score.key}`} plain onPress={() => toggle(score.key)}>
                <Text dimColor>{isOpen ? '▾' : '▸'}</Text> <Text color={tone}>●</Text>{' '}
                {score.label.padEnd(labelWidth)} <Text color={tone}>{'█'.repeat(filled)}</Text>
                <Text dimColor>{'░'.repeat(barWidth - filled)}</Text>{' '}
                <Text color={delta?.isImproved ? 'success' : 'error'}>
                  {(delta?.text ?? '').padStart(7)}
                </Text>{' '}
                <Text bold>{pointValue(score.value_type, score).padStart(4)}</Text>
              </Button>
              {isOpen && (
                <Box flexDirection="column" paddingLeft={4} marginBottom={1}>
                  {score.history.length === 0 ? (
                    <Text dimColor>This runner hasn't scored the trail yet.</Text>
                  ) : (
                    <Text>
                      {score.rationale}
                      {score.sha !== trail.headSha ? ` (${shortSha(score.sha)})` : ''}
                    </Text>
                  )}
                  {score.history.length > 1 && (
                    <Text dimColor>
                      History by commit:{' '}
                      {score.history.map(point => pointValue(score.value_type, point)).join(' → ')}
                    </Text>
                  )}
                  {isImprovable(score) && (
                    <Box>
                      <Button
                        key={`ask-${score.key}`}
                        label={askVerb(score)}
                        onPress={() =>
                          $.prompt.fill({
                            text: scorePrompt(
                              score,
                              trail.number,
                              runners.find(runner => runner.monitor?.key === score.key)?.file ??
                                null,
                            ),
                          })
                        }
                      />
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          )
        })}

        <Box marginTop={1}>
          <Text bold>GATES</Text>
        </Box>
        {trail.gates.length === 0 && <Text dimColor>No gates reported.</Text>}
        {trail.gates.map(gate => (
          <Box key={`gate-${gate.key}`} flexDirection="column">
            <Box gap={1}>
              <Text
                color={
                  gate.status === 'passed'
                    ? 'success'
                    : gate.status === 'failed'
                      ? 'error'
                      : 'subtle'
                }
              >
                {gate.status === 'passed' ? '✓' : gate.status === 'failed' ? '✕' : '•'}
              </Text>
              <Box width={11} flexShrink={0}>
                <Text>{GATE_LABELS[gate.key] ?? gate.key}</Text>
              </Box>
              <Text dimColor>
                {gate.rationale ?? gate.status}
                {gate.runnerIds.length > 0
                  ? ` · ${gate.runnerIds.map(id => runnerName(runners, id)).join(', ')}`
                  : ''}
              </Text>
            </Box>
            {gate.key === 'up_to_date' &&
              gate.status === 'failed' &&
              trail.status === 'open' &&
              current.isOwnBranch && (
                <Box paddingLeft={2}>
                  <Button
                    key="update-branch"
                    label={`Update from ${trail.base} with Claude`}
                    onPress={() =>
                      void $.prompt
                        .submit({
                          text: updatePrompt(trail, current.branch, gate.rationale),
                          asUser: true,
                        })
                        .catch(error => $.ui.toast(`Claude did not get the prompt: ${String(error)}`))
                    }
                  />
                </Box>
              )}
          </Box>
        ))}

        <Box marginTop={1} gap={2}>
          <Text bold>CHECKS</Text>
          <Text dimColor>{checksSummary(trail.checks)}</Text>
        </Box>
        {trail.checks.length === 0 && <Text dimColor>No CI checks reported.</Text>}
        {sortChecks(trail.checks).map(check => {
          const tone = checkTone(check)
          return (
            <Box key={`check-${check.name}`} gap={1}>
              <Text color={CHECK_COLOR[tone]}>{CHECK_ICON[tone]}</Text>
              <Box flexGrow={1}>
                <Text wrap="truncate-end">{check.name}</Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {check.app}
              </Text>
            </Box>
          )
        })}

        <Box marginTop={1} gap={2}>
          <Text bold>FINDINGS</Text>
          <Text dimColor>
            {findings ? `${findings.count} open` : 'unavailable'}
            {resolved && resolved.count > 0 ? ` · ${resolved.count} resolved` : ''}
          </Text>
        </Box>
        {findings && findings.items.length === 0 && <Text dimColor>No open findings.</Text>}
        {findings?.items.map((finding, index) => findingRow(finding, `finding-${index}`, false))}
        {resolved && resolved.items.length > 0 && (
          <Box flexDirection="column">
            <Button key="toggle-resolved" plain onPress={() => toggle('resolved')}>
              <Text dimColor>{open.includes('resolved') ? '▾' : '▸'}</Text> {resolved.count} resolved
            </Button>
            {open.includes('resolved') &&
              resolved.items.map((finding, index) =>
                findingRow(finding, `resolved-${index}`, true),
              )}
          </Box>
        )}
      </Box>
    )

    function findingRow(finding: TrailFinding, key: string, isResolved: boolean) {
      return (
        <Box key={key} flexDirection="column" paddingLeft={isResolved ? 2 : 0}>
          <Text>
            {isResolved ? (
              <Text color="success">✓</Text>
            ) : (
              <Text color={finding.severity === 'high' ? 'error' : 'warning'}>
                {finding.severity}
              </Text>
            )}{' '}
            <Text dimColor>
              {finding.file
                ? `${finding.file}${finding.line ? `:${finding.line}` : ''}`
                : 'General'}
              {finding.runnerId ? ` · ${runnerName(runners, finding.runnerId)}` : ''}
            </Text>
          </Text>
          <Box flexDirection="column" paddingLeft={2}>
            <Text dimColor={isResolved}>{finding.title}</Text>
            {isResolved && finding.reason && <Text dimColor>{finding.reason}</Text>}
          </Box>
        </Box>
      )
    }
  })
}
