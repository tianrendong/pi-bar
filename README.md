# pi-bar

[![npm version](https://img.shields.io/npm/v/pi-bar.svg)](https://www.npmjs.com/package/pi-bar)
[![npm downloads](https://img.shields.io/npm/dm/pi-bar.svg)](https://www.npmjs.com/package/pi-bar)

**Never accidentally run Opus on a typo again.** pi-bar keeps your model, thinking level, context pressure, a live progress update, and any extension statuses visible in pi's footer.

```text
claude-opus-4.7  ❯  think:med  ❯  2.6% / 1.0M  ❯  Reviewing package structure  ❯  Plan active  ❯  Queue: 2
```

![pi-bar with low context usage](https://cdn.jsdelivr.net/npm/pi-bar@0.3.38/assets/screenshot-green.png)
![pi-bar with medium context usage](https://cdn.jsdelivr.net/npm/pi-bar@0.3.38/assets/screenshot-yellow.png)
![pi-bar with high context usage](https://cdn.jsdelivr.net/npm/pi-bar@0.3.38/assets/screenshot-red.png)

## Why use it?

- **See the active model at a glance** — catch accidental model switches before an expensive or sensitive task starts.
- **Track thinking level in place** — immediately notice when you are using the wrong reasoning setting.
- **Watch context pressure early** — context usage turns green, yellow, then red as you approach the limit.
- **Follow what pi is doing** — a one-line progress update keeps the current task visible without scrolling.
- **Keep extension statuses visible** — statuses other extensions set still appear in the footer.

pi-bar is intentionally tiny: one small extension and no broad behavior changes. It replaces pi's built-in footer with a compact model / thinking / context / progress / extension-status line.

## Install

```bash
pi install npm:pi-bar
```

If pi is already running after install, reload resources:

```text
/reload
```

## Automatic layout

The footer adapts to terminal width without extra configuration:

- **Model, thinking level, and context percentage take priority.**
- Separators have two spaces on each side by default, for a roomier display.
- Progress text shrinks first. If space is still tight, separator padding reduces to one space per side before compacting content. CWD then compacts from its preferred path to `parent/project`, then `project`; context window size is omitted when needed.
- Extension badges stay in their published order. Badges that cannot fit are hidden whole, with `+N` showing how many are behind the overflow. Open `/bar status` to inspect their text and visibility by key.
- On very narrow terminals, progress and CWD yield to core information. If even the core cannot fit, the model name is truncated first. At extreme widths, not every value or overflow count can remain visible.
- Widening the terminal restores the full display. Thinking and context retain their semantic colors throughout.

Existing segment visibility settings still apply; CWD remains opt-in.

## Customization

pi-bar works out of the box. Run `/bar` inside pi to choose which footer segments and extension statuses are shown:

```text
/bar
```

Toggle `Model`, `Thinking level`, `Context usage`, `Current directory`, `Progress update`, and `Extension statuses` between `shown` and `hidden`. If other extensions have published status badges, `/bar` also shows fine-grained `Status: <key>` rows plus a `New extension statuses` default. You can also use commands:

```text
/bar segments list
/bar segments only model context
/bar segments hide progress
/bar segments show thinking
```

Allowed segments are `model`, `thinking`, `context`, `cwd`, `progress`, and `extensions`. The `cwd` segment is off by default. The `progress` segment stays hidden until pi-bar has a current update. The `extensions` segment stays hidden when no extension has set a status.

You can also set startup defaults with environment variables before launching pi:

```bash
PI_BAR_SHOW=model,thinking,context,progress,extensions pi
PI_BAR_SHOW=model,context pi
```

### Show the session directory

Enable the optional `cwd` segment to distinguish projects and sessions:

```text
/bar segments show cwd
```

Or set startup segments with `PI_BAR_SHOW=model,thinking,context,cwd,progress,extensions`.

```text
claude-opus-4.7  ❯  think:med  ❯  2.6% / 1.0M  ❯  ~/projects/pi-bar
```

Your home directory becomes `~`. Long paths omit middle directories, retaining trailing directory names where possible. The segment is capped at 36 terminal columns, including wide Unicode characters. Override the cap before starting pi:

```bash
PI_BAR_CWD_MAX_WIDTH=48 pi
```

The cap must be an integer of at least 8; invalid values use 36. Very long directory names are truncated. Paths are stripped of terminal controls before display.

This is Pi's session working directory (`ctx.cwd`), not a live shell directory: `cd` inside a tool command does not change it. Visibility persists through the existing `/bar` configuration.

### Configure live progress updates

pi-bar shows a short, plain-English description of what pi is working on right now. It refreshes as pi works and resets when you switch branches in the session tree, so stale updates never follow you across tasks. Hide `Progress update` in `/bar`, run `/bar segments hide progress`, or set `PI_BAR_SHOW` without `progress` to disable it.

Pick a specific model for the update by setting the env var or pi settings:

```bash
PI_BAR_PROGRESS_MODEL=anthropic/claude-haiku-4-5 pi
```

Or in pi settings: `bar.progressModel`. Otherwise pi-bar picks a fast model you are already authenticated with.

### Configure extension statuses

Other pi extensions can publish small status badges. Pi-bar displays their text as written, without prepending internal keys: `setStatus("mcp", "MCP: 2/2 servers")` appears as `MCP: 2/2 servers`, not `mcp:MCP: 2/2 servers`. Extensions should publish self-describing text; pi-bar does not guess labels for bare values.

Pi-bar strips embedded terminal colors and control sequences, and separates each badge with the same `❯` divider used by other footer segments. Keys remain available for filtering and identification in `/bar`; selecting a status row shows its current sanitized text. Run `/bar` or `/bar status` inside pi to inspect statuses or pick which ones to show:

```text
/bar status
```

Toggle each status between `shown` and `hidden`. The `New statuses` row controls the default for badges that appear later.

Your choices persist across pi sessions in `~/.pi/agent/pi-bar.json`. Override the path with `PI_BAR_CONFIG=/some/path.json`.

### Change context thresholds

```bash
PI_BAR_THRESHOLDS=60,85 pi
```

The first number is the warning/yellow threshold. The second number is the danger/red threshold. Defaults are `70,90`.

## Pairs well with

- **[pi-chrome](https://www.npmjs.com/package/pi-chrome)** — give your Pi agent your real, signed-in Chrome. Use pi-bar's red-context threshold as the signal to wrap up long browser scrapes before context overflows.
- **[pi-qq](https://www.npmjs.com/package/pi-qq)** — ask side questions about what the agent just did without polluting the transcript.

## Development

```bash
npm ci --ignore-scripts
npm test
npm run check
```

Tests cover path formatting, display-ready statuses, responsive layout, terminal safety, ANSI/Unicode width limits, resize behavior, and segment/status visibility persistence. Test configuration mirrors Pi's `pi-ai/compat` loader alias; runtime dependencies remain optional peers supplied by Pi.

## Security note

Pi extensions run with your local user permissions. Review any pi package source before installing it.

Progress updates send short snippets of your session activity to the selected model provider. Hide `Progress update` in `/bar` or disable the `progress` segment with `PI_BAR_SHOW` if that is not acceptable.
