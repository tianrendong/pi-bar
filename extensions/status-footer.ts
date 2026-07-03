/**
 * pi-bar — footer / statusline extension.
 *
 * Replaces pi's built-in footer with left-aligned segments:
 *   <model> ❯ think:<level> ❯ <context% / window> ❯ <progress> ❯ <extensions>
 *
 * Example:
 *   claude-opus-4.7  ❯  think:med  ❯  2.6% / 1.0M  ❯  Reviewing package structure
 *
 * Re-renders on model change, thinking-level change, status updates, and after
 * each assistant turn so context usage stays current.
 *
 * Environment variables:
 *   PI_BAR_SHOW           comma-separated list of segments to show
 *   PI_BAR_THRESHOLDS     warning,danger context-usage percentages
 *   PI_BAR_PROGRESS_MODEL provider/id for the progress update model
 *   PI_BAR_CONFIG         override the persisted pi-bar config path
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

type SegmentName = "model" | "thinking" | "context" | "progress" | "extensions";
type StatusFilter =
	| { mode: "all"; hidden: Set<string> }
	| { mode: "only"; shown: Set<string> };
type SerializedStatusFilter =
	| { mode: "all"; hidden: string[] }
	| { mode: "only"; shown: string[] };
type GlobalBarConfig = {
	statusFilter?: SerializedStatusFilter;
	segments?: SegmentName[];
	hideStatusLabels?: boolean;
};
type ProgressActivityType =
	| "user_message"
	| "assistant_update"
	| "tool_call"
	| "tool_result"
	| "assistant_final"
	| "assistant_failure";
type ProgressDisplayPriority = "immediate" | "normal" | "final";
type ProgressActivity = {
	index: number;
	activityType: ProgressActivityType;
	displayPriority: ProgressDisplayPriority;
	text: string;
	toolCallId?: string;
};
type ProgressCheckpoint = {
	activityIndex: number;
	displayPriority: ProgressDisplayPriority;
	text: string;
};
type ProgressCheckpointJob = {
	activityIndex: number;
	displayPriority: ProgressDisplayPriority;
	runId: number;
};
type ProgressModelPreference = { provider: string; id: string };
type FastModelAuth = {
	model: Parameters<typeof complete>[0];
	apiKey: string;
	headers?: Record<string, string>;
};

const STATUS_FILTER_ENTRY_TYPE = "pi-bar-status-filter";
const SETTINGS_PROGRESS_KEY = "progress";
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
const PROGRESS_MAX_TOKENS = 120;
const PROGRESS_REQUEST_TIMEOUT_MS = 2_000;
const PROGRESS_DISPLAY_UPDATE_INTERVAL_MS = 1_200;
const PROGRESS_TARGET_SUMMARY_CHARS = 60;
// Burst debouncing on the generation side: coalesce rapid-fire activities into
// one model call. Quiet window catches short bursts; max wait surfaces progress
// during continuous activity.
// Quiet window long enough to let tool_result land before flushing, so the
// model summarizes the completed outcome instead of guessing from tool_call.
const NORMAL_CHECKPOINT_QUIET_MS = 1_500;
const NORMAL_CHECKPOINT_MAX_WAIT_MS = 2_500;
// Defensive ceiling: even if the model ignores the length instruction, never
// blast a large payload into the footer.
const MAX_SAFE_PROGRESS_CHARS = 240;
const CONFIG_PATH =
	process.env.PI_BAR_CONFIG ?? join(homedir(), ".pi", "agent", "pi-bar.json");

const DEFAULT_SEGMENTS: SegmentName[] = [
	"model",
	"thinking",
	"context",
	"progress",
	"extensions",
];
const ALL_SEGMENTS: readonly SegmentName[] = [
	"model",
	"thinking",
	"context",
	"progress",
	"extensions",
];
const SEGMENT_LABELS: Record<SegmentName, string> = {
	model: "Model",
	thinking: "Thinking level",
	context: "Context usage",
	progress: "Progress update",
	extensions: "Extension statuses",
};
const DEFAULT_WARNING_THRESHOLD = 70;
const DEFAULT_ERROR_THRESHOLD = 90;

const SEGMENT_SEPARATOR = "›";
const EXTENSION_STATUS_SEPARATOR = SEGMENT_SEPARATOR;

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

function formatModelName(model: { id: string; provider?: string } | undefined): string {
	if (!model?.id) return "no-model";
	const provider = model.id.includes("/") ? undefined : model.provider;
	const rawModelId = model.id.includes("/") ? model.id.split(/\/(.+)/, 2)[1] : model.id;
	const modelId = (rawModelId ?? model.id)
		.replace(/-\d{8}$/, "")
		.replace(/-\d{4}-\d{2}-\d{2}$/, "");
	return provider ? `${provider}/${modelId}` : modelId;
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

function formatThinkingLevel(level: string): string {
	switch (level) {
		case "minimal":
		case "min":
			return "mini";
		case "medium":
		case "med":
			return "med";
		default:
			return level;
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

function isSegmentName(value: string): value is SegmentName {
	return (ALL_SEGMENTS as readonly string[]).includes(value);
}

function parseSegments(): SegmentName[] {
	const raw = process.env.PI_BAR_SHOW;
	if (!raw) return DEFAULT_SEGMENTS;

	const requested = raw
		.split(",")
		.map((segment) => segment.trim().toLowerCase())
		.filter(isSegmentName);

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

function parseProgressModelSpec(value: string): ProgressModelPreference | undefined {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "auto") return undefined;
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, separator), id: trimmed.slice(separator + 1) };
}

function settingsModelValue(settings: Record<string, unknown>): string | undefined {
	const bar = settings[SETTINGS_BAR_KEY];
	if (bar && typeof bar === "object" && !Array.isArray(bar)) {
		const value = (bar as Record<string, unknown>).progressModel;
		if (typeof value === "string") return value;
	}

	const progressSection = settings[SETTINGS_PROGRESS_KEY];
	if (progressSection && typeof progressSection === "object" && !Array.isArray(progressSection)) {
		const value = (progressSection as Record<string, unknown>).model;
		if (typeof value === "string") return value;
	}

	return undefined;
}

function resolveProgressModelPreference(cwd: string): ProgressModelPreference | undefined {
	const envModel = process.env.PI_BAR_PROGRESS_MODEL;
	if (envModel) return parseProgressModelSpec(envModel);

	const settings = SettingsManager.create(cwd);
	const projectModel = settingsModelValue(
		settings.getProjectSettings() as Record<string, unknown>,
	);
	if (projectModel !== undefined) return parseProgressModelSpec(projectModel);

	const globalModel = settingsModelValue(
		settings.getGlobalSettings() as Record<string, unknown>,
	);
	return globalModel ? parseProgressModelSpec(globalModel) : undefined;
}

// Fallback order optimizes for low latency + low cost first. The progress
// update path does not need reasoning quality; codex/gpt-5.4-mini is fastest
// in practice.
const FAST_PROGRESS_MODELS: readonly ProgressModelPreference[] = [
	{ provider: "openai-codex", id: "gpt-5.4-mini" },
	{ provider: "openai-codex", id: "gpt-5.3-codex-spark" },
	{ provider: "anthropic", id: "claude-haiku-4-5" },
	{ provider: "anthropic", id: "claude-haiku-4-5-20251001" },
];

function formatProgressModelKey(model: ProgressModelPreference): string {
	return `${model.provider}/${model.id}`;
}

async function getModelAuth(
	ctx: ExtensionContext,
	preference: ProgressModelPreference,
): Promise<FastModelAuth | undefined> {
	const model = ctx.modelRegistry.find(preference.provider, preference.id);
	if (!model) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	return auth.ok && auth.apiKey
		? { model, apiKey: auth.apiKey, headers: auth.headers }
		: undefined;
}

async function getFastProgressModelAuth(
	ctx: ExtensionContext,
	configuredModel?: ProgressModelPreference,
): Promise<FastModelAuth | undefined> {
	if (configuredModel) {
		const configuredAuth = await getModelAuth(ctx, configuredModel);
		if (configuredAuth) return configuredAuth;
	}

	for (const candidate of FAST_PROGRESS_MODELS) {
		if (configuredModel && formatProgressModelKey(candidate) === formatProgressModelKey(configuredModel)) {
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

class ProgressFactCollector {
	private nextIndex = 1;
	private readonly activities: ProgressActivity[] = [];

	resetConversation(): void {
		this.nextIndex = 1;
		this.activities.splice(0);
	}

	recordUserMessage(prompt: string): ProgressActivity {
		return this.addActivity(
			"user_message",
			"immediate",
			`user: ${truncateText(compactText(prompt), MAX_USER_TEXT_CHARS)}`,
		);
	}

	recordAssistantUpdate(message: unknown): ProgressActivity | undefined {
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

	recordToolCall(event: {
		toolName: string;
		input?: Record<string, unknown>;
		toolCallId?: string;
	}): ProgressActivity {
		return this.addActivity(
			"tool_call",
			"normal",
			`tool: ${compactToolInput(event.toolName, event.input)}`,
			event.toolCallId,
		);
	}

	recordToolResult(event: {
		toolName: string;
		input?: Record<string, unknown>;
		isError?: boolean;
		content?: readonly unknown[];
		details?: unknown;
		toolCallId?: string;
	}): ProgressActivity {
		const isError = Boolean(event.isError);
		const resultText = summarizeToolResult(
			event.toolName,
			event.input,
			extractTextContent(event.content),
			isError,
		);
		const status = isError ? "error" : "ok";
		const tool = compactToolInput(event.toolName, event.input);

		// Result fact subsumes the prior tool_call fact for the same call. Drop the
		// matching tool_call so the model sees one combined fact instead of two.
		if (event.toolCallId) {
			const idx = this.activities.findIndex(
				(activity) =>
					activity.activityType === "tool_call" &&
					activity.toolCallId === event.toolCallId,
			);
			if (idx !== -1) this.activities.splice(idx, 1);
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

	recordMessageEnd(message: unknown): ProgressActivity | "emptyFinalStop" | "ignored" {
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

	activitiesAfter(previousIndex: number, throughIndex: number): readonly ProgressActivity[] {
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
		activityType: ProgressActivityType,
		displayPriority: ProgressDisplayPriority,
		text: string,
		toolCallId?: string,
	): ProgressActivity {
		const activity = {
			index: this.nextIndex,
			activityType,
			displayPriority,
			text: truncateText(text, MAX_ACTIVITY_TEXT_CHARS),
			toolCallId,
		};
		this.nextIndex++;
		this.activities.push(activity);
		if (this.activities.length > MAX_RETAINED_RAW_ACTIVITIES) {
			this.activities.splice(0, this.activities.length - MAX_RETAINED_RAW_ACTIVITIES);
		}
		return activity;
	}
}

class FooterProgressEngine {
	private readonly facts = new ProgressFactCollector();
	private configuredModel?: ProgressModelPreference;
	private runId = 0;
	private latestAcceptedActivityIndex = 0;
	private lastRenderedActivityIndex = 0;
	private lastRenderedText = "";
	private lastDisplayAt = Number.NEGATIVE_INFINITY;
	private readonly acceptedCheckpoints: ProgressCheckpoint[] = [];
	private checkpointQueue: ProgressCheckpointJob[] = [];
	private inFlightCheckpoint?: ProgressCheckpointJob;
	private pendingDisplayCheckpoint?: ProgressCheckpoint;
	private displayTimer?: ReturnType<typeof setTimeout>;
	private abortController?: AbortController;
	private currentText: string | null = null;
	// Normal-priority bursts wait for a quiet window before triggering a model
	// call. Pi often emits many rapid activities (e.g. streaming reads); without
	// debouncing we would hammer the progress update model for intermediate states.
	private pendingNormalCheckpoint?: ProgressCheckpointJob;
	private normalCheckpointTimer?: ReturnType<typeof setTimeout>;
	private normalCheckpointBurstStartedAt?: number;

	constructor(private readonly requestRender: () => void) {}

	text(): string | null {
		return this.currentText;
	}

	startSession(cwd: string): void {
		this.configuredModel = resolveProgressModelPreference(cwd);
		this.facts.resetConversation();
		this.startFreshRun();
	}

	shutdown(): void {
		this.facts.resetConversation();
		this.startFreshRun();
	}

	recordUserMessage(ctx: ExtensionContext, prompt: string): void {
		// A new user turn replaces the entire visible progress update context, so wipe both
		// the rendered text and the prior-turn checkpoint context that feeds the
		// model. Carrying old checkpoints biased the next turn's phrasing toward
		// the previous task.
		this.currentText = null;
		this.lastRenderedText = "";
		this.acceptedCheckpoints.splice(0);
		this.latestAcceptedActivityIndex = 0;
		this.requestRender();
		this.enqueue(ctx, this.facts.recordUserMessage(prompt));
	}

	recordAssistantUpdate(ctx: ExtensionContext, message: unknown): void {
		const activity = this.facts.recordAssistantUpdate(message);
		if (activity) this.enqueue(ctx, activity);
	}

	recordToolCall(
		_ctx: ExtensionContext,
		event: { toolName: string; input?: Record<string, unknown>; toolCallId?: string },
	): void {
		// Record the fact so a subsequent checkpoint sees the tool was started,
		// but DO NOT enqueue. tool_call alone has no outcome; flushing here
		// before tool_result arrives makes the model hallucinate "completed
		// successfully". The tool_result event triggers the actual checkpoint.
		this.facts.recordToolCall(event);
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

		// Failure/aborted finals have no narratable content. A model call here
		// fabricates a reason; render a deterministic literal instead.
		if (result.activityType === "assistant_failure") {
			const stopReason = extractStopReason(message);
			this.renderLiteralFinal(stopReason);
			this.facts.resetConversation();
			this.startFreshRun();
			return;
		}

		this.enqueue(ctx, result);
	}

	private renderLiteralFinal(stopReason: string | undefined): void {
		this.clearPendingDisplay();
		this.clearPendingNormalCheckpoint();
		this.checkpointQueue.splice(0);
		this.abortInFlightCheckpoint();
		const literal = stopReason === "aborted" ? "Aborted." : `Stopped: ${stopReason ?? "error"}.`;
		this.currentText = literal;
		this.lastRenderedText = literal;
		this.lastRenderedActivityIndex = this.facts.latestActivityIndex();
		this.lastDisplayAt = performance.now();
		this.requestRender();
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
		job: ProgressCheckpointJob,
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

	private enqueue(ctx: ExtensionContext, activity: ProgressActivity): void {
		if (!ctx.hasUI) return;
		const job = {
			activityIndex: activity.index,
			displayPriority: activity.displayPriority,
			runId: this.runId,
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

	private clearPendingDisplay(): void {
		if (this.displayTimer) clearTimeout(this.displayTimer);
		this.displayTimer = undefined;
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

	private isCurrentJob(job: ProgressCheckpointJob): boolean {
		return job.runId === this.runId && this.inFlightCheckpoint === job;
	}

	private async runCheckpointRequest(
		ctx: ExtensionContext,
		job: ProgressCheckpointJob,
	): Promise<void> {
		let abortController: AbortController | undefined;
		try {
			const prompt = this.checkpointPrompt(job);
			if (!prompt) return;
			const auth = await getFastProgressModelAuth(ctx, this.configuredModel);
			if (!this.isCurrentJob(job) || !auth) return;

			abortController = new AbortController();
			this.abortController = abortController;
			const response = await complete(
				auth.model,
				{ systemPrompt: checkpointSystemPrompt(job), messages: [prompt] },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: PROGRESS_MAX_TOKENS,
					maxRetries: 0,
					cacheRetention: "none",
					timeoutMs: PROGRESS_REQUEST_TIMEOUT_MS,
					signal: abortController.signal,
				},
			);
			if (!this.isCurrentJob(job) || response.stopReason !== "stop") return;

			const rawText = extractTextContent(response.content) ?? "";
			const text = sanitizeProgressText(rawText);
			if (!text) return;
			const checkpoint = {
				activityIndex: job.activityIndex,
				displayPriority: job.displayPriority,
				text,
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

	private acceptCheckpoint(checkpoint: ProgressCheckpoint): void {
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
		checkpoint: ProgressCheckpoint,
	): void {
		if (checkpoint.activityIndex <= this.lastRenderedActivityIndex) return;
		if (checkpoint.activityIndex !== this.facts.latestActivityIndex()) return;

		if (checkpoint.displayPriority !== "normal" || !this.lastRenderedText) {
			this.clearPendingDisplay();
			this.renderCheckpoint(checkpoint);
			return;
		}

		const elapsedMs = performance.now() - this.lastDisplayAt;
		if (elapsedMs >= PROGRESS_DISPLAY_UPDATE_INTERVAL_MS) {
			this.clearPendingDisplay();
			this.renderCheckpoint(checkpoint);
			return;
		}

		this.pendingDisplayCheckpoint = checkpoint;
		if (this.displayTimer) return;
		this.displayTimer = setTimeout(() => {
			this.displayTimer = undefined;
			const pending = this.pendingDisplayCheckpoint;
			this.pendingDisplayCheckpoint = undefined;
			if (!pending || pending.activityIndex !== this.facts.latestActivityIndex()) return;
			this.renderCheckpoint(pending);
		}, PROGRESS_DISPLAY_UPDATE_INTERVAL_MS - elapsedMs);
	}

	private renderCheckpoint(checkpoint: ProgressCheckpoint): void {
		if (checkpoint.activityIndex <= this.lastRenderedActivityIndex) return;
		if (checkpoint.text === this.lastRenderedText) return;
		// Skip near-duplicates: a burst of consecutive checkpoints often produces
		// the same action fragment with only punctuation/casing differences. They
		// flash visibly in the footer without adding information.
		if (isNearDuplicateProgress(checkpoint.text, this.lastRenderedText)) {
			this.lastRenderedActivityIndex = checkpoint.activityIndex;
			return;
		}
		this.lastRenderedActivityIndex = checkpoint.activityIndex;
		this.lastRenderedText = checkpoint.text;
		this.lastDisplayAt = performance.now();
		this.currentText = checkpoint.text;
		this.requestRender();
	}

	private checkpointPrompt(job: ProgressCheckpointJob): UserMessage | undefined {
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
						"Prior progress updates (context only, do not copy phrasing):",
						previousCheckpointLines(this.acceptedCheckpoints),
						"",
						"New activity to summarize:",
						...rawActivities.map(formatRawActivity),
						"",
						"Write the next progress update.",
					].join("\n"),
				},
			],
			timestamp: Date.now(),
		};
	}
}

// First-word allow/ban lists are duplicated between the prompt and the
// sanitizer fallback. They live here so both stay aligned automatically when
// new verbs get added or moved.
const ALLOWED_FIRST_WORDS_PROGRESSIVE = [
	"Reviewing",
	"Investigating",
	"Exploring",
	"Updating",
	"Refining",
	"Fixing",
	"Implementing",
	"Wrapping up",
	"Bumping",
	"Releasing",
	"Preparing",
	"Drafting",
	"Resuming",
	"Pulling",
	"Surveying",
	"Recording",
] as const;
const ALLOWED_FIRST_WORDS_PAST = [
	"Reviewed",
	"Investigated",
	"Explored",
	"Updated",
	"Refined",
	"Fixed",
	"Implemented",
	"Wrapped up",
	"Bumped",
	"Released",
	"Prepared",
	"Drafted",
	"Resumed",
	"Pulled",
	"Surveyed",
	"Recorded",
] as const;
const BANNED_FIRST_WORDS = [
	"Read",
	"Reading",
	"Grep",
	"Grepping",
	"Listing",
	"List",
	"Counting",
	"Counted",
	"Extracting",
	"Extracted",
	"Displaying",
	"Displayed",
	"Editing",
	"Edited",
	"Writing",
	"Wrote",
	"Running",
	"Ran",
	"Publishing",
	"Published",
	"Capturing",
	"Captured",
	"Verifying",
	"Verified",
	"Verify",
	"Validating",
	"Validated",
	"Validate",
	"Checking",
	"Checked",
	"Check",
	"Confirming",
	"Confirmed",
	"Confirm",
	"Searching",
	"Searched",
	"Search",
	"Finding",
	"Found",
	"Find",
] as const;

function checkpointSystemPrompt(job: ProgressCheckpointJob): string {
	// Tense + exemplars vary by priority. Final progress updates describe
	// completed turns; using -ing examples for final caused all of them to slip
	// back into present-progressive even though the literal instruction said
	// past tense.
	// Immediate progress updates cover a brand-new user request; they need a rephrase
	// directive instead of generic filler like "Continuing with task".
	let tenseInstruction: string;
	let goodExamples: string;
	let allowedFirstWords: readonly string[];
	if (job.displayPriority === "final") {
		tenseInstruction = "Start with a past-tense verb describing what was completed.";
		goodExamples = [
			"- Updated footer summary behavior",
			"- Investigated live progress regressions",
			"- Refined sanitizer for stray prefixes",
			"- Wrapped up extension release",
		].join("\n");
		allowedFirstWords = ALLOWED_FIRST_WORDS_PAST;
	} else if (job.displayPriority === "immediate") {
		tenseInstruction =
			"Rephrase the user's new request as a concise present-progressive task clause. If the request is opaque (e.g. \"continue\", \"go\", \"ok\"), name the carry-over task with a noun (e.g. \"Resuming refactor work\"), not generic filler.";
		goodExamples = [
			"- Reviewing footer summary behavior",
			"- Investigating live progress regressions",
			"- Refining sanitizer for stray prefixes",
			"- Preparing extension release",
			"- Resuming refactor work",
		].join("\n");
		allowedFirstWords = ALLOWED_FIRST_WORDS_PROGRESSIVE;
	} else {
		tenseInstruction = "Start with a present-tense -ing verb describing current work.";
		goodExamples = [
			"- Reviewing footer summary behavior",
			"- Investigating live progress regressions",
			"- Refining sanitizer for stray prefixes",
			"- Wrapping up extension release",
		].join("\n");
		allowedFirstWords = ALLOWED_FIRST_WORDS_PROGRESSIVE;
	}

	// Frame the model as a human developer describing visible work, not an agent
	// summarizing its own mechanics. The banned phrases and few-shot examples
	// fix concrete regressions observed in backtests: tool-name verbs, success
	// suffixes, file path leaks, and markdown formatting. The HARD CONSTRAINTS
	// block sits at the tail of the prompt because instruction-following models
	// give the most weight to the most-recent directives (recency bias).
	return `Write one plain-English progress update for a Pi coding agent.
Describe the work progress as if a human developer were doing it.
Focus on the task activity and current outcome, not agent mechanics.
Do not mention tools, tool calls, prompts, messages, model output, or implementation details.
Use human-developer verbs instead of tool-narration verbs.
Do not use file paths, file extensions, code identifiers, package names, or version strings.
Do not use backticks, asterisks, underscores, quotes, or any markdown formatting.
Do not append filler suffixes such as "with success", "successfully", or "completed successfully".
Do not claim progress or completion that is not present in the activity.
Use the prior progress updates for context and the new activity for the update.
Summarize the current state of work; do not narrate the history.
If context is sparse, still summarize the available activity.
Never ask for more information or say there is not enough context.
Return one concise status fragment under ${PROGRESS_TARGET_SUMMARY_CHARS} characters.
Omit subjects like "the agent" or "it".
Prefer verb + direct object. Include outcome only if important.
Do not address the user.
Output only the status fragment itself. No prefixes, labels, bullets, or quotes.
Plain text only; no markdown, JSON, code, file paths, or tool names.

Good examples:
${goodExamples}

Bad examples:
- Editing extensions/status-footer.ts with success.
- Reading status-footer file completed successfully.
- Publishing \`pi-bar@0.3.3\` to npm.
- Grepping for sanitizeProgressText callers.
- Verifying repository status after commit.
- Investigating user input responses.

HARD CONSTRAINTS (apply last; override anything above that conflicts):
- First word MUST be one of: ${allowedFirstWords.join(", ")}.
- First word MUST NOT be: ${BANNED_FIRST_WORDS.join(", ")}.
- ${tenseInstruction}`;
}

function extractStopReason(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as Record<string, unknown>;
	const stopReason = record.stopReason;
	return typeof stopReason === "string" ? stopReason : undefined;
}

// Two progress updates are near-duplicates if their normalized action fragments (lowercase,
// punctuation/whitespace collapsed) match. Catches bursts of cosmetic variants
// like "Editing X." vs "Editing X" vs "editing  x.".
function normalizedActionFragment(text: string): string {
	return text
		.toLowerCase()
		.replace(/[\p{P}\p{S}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function isNearDuplicateProgress(current: string, previous: string): boolean {
	if (!previous) return false;
	return normalizedActionFragment(current) === normalizedActionFragment(previous);
}

function previousCheckpointLines(checkpoints: readonly ProgressCheckpoint[]): string {
	if (checkpoints.length === 0) return "none";
	return checkpoints
		.slice(-MAX_CONTEXT_CHECKPOINTS)
		.map((checkpoint) => `- ${sanitizeProgressText(checkpoint.text)}`)
		.join("\n");
}

function formatRawActivity(activity: ProgressActivity): string {
	return `- ${activity.text}`;
}

// Strips ANSI/CSI/OSC/DCS/SOS/PM/APC escape sequences from model output before
// it lands in the terminal. The progress update text is model-controlled and renders into
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
	/^\s*(?:[-*•]\s*)?(?:(?:through\s+activity|activity|checkpoint)\s+\d+\s*[:.\-—–]\s*|(?:tldr|summary|progress\s+update|progress)\s*[:.\-—–]\s*)+/i;
const LEADING_PUNCT_PATTERN = /^[\s\-—–•*:#.,;]+/;
const TRAILING_PUNCT_PATTERN = /[\s\-—–•*:#.,;]+$/;

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

// Strip backticks (` and triple-backtick fences) and markdown emphasis markers
// the model occasionally adds despite the prompt's plain-text rule. We keep
// inner content verbatim; only the formatting characters disappear.
function stripMarkdownFormatting(text: string): string {
	return text
		.replace(/```+/g, "")
		.replace(/`+/g, "")
		.replace(/(^|[^\\])([*_~]{1,3})(.+?)\2/g, "$1$3");
}

// File-path / version / package leaks observed in backtests:
//   extensions/status-footer.ts, README.md, package.json, pi-bar@0.3.3, …
const FILE_PATH_PATTERN =
	/(?:\b[\w./@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|json|yml|yaml|toml|lock|sh|py|rs|go|html|css))\b/g;
const PACKAGE_VERSION_PATTERN = /\b[\w./@-]+@\d[\w.+-]*\b/g;
const VERSION_PATTERN = /\bv?\d+\.\d+(?:\.\d+(?:[-+][\w.]+)?)?\b/g;

function stripIdentifierLeaks(text: string): string {
	return text
		.replace(PACKAGE_VERSION_PATTERN, "")
		.replace(FILE_PATH_PATTERN, "")
		.replace(VERSION_PATTERN, "")
		.replace(/\s+/g, " ")
		.trim();
}

// After identifier removal the sentence often has a dangling preposition like
// "Bumping version to for publishing" (was "to 0.3.2 for publishing") or a
// trailing "to"/"version". Run in a fix-point loop so chained leftovers (e.g.
// "to version") collapse cleanly.
const DANGLING_TRAILING_PREP_PATTERN =
	/\s+(?:to|at|as|of|by|for|in|on|with|from|version|v)\s*[.!?,;:]?\s*$/i;
const DANGLING_PREP_CHAIN_PATTERN =
	/\b(to|at|as|of|by|from|version|v)\s+(for|in|on|with|from|after|before|during|to|at|as|of|by|and|but|or)\b/gi;
// File-path / identifier strip can leave a verb directly followed by a
// preposition: "Reviewing README for image update" -> after path strip ->
// "Reviewing for image update". Collapse the bare verb+prep into just the verb.
const VERB_BARE_PREP_PATTERN =
	/\b(Reviewing|Investigating|Updating|Refining|Exploring|Fixing|Implementing|Bumping|Releasing|Preparing|Drafting|Resuming|Pulling|Surveying|Recording)\s+(?:for|in|on|with|after|before|to|at|as|of|by|from)\s+/gi;
// Identifier strip removes version numbers like "0.3.4" but can leave stranded
// release adjectives behind: "Released latest of package" was "Released latest
// 0.3.4 of package"; "Released new with X" was "Released new 0.3.4 with X".
// The chain pattern keeps the noun phrase that followed the version. The
// trailing pattern handles bare "... new" or "... latest" tails.
const RELEASE_FRAGMENT_CHAIN_PATTERN =
	/\b(Released|Releasing|Bumped|Bumping|Published|Publishing|Updated|Updating|Shipped|Shipping)\s+(?:new|latest|version|update)\s+(?:of|with|to|and|in|on|for)\s+/gi;
const RELEASE_FRAGMENT_TRAILING_PATTERN =
	/\s+(?:new|latest|version|update)\s*(?:of|with|to|and|in|on)?\s*[.!?,;:]?\s*$/i;

function stripDanglingPrepositions(text: string): string {
	let cleaned = text;
	let previous: string;
	do {
		previous = cleaned;
		cleaned = cleaned.replace(VERB_BARE_PREP_PATTERN, "$1 ");
		cleaned = cleaned.replace(RELEASE_FRAGMENT_CHAIN_PATTERN, "$1 ");
		cleaned = cleaned.replace(DANGLING_PREP_CHAIN_PATTERN, "$2");
		cleaned = cleaned.replace(RELEASE_FRAGMENT_TRAILING_PATTERN, "").trim();
		cleaned = cleaned.replace(DANGLING_TRAILING_PREP_PATTERN, "").trim();
	} while (cleaned !== previous && cleaned.length > 0);
	return cleaned;
}

// Last-resort fallback when the model ignored the allow-list and started the
// progress update with a banned tool-narration verb. The map preserves tense (present
// vs past). Case of the first letter follows the original word.
const BANNED_FIRST_WORD_REWRITES: Record<string, string> = {
	Reading: "Reviewing",
	Read: "Reviewed",
	Grepping: "Investigating",
	Grep: "Investigated",
	Listing: "Reviewing",
	List: "Reviewed",
	Counting: "Surveying",
	Counted: "Surveyed",
	Extracting: "Pulling",
	Extracted: "Pulled",
	Displaying: "Reviewing",
	Displayed: "Reviewed",
	Editing: "Updating",
	Edited: "Updated",
	Writing: "Drafting",
	Wrote: "Drafted",
	Running: "Working on",
	Ran: "Worked on",
	Publishing: "Releasing",
	Published: "Released",
	Capturing: "Recording",
	Captured: "Recorded",
	Verifying: "Reviewing",
	Verified: "Reviewed",
	Verify: "Review",
	Validating: "Reviewing",
	Validated: "Reviewed",
	Validate: "Review",
	Checking: "Reviewing",
	Checked: "Reviewed",
	Check: "Review",
	Confirming: "Reviewing",
	Confirmed: "Reviewed",
	Confirm: "Review",
	Searching: "Investigating",
	Searched: "Investigated",
	Search: "Investigate",
	Finding: "Investigating",
	Found: "Investigated",
	Find: "Investigate",
};
const BANNED_FIRST_WORD_PATTERN = new RegExp(
	`^(${Object.keys(BANNED_FIRST_WORD_REWRITES).join("|")})\\b`,
);

function rewriteBannedFirstWord(text: string): string {
	const match = BANNED_FIRST_WORD_PATTERN.exec(text);
	if (!match) return text;
	const original = match[1];
	const replacement = BANNED_FIRST_WORD_REWRITES[original];
	if (!replacement) return text;
	// Preserve lowercase-start outputs (rare but possible) by matching original case.
	const cased =
		original[0] === original[0].toLowerCase()
			? replacement[0].toLowerCase() + replacement.slice(1)
			: replacement;
	return cased + text.slice(original.length);
}

// Trailing filler suffixes observed in backtests:
//   "... with success.", "... completed successfully.", "... successfully."
const SUCCESS_SUFFIX_PATTERN =
	/[\s,;:—–-]*(?:with\s+success|completed\s+successfully|finished\s+successfully|done\s+successfully|successfully\s+completed|successfully\s+finished|successfully)\s*[.!?]*\s*$/i;

function stripSuccessSuffix(text: string): string {
	let cleaned = text;
	let stripped = false;
	while (true) {
		const next = cleaned.replace(SUCCESS_SUFFIX_PATTERN, "").trim();
		if (next === cleaned || next.length === 0) break;
		cleaned = next;
		stripped = true;
	}
	// Only clean up trailing punctuation when an actual success suffix was
	// removed; otherwise we would strip the natural period from a normal
	// sentence like "Reviewing footer behavior.".
	if (stripped) cleaned = cleaned.replace(TRAILING_PUNCT_PATTERN, "").trim();
	return cleaned;
}

function sanitizeProgressText(
	text: string,
	maxChars = MAX_SAFE_PROGRESS_CHARS,
): string {
	const stripped = stripTerminalControls(text);
	const withoutMarkdown = stripMarkdownFormatting(stripped);
	const withoutScaffolding = stripLeakedScaffolding(withoutMarkdown) || withoutMarkdown;
	const withoutLeaks = stripIdentifierLeaks(withoutScaffolding) || withoutScaffolding;
	const withoutDangling = stripDanglingPrepositions(withoutLeaks) || withoutLeaks;
	const withoutSuccess = stripSuccessSuffix(withoutDangling) || withoutDangling;
	const rewritten = rewriteBannedFirstWord(withoutSuccess);
	return truncateText(rewritten, maxChars);
}

function shouldShowStatus(key: string, filter: StatusFilter): boolean {
	if (filter.mode === "only") return filter.shown.has(key);
	return !filter.hidden.has(key);
}

function formatExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
	filter: StatusFilter,
	seenStatusKeys: Set<string>,
	hideLabels?: boolean,
): string[] | null {
	const parts = Array.from(statuses.entries())
		.filter(([, text]) => stripTerminalControls(text).trim().length > 0)
		.filter(([key]) => {
			seenStatusKeys.add(key);
			return shouldShowStatus(key, filter);
		})
		.map(([key, text]) => (hideLabels ? text : `${stripTerminalControls(key)}:${text}`));

	return parts.length > 0 ? parts : null;
}

function serializeStatusFilter(filter: StatusFilter): SerializedStatusFilter {
	if (filter.mode === "only") {
		return { mode: "only", shown: Array.from(filter.shown).sort() };
	}
	return { mode: "all", hidden: Array.from(filter.hidden).sort() };
}

function serializeSegments(segments: readonly SegmentName[]): SegmentName[] {
	return ALL_SEGMENTS.filter((segment) => segments.includes(segment));
}

function parseSerializedSegments(value: unknown): SegmentName[] | null {
	if (!Array.isArray(value)) return null;
	const segments = value.filter(
		(segment): segment is SegmentName => typeof segment === "string" && isSegmentName(segment),
	);
	return serializeSegments(segments);
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

function splitSegmentNames(raw: string): SegmentName[] {
	return raw
		.split(/[\s,]+/)
		.map((segment) => segment.trim().toLowerCase())
		.filter(isSegmentName);
}

function describeSegments(segments: readonly SegmentName[]): string {
	if (segments.length === 0) return "showing none";
	return `showing: ${segments.map((segment) => SEGMENT_LABELS[segment]).join(", ")}`;
}

function describeStatusFilter(filter: StatusFilter): string {
	if (filter.mode === "only") {
		const shown = Array.from(filter.shown).sort();
		return shown.length > 0 ? `showing only: ${shown.join(", ")}` : "showing none";
	}

	const hidden = Array.from(filter.hidden).sort();
	return hidden.length > 0 ? `showing all except: ${hidden.join(", ")}` : "showing all";
}

function readGlobalConfig(): GlobalBarConfig {
	try {
		const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
		const statusFilter = parseSerializedStatusFilter(data.statusFilter ?? data);
		return {
			statusFilter: statusFilter ? serializeStatusFilter(statusFilter) : undefined,
			segments: parseSerializedSegments(data.segments) ?? undefined,
			hideStatusLabels: typeof data.hideStatusLabels === "boolean" ? data.hideStatusLabels : undefined,
		};
	} catch {
		return {};
	}
}

function readGlobalStatusFilter(): StatusFilter | null {
	return parseSerializedStatusFilter(readGlobalConfig().statusFilter);
}

function readGlobalSegments(): SegmentName[] | null {
	return process.env.PI_BAR_SHOW ? parseSegments() : readGlobalConfig().segments ?? null;
}

function writeGlobalConfig(config: GlobalBarConfig): void {
	const data = JSON.stringify(config, null, 2);
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`;
	writeFileSync(tmpPath, `${data}\n`, "utf8");
	renameSync(tmpPath, CONFIG_PATH);
}

function writeGlobalStatusFilter(filter: StatusFilter): void {
	const existing = readGlobalConfig();
	writeGlobalConfig({ ...existing, statusFilter: serializeStatusFilter(filter) });
}

function writeGlobalSegments(segments: readonly SegmentName[]): void {
	const existing = readGlobalConfig();
	writeGlobalConfig({ ...existing, segments: serializeSegments(segments) });
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
	let visibleSegments: SegmentName[] = readGlobalSegments() ?? DEFAULT_SEGMENTS;
	let hideLabels = readGlobalConfig().hideStatusLabels ?? false;
	const seenStatusKeys = new Set<string>();
	const refresh = () => requestRender?.();
	const progress = new FooterProgressEngine(refresh);
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
	const persistHideLabels = (value: boolean) => {
		hideLabels = value;
		const existing = readGlobalConfig();
		writeGlobalConfig({ ...existing, hideStatusLabels: value });
		refresh();
	};
	const setVisibleSegments = (segments: readonly SegmentName[], ctx?: ExtensionContext) => {
		const previousProgressVisible = visibleSegments.includes("progress");
		visibleSegments = serializeSegments(segments);
		writeGlobalSegments(visibleSegments);
		const nextProgressVisible = visibleSegments.includes("progress");
		if (previousProgressVisible && !nextProgressVisible) progress.shutdown();
		if (!previousProgressVisible && nextProgressVisible && ctx) progress.startSession(ctx.cwd);
		refresh();
	};
	const openSegmentConfigurator = async (ctx: ExtensionContext) => {
		await ctx.ui.custom((tui, theme, _kb, done) => {
			const knownStatusKeys = getKnownStatusKeys(statusFilter, seenStatusKeys);
			const segmentVisibility = new Map(
				ALL_SEGMENTS.map(
					(segment): [SegmentName, boolean] => [segment, visibleSegments.includes(segment)],
				),
			);
			let futureShown = statusFilter.mode === "all";
			const statusVisibility = new Map(
				knownStatusKeys.map((key): [string, boolean] => [
					key,
					shouldShowStatus(key, statusFilter),
				]),
			);
			const persistSegmentsFromVisibility = () => {
				setVisibleSegments(
					ALL_SEGMENTS.filter((segment) => segmentVisibility.get(segment)),
					ctx,
				);
			};
			const persistStatusesFromVisibility = () => {
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

			const segmentItems: SettingItem[] = ALL_SEGMENTS.map((segment): SettingItem => ({
				id: `segment:${segment}`,
				label: SEGMENT_LABELS[segment],
				description: "Footer segment visibility",
				currentValue: segmentVisibility.get(segment) ? "shown" : "hidden",
				values: ["shown", "hidden"],
			}));
			const statusItems: SettingItem[] = knownStatusKeys.length > 0
				? [
					{
						id: "status:__future",
						label: "New extension statuses",
						description: "Default visibility for status keys discovered later",
						currentValue: futureShown ? "shown" : "hidden",
						values: ["shown", "hidden"],
					},
					...knownStatusKeys.map((key): SettingItem => ({
						id: `status:${key}`,
						label: `Status: ${key}`,
						description: "Extension status visibility",
						currentValue: statusVisibility.get(key) ? "shown" : "hidden",
						values: ["shown", "hidden"],
					})),
				]
				: [];
			const items: SettingItem[] = [...segmentItems, ...statusItems];

			const container = new Container();
			container.addChild(
				new (class {
					render(_width: number) {
						return [
							theme.fg("accent", theme.bold("pi-bar visibility")),
							theme.fg(
								"dim",
								knownStatusKeys.length > 0
									? "Footer segments + extension statuses · Enter/Space toggles · Esc closes"
									: "Footer segments · no extension statuses seen yet · Esc closes",
							),
							"",
						];
					}
					invalidate() {}
				})(),
			);

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 18),
				getSettingsListTheme(),
				(id, newValue) => {
					if (id.startsWith("segment:")) {
						const segment = id.slice("segment:".length);
						if (!isSegmentName(segment)) return;
						segmentVisibility.set(segment, newValue === "shown");
						persistSegmentsFromVisibility();
						return;
					}

					if (id === "status:__future") {
						futureShown = newValue === "shown";
						persistStatusesFromVisibility();
						return;
					}

					if (id.startsWith("status:")) {
						statusVisibility.set(id.slice("status:".length), newValue === "shown");
						persistStatusesFromVisibility();
					}
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
		description: "Configure pi-bar footer visibility",
		handler: async (args, ctx) => {
			const [section, action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (!section || section === "config" || section === "configure" || section === "edit") {
				await openSegmentConfigurator(ctx);
				return;
			}
			if (section === "list" || section === "ls") {
				ctx.ui.notify(`pi-bar footer: ${describeSegments(visibleSegments)}`, "info");
				return;
			}

			if (section === "segment" || section === "segments" || section === "footer") {
				const segments = splitSegmentNames(rest.join(" "));
				if ((action === "only" || action === "show" || action === "hide") && segments.length === 0) {
					ctx.ui.notify(
						`Segments: ${ALL_SEGMENTS.join(", ")}`,
						"warning",
					);
					return;
				}

				switch (action) {
					case undefined:
					case "config":
					case "configure":
					case "edit":
						await openSegmentConfigurator(ctx);
						return;
					case "list":
					case "ls":
						ctx.ui.notify(`pi-bar footer: ${describeSegments(visibleSegments)}`, "info");
						return;
					case "all":
						setVisibleSegments(ALL_SEGMENTS, ctx);
						break;
					case "none":
						setVisibleSegments([], ctx);
						break;
					case "only":
						setVisibleSegments(segments, ctx);
						break;
					case "hide":
						setVisibleSegments(
							visibleSegments.filter((segment) => !segments.includes(segment)),
							ctx,
						);
						break;
					case "show":
						setVisibleSegments([...visibleSegments, ...segments], ctx);
						break;
					default:
						ctx.ui.notify(
							"Usage: /bar [config] or /bar segments [list|all|none|only <segments>|show <segments>|hide <segments>]",
							"warning",
						);
						return;
				}

				ctx.ui.notify(`pi-bar footer: ${describeSegments(visibleSegments)}`, "info");
				return;
			}

			if ((section === "status" || section === "statuses") && !action) {
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
					case "labels": {
						const setting = keys[0];
						if (setting === "show" || setting === "on") {
							persistHideLabels(false);
							ctx.ui.notify("pi-bar: status labels shown", "info");
						} else if (setting === "hide" || setting === "off") {
							persistHideLabels(true);
							ctx.ui.notify("pi-bar: status labels hidden", "info");
						} else {
							persistHideLabels(!hideLabels);
							ctx.ui.notify(`pi-bar: status labels ${hideLabels ? "shown" : "hidden"}`, "info");
						}
						return;
					}
					default:
						ctx.ui.notify(
							"Usage: /bar status [list|all|none|only <keys>|show <keys>|hide <keys>|labels [show|hide]]",
							"warning",
						);
						return;
				}

				persistStatusFilter();
				ctx.ui.notify(`pi-bar statuses: ${describeStatusFilter(statusFilter)}`, "info");
				return;
			}

			ctx.ui.notify(
				"Usage: /bar [config] or /bar segments [list|all|none|only <segments>|show <segments>|hide <segments>] or /bar status [list|all|none|only <keys>|show <keys>|hide <keys>|labels [show|hide]]",
				"warning",
			);
		},
	});

	pi.on("model_select", async () => refresh());
	pi.on("thinking_level_select", async () => refresh());
	pi.on("turn_end", async () => refresh());
	pi.on("before_agent_start", async (event, ctx) => {
		if (visibleSegments.includes("progress")) progress.recordUserMessage(ctx, event.prompt);
	});
	pi.on("message_update", async (event, ctx) => {
		if (visibleSegments.includes("progress")) progress.recordAssistantUpdate(ctx, event.message);
	});
	pi.on("tool_call", async (event, ctx) => {
		if (visibleSegments.includes("progress")) progress.recordToolCall(ctx, event);
	});
	pi.on("tool_result", async (event, ctx) => {
		if (visibleSegments.includes("progress")) progress.recordToolResult(ctx, event);
	});
	pi.on("message_end", async (event, ctx) => {
		if (visibleSegments.includes("progress")) progress.recordMessageEnd(ctx, event.message);
		refresh();
	});
	pi.on("session_before_tree", async () => {
		progress.shutdown();
	});
	const restoreHideLabels = () => {
		hideLabels = readGlobalConfig().hideStatusLabels ?? false;
	};

	pi.on("session_tree", async (_event, ctx) => {
		if (visibleSegments.includes("progress")) progress.startSession(ctx.cwd);
		else progress.shutdown();
		restoreStatusFilter(ctx);
		restoreHideLabels();
		refresh();
	});

	pi.on("session_start", async (_event, ctx) => {
		visibleSegments = readGlobalSegments() ?? DEFAULT_SEGMENTS;
		if (visibleSegments.includes("progress")) progress.startSession(ctx.cwd);
		else progress.shutdown();
		restoreStatusFilter(ctx);
		restoreHideLabels();

		if (!ctx.hasUI) return;

		const { warningThreshold, errorThreshold } = parseThresholds();

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			return {
				dispose() {
					requestRender = undefined;
				},
				invalidate() {},
					render(width: number): string[] {
						const modelName = formatModelName(ctx.model);
						const thinkingLevel = String(pi.getThinkingLevel());
						const thinkingLabel = formatThinkingLevel(thinkingLevel);
						const extensionStatusParts = formatExtensionStatuses(
							footerData?.getExtensionStatuses?.() ?? new Map(),
							statusFilter,
						seenStatusKeys,
						hideLabels,
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
					const progressText = progress.text();
					const showModel = visibleSegments.includes("model");
					const showThinking = visibleSegments.includes("thinking");

					const extensionStatuses = extensionStatusParts
						? extensionStatusParts
							.join(` ${theme.fg("dim", EXTENSION_STATUS_SEPARATOR)} `)
						: null;
					const segmentRenderers: Record<SegmentName, string | null> = {
						model: showModel
							? theme.fg("accent", showThinking ? `${modelName}:${thinkingLabel}` : modelName)
							: null,
						thinking: showThinking && !showModel
							? theme.fg(thinkingColor(thinkingLevel), `think:${thinkingLabel}`)
							: null,
						context: theme.fg(contextSegmentColor, contextText),
						progress: progressText ? theme.fg("text", progressText) : null,
						extensions: extensionStatuses,
					};

					const separator = ` ${theme.fg("dim", SEGMENT_SEPARATOR)} `;
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
		progress.shutdown();
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
	});
}
