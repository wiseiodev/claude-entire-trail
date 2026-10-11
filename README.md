# Entire Trail for Claude Code

A Claude Code pane for [Entire](https://entire.io) Trails. It shows the open trail for your session's
branch, or for any branch or pull request you name: runner scores and how they changed, gates, CI
checks, and open findings. It updates live as runners report.

It is the Claude Code version of [Entire Trails for Orca](https://github.com/wiseiodev/orca-entire-trails).
It drives the `entire` and `gh` CLIs you already use. Nothing talks to Entire or GitHub except those
CLIs.

## Install

Type this at the prompt of a Claude Code session:

```
/plugin install entire-trail --marketplace wiseiodev/claude-entire-trail
```

Answer `y` to add the marketplace, then pick the user scope. The pane starts in that session and in
every session after it.

## Requirements

- Claude Code 2.1.296 or later. The pane uses Claude Code's function hooks, which are in early access
  and can change between releases.
- [`entire`](https://entire.io) installed and signed in (`entire auth status`), in a repository with
  Entire Trails.
- [`gh`](https://cli.github.com) signed in (`gh auth status`), for `/trail <PR number>`.

## Use it

The pane opens by itself when your terminal is at least 144 columns wide. In a narrower terminal,
run `/trail` to open it.

| Command | What the pane shows |
| --- | --- |
| `/trail` | The trail for this session's branch. The pane follows the branch when you switch. |
| `/trail <branch>` | The trail for that branch, such as a teammate's. |
| `/trail <PR number>` | The trail for that pull request's head branch. `#877` works too. |

Trail numbers and PR numbers are different: `/trail 880` means PR #880.

## What the pane shows

- **Header:** trail number (a link to the trail), status, title, branch, head commit, and base.
- **Approve:** approves an open trail with one press (`entire trail approve <n>`). It changes to
  **✓ Approved** once the trail's approvals gate passes.
- **Scores:** Confidence, Risk, Security, Drift, and Loose Ends, each with a bar and the change since
  the previous scored commit. Press a score to read the runner's notes and its history by commit.
- **Raise or lower a score with Claude:** a button under an open score that can still improve. It puts
  a prompt with the runner's notes in your input box. Read it, then press Enter to send it.
- **Gates, Checks, Findings:** the trail's gates, every CI check (failures first), and open agent
  findings with file and line.
- **Update from main with Claude:** shows under a failed **Up to date** gate on your session's own
  branch. It sends Claude a prompt to bring the base branch in and resolve conflicts, using a
  `sync-main` skill when the repository has one. A teammate's branch shown with `/trail` gets no
  button, because your session can't update it.
- **Refresh:** reads the trail again and replays the score stream.

The pane runs `entire trail watch` for live scores, and reads the trail again after other trail
events and every 30 seconds.

## Develop it

Clone the repository and load it from your clone:

```sh
git clone https://github.com/wiseiodev/claude-entire-trail.git ~/dev/claude-entire-trail
claude --plugin-dir ~/dev/claude-entire-trail
```

To load it in every session, set `CLAUDE_CODE_PLUGIN_DIRS` to the folder in the `env` block of
`~/.claude/settings.json`. Claude Code reloads the plugin when you save a file. Don't also install it
from the marketplace, or two copies load.

Check a change before you push it:

```sh
claude plugin validate ~/dev/claude-entire-trail
claude plugin test ~/dev/claude-entire-trail
```

`hooks/register.tsx` holds the hooks and the pane. `hooks/trail.ts` reads the `entire` output.

## License

MIT
