/**
 * pi-bar — footer/statusline extension.
 *
 * Replaces the built-in footer with left-aligned segments:
 *   <model name> ❯ think:<level> ❯ <context% / window> ❯ <tldr> ❯ <extension statuses>
 *
 * Examples:
 *   claude-opus-4.7  ❯  think:med  ❯  2.6% / 1.0M
 *
 * Re-renders on model change, thinking-level change, status updates,
 * and after each assistant turn so context usage stays current.
 *
 * Configuration env vars:
 *   PI_BAR_SHOW=model,thinking,context,tldr,extensions
 *   PI_BAR_THRESHOLDS=70,90
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import {
	getSettingsListTheme,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
	truncateToWidth,
} from "@earendil-works/pi-tui";

type SegmentName = "model" | "thinking" | "context" | "tldr" | "extensions";
type StatusFilter =
	| { mode: "all"; hidden: Set<string> }
	| { mode: "only"; shown: Set<string> };
type SerializedStatusFilter =
	| { mode: "all"; hidden: string[] }
	| { mode: "only"; shown: string[] };
type TldrActivityType =
	| "user_message"
	| "assistant_update"
	| "tool_input_start"
	| "tool_input_update"
	| "tool_input_end"
	| "tool_call"
	| "tool_execution_update"
	| "tool_result"
	| "assistant_final"
	| "assistant_failure";
type TldrDisplayPriority = "immediate" | "normal" | "final";
type TldrActivity = {
	index: number;
	activityType: TldrActivityType;
	displayPriority: TldrDisplayPriority;
	text: string;
	toolCallId?: string;
	// Identifies a continuous streaming run (tool input arg streaming, or tool
	// execution output streaming). Activities sharing a group represent updates
	// to the same task; staleness handling treats them as one stream.
	progressGroup?: string;
};
type TldrCheckpoint = {
	activityIndex: number;
	activityType: TldrActivityType;
	displayPriority: TldrDisplayPriority;
	text: string;
	progressGroup?: string;
};
type TldrCheckpointJob = {
	activityIndex: number;
	activityType: TldrActivityType;
	displayPriority: TldrDisplayPriority;
	runId: number;
	progressGroup?: string;
};

// Activities that represent ongoing streaming work. These are treated
// specially: their checkpoints can render even when newer same-stream activity
// exists, and the display refresh slows to a 10s cadence for repeat renders so
// the footer does not become a model-call ticker.
function isToolProgressActivity(activityType: TldrActivityType): boolean {
	return (
		activityType === "tool_input_update" ||
		activityType === "tool_execution_update"
	);
}
type TldrModelPreference = { provider: string; id: string };
type FastModelAuth = {
	model: Parameters<typeof complete>[0];
	apiKey: string;
	headers?: Record<string, string>;
};

const STATUS_FILTER_ENTRY_TYPE = "pi-bar-status-filter";
const SETTINGS_TLDR_KEY = "tldr";
const SETTINGS_BAR_KEY = "bar";
const MAX_ACTIVITY_TEXT_CHARS = 800;
const MAX_USER_TEXT_CHARS = 700;
const MAX_ASSISTANT_UPDATE_CHARS = 500;
const MAX_TOOL_RESULT_OK_CHARS = 160;
const MAX_TOOL_RESULT_ERROR_CHARS = 320;
const MAX_FINAL_TEXT_CHARS = 700;
const MAX_RETAINED_RAW_ACTIVITIES = 128;
const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const MAX_CONTEXT_CHECKPOINTS = 8;
const TLDR_MAX_TOKENS = 120;
const TLDR_REQUEST_TIMEOUT_MS = 2_000;
const TLDR_DISPLAY_UPDATE_INTERVAL_MS = 1_200;
const TLDR_TARGET_SUMMARY_CHARS = 60;
// While rendering successive progress checkpoints from the same stream (e.g.
// long bash output), slow the display refresh dramatically. The TLDR text
// barely changes between adjacent chunks; refreshing every 1.2s would burn API
// calls and footer renders for noise.
const TOOL_PROGRESS_DISPLAY_UPDATE_INTERVAL_MS = 10_000;
const MAX_TOOL_PROGRESS_PARTIAL_CHARS = 280;
// Burst debouncing on the generation side: coalesce rapid-fire activities into
// one model call. Quiet window catches short bursts; max wait surfaces progress
// during continuous activity.
const NORMAL_CHECKPOINT_QUIET_MS = 700;
const NORMAL_CHECKPOINT_MAX_WAIT_MS = 2_500;
// Defensive ceiling: even if the model ignores the length instruction, never
// blast a large payload into the footer.
const MAX_SAFE_TLDR_CHARS = 240;
const CONFIG_PATH =
	process.env.PI_BAR_CONFIG ?? join(homedir(), ".pi", "agent", "pi-bar.json");

const DEFAULT_SEGMENTS: SegmentName[] = [
	"model",
	"thinking",
	"context",
	"tldr",
	"extensions",
];
const DEFAULT_WARNING_THRESHOLD = 70;
const DEFAULT_ERROR_THRESHOLD = 90;

const SEGMENT_SEPARATOR = "❯";

function formatTokens(n: number): string {
	if (n >= 1_000_000) {
		const value = n / 1_000_000;
		return value >= 10 ? `${Math.round(value)}M` : `${value.toFixed(1)}M`;
	}
	if (n >= 1_000) {
		const value = n / 1_000;
		return value >= 10 ? `${Math.round(value)}k` : `${value.toFixed(1)}k`;
	}
	return `${n}`;
}

function formatModelName(id: string | undefined): string {
	if (!id) return "no-model";
	const base = id.includes("/") ? (id.split("/").pop() ?? id) : id;
	return base.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function thinkingColor(level: string): ThemeColor {
	switch (level) {
		case "off":
			return "thinkingOff";
		case "minimal":
		case "min":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
		case "med":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
		case "extra-high":
			return "thinkingXhigh";
		default:
			return "thinkingText";
	}
}

function contextColor(
	percent: number | null | undefined,
	warningThreshold: number,
	errorThreshold: number,
): ThemeColor {
	if (percent === null || percent === undefined) return "muted";
	if (percent >= errorThreshold) return "error";
	if (percent >= warningThreshold) return "warning";
	return "success";
}

function parseSegments(): SegmentName[] {
	const raw = process.env.PI_BAR_SHOW;
	if (!raw) return DEFAULT_SEGMENTS;

	const requested = raw
		.split(",")
		.map((segment) => segment.trim().toLowerCase())
		.filter((segment): segment is SegmentName =>
			["model", "thinking", "context", "tldr", "extensions"].includes(segment),
		);

	return requested.length > 0 ? requested : DEFAULT_SEGMENTS;
}

function parseThresholds(): { warningThreshold: number; errorThreshold: number } {
	const raw = process.env.PI_BAR_THRESHOLDS;
	if (!raw) {
		return {
			warningThreshold: DEFAULT_WARNING_THRESHOLD,
			errorThreshold: DEFAULT_ERROR_THRESHOLD,
		};
	}

	const [warning, error] = raw
		.split(",")
		.map((value) => Number.parseFloat(value.trim()));

	if (
		Number.isFinite(warning) &&
		Number.isFinite(error) &&
		warning >= 0 &&
		error > warning
	) {
		return { warningThreshold: warning, errorThreshold: error };
	}

	return {
		warningThreshold: DEFAULT_WARNING_THRESHOLD,
		errorThreshold: DEFAULT_ERROR_THRESHOLD,
	};
}

function parseTldrModelSpec(value: string): TldrModelPreference | undefined {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "auto") return undefined;
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, separator), id: trimmed.slice(separator + 1) };
}

function settingsModelValue(settings: Record<string, unknown>): string | undefined {
	const bar = settings[SETTINGS_BAR_KEY];
	if (bar && typeof bar === "object" && !Array.isArray(bar)) {
		const value = (bar as Record<string, unknown>).tldrModel;
		if (typeof value === "string") return value;
	}

	const tldr = settings[SETTINGS_TLDR_KEY];
	if (tldr && typeof tldr === "object" && !Array.isArray(tldr)) {
		const value = (tldr as Record<string, unknown>).model;
		if (typeof value === "string") return value;
	}

	return undefined;
}

function resolveTldrModelPreference(cwd: string): TldrModelPreference | undefined {
	const envModel = process.env.PI_BAR_TLDR_MODEL;
	if (envModel) return parseTldrModelSpec(envModel);

	const settings = SettingsManager.create(cwd);
	const projectModel = settingsModelValue(
		settings.getProjectSettings() as Record<string, unknown>,
	);
	if (projectModel !== undefined) return parseTldrModelSpec(projectModel);

	const globalModel = settingsModelValue(
		settings.getGlobalSettings() as Record<string, unknown>,
	);
	return globalModel ? parseTldrModelSpec(globalModel) : undefined;
}

// Fallback order optimizes for low latency + low cost first. The TLDR path does
// not need reasoning quality; codex/gpt-5.4-mini is fastest in practice.
const FAST_TLDR_MODELS: readonly TldrModelPreference[] = [
	{ provider: "openai-codex", id: "gpt-5.4-mini" },
	{ provider: "openai-codex", id: "gpt-5.3-codex-spark" },
	{ provider: "anthropic", id: "claude-haiku-4-5" },
	{ provider: "anthropic", id: "claude-haiku-4-5-20251001" },
];

function formatTldrModelKey(model: TldrModelPreference): string {
	return `${model.provider}/${model.id}`;
}

async function getModelAuth(
	ctx: ExtensionContext,
	preference: TldrModelPreference,
): Promise<FastModelAuth | undefined> {
	const model = ctx.modelRegistry.find(preference.provider, preference.id);
	if (!model) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	return auth.ok && auth.apiKey
		? { model, apiKey: auth.apiKey, headers: auth.headers }
		: undefined;
}

async function getFastTldrModelAuth(
	ctx: ExtensionContext,
	configuredModel?: TldrModelPreference,
): Promise<FastModelAuth | undefined> {
	if (configuredModel) {
		const configuredAuth = await getModelAuth(ctx, configuredModel);
		if (configuredAuth) return configuredAuth;
	}

	for (const candidate of FAST_TLDR_MODELS) {
		if (configuredModel && formatTldrModelKey(candidate) === formatTldrModelKey(configuredModel)) {
			continue;
		}
		const auth = await getModelAuth(ctx, candidate);
		if (auth) return auth;
	}

	return undefined;
}

function truncateText(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	const chars = Array.from(text);
	if (chars.length <= maxChars) return text;
	if (maxChars === 1) return "…";

	// Head+tail preserves both "what started" and "how it ended". Most useful for
	// long bash/tool outputs where the final lines carry the outcome.
	const retainedChars = maxChars - 1;
	const headLength = Math.ceil(retainedChars / 2);
	const tailLength = Math.floor(retainedChars / 2);
	const head = chars.slice(0, headLength).join("");
	const tail = tailLength > 0 ? chars.slice(-tailLength).join("") : "";
	return `${head}…${tail}`;
}

function tailText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `…${text.slice(-(maxChars - 1))}`;
}

function compactText(text: string): string {
	return text.replace(ANSI_PATTERN, "").replace(/\s+/g, " ").trim();
}

function compactValue(value: unknown, maxChars: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	let text: string;
	if (typeof value === "string") {
		text = value;
	} else {
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
	}
	return text ? truncateText(compactText(text), maxChars) : undefined;
}

function compactInputArgs(input: Record<string, unknown>, maxChars: number): string | undefined {
	const args = Object.entries(input)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => {
			const formatted = compactValue(value, 80);
			return formatted ? `${key}=${formatted}` : undefined;
		})
		.filter((arg): arg is string => Boolean(arg));

	let result = "";
	for (const arg of args) {
		const next = result ? `${result} ${arg}` : arg;
		if (next.length > maxChars) break;
		result = next;
	}
	return result || undefined;
}

function compactToolInput(toolName: string, input: Record<string, unknown> | undefined): string {
	if (!input) return toolName;

	const path = compactValue(input.path ?? input.filePath ?? input.cwd, 120);
	const command = compactValue(input.command, 180);
	const pattern = compactValue(input.pattern ?? input.query, 120);
	const include = compactValue(input.include ?? input.glob, 80);

	switch (toolName) {
		case "bash":
			return command ? `bash ${command}` : "bash";
		case "read":
			return path ? `read ${path}` : "read";
		case "edit":
			return path ? `edit ${path}` : "edit";
		case "write":
			return path ? `write ${path}` : "write";
		case "grep":
			return ["grep", pattern, path, include ? `include ${include}` : undefined]
				.filter(Boolean)
				.join(" ");
		case "find":
			return ["find", path, pattern].filter(Boolean).join(" ");
		case "ls":
			return path ? `ls ${path}` : "ls";
		default: {
			const args = compactInputArgs(input, 240);
			return args ? `${toolName} ${args}` : toolName;
		}
	}
}

function usefulLineCount(text: string): number {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean).length;
}

const ERROR_LINE_PATTERN = /(error|failed|TS\d+|E[A-Z]+\d*|Command exited|denied|refused|aborted|panic|fatal|exception)/i;

function errorSummary(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const cleaned = text.replace(ANSI_PATTERN, "");
	const lines = cleaned
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return undefined;
	const matched = lines.find((line) => ERROR_LINE_PATTERN.test(line)) ?? lines[lines.length - 1];
	return truncateText(compactText(matched), MAX_TOOL_RESULT_ERROR_CHARS);
}

function summarizeToolResult(
	toolName: string,
	input: Record<string, unknown> | undefined,
	text: string | undefined,
	isError: boolean,
): string | undefined {
	if (isError) return errorSummary(text);

	const lineCount = text ? usefulLineCount(text) : 0;
	const path = compactValue(input?.path ?? input?.filePath ?? input?.cwd, 120);

	switch (toolName) {
		case "bash":
			return undefined;
		case "read":
			return path ? `read ${path}` : undefined;
		case "edit":
			return path ? `edited ${path}` : undefined;
		case "write":
			return path ? `wrote ${path}` : undefined;
		case "grep":
			return lineCount ? `${lineCount} matches` : "no matches";
		case "find":
			return lineCount ? `${lineCount} paths` : "no paths";
		case "ls":
			return lineCount ? `${lineCount} entries` : undefined;
		default:
			return undefined;
	}
}

function extractTextContent(content: readonly unknown[] | undefined): string | undefined {
	if (!content) return undefined;
	const text = content
		.map((part) => {
			if (!part || typeof part !== "object") return undefined;
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string"
				? record.text
				: undefined;
		})
		.filter((part): part is string => Boolean(part))
		.join("\n");
	const compacted = compactText(text);
	return compacted.length > 0 ? compacted : undefined;
}

type ToolInputAssistantEvent =
	| { type: "toolcall_start"; contentIndex: number; partial: unknown }
	| {
			type: "toolcall_delta";
			contentIndex: number;
			delta: string;
			partial: unknown;
		}
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: { id: string; name: string; arguments?: unknown };
			partial: unknown;
		};

function toolCallAtContentIndex(
	partial: unknown,
	contentIndex: number,
): { id: string; name: string; arguments?: unknown } | undefined {
	if (!partial || typeof partial !== "object") return undefined;
	const content = (partial as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const block = content[contentIndex];
	if (!block || typeof block !== "object") return undefined;
	const record = block as Record<string, unknown>;
	if (record.type !== "toolCall") return undefined;
	if (typeof record.id !== "string" || typeof record.name !== "string") {
		return undefined;
	}
	return {
		id: record.id,
		name: record.name,
		arguments: record.arguments,
	};
}

class TldrFactCollector {
	private nextIndex = 1;
	private readonly activities: TldrActivity[] = [];
	// Streaming tool inputs (`toolcall_start/delta/end` from message_update)
	// arrive before the final tool id is available; content index is the best
	// stable anchor until the id appears.
	private readonly activeToolInputAnchors = new Map<string, string>();

	resetConversation(): void {
		this.nextIndex = 1;
		this.activities.splice(0);
		this.activeToolInputAnchors.clear();
	}

	latestActivity(): TldrActivity | undefined {
		return this.activities[this.activities.length - 1];
	}

	recordUserMessage(prompt: string): TldrActivity {
		return this.addActivity(
			"user_message",
			"immediate",
			`user: ${truncateText(compactText(prompt), MAX_USER_TEXT_CHARS)}`,
		);
	}

	recordAssistantUpdate(message: unknown): TldrActivity | undefined {
		if (!message || typeof message !== "object") return undefined;
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant") return undefined;
		const text = extractTextContent(record.content as readonly unknown[] | undefined);
		if (!text) return undefined;

		// Streaming emits many partial updates per message. Keep only the latest by
		// dropping the previous assistant_update so the model sees one accurate snapshot.
		const last = this.activities[this.activities.length - 1];
		if (last?.activityType === "assistant_update") {
			this.activities.pop();
		}

		return this.addActivity(
			"assistant_update",
			"normal",
			`assistant: ${tailText(text, MAX_ASSISTANT_UPDATE_CHARS)}`,
		);
	}

	// Stage 1: tool input streaming. The model is writing tool name + args; pi
	// surfaces this via `assistantMessageEvent` on `message_update` with
	// toolcall_start / toolcall_delta / toolcall_end. Useful when args are long
	// (big edits, structured plans) and the user wants visible progress before
	// the actual tool execution starts.
	recordToolInputActivity(
		event: ToolInputAssistantEvent | undefined,
	): TldrActivity | undefined {
		if (!event) return undefined;

		switch (event.type) {
			case "toolcall_start": {
				const toolCall = toolCallAtContentIndex(event.partial, event.contentIndex);
				const toolName = toolCall?.name ?? "unknown";
				const anchorKey = toolCall?.id ?? `content:${event.contentIndex}`;
				const anchorText = `tool input: ${toolName}`;
				this.activeToolInputAnchors.set(anchorKey, anchorText);
				return this.addActivity(
					"tool_input_start",
					"normal",
					anchorText,
					toolCall?.id,
				);
			}
			case "toolcall_delta": {
				const toolCall = toolCallAtContentIndex(event.partial, event.contentIndex);
				const anchorKey = toolCall?.id ?? `content:${event.contentIndex}`;
				const anchorText =
					this.activeToolInputAnchors.get(anchorKey) ??
					`tool input: ${toolCall?.name ?? "unknown"}`;

				// Repeated delta updates for the same call collapse into the latest
				// snapshot. Otherwise long arg streams would push out useful facts.
				const last = this.activities[this.activities.length - 1];
				if (
					last?.activityType === "tool_input_update" &&
					last.progressGroup === `tool-input:${anchorKey}`
				) {
					this.activities.pop();
				}

				const argSnapshot = compactValue(toolCall?.arguments, 200);
				const chunk = event.delta
					? `latest: ${truncateText(compactText(event.delta), 120)}`
					: undefined;
				const update = [argSnapshot, chunk].filter(Boolean).join("; ");

				return this.addActivity(
					"tool_input_update",
					"normal",
					`${anchorText}; ${update || "streaming"}`,
					toolCall?.id,
					`tool-input:${anchorKey}`,
				);
			}
			case "toolcall_end": {
				const anchorKey = event.toolCall.id;
				const anchorText =
					this.activeToolInputAnchors.get(anchorKey) ??
					`tool input: ${event.toolCall.name}`;
				this.activeToolInputAnchors.delete(anchorKey);

				const args = compactValue(event.toolCall.arguments, 240);
				return this.addActivity(
					"tool_input_end",
					"normal",
					args ? `${anchorText} completed; ${args}` : `${anchorText} completed`,
					event.toolCall.id,
				);
			}
		}
	}

	recordToolCall(event: {
		toolName: string;
		input?: Record<string, unknown>;
		toolCallId?: string;
	}): TldrActivity {
		return this.addActivity(
			"tool_call",
			"normal",
			`tool: ${compactToolInput(event.toolName, event.input)}`,
			event.toolCallId,
		);
	}

	// Stage 2: tool execution streaming. The host is running the tool and
	// emitting partial output. Tagged with progressGroup so adjacent chunks of
	// the same execution are treated as one continuous stream.
	recordToolExecutionUpdate(event: {
		toolCallId: string;
		toolName: string;
		partialResult: unknown;
	}): TldrActivity {
		const partialText =
			extractTextContent(
				Array.isArray((event.partialResult as { content?: unknown })?.content)
					? ((event.partialResult as { content: unknown[] }).content as unknown[])
					: undefined,
			) ??
			compactValue(event.partialResult, MAX_TOOL_PROGRESS_PARTIAL_CHARS) ??
			"streaming";

		const progressGroup = `tool-execution:${event.toolCallId}`;

		// Adjacent execution-update activities for the same stream collapse into
		// the latest. The retained activity list stays bounded and the model sees
		// one current snapshot of in-progress output.
		const last = this.activities[this.activities.length - 1];
		if (
			last?.activityType === "tool_execution_update" &&
			last.progressGroup === progressGroup
		) {
			this.activities.pop();
		}

		return this.addActivity(
			"tool_execution_update",
			"normal",
			`running ${event.toolName}; ${tailText(partialText, MAX_TOOL_PROGRESS_PARTIAL_CHARS)}`,
			event.toolCallId,
			progressGroup,
		);
	}

	recordToolResult(event: {
		toolName: string;
		input?: Record<string, unknown>;
		isError?: boolean;
		content?: readonly unknown[];
		details?: unknown;
		toolCallId?: string;
	}): TldrActivity {
		const isError = Boolean(event.isError);
		const resultText = summarizeToolResult(
			event.toolName,
			event.input,
			extractTextContent(event.content),
			isError,
		);
		const status = isError ? "error" : "ok";
		const tool = compactToolInput(event.toolName, event.input);

		// The completed result fact subsumes all in-progress facts for the same
		// call: the original tool_call, any tool_input_* lifecycle facts, and any
		// tool_execution_update progress. The model only needs the final outcome.
		if (event.toolCallId) {
			const id = event.toolCallId;
			for (let i = this.activities.length - 1; i >= 0; i--) {
				const activity = this.activities[i];
				if (activity.toolCallId !== id) continue;
				if (
					activity.activityType === "tool_call" ||
					activity.activityType === "tool_input_start" ||
					activity.activityType === "tool_input_update" ||
					activity.activityType === "tool_input_end" ||
					activity.activityType === "tool_execution_update"
				) {
					this.activities.splice(i, 1);
				}
			}
		}

		return this.addActivity(
			"tool_result",
			"normal",
			resultText
				? `result: ${tool} ${status}; ${resultText}`
				: `result: ${tool} ${status}`,
			event.toolCallId,
		);
	}

	recordMessageEnd(message: unknown): TldrActivity | "emptyFinalStop" | "ignored" {
		if (!message || typeof message !== "object") return "ignored";
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant") return "ignored";

		const stopReason = typeof record.stopReason === "string" ? record.stopReason : undefined;
		if (stopReason === "toolUse") return "ignored";

		let text: string | undefined;
		if (stopReason === "stop") {
			const finalText = extractTextContent(record.content as readonly unknown[] | undefined);
			if (!finalText) return "emptyFinalStop";
			text = `final: ${truncateText(finalText, MAX_FINAL_TEXT_CHARS)}`;
		} else if (stopReason) {
			const error = typeof record.errorMessage === "string" ? compactText(record.errorMessage) : undefined;
			text = error
				? `final: ${stopReason}; ${truncateText(error, MAX_FINAL_TEXT_CHARS)}`
				: `final: ${stopReason}`;
		}

		return text
			? this.addActivity(
					stopReason === "stop" ? "assistant_final" : "assistant_failure",
					"final",
					text,
				)
			: "ignored";
	}

	activitiesAfter(previousIndex: number, throughIndex: number): readonly TldrActivity[] {
		return this.activities.filter(
			(activity) => activity.index > previousIndex && activity.index <= throughIndex,
		);
	}

	latestActivityIndex(): number {
		return this.nextIndex - 1;
	}

	discardActivitiesThrough(activityIndex: number): void {
		const firstRetainedIndex = this.activities.findIndex(
			(activity) => activity.index > activityIndex,
		);
		if (firstRetainedIndex === -1) {
			this.activities.splice(0);
			return;
		}
		if (firstRetainedIndex > 0) this.activities.splice(0, firstRetainedIndex);
	}

	private addActivity(
		activityType: TldrActivityType,
		displayPriority: TldrDisplayPriority,
		text: string,
		toolCallId?: string,
		progressGroup?: string,
	): TldrActivity {
		const activity: TldrActivity = {
			index: this.nextIndex,
			activityType,
			displayPriority,
			text: truncateText(text, MAX_ACTIVITY_TEXT_CHARS),
			toolCallId,
			progressGroup,
		};
		this.nextIndex++;
		this.activities.push(activity);
		if (this.activities.length > MAX_RETAINED_RAW_ACTIVITIES) {
			this.activities.splice(0, this.activities.length - MAX_RETAINED_RAW_ACTIVITIES);
		}
		return activity;
	}
}

class FooterTldrEngine {
	private readonly facts = new TldrFactCollector();
	private configuredModel?: TldrModelPreference;
	private runId = 0;
	private latestAcceptedActivityIndex = 0;
	private lastRenderedActivityIndex = 0;
	private lastRenderedText = "";
	private lastDisplayAt = Number.NEGATIVE_INFINITY;
	private readonly acceptedCheckpoints: TldrCheckpoint[] = [];
	private checkpointQueue: TldrCheckpointJob[] = [];
	private inFlightCheckpoint?: TldrCheckpointJob;
	private pendingDisplayCheckpoint?: TldrCheckpoint;
	private displayTimer?: ReturnType<typeof setTimeout>;
	private abortController?: AbortController;
	private currentText: string | null = null;
	// Normal-priority bursts wait for a quiet window before triggering a model
	// call. Pi often emits many rapid activities (e.g. streaming reads); without
	// debouncing we would hammer the TLDR model for intermediate states.
	private pendingNormalCheckpoint?: TldrCheckpointJob;
	private normalCheckpointTimer?: ReturnType<typeof setTimeout>;
	private normalCheckpointBurstStartedAt?: number;
	// Last progress stream that produced a rendered checkpoint. Used to slow the
	// display refresh for repeat renders from the same stream.
	private lastRenderedProgressGroup?: string;

	constructor(private readonly requestRender: () => void) {}

	text(): string | null {
		return this.currentText;
	}

	startSession(cwd: string): void {
		this.configuredModel = resolveTldrModelPreference(cwd);
		this.facts.resetConversation();
		this.startFreshRun();
	}

	shutdown(): void {
		this.facts.resetConversation();
		this.startFreshRun();
	}

	recordUserMessage(ctx: ExtensionContext, prompt: string): void {
		this.currentText = null;
		this.requestRender();
		this.enqueue(ctx, this.facts.recordUserMessage(prompt));
	}

	recordAssistantUpdate(
		ctx: ExtensionContext,
		message: unknown,
		assistantMessageEvent?: unknown,
	): void {
		// Tool input streaming hides inside `message_update`. Drain that signal
		// first; only if no tool-input fact was produced does this look like a
		// plain assistant text update worth recording.
		const toolInputActivity = this.facts.recordToolInputActivity(
			normalizeToolInputEvent(assistantMessageEvent),
		);
		if (toolInputActivity) {
			this.enqueue(ctx, toolInputActivity);
			return;
		}

		const activity = this.facts.recordAssistantUpdate(message);
		if (activity) this.enqueue(ctx, activity);
	}

	recordToolCall(
		ctx: ExtensionContext,
		event: { toolName: string; input?: Record<string, unknown>; toolCallId?: string },
	): void {
		this.enqueue(ctx, this.facts.recordToolCall(event));
	}

	recordToolExecutionUpdate(
		ctx: ExtensionContext,
		event: {
			toolCallId: string;
			toolName: string;
			partialResult: unknown;
		},
	): void {
		this.enqueue(ctx, this.facts.recordToolExecutionUpdate(event));
	}

	recordToolResult(
		ctx: ExtensionContext,
		event: {
			toolName: string;
			input?: Record<string, unknown>;
			isError?: boolean;
			content?: readonly unknown[];
			details?: unknown;
			toolCallId?: string;
		},
	): void {
		this.enqueue(ctx, this.facts.recordToolResult(event));
	}

	recordMessageEnd(ctx: ExtensionContext, message: unknown): void {
		const result = this.facts.recordMessageEnd(message);
		if (result === "ignored") return;
		if (result === "emptyFinalStop") {
			this.facts.resetConversation();
			this.startFreshRun();
			return;
		}
		this.enqueue(ctx, result);
	}

	private startFreshRun(): void {
		this.runId++;
		this.cancelWork();
		this.latestAcceptedActivityIndex = 0;
		this.lastRenderedActivityIndex = 0;
		this.lastRenderedText = "";
		this.lastDisplayAt = Number.NEGATIVE_INFINITY;
		this.acceptedCheckpoints.splice(0);
		this.pendingDisplayCheckpoint = undefined;
		this.lastRenderedProgressGroup = undefined;
		this.currentText = null;
		this.requestRender();
	}

	private cancelWork(): void {
		if (this.displayTimer) clearTimeout(this.displayTimer);
		this.displayTimer = undefined;
		this.clearPendingNormalCheckpoint();
		this.checkpointQueue.splice(0);
		this.inFlightCheckpoint = undefined;
		this.abortController?.abort();
		this.abortController = undefined;
	}

	private clearNormalCheckpointTimer(): void {
		if (!this.normalCheckpointTimer) return;
		clearTimeout(this.normalCheckpointTimer);
		this.normalCheckpointTimer = undefined;
	}

	private clearPendingNormalCheckpoint(): void {
		this.clearNormalCheckpointTimer();
		this.pendingNormalCheckpoint = undefined;
		this.normalCheckpointBurstStartedAt = undefined;
	}

	private scheduleNormalCheckpoint(
		ctx: ExtensionContext,
		job: TldrCheckpointJob,
	): void {
		this.pendingNormalCheckpoint = job;
		this.normalCheckpointBurstStartedAt ??= performance.now();
		this.clearNormalCheckpointTimer();

		const elapsedSinceBurstStarted =
			performance.now() - this.normalCheckpointBurstStartedAt;
		const maxWaitRemainingMs =
			NORMAL_CHECKPOINT_MAX_WAIT_MS - elapsedSinceBurstStarted;
		const delayMs = Math.max(
			0,
			Math.min(NORMAL_CHECKPOINT_QUIET_MS, maxWaitRemainingMs),
		);

		if (delayMs === 0) {
			this.flushPendingNormalCheckpoint(ctx);
			return;
		}

		this.normalCheckpointTimer = setTimeout(() => {
			this.normalCheckpointTimer = undefined;
			this.flushPendingNormalCheckpoint(ctx);
		}, delayMs);
	}

	private flushPendingNormalCheckpoint(ctx: ExtensionContext): void {
		const job = this.pendingNormalCheckpoint;
		this.clearPendingNormalCheckpoint();
		if (!job || job.runId !== this.runId) return;

		this.checkpointQueue = this.checkpointQueue.filter(
			(queued) => queued.displayPriority !== "normal",
		);
		this.checkpointQueue.push(job);
		this.pump(ctx);
	}

	private enqueue(ctx: ExtensionContext, activity: TldrActivity): void {
		if (!ctx.hasUI) return;
		const job: TldrCheckpointJob = {
			activityIndex: activity.index,
			activityType: activity.activityType,
			displayPriority: activity.displayPriority,
			runId: this.runId,
			progressGroup: activity.progressGroup,
		};

		if (job.displayPriority === "immediate") {
			this.clearPendingDisplay();
			this.clearPendingNormalCheckpoint();
			this.lastRenderedText = "";
			this.checkpointQueue.splice(0);
			this.abortInFlightCheckpoint();
			this.checkpointQueue.push(job);
			this.pump(ctx);
			return;
		}

		if (job.displayPriority === "final") {
			this.clearPendingDisplay();
			this.clearPendingNormalCheckpoint();
			this.checkpointQueue = this.checkpointQueue.filter(
				(queued) => queued.displayPriority !== "normal",
			);
			if (this.inFlightCheckpoint?.displayPriority === "normal") {
				this.abortInFlightCheckpoint();
			}
			this.checkpointQueue.push(job);
			this.pump(ctx);
			return;
		}

		// Normal-priority: debounce into a single coalesced job. The latest job
		// always wins because raw activity since the last accepted checkpoint is
		// what the model already sees, regardless of which job triggers the call.
		this.scheduleNormalCheckpoint(ctx, job);
	}

	private clearDisplayTimer(): void {
		if (this.displayTimer) clearTimeout(this.displayTimer);
		this.displayTimer = undefined;
	}

	private clearPendingDisplay(): void {
		this.clearDisplayTimer();
		this.pendingDisplayCheckpoint = undefined;
	}

	private abortInFlightCheckpoint(): void {
		if (!this.inFlightCheckpoint) return;
		this.abortController?.abort();
		this.abortController = undefined;
		this.inFlightCheckpoint = undefined;
	}

	private pump(ctx: ExtensionContext): void {
		if (!ctx.hasUI || this.inFlightCheckpoint) return;
		const job = this.checkpointQueue.shift();
		if (!job) return;
		if (job.runId !== this.runId || job.activityIndex <= this.latestAcceptedActivityIndex) {
			this.pump(ctx);
			return;
		}
		this.inFlightCheckpoint = job;
		void this.runCheckpointRequest(ctx, job);
	}

	private isCurrentJob(job: TldrCheckpointJob): boolean {
		return job.runId === this.runId && this.inFlightCheckpoint === job;
	}

	private async runCheckpointRequest(
		ctx: ExtensionContext,
		job: TldrCheckpointJob,
	): Promise<void> {
		let abortController: AbortController | undefined;
		try {
			const prompt = this.checkpointPrompt(job);
			if (!prompt) return;
			const auth = await getFastTldrModelAuth(ctx, this.configuredModel);
			if (!this.isCurrentJob(job) || !auth) return;

			abortController = new AbortController();
			this.abortController = abortController;
			const response = await complete(
				auth.model,
				{ systemPrompt: checkpointSystemPrompt(job), messages: [prompt] },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: TLDR_MAX_TOKENS,
					maxRetries: 0,
					cacheRetention: "none",
					timeoutMs: TLDR_REQUEST_TIMEOUT_MS,
					signal: abortController.signal,
				},
			);
			if (!this.isCurrentJob(job) || response.stopReason !== "stop") return;

			const rawText = extractTextContent(response.content) ?? "";
			const text = sanitizeTldrText(rawText);
			if (!text) return;
			const checkpoint: TldrCheckpoint = {
				activityIndex: job.activityIndex,
				activityType: job.activityType,
				displayPriority: job.displayPriority,
				text,
				progressGroup: job.progressGroup,
			};
			this.acceptCheckpoint(checkpoint);
			this.considerDisplayingCheckpoint(ctx, checkpoint);
		} catch {
			// Best effort. Later checkpoints include unaccepted raw activity.
		} finally {
			if (abortController && this.abortController === abortController) {
				this.abortController = undefined;
			}
			if (this.inFlightCheckpoint === job) this.inFlightCheckpoint = undefined;
			this.pump(ctx);
		}
	}

	private acceptCheckpoint(checkpoint: TldrCheckpoint): void {
		this.acceptedCheckpoints.push(checkpoint);
		if (this.acceptedCheckpoints.length > MAX_CONTEXT_CHECKPOINTS) {
			this.acceptedCheckpoints.splice(
				0,
				this.acceptedCheckpoints.length - MAX_CONTEXT_CHECKPOINTS,
			);
		}
		this.latestAcceptedActivityIndex = checkpoint.activityIndex;
		this.facts.discardActivitiesThrough(checkpoint.activityIndex);
	}

	private considerDisplayingCheckpoint(
		ctx: ExtensionContext,
		checkpoint: TldrCheckpoint,
	): void {
		if (checkpoint.activityIndex <= this.lastRenderedActivityIndex) return;
		if (this.shouldDropStaleCheckpoint(checkpoint)) return;

		if (checkpoint.displayPriority !== "normal" || !this.lastRenderedText) {
			this.clearPendingDisplay();
			this.renderCheckpoint(checkpoint);
			return;
		}

		const displayIntervalMs = this.displayIntervalFor(checkpoint);
		const elapsedMs = performance.now() - this.lastDisplayAt;
		if (elapsedMs >= displayIntervalMs) {
			this.clearPendingDisplay();
			this.renderCheckpoint(checkpoint);
			return;
		}

		this.pendingDisplayCheckpoint = checkpoint;
		// Recompute the timer for each newly accepted pending checkpoint. A long
		// 10s progress-stream debounce should not block a subsequent ordinary
		// update that wants to render at the normal 1.2s cadence.
		this.clearDisplayTimer();
		this.displayTimer = setTimeout(() => {
			this.displayTimer = undefined;
			const pending = this.pendingDisplayCheckpoint;
			this.pendingDisplayCheckpoint = undefined;
			if (!pending) return;
			if (this.shouldDropStaleCheckpoint(pending)) return;
			this.renderCheckpoint(pending);
		}, displayIntervalMs - elapsedMs);
	}

	// A model call for chunk N may finish after chunk N+1 has been recorded.
	// Most stale checkpoints are dropped, but progress streams are an exception:
	// while the same stream is still active, a slightly-behind TLDR is still
	// useful, and dropping it would leave the footer stuck on older text.
	private shouldDropStaleCheckpoint(checkpoint: TldrCheckpoint): boolean {
		if (checkpoint.activityIndex === this.facts.latestActivityIndex()) {
			return false;
		}

		// Boundary checkpoints (user_message, assistant_final, etc.) must stay
		// latest-only. A stale prompt-start or final TLDR would describe the wrong
		// turn entirely.
		if (checkpoint.displayPriority !== "normal") return true;

		if (!isToolProgressActivity(checkpoint.activityType)) return true;
		if (!checkpoint.progressGroup) return true;

		const latestActivity = this.facts.latestActivity();
		return !(
			latestActivity &&
			latestActivity.index > checkpoint.activityIndex &&
			latestActivity.activityType === checkpoint.activityType &&
			latestActivity.progressGroup === checkpoint.progressGroup
		);
	}

	private displayIntervalFor(checkpoint: TldrCheckpoint): number {
		if (!isToolProgressActivity(checkpoint.activityType)) {
			return TLDR_DISPLAY_UPDATE_INTERVAL_MS;
		}
		// First render from a new progress group uses the normal cadence so the
		// user sees the stream's first TLDR quickly. Subsequent renders for the
		// same group slow down: the model output barely changes between chunks.
		return checkpoint.progressGroup &&
			checkpoint.progressGroup === this.lastRenderedProgressGroup
			? TOOL_PROGRESS_DISPLAY_UPDATE_INTERVAL_MS
			: TLDR_DISPLAY_UPDATE_INTERVAL_MS;
	}

	private renderCheckpoint(checkpoint: TldrCheckpoint): void {
		if (checkpoint.activityIndex <= this.lastRenderedActivityIndex) return;
		if (checkpoint.text === this.lastRenderedText) return;
		this.lastRenderedActivityIndex = checkpoint.activityIndex;
		this.lastRenderedText = checkpoint.text;
		this.lastDisplayAt = performance.now();
		this.lastRenderedProgressGroup = isToolProgressActivity(checkpoint.activityType)
			? checkpoint.progressGroup
			: undefined;
		this.currentText = checkpoint.text;
		this.requestRender();
	}

	private checkpointPrompt(job: TldrCheckpointJob): UserMessage | undefined {
		const rawActivities = this.facts.activitiesAfter(
			this.latestAcceptedActivityIndex,
			job.activityIndex,
		);
		if (rawActivities.length === 0) return undefined;
		return {
			role: "user",
			content: [
				{
					type: "text",
					text: [
						"Prior TLDRs (context only, do not copy phrasing):",
						previousCheckpointLines(this.acceptedCheckpoints),
						"",
						"New activity to summarize:",
						...rawActivities.map(formatRawActivity),
						"",
						"Write the next TLDR.",
					].join("\n"),
				},
			],
			timestamp: Date.now(),
		};
	}
}

function checkpointSystemPrompt(job: TldrCheckpointJob): string {
	const tenseInstruction =
		job.displayPriority === "final"
			? "Start with a past-tense verb."
			: "Start with a present-tense -ing verb.";
	// Frame the model as a human developer describing visible work, not an agent
	// summarizing its own mechanics. Avoids leaks like tool names, prompt labels,
	// or our internal scaffolding (activity indexes, prior checkpoints).
	return `Write one plain-English TLDR for a Pi coding agent.
Describe the work progress as if a human developer were doing it.
Focus on the task activity and current outcome, not agent mechanics.
Do not mention tools, tool calls, prompts, messages, model output, or implementation details.
Use the prior TLDRs for context and the new activity for the update.
Summarize the current state of work; do not narrate the history.
If context is sparse, still summarize the available activity.
Never ask for more information or say there is not enough context.
Return one concise status fragment under ${TLDR_TARGET_SUMMARY_CHARS} characters.
Omit subjects like "the agent" or "it".
Prefer verb + direct object. Include outcome only if important.
Do not address the user.
Output only the status fragment itself. No prefixes, labels, bullets, or quotes.
Plain text only; no markdown, JSON, code, file paths, or tool names.
${tenseInstruction}`;
}

function previousCheckpointLines(checkpoints: readonly TldrCheckpoint[]): string {
	if (checkpoints.length === 0) return "none";
	return checkpoints
		.slice(-MAX_CONTEXT_CHECKPOINTS)
		.map((checkpoint) => `- ${sanitizeTldrText(checkpoint.text)}`)
		.join("\n");
}

function formatRawActivity(activity: TldrActivity): string {
	return `- ${activity.text}`;
}

// Narrows the unknown `assistantMessageEvent` from `message_update` to the
// three tool-input streaming variants. Other event shapes (text_start, etc.)
// produce undefined, signalling "no tool input fact to record".
function normalizeToolInputEvent(value: unknown): ToolInputAssistantEvent | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const type = record.type;
	if (type !== "toolcall_start" && type !== "toolcall_delta" && type !== "toolcall_end") {
		return undefined;
	}
	if (typeof record.contentIndex !== "number") return undefined;

	if (type === "toolcall_delta") {
		return {
			type,
			contentIndex: record.contentIndex,
			delta: typeof record.delta === "string" ? record.delta : "",
			partial: record.partial,
		};
	}
	if (type === "toolcall_end") {
		const toolCall = record.toolCall;
		if (
			!toolCall ||
			typeof toolCall !== "object" ||
			typeof (toolCall as Record<string, unknown>).id !== "string" ||
			typeof (toolCall as Record<string, unknown>).name !== "string"
		) {
			return undefined;
		}
		return {
			type,
			contentIndex: record.contentIndex,
			toolCall: toolCall as { id: string; name: string; arguments?: unknown },
			partial: record.partial,
		};
	}
	return {
		type,
		contentIndex: record.contentIndex,
		partial: record.partial,
	};
}

// Strips ANSI/CSI/OSC/DCS/SOS/PM/APC escape sequences from model output before
// it lands in the terminal. The TLDR text is model-controlled and renders into
// the footer; the system prompt asking for plain text is not a security
// boundary, so we defensively remove terminal controls here.
const ESC_BYTE = 0x1b;
const BEL_BYTE = 0x07;
const ST_BYTE = 0x9c;

function isControlCharacter(code: number): boolean {
	return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}

function isWhitespaceControl(code: number): boolean {
	return (
		code === 0x09 ||
		code === 0x0a ||
		code === 0x0b ||
		code === 0x0c ||
		code === 0x0d
	);
}

function skipCsiSequence(text: string, startIndex: number): number {
	for (let index = startIndex; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) return index + 1;
	}
	return text.length;
}

function skipStringControl(text: string, startIndex: number): number {
	for (let index = startIndex; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === BEL_BYTE || code === ST_BYTE) return index + 1;
		if (code === ESC_BYTE && text.charCodeAt(index + 1) === 0x5c) {
			return index + 2;
		}
	}
	return text.length;
}

function skipEscapeSequence(text: string, escapeIndex: number): number {
	const nextCode = text.charCodeAt(escapeIndex + 1);
	if (Number.isNaN(nextCode)) return escapeIndex + 1;

	switch (nextCode) {
		case 0x5b: // CSI: ESC [
			return skipCsiSequence(text, escapeIndex + 2);
		case 0x5d: // OSC: ESC ]
		case 0x50: // DCS: ESC P
		case 0x58: // SOS: ESC X
		case 0x5e: // PM: ESC ^
		case 0x5f: // APC: ESC _
			return skipStringControl(text, escapeIndex + 2);
		default:
			if (
				nextCode === 0x20 ||
				nextCode === 0x23 ||
				nextCode === 0x25 ||
				(nextCode >= 0x28 && nextCode <= 0x2f)
			) {
				return Math.min(text.length, escapeIndex + 3);
			}
			return Math.min(text.length, escapeIndex + 2);
	}
}

function stripTerminalControls(text: string): string {
	let stripped = "";
	for (let index = 0; index < text.length; ) {
		const code = text.charCodeAt(index);

		if (code === ESC_BYTE) {
			index = skipEscapeSequence(text, index);
			continue;
		}
		if (code === 0x9b) {
			index = skipCsiSequence(text, index + 1);
			continue;
		}
		if (
			code === 0x90 ||
			code === 0x98 ||
			code === 0x9d ||
			code === 0x9e ||
			code === 0x9f
		) {
			index = skipStringControl(text, index + 1);
			continue;
		}
		if (isControlCharacter(code)) {
			if (isWhitespaceControl(code)) stripped += " ";
			index++;
			continue;
		}

		stripped += text[index];
		index++;
	}
	return stripped.replace(/\s+/gu, " ").trim();
}

// Second layer: strip leaked prompt scaffolding such as "Through activity 12:".
// The system prompt forbids these prefixes, but model outputs sometimes still
// parrot them; the regex is narrow enough not to clip natural starts like
// "Activity slowed after retry" or "Checkpointing release state".
const LEAKED_PREFIX_PATTERN =
	/^\s*(?:[-*•]\s*)?(?:(?:through\s+activity|activity|checkpoint)\s+\d+\s*[:.\-—–]\s*|(?:tldr|summary)\s*[:.\-—–]\s*)+/i;
const LEADING_PUNCT_PATTERN = /^[\s\-—–•*:#.,;]+/;

function stripLeakedScaffolding(text: string): string {
	let cleaned = text;
	let previous: string;
	do {
		previous = cleaned;
		cleaned = cleaned.replace(LEAKED_PREFIX_PATTERN, "").trim();
		cleaned = cleaned.replace(LEADING_PUNCT_PATTERN, "").trim();
	} while (cleaned !== previous && cleaned.length > 0);
	return cleaned;
}

function sanitizeTldrText(
	text: string,
	maxChars = MAX_SAFE_TLDR_CHARS,
): string {
	const stripped = stripTerminalControls(text);
	const cleaned = stripLeakedScaffolding(stripped) || stripped;
	return truncateText(cleaned, maxChars);
}

function shouldShowStatus(key: string, filter: StatusFilter): boolean {
	if (filter.mode === "only") return filter.shown.has(key);
	return !filter.hidden.has(key);
}

function formatExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
	filter: StatusFilter,
	seenStatusKeys: Set<string>,
): string | null {
	const parts = Array.from(statuses.entries())
		.filter(([, text]) => text.trim().length > 0)
		.filter(([key]) => {
			seenStatusKeys.add(key);
			return shouldShowStatus(key, filter);
		})
		.map(([key, text]) => `${key}:${text}`);

	return parts.length > 0 ? parts.join(" ") : null;
}

function serializeStatusFilter(filter: StatusFilter): SerializedStatusFilter {
	if (filter.mode === "only") {
		return { mode: "only", shown: Array.from(filter.shown).sort() };
	}
	return { mode: "all", hidden: Array.from(filter.hidden).sort() };
}

function parseSerializedStatusFilter(value: unknown): StatusFilter | null {
	if (!value || typeof value !== "object") return null;
	const data = value as Partial<SerializedStatusFilter>;

	if (data.mode === "only" && Array.isArray(data.shown)) {
		return { mode: "only", shown: new Set(data.shown) };
	}
	if (data.mode === "all" && Array.isArray(data.hidden)) {
		return { mode: "all", hidden: new Set(data.hidden) };
	}
	return null;
}

function splitStatusKeys(raw: string): string[] {
	return raw
		.split(/[\s,]+/)
		.map((key) => key.trim())
		.filter(Boolean);
}

function describeStatusFilter(filter: StatusFilter): string {
	if (filter.mode === "only") {
		const shown = Array.from(filter.shown).sort();
		return shown.length > 0 ? `showing only: ${shown.join(", ")}` : "showing none";
	}

	const hidden = Array.from(filter.hidden).sort();
	return hidden.length > 0 ? `showing all except: ${hidden.join(", ")}` : "showing all";
}

function readGlobalStatusFilter(): StatusFilter | null {
	try {
		const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
			statusFilter?: unknown;
		};
		return parseSerializedStatusFilter(data.statusFilter ?? data);
	} catch {
		return null;
	}
}

function writeGlobalStatusFilter(filter: StatusFilter): void {
	const data = JSON.stringify(
		{ statusFilter: serializeStatusFilter(filter) },
		null,
		2,
	);
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`;
	writeFileSync(tmpPath, `${data}\n`, "utf8");
	renameSync(tmpPath, CONFIG_PATH);
}

function getKnownStatusKeys(filter: StatusFilter, seenStatusKeys: Set<string>): string[] {
	const keys = new Set(seenStatusKeys);
	if (filter.mode === "only") {
		for (const key of filter.shown) keys.add(key);
	} else {
		for (const key of filter.hidden) keys.add(key);
	}
	return Array.from(keys).sort();
}

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;
	let statusFilter: StatusFilter = { mode: "all", hidden: new Set() };
	const seenStatusKeys = new Set<string>();
	const refresh = () => requestRender?.();
	const tldr = new FooterTldrEngine(refresh);
	const restoreStatusFilter = (ctx: ExtensionContext) => {
		let restoredFilter = readGlobalStatusFilter();
		if (!restoredFilter) {
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "custom" && entry.customType === STATUS_FILTER_ENTRY_TYPE) {
					restoredFilter = parseSerializedStatusFilter(entry.data);
				}
			}
		}
		statusFilter = restoredFilter ?? { mode: "all", hidden: new Set() };
	};
	const persistStatusFilter = () => {
		writeGlobalStatusFilter(statusFilter);
		refresh();
	};
	const openStatusConfigurator = async (ctx: ExtensionContext) => {
		const knownStatusKeys = getKnownStatusKeys(statusFilter, seenStatusKeys);
		if (knownStatusKeys.length === 0) {
			ctx.ui.notify(
				"No extension statuses seen yet. Open /bar after another extension calls ctx.ui.setStatus().",
				"info",
			);
			return;
		}

		await ctx.ui.custom((tui, theme, _kb, done) => {
			let futureShown = statusFilter.mode === "all";
			const statusVisibility = new Map(
				knownStatusKeys.map((key) => [key, shouldShowStatus(key, statusFilter)]),
			);
			const persistFromVisibility = () => {
				if (futureShown) {
					statusFilter = {
						mode: "all",
						hidden: new Set(
							knownStatusKeys.filter((key) => !statusVisibility.get(key)),
						),
					};
				} else {
					statusFilter = {
						mode: "only",
						shown: new Set(
							knownStatusKeys.filter((key) => statusVisibility.get(key)),
						),
					};
				}
				persistStatusFilter();
			};

			const items: SettingItem[] = [
				{
					id: "__future",
					label: "New statuses",
					description: "Default visibility for status keys discovered later",
					currentValue: futureShown ? "shown" : "hidden",
					values: ["shown", "hidden"],
				},
				...knownStatusKeys.map((key): SettingItem => ({
					id: key,
					label: key,
					description: "Extension status visibility",
					currentValue: statusVisibility.get(key) ? "shown" : "hidden",
					values: ["shown", "hidden"],
				})),
			];

			const container = new Container();
			container.addChild(
				new (class {
					render(_width: number) {
						return [
							theme.fg("accent", theme.bold("pi-bar status visibility")),
							theme.fg("dim", "Enter/Space toggles · Esc closes"),
							"",
						];
					}
					invalidate() {}
				})(),
			);

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 15),
				getSettingsListTheme(),
				(id, newValue) => {
					if (id === "__future") {
						futureShown = newValue === "shown";
					} else {
						statusVisibility.set(id, newValue === "shown");
					}
					persistFromVisibility();
				},
				() => done(undefined),
				{ enableSearch: true },
			);

			container.addChild(settingsList);

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	};

	pi.registerCommand("bar", {
		description: "Configure pi-bar footer status segments",
		handler: async (args, ctx) => {
			const [section, action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (!section || ((section === "status" || section === "statuses") && !action)) {
				await openStatusConfigurator(ctx);
				return;
			}

			if (section === "status" || section === "statuses") {
				const keys = splitStatusKeys(rest.join(" "));

				switch (action) {
					case "config":
					case "configure":
					case "edit":
						await openStatusConfigurator(ctx);
						return;
					case "list":
					case "ls": {
						const known = getKnownStatusKeys(statusFilter, seenStatusKeys);
						ctx.ui.notify(
							`pi-bar statuses: ${describeStatusFilter(statusFilter)}${known.length > 0 ? `; known: ${known.join(", ")}` : "; known: none yet"}`,
							"info",
						);
						return;
					}
					case "all":
						statusFilter = { mode: "all", hidden: new Set() };
						break;
					case "none":
						statusFilter = { mode: "only", shown: new Set() };
						break;
					case "only":
						statusFilter = { mode: "only", shown: new Set(keys) };
						break;
					case "hide":
						if (statusFilter.mode === "only") {
							for (const key of keys) statusFilter.shown.delete(key);
						} else {
							for (const key of keys) statusFilter.hidden.add(key);
						}
						break;
					case "show":
						if (statusFilter.mode === "only") {
							for (const key of keys) statusFilter.shown.add(key);
						} else {
							for (const key of keys) statusFilter.hidden.delete(key);
						}
						break;
					default:
						ctx.ui.notify(
							"Usage: /bar status [list|all|none|only <keys>|show <keys>|hide <keys>]",
							"warning",
						);
						return;
				}

				persistStatusFilter();
				ctx.ui.notify(`pi-bar statuses: ${describeStatusFilter(statusFilter)}`, "info");
				return;
			}

			ctx.ui.notify(
				"Usage: /bar status [list|all|none|only <keys>|show <keys>|hide <keys>]",
				"warning",
			);
		},
	});

	pi.on("model_select", async () => refresh());
	pi.on("thinking_level_select", async () => refresh());
	pi.on("turn_end", async () => refresh());
	pi.on("before_agent_start", async (event, ctx) => {
		tldr.recordUserMessage(ctx, event.prompt);
	});
	pi.on("message_update", async (event, ctx) => {
		tldr.recordAssistantUpdate(
			ctx,
			event.message,
			(event as { assistantMessageEvent?: unknown }).assistantMessageEvent,
		);
	});
	pi.on("tool_call", async (event, ctx) => {
		tldr.recordToolCall(ctx, event);
	});
	pi.on("tool_execution_update", async (event, ctx) => {
		tldr.recordToolExecutionUpdate(ctx, event);
	});
	pi.on("tool_result", async (event, ctx) => {
		tldr.recordToolResult(ctx, event);
	});
	pi.on("message_end", async (event, ctx) => {
		tldr.recordMessageEnd(ctx, event.message);
		refresh();
	});
	pi.on("session_before_tree", async () => {
		tldr.shutdown();
	});
	pi.on("session_tree", async (_event, ctx) => {
		tldr.startSession(ctx.cwd);
		restoreStatusFilter(ctx);
		refresh();
	});

	pi.on("session_start", async (_event, ctx) => {
		tldr.startSession(ctx.cwd);
		restoreStatusFilter(ctx);

		if (!ctx.hasUI) return;

		const visibleSegments = parseSegments();
		const { warningThreshold, errorThreshold } = parseThresholds();

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			return {
				dispose() {
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const modelName = formatModelName(ctx.model?.id);
					const thinkingLevel = String(pi.getThinkingLevel());
					const extensionStatuses = formatExtensionStatuses(
						footerData?.getExtensionStatuses?.() ?? new Map(),
						statusFilter,
						seenStatusKeys,
					);
					const usage = ctx.getContextUsage();
					const contextSegmentColor = contextColor(
						usage?.percent,
						warningThreshold,
						errorThreshold,
					);

					const contextText = usage
						? `${usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "—%"} / ${formatTokens(usage.contextWindow)}`
						: "—";
					const tldrText = tldr.text();

					const segmentRenderers: Record<SegmentName, string | null> = {
						model: theme.fg("accent", modelName),
						thinking: theme.fg(thinkingColor(thinkingLevel), `think:${thinkingLevel}`),
						context: theme.fg(contextSegmentColor, contextText),
						tldr: tldrText ? theme.fg("muted", tldrText) : null,
						extensions: extensionStatuses ? theme.fg("muted", extensionStatuses) : null,
					};

					const separator = `  ${theme.fg("dim", SEGMENT_SEPARATOR)}  `;
					const line = visibleSegments
						.map((segment) => segmentRenderers[segment])
						.filter((segment): segment is string => segment !== null)
						.join(separator);

					return [truncateToWidth(line, width)];
				},
			};
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		tldr.shutdown();
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
	});
}
