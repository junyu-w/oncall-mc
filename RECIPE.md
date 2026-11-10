# Mission Control

Mission Control is a Herdr space for an on-call shift. You talk to an operator agent in the left pane. The
operator starts watcher agents, and each watcher watches one Slack channel. When a watcher finds something
of interest, it starts a worker agent to triage it.

The right pane is the Mission Control panel. It shows:
- what needs you
- the operator's direct tasks
- every watcher, with its stats and its tasks: status, task ID, summary, PRs and links

Click any row to open that agent's live terminal.

![Mission Control](preview.png)

## What you see

The space "Mission Control" has one tab with two panes. The operator terminal is on the left. The panel is
a mod pane split to its right.

The panel, top to bottom:

1. **Header**
   - On the left: "Mission Control", 15px semibold.
   - On the right: `N triaging` in the theme's `working` color, `N open` and `N watching`. These are 11.5px.
2. **Filter tabs.** These are two rows of text tabs:
   - Watchers: All, Running, Issues, Stopped
   - Tasks: All, Open, Needs you, Triaging, Queued, Done, Failed

   Each tab shows a count. The selected tab has a 2px underline in the `accent` color. Tabs with a count of 0
   are dimmed.
3. **Needs you strip.** It appears only when a task has status `needs-you` or a watcher is flagged.
   - The background is the theme's `blocked` color at about 10% alpha, with a border at about 33% alpha and
     8px corner radius.
   - Each item shows the title, the message, and `task-NNN in #channel`.
4. **Operator row.** It is pinned, so it always shows whatever the watcher filter is. It holds the
   operator's direct tasks.
5. **Watcher rows.** Each row has a 3px status bar on its left edge, and rows are separated by 1px borders.
   - The channel is in 13.5px medium weight. On the right is `checked 32s ago`.
   - Then one muted line with the goal.
   - Then the stats: checks, messages, matched and interval, spaced 12px apart.
6. **Task rows** under each watcher:
   - The status word and glyph are in an 82px column. The glyphs are: ◦ queued, a braille spinner for
     triaging, ◦ waiting, ● needs you, ✓ done, ✕ failed.
   - Under the status word, in the same column, is the task ID (`task-012`).
   - The title is in 12.5px. The age is on the right.
   - The summary line sits beside the task ID.
   - PR and link labels are plain text: PRs in `accent`, other links in `muted`.
7. **Stopped watchers** fold into one line ("1 stopped watcher"). Click it to expand them.

All colors are theme colors, so the panel follows the person's theme. Text uses the theme's UI font.

## How it behaves

- **Status bars:**
  - The watcher's agent is working: the `working` color.
  - Problems (the watcher exited, is blocked, has an error, has a flag, or has not checked in for
    3× its interval): the `blocked` color.
  - Stopped: the `border` color.
  - Idle: the `idle` color.
- **Spinners:** triaging tasks and working agents show a braille spinner (`.frames`, 90ms). No timers drive it.
- **Clicks:**
  - A watcher or task row opens `terminal.peek` for that agent. A dead agent gives a toast that says to run
    `oncall-mc resume`.
  - A PR or link label opens the URL: `open` on macOS, `xdg-open` on Linux, `start` on Windows.
- **Toasts:** a newly flagged item shows a warning toast. Clicking the toast opens the agent.
- **Older tasks:** finished tasks older than 24h, or beyond the latest 3, fold behind "Show N older".
  A task filter shows every match.
- **Filters:** the panel saves the selected filters per mod copy, in `localStorage`.
- **Updates:** the panel redraws when `<state>/board.json` changes (`watchFolder`), and every 30 s for the
  relative times.

## Built from

- **Mod `mods/mission-control`.** It is a single `main.js`.
  - Props: `{ state: <absolute state folder> }`.
  - Reads: `<state>/board.json` (`{operator, watchers[], tasks[]}`).
  - Live status: `agents()` and `terminals()`.
  - Calls: `run("terminal.peek")`, `notify`, `exec` (only to open URLs), `watchFolder`, `readTextFile`.
- **CLI `bin/oncall-mc`.** It is Python 3 with the standard library only.
  - It is the only writer of state, and the only launcher of agents. It launches them as `hc` terminals.
  - It creates the space by labelling the operator terminal `herdr.space=spmissioncontrol` and
    `herdr.tab=tbmissioncontrol`. Then it runs `space.rename` and `pane.split {mod: "mission-control"}`.
  - A ticker terminal per watcher wakes the watcher with `hc send` every interval, but only while the
    watcher is idle.
- **Role briefs** in `prompts/`: operator, watcher and worker.
- **Shift recipes** in `recipes/`, with `recipes/example.toml` as the template. These are TOML files of worker
  modes (prompts), operator instructions and watchers. `oncall-mc start --recipe <name>` reads them. They are
  separate from this file.
- **Mode on the panel:** each watcher row shows its mode in its stats line (`mode triage-reply`).
- **Programs it runs:** `hc`, `herdr-app`, the agent commands from `state/config.json` (defaults: `claude` for
  the operator, `codex` for watchers and workers) and `git`, which `update` uses.
- **Network:** the panel makes no network calls. The agents use their own Slack tools.

## Watch out

- The panel only displays state. Without `oncall-mc`, it shows "No session yet".
- Watchers and workers run unattended. If their agent commands stop at approval prompts, they hang. Set the
  approval and model flags in `state/config.json`.
- Every watcher cycle is a model call. Quiet channels should get longer intervals
  (`oncall-mc watcher set <id> --interval 600`).
- Agents survive a closed window, but not sleep or a reboot. After either, run `oncall-mc resume`.
- `hc` terminal names are global. `oncall-mc` adds a suffix (`task-001-2`) when a name is taken.
- Requires macOS or Linux, because the CLI uses `fcntl` file locks.

## Done when

- `oncall-mc install` reports the panel as installed, with `check passed`.
- `oncall-mc start` opens a "Mission Control" space with the operator on the left and the panel on the right.
- Asking the operator for a watcher adds a watcher row within a minute, and its "checked … ago" stays fresh.
- `oncall-mc watcher set <id> --interval 300` changes "every …" on the row.
- Clicking a task row opens that worker's terminal.
- `oncall-mc end --yes` closes the space and archives the session under `state/archive/`.
