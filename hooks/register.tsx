import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { TrailMonitor, TrailView } from '../types'
import {
  GATE_LABELS,
  applyMonitor,
  askVerb,
  checkTone,
  checksSummary,
  isImprovable,
  monitorDelta,
  monitorTone,
  parseWatchLine,
  pickFindings,
  pickTrail,
  pointValue,
  scorePrompt,
  shortSha,
  sortChecks,
  sortMonitors,
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

const TONE_COLOR = { good: 'success', warn: 'warning', bad: 'error', muted: 'subtle' } as const
const CHECK_ICON = { bad: '✕', running: '•', good: '✓', skipped: '–' } as const
const CHECK_COLOR = { bad: 'error', running: 'warning', good: 'success', skipped: 'subtle' } as const

type Poller = { refresh: (isForced?: boolean) => void; start: () => void; stop: () => void }

export const register: Register = on => {
  // Built in session.start, so its timers and the score stream run on that hook's `$`.
  let poller: Poller | null = null

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    let branch: string | null = null
    let watch: { trail: number; stop: () => void } | null = null
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

    async function sessionBranch() {
      const pinned = await read($, pinnedBranch)
      if (pinned) return pinned
      const ran = await $.process.run(['git', 'branch', '--show-current'])
      return ran.exitCode === 0 ? ran.stdout.trim() : ''
    }

    function stopWatch() {
      watch?.stop()
      watch = null
    }

    // `entire trail watch` replays every score from the start, then streams new ones as runners report.
    function startWatch(trailNumber: number) {
      stopWatch()
      const child = $.process.spawn({
        argv: ['entire', 'trail', 'watch', String(trailNumber), '--json'],
      })
      const current = { trail: trailNumber, stop: () => void child.return({ code: null, signal: null }) }
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
        const current = await sessionBranch()
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
        let shown: unknown
        try {
          shown = await entireJson(['trail', 'show', '--branch', current, '--json'])
        } catch (error) {
          stopWatch()
          const message = error instanceof Error ? error.message : String(error)
          await update($, view, (): TrailView =>
            /no trail found/i.test(message)
              ? { status: 'no-trail', branch: current }
              : { status: 'error', branch: current, error: message },
          )
          return
        }
        const trail = pickTrail(shown)
        const findings = await entireJson([
          'trail',
          'finding',
          '--branch',
          current,
          '--json',
          '-n',
          '50',
        ]).then(pickFindings, () => null)
        await update($, view, (): TrailView => ({ status: 'ready', branch: current, trail, findings }))
        if (watch?.trail !== trail.number) startWatch(trail.number)
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

    const { trail, findings } = current
    const scores = sortMonitors(await read($, monitors))
    const open = await read($, expanded)
    const barWidth = Math.max(6, Math.min(30, e.props.bodyColumns - 36))
    const isHeadScored = scores.some(score => score.sha === trail.headSha)
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
        <Box marginTop={1}>{refreshButton}</Box>

        <Box marginTop={1}>
          <Text bold>SCORES</Text>
        </Box>
        {scores.length === 0 && <Text dimColor>No runner scores yet.</Text>}
        {scores.length > 0 && !isHeadScored && (
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
                {score.label.padEnd(11)} <Text color={tone}>{'█'.repeat(filled)}</Text>
                <Text dimColor>{'░'.repeat(barWidth - filled)}</Text>{' '}
                <Text color={delta?.isImproved ? 'success' : 'error'}>
                  {(delta?.text ?? '').padStart(7)}
                </Text>{' '}
                <Text bold>{pointValue(score.value_type, score).padStart(4)}</Text>
              </Button>
              {isOpen && (
                <Box flexDirection="column" paddingLeft={4} marginBottom={1}>
                  <Text>
                    {score.rationale}
                    {score.sha !== trail.headSha ? ` (${shortSha(score.sha)})` : ''}
                  </Text>
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
                        onPress={() => $.prompt.fill({ text: scorePrompt(score, trail.number) })}
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
          <Box key={`gate-${gate.key}`} gap={1}>
            <Text
              color={
                gate.status === 'passed' ? 'success' : gate.status === 'failed' ? 'error' : 'subtle'
              }
            >
              {gate.status === 'passed' ? '✓' : gate.status === 'failed' ? '✕' : '•'}
            </Text>
            <Text>{(GATE_LABELS[gate.key] ?? gate.key).padEnd(11)}</Text>
            <Text dimColor>{gate.rationale ?? gate.status}</Text>
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
          <Text dimColor>{findings ? `${findings.open} open` : 'unavailable'}</Text>
        </Box>
        {findings && findings.items.length === 0 && <Text dimColor>No open findings.</Text>}
        {findings?.items.map((finding, index) => (
          <Box key={`finding-${index}`} flexDirection="column">
            <Text>
              <Text color={finding.severity === 'high' ? 'error' : 'warning'}>
                {finding.severity}
              </Text>{' '}
              <Text dimColor>
                {finding.file
                  ? `${finding.file}${finding.line ? `:${finding.line}` : ''}`
                  : 'General'}
              </Text>
            </Text>
            <Box paddingLeft={2}>
              <Text>{finding.title}</Text>
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
