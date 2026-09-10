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
- Progress text shrinks first. If space is still tight, separator padding reduces to one space per side before compacting content. CWD then compacts from its preferred path to `parent/project`, then `project`; context window size is omitted when needed. An enabled provider prefix can yield before the model name is clipped.
- Optional token totals, cost, and cache-hit ratio yield whole under width pressure, before overflowing extension badges. Numeric metrics are never shown partially.
- Extension badges stay in their published order. Badges that cannot fit are hidden whole, with `+N` showing how many are behind the overflow. Open `/bar status` to inspect their text and visibility by key.
- On very narrow terminals, progress and CWD yield to core information. If even the core cannot fit, the model name is truncated first. At extreme widths, not every value or overflow count can remain visible.
- Widening the terminal restores the full display. Thinking and context retain their semantic colors throughout.

Existing visibility settings still apply. CWD, usage metrics, and the provider prefix are opt-in; the default footer is unchanged.

## Customization

pi-bar works out of the box. Run `/bar` inside pi to choose which footer segments and extension statuses are shown:

```text
/bar
```

Toggle `Model`, `Thinking level`, `Context usage`, `Cache hit ratio`, `Estimated session cost`, `Session token totals`, `Current directory`, `Progress update`, and `Extension statuses` between `shown` and `hidden`. `Show provider` controls the optional prefix inside the model segment. `Progress model` opens a searchable model picker. If other extensions have published status badges, `/bar` also shows fine-grained `Status: <key>` rows plus a `New extension statuses` default. You can also use commands:

```text
/bar segments list
/bar segments only model context
/bar segments hide progress
/bar segments show thinking
```

Allowed segments are `model`, `thinking`, `context`, `cache_hit_ratio`, `cost`, `tokens`, `cwd`, `progress`, and `extensions`. The `cwd`, `cache_hit_ratio`, `cost`, and `tokens` segments are off by default. The `progress` segment stays hidden until pi-bar has a current update. The `extensions` segment stays hidden when no extension has set a status.

Tab completes `/bar` subcommands, actions, segment names, known status keys, and configured progress-model IDs. Completion preserves preceding arguments, including comma-separated lists such as `/bar segments show model,ca`.

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

### Show the model provider

Provider prefixes are hidden by default. Enable `Show provider` in `/bar`, or use:

```text
/bar provider show
/bar provider hide
/bar provider
```

The last command reports the current setting. The choice persists as `showProvider` in `~/.pi/agent/pi-bar.json`; an absent setting means `false`.

```text
claude-opus-4.7             # default
anthropic/claude-opus-4.7   # direct provider, enabled
openrouter/claude-opus-4.7  # routed provider, enabled
```

The prefix uses the actual model provider, not a namespace embedded in the model ID. It stays inside the model segment: hiding `model` hides both. Under width pressure, the prefix yields before clipping the model name and returns when space is available.

### Show cache, cost, and token metrics

Enable any of the optional metrics through `/bar` or the existing segment commands:

```text
/bar segments show cache_hit_ratio cost tokens
```

```text
claude-opus-4.7  ❯  think:med  ❯  2.6% / 1.0M  ❯  CH:84%  ❯  ≈$0.123  ❯  ↑12k ↓3k
```

| Segment | Meaning |
| --- | --- |
| `cache_hit_ratio` | Latest active-branch assistant prompt's cache-read percentage: `cacheRead / (input + cacheRead + cacheWrite)`. Hidden when that response has no reported prompt usage. Restored on resume and `/tree`; tool, summary, and progress calls do not replace this value. |
| `cost` | Estimated dollar cost for recorded usage in the current session file. `≈` means an estimate, **not an invoice**. |
| `tokens` | Cumulative input (`↑`, including cache reads and writes) and output (`↓`, including reported reasoning tokens). These are usage totals, not current context size or tokens/sec. |

Cost and token totals include assistant responses, usage reported by tools, compaction/branch summaries, and pi-bar progress calls. They include all branches in the current session file, so `/tree` does not erase prior spend; `/new` starts fresh. Both stay hidden until usage is available. A zero-cost response with token usage still shows `≈$0.000`.

Progress usage is saved as numeric-only `pi-bar-progress-usage` custom entries, without prompts or response text. These entries survive reloads but are not sent to the main model. Older sessions may lack progress-call usage. Requests with no reported usage, including some failed/interrupted calls, cannot be counted.

Prices come from the usage estimates Pi/providers report. Subscription allowances, invoices, and missing/custom model pricing can differ; a reported zero is not a billing guarantee. Metrics make no additional model requests. Usage is aggregated at lifecycle events, not by scanning history on every footer render.

### Configure live progress updates

pi-bar shows a short, plain-English description of what pi is working on right now. It refreshes as pi works and resets when you switch branches in the session tree, so stale updates never follow you across tasks. Hide `Progress update` in `/bar`, run `/bar segments hide progress`, or set `PI_BAR_SHOW` without `progress` to disable it.

**Pick a model interactively:** open `/bar`, select `Progress model` directly below `Progress update`, and press Enter. Type a provider or model ID (for example `gpt`), then press Enter to select. Esc cancels without changing the preference. The picker shows models with configured Pi credentials and an `Auto` option; it does not validate keys or make model requests.

**Or use commands with Tab completion:**

```text
/bar progress-model
/bar progress-model openai/gpt-4.1-mini
/bar progress-model auto
```

The first command reports the effective preference. After `/bar progress-model `, Tab offers `auto` and models with configured Pi credentials. Search by provider or model fragment, such as `gpt` or `haiku`; completion inserts the full `provider/model` ID, including any nested namespace. Suggestions use the current local model catalog, without refreshing catalogs, resolving credentials, or making model requests. Unknown/unavailable model arguments leave the preference unchanged.

The choice saves as `progressModel` in `~/.pi/agent/pi-bar.json` (or `PI_BAR_CONFIG`) for all projects. It applies to subsequent progress updates without `/reload`, cancels pending old-model updates, and leaves your main chat model and credentials unchanged. Choosing a model does not enable a hidden progress segment.

`Auto` tries fast Codex models, then Anthropic Haiku. To use an OpenAI API key instead of a Codex subscription, choose an **`openai/...`** model explicitly, such as `openai/gpt-4.1-mini`. Progress uses that provider's normal Pi credentials; no separate pi-bar key is needed. Configured but revoked credentials can still fail.

You can also set a model before launching Pi:

```bash
PI_BAR_PROGRESS_MODEL=openai/gpt-4.1-mini pi
```

Preference order: `PI_BAR_PROGRESS_MODEL` → saved pi-bar `progressModel` → project Pi settings → global Pi settings → Auto. Within each Pi settings scope, `bar.progressModel` takes precedence over the legacy `progress.model` setting. A nonempty environment override makes both the picker and command read-only and suppresses model-value completion; unset it and restart Pi to choose another model. A saved `"auto"` explicitly enables automatic selection rather than falling back to Pi settings. Remove `progressModel` from the pi-bar config to use Pi settings again.

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

Tests cover path formatting, display-ready statuses, responsive layout, all 512 segment visibility combinations, terminal safety, ANSI/Unicode widths, provider settings, progress-model selection, command completion, usage accounting, progress-call persistence, session/tree lifecycle, and config persistence. Test configuration mirrors Pi's `pi-ai/compat` loader alias; runtime dependencies remain optional peers supplied by Pi.

## Security note

Pi extensions run with your local user permissions. Review any pi package source before installing it.

Progress updates send short snippets of your session activity to the selected model provider. Hide `Progress update` in `/bar` or disable the `progress` segment with `PI_BAR_SHOW` if that is not acceptable.
