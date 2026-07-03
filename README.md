# pi-bar

[![npm version](https://img.shields.io/npm/v/pi-bar.svg)](https://www.npmjs.com/package/pi-bar)
[![npm downloads](https://img.shields.io/npm/dm/pi-bar.svg)](https://www.npmjs.com/package/pi-bar)

**Never accidentally run Opus on a typo again.** pi-bar keeps your model, thinking level, context pressure, a live progress update, and any extension statuses visible in pi's footer.

```text
anthropic/claude-opus-4.7  ❯  think:med  ❯  2.6% / 1.0M  ❯  Reviewing package structure  ❯  plan:active ❯ queue:2
```

![pi-bar with low context usage](https://cdn.jsdelivr.net/npm/pi-bar@0.3.38/assets/screenshot-green.png)
![pi-bar with medium context usage](https://cdn.jsdelivr.net/npm/pi-bar@0.3.38/assets/screenshot-yellow.png)
![pi-bar with high context usage](https://cdn.jsdelivr.net/npm/pi-bar@0.3.38/assets/screenshot-red.png)

## Why use it?

- **See the active model and provider at a glance** — catch accidental model switches before an expensive or sensitive task starts.
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

## Customization

pi-bar works out of the box. Run `/bar` inside pi to choose which footer segments and extension statuses are shown:

```text
/bar
```

Toggle `Model`, `Thinking level`, `Context usage`, `Progress update`, and `Extension statuses` between `shown` and `hidden`. If other extensions have published status badges, `/bar` also shows fine-grained `Status: <key>` rows plus a `New extension statuses` default. You can also use commands:

```text
/bar segments list
/bar segments only model context
/bar segments hide progress
/bar segments show thinking
```

Allowed segments are `model`, `thinking`, `context`, `progress`, and `extensions`. The `progress` segment stays hidden until pi-bar has a current update. The `extensions` segment stays hidden when no extension has set a status.

You can also set startup defaults with environment variables before launching pi:

```bash
PI_BAR_SHOW=model,thinking,context,progress,extensions pi
PI_BAR_SHOW=model,context pi
```

### Configure live progress updates

pi-bar shows a short, plain-English description of what pi is working on right now. It refreshes as pi works and resets when you switch branches in the session tree, so stale updates never follow you across tasks. Hide `Progress update` in `/bar`, run `/bar segments hide progress`, or set `PI_BAR_SHOW` without `progress` to disable it.

Pick a specific model for the update by setting the env var or pi settings:

```bash
PI_BAR_PROGRESS_MODEL=anthropic/claude-haiku-4-5 pi
```

Or in pi settings: `bar.progressModel`. Otherwise pi-bar picks a fast model you are already authenticated with.

### Configure extension statuses

Other pi extensions can publish small status badges. Pi-bar collects them into the `extensions` segment, strips embedded terminal colors, and separates each badge with the same `❯` divider used by other footer segments. Run `/bar` or `/bar status` inside pi to pick which ones to show:

```text
/bar status
```

Toggle each status between `shown` and `hidden`. The `New statuses` row controls the default for badges that appear later.

Your choices persist across pi sessions in `~/.pi/agent/pi-bar.json`. Override the path with `PI_BAR_CONFIG=/some/path.json`.

### Hide status labels

By default extension statuses show their key as a prefix (`mcp:MCP: 0/2 servers`). You can hide the label prefix to show only the status text (`MCP: 0/2 servers`):

```text
/bar status labels       # toggle hide/show
/bar status labels hide  # hide labels
/bar status labels show  # show labels
```

Or set it directly in `~/.pi/agent/pi-bar.json`:

```json
{
  "hideStatusLabels": true
}
```

### Change context thresholds

```bash
PI_BAR_THRESHOLDS=60,85 pi
```

The first number is the warning/yellow threshold. The second number is the danger/red threshold. Defaults are `70,90`.

## Pairs well with

- **[pi-chrome](https://www.npmjs.com/package/pi-chrome)** — give your Pi agent your real, signed-in Chrome. Use pi-bar's red-context threshold as the signal to wrap up long browser scrapes before context overflows.
- **[pi-qq](https://www.npmjs.com/package/pi-qq)** — ask side questions about what the agent just did without polluting the transcript.

## Security note

Pi extensions run with your local user permissions. Review any pi package source before installing it.

Progress updates send short snippets of your session activity to the selected model provider. Hide `Progress update` in `/bar` or disable the `progress` segment with `PI_BAR_SHOW` if that is not acceptable.
