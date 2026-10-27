# Entire Trail for Claude Code

A Claude Code pane for [Entire](https://entire.io) Trails. It shows the open trail for your session's
branch, or for any branch or pull request you name: agent and runner scores and how they changed,
gates, CI checks, and open findings with the agent that raised each one. It updates live as Entire
reports.

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
- [`entire`](https://entire.io) 0.12.0 or later, installed and signed in (`entire auth status`), in a
  GitHub repository with Entire Trails.
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

- **Header:** the branch's change number on its trail (a link to the change), status, title, branch,
  head commit, and base.
- **Description:** the trail's description, under the Approve and Refresh buttons. Press it to open
  or close the text. It starts closed.
- **Approve:** approves an open trail with one press (`entire trail approve <repo>/<n>`). It changes to
  **✓ Approved** once the trail's approvals gate passes.
- **Scores:** one row for each runner in the repository's `.entire/runners/*.json` that reports a
  score, in file-name order, then one row for each agent the project sets up on Entire, in the order
  Entire lists them. Each row has a bar, a Yes or No, or a Small, Medium or Large, and the change since
  the previous scored commit. A score that has not come in yet shows —. While an agent scores a new
  push, its row says **scoring** and keeps the last score; a run that failed says **failed** and why.
  The pane reads the runner files again on each refresh, so a runner you add shows without a
  restart. Press a score to read its notes, its history by commit, and how many open findings an
  agent raised.
- **Raise or lower a score with Claude:** a button under an open score that can still improve. It puts
  a prompt with the score's notes in your input box. The prompt follows the score's value type and
  polarity, and for a runner names its file so Claude reads what the runner checks. Read it, then
  press Enter to send it.
- **Gates, Checks, Findings:** the trail's gates, every CI check (failures first), and open agent
  findings with file and line. A gate that review runners decide, such as **Findings**, names those
  runners. Each finding names the runner or agent that posted it: a runner by its file's
  `display_name`, an agent by its name on Entire.
- **Resolved findings:** press **▸ N resolved** under the open findings to read the resolved ones,
  each with the note it was resolved with. These include findings on earlier commits, because a fix
  usually changes the code a finding was about.
- **Update from main with Claude:** shows under a failed **Up to date** gate on your session's own
  branch. It sends Claude a prompt to bring the base branch in and resolve conflicts, using a
  `sync-main` skill when the repository has one. A teammate's branch shown with `/trail` gets no
  button, because your session can't update it.
- **Refresh:** reads the trail again and replays the score stream.

The pane finds the branch's change on its project trail (`entire trail show --branch`). For merged
work, it looks in the repository's trail list instead. It reads the change's gates, checks and agent
scores with `entire api`, because no other `entire` command prints them. Entire's findings don't name
the agent that raised them, so the pane reads the agent run that posted each finding's review, once
per run. It runs `entire trail watch` for live runner scores, and reads the change again after other
trail events, such as an agent starting or finishing a run, and every 30 seconds.

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
