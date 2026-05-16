# pi-bar

[![npm version](https://img.shields.io/npm/v/pi-bar.svg)](https://www.npmjs.com/package/pi-bar)
[![npm downloads](https://img.shields.io/npm/dm/pi-bar.svg)](https://www.npmjs.com/package/pi-bar)

**Never accidentally run Opus on a typo again.** pi-bar keeps your model, thinking level, context pressure, extension status, and a live one-line TLDR visible in pi's footer.

```text
claude-opus-4.7  ❯  think:med  ❯  2.6% / 1.0M  ❯  Inspecting package structure  ❯  plan:active
```

![pi-bar with low context usage](https://cdn.jsdelivr.net/npm/pi-bar@0.3.25/assets/screenshot-green.png)
![pi-bar with medium context usage](https://cdn.jsdelivr.net/npm/pi-bar@0.3.25/assets/screenshot-yellow.png)
![pi-bar with high context usage](https://cdn.jsdelivr.net/npm/pi-bar@0.3.25/assets/screenshot-red.png)

## Why use it?

- **See the active model at a glance** — catch accidental model switches before an expensive or sensitive task starts.
- **Track thinking level in place** — immediately notice when you are using the wrong reasoning setting.
- **Watch context pressure early** — context usage turns green, yellow, then red as you approach the limit.
- **Follow what pi is doing** — a live TLDR keeps the current task visible without scrolling.
- **Keep extension statuses visible** — statuses set with `ctx.ui.setStatus()` still appear in the custom footer.

pi-bar is intentionally tiny: one small extension, no broad behavior changes, and no commands to learn. It replaces pi's built-in footer with a compact model / thinking / context / TLDR / extension-status line.

## Install

```bash
pi install npm:pi-bar
```

If pi is already running after install, reload resources:

```text
/reload
```

## Customization

pi-bar works out of the box, but you can tune it with environment variables before launching pi.

### Show or hide segments

```bash
PI_BAR_SHOW=model,thinking,context,tldr,extensions pi
PI_BAR_SHOW=model,context pi
```

Allowed segments are `model`, `thinking`, `context`, `tldr`, and `extensions`. The `tldr` segment is hidden until pi-bar generates a current TLDR. The `extensions` segment is hidden when no extension has set a status.

### Configure live TLDR

pi-bar shows a concise live TLDR of the current task in the footer. It generates TLDRs from recent prompt, assistant, and deterministic code-compressed tool facts (for example `bash ... ok`, `grep ... 4 matches`, `read file`, or `custom_tool key=value ok`). It resets when you navigate the session tree so stale summaries do not follow you across branches. Set `PI_BAR_SHOW` without `tldr` to hide it.

Override the TLDR model with:

```bash
PI_BAR_TLDR_MODEL=anthropic/claude-haiku-4-5 pi
```

You can also set `bar.tldrModel` in pi settings.

### Configure extension statuses

pi-bar shows statuses set by other extensions with `ctx.ui.setStatus()`.
Use `/bar` inside pi to open an interactive status-visibility picker.

```text
/bar
```

Toggle each status key between `shown` and `hidden`. The `New statuses` row controls whether status keys discovered later are shown or hidden by default.

Status filter choices persist globally across pi sessions. Set `PI_BAR_CONFIG=/path/to/config.json` before launching pi to override the default config path (`~/.pi/agent/pi-bar.json`). Advanced command forms like `/bar status hide <key>` still work for scripting.

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

Live TLDR generation sends short activity snippets to the selected TLDR model provider. Disable the `tldr` segment with `PI_BAR_SHOW` if that is unacceptable.
