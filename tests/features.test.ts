import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { after, beforeEach, test } from "node:test";
import { createAssistantMessageEventStream, registerApiProvider, unregisterApiProviders, type Model } from "@earendil-works/pi-ai";
import { initTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type Component } from "@earendil-works/pi-tui";
import { PROGRESS_USAGE_ENTRY_TYPE } from "../extensions/usage.ts";
import { assistant, makeUsage, messageEntry, summaryEntry } from "./fixtures.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-bar-features-test-"));
const config = join(directory, "config.json");
const envKeys = ["PI_BAR_CONFIG", "PI_BAR_SHOW", "PI_BAR_PROGRESS_MODEL"];
const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
process.env.PI_BAR_CONFIG = config;
process.env.PI_BAR_PROGRESS_MODEL = "auto";
const { default: statusFooter, completeBarArguments, formatModelName } = await import("../extensions/status-footer.ts");
initTheme("dark", false);

beforeEach(() => {
	rmSync(config, { force: true });
	delete process.env.PI_BAR_SHOW;
	process.env.PI_BAR_PROGRESS_MODEL = "auto";
});
after(() => {
	for (const [key, value] of previousEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(directory, { recursive: true, force: true });
});

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Handler = (event: never, ctx: ExtensionContext) => unknown;

function harness(initialEntries: SessionEntry[] = [], statuses = new Map<string, string>()) {
	const handlers = new Map<string, Handler>();
	let command: Command;
	let footer: (Component & { dispose?(): void }) | undefined;
	let custom: Component | undefined;
	let entries = [...initialEntries];
	let branch = entries;
	let reads = 0;
	const notifications: string[] = [];
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const tui = { requestRender() {} };
	const ctx = {
		cwd: directory,
		mode: "tui",
		hasUI: true,
		model: { id: "test-model", provider: "test-provider" },
		getContextUsage: () => ({ percent: 12, contextWindow: 200_000 }),
		sessionManager: {
			getEntries: () => { reads++; return [...entries]; },
			getBranch: () => { reads++; return [...branch]; },
		},
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setFooter: (factory: Function | undefined) => {
				footer?.dispose?.();
				footer = factory?.(tui, theme, { getExtensionStatuses: () => statuses });
			},
			custom: (factory: Function) => new Promise((resolve) => {
				custom = factory(tui, theme, {}, resolve);
			}),
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (_name: string, definition: Command) => { command = definition; },
		getThinkingLevel: () => "medium",
		appendEntry: (customType: string, data: unknown) => {
			const entry: SessionEntry = { type: "custom", id: `custom-${entries.length}`, parentId: branch.at(-1)?.id ?? null, timestamp: new Date(0).toISOString(), customType, data };
			entries.push(entry);
			if (branch !== entries) branch.push(entry);
		},
	} as unknown as ExtensionAPI;
	statusFooter(pi);
	const emit = async (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx);
	return {
		ctx,
		statuses,
		notifications,
		emit,
		start: () => emit("session_start"),
		shutdown: () => emit("session_shutdown"),
		command: (args: string) => command.handler(args, ctx as ExtensionCommandContext),
		complete: (prefix: string) => command.getArgumentCompletions!(prefix),
		render: (width = 240) => footer!.render(width)[0],
		customRender: () => custom!.render(160).join("\n"),
		input: (data: string) => custom!.handleInput!(data),
		entries: () => entries,
		setBranch: (next: SessionEntry[]) => { branch = [...next]; },
		replaceSession: (next: SessionEntry[]) => { entries = [...next]; branch = entries; },
		reads: () => reads,
	};
}

const values = (prefix: string, keys: string[] = []) => completeBarArguments(prefix, keys)?.map((item) => item.value) ?? [];

test("autocomplete handles sections, aliases, actions and provider choices", () => {
	assert.deepEqual(values(""), ["config", "segments", "status", "provider", "progress-model", "list"]);
	assert.deepEqual(values("pro"), ["provider", "progress-model"]);
	assert.deepEqual(values("segments sh"), ["segments show"]);
	assert.deepEqual(values("segment h"), ["segment hide"]);
	assert.deepEqual(values("footer on"), ["footer only"]);
	assert.deepEqual(values("statuses n"), ["statuses none"]);
	assert.deepEqual(values("provider "), ["provider show", "provider hide"]);
	for (const prefix of ["unknown ", "list ", "config ", "segments all ", "status none ", "provider show ", "segments show nonexistent"]) {
		assert.equal(completeBarArguments(prefix), null, prefix);
	}
});

test("autocomplete preserves prior arguments, commas, whitespace and key case", () => {
	assert.deepEqual(values("segments show model,ca"), ["segments show model,cache_hit_ratio"]);
	assert.deepEqual(values("segments only model thinking to"), ["segments only model thinking tokens"]);
	assert.deepEqual(values("  footer\tshow   MODEL,co"), ["  footer\tshow   MODEL,context", "  footer\tshow   MODEL,cost"]);
	assert.ok(!values("segments show model,").includes("segments show model,model"));
	assert.deepEqual(values("status hide plan,m", ["plan", "mcp", "MCP"]), ["status hide plan,mcp"]);
	assert.deepEqual(values("status show M", ["mcp", "MCP"]), ["status show MCP"]);
	assert.deepEqual(values("status show ", ["mcp", "mcp", "", "bad key", "a,b", "\x1b[31mred", "bad\x9bkey", "目录"]), ["status show mcp", "status show 目录"]);
});

test("model completion keeps full IDs, filters unsafe keys and matches provider or model fragments", () => {
	const keys = ["openai/gpt-4.1-mini", "openrouter/anthropic/claude-opus-4.7", "openai/gpt-4.1-mini", "auto", "", "missing-slash", "openai/", "bad/white space", "bad/\x1b[31mred", " padded/model", "bad/trailing "];
	const complete = (prefix: string) => completeBarArguments(prefix, [], keys)?.map((item) => item.value) ?? [];
	assert.deepEqual(complete("progress-model "), ["progress-model auto", "progress-model openai/gpt-4.1-mini", "progress-model openrouter/anthropic/claude-opus-4.7"]);
	assert.deepEqual(complete("progress-model GPT"), ["progress-model openai/gpt-4.1-mini"]);
	assert.deepEqual(complete("  progress-model\tOPUS"), ["  progress-model\topenrouter/anthropic/claude-opus-4.7"]);
	assert.deepEqual(complete("progress-model openrouter/anthropic/clau"), ["progress-model openrouter/anthropic/claude-opus-4.7"]);
	for (const prefix of ["progress-model auto ", "progress-model openai/gpt-4.1-mini ", "progress-model missing", "progress-model auto extra"]) {
		assert.equal(completeBarArguments(prefix, [], keys), null, prefix);
	}
});

test("real Pi autocomplete replaces the full argument prefix without losing prior values", async () => {
	const provider = new CombinedAutocompleteProvider([{
		name: "bar",
		getArgumentCompletions: (prefix) => completeBarArguments(prefix, [], ["openrouter/anthropic/claude-opus-4.7"]),
	}], directory);
	for (const [line, expected] of [
		["/bar segments show model,ca", "/bar segments show model,cache_hit_ratio"],
		["/bar progress-model OPUS", "/bar progress-model openrouter/anthropic/claude-opus-4.7"],
		["/bar progress-model openrouter/anthropic/clau", "/bar progress-model openrouter/anthropic/claude-opus-4.7"],
		["/bar progress-model ", "/bar progress-model auto"],
	]) {
		const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		assert.ok(suggestions);
		const completed = provider.applyCompletion([line], 0, line.length, suggestions.items[0], suggestions.prefix);
		assert.deepEqual(completed.lines, [expected]);
	}
});

test("registered completions include live and hidden status keys; commands retain existing behavior", async () => {
	const h = harness([], new Map([["plan", "Plan active"], ["mcp", "MCP ready"]]));
	await h.start();
	h.render();
	await h.command("status hide plan");
	assert.deepEqual((await h.complete("status show p"))?.map((item) => item.value), ["status show plan"]);
	await h.command("segments only tokens cost");
	assert.deepEqual(JSON.parse(readFileSync(config, "utf8")).segments, ["cost", "tokens"]);
	await h.command("segments show cache_hit_ratio");
	assert.deepEqual(JSON.parse(readFileSync(config, "utf8")).segments, ["cache_hit_ratio", "cost", "tokens"]);
	await h.command("segments hide cost");
	assert.deepEqual(JSON.parse(readFileSync(config, "utf8")).segments, ["cache_hit_ratio", "tokens"]);
	await h.shutdown();
});

test("provider formatting uses routing provider, preserves default names and strips terminal controls", () => {
	for (const [id, name] of [["claude-opus-4.7", "claude-opus-4.7"], ["anthropic/claude-sonnet-4-5-20250929", "claude-sonnet-4-5"], ["accounts/team/models/model-2025-01-01", "model"]]) {
		assert.equal(formatModelName({ id, provider: "openrouter" }), name);
		for (const provider of ["anthropic", "openrouter", "custom-router"]) {
			assert.equal(formatModelName({ id, provider }, true), `${provider}/${name}`);
		}
	}
	assert.equal(formatModelName(undefined, true), "no-model");
	assert.equal(formatModelName({ id: "test" }, true), "test");
	assert.equal(formatModelName({ id: "\x1b[31mvendor/model\x1b[0m", provider: "openrouter\x1b]0;title\x07" }, true), "openrouter/model");
});

test("provider prefix is off by default and persists independently of visibility and status filters", async () => {
	process.env.PI_BAR_SHOW = "model";
	const h = harness();
	await h.start();
	assert.equal(h.render(), "test-model");
	await h.command("provider show");
	assert.equal(h.render(), "test-provider/test-model");
	await h.command("segments hide model");
	assert.equal(h.render(), "", "provider is not an independent segment");
	await h.command("status hide plan");
	const saved = JSON.parse(readFileSync(config, "utf8"));
	assert.equal(saved.showProvider, true);
	assert.deepEqual(saved.segments, []);
	assert.deepEqual(saved.statusFilter, { mode: "all", hidden: ["plan"] });
	await h.shutdown();

	const next = harness();
	await next.start();
	assert.equal(next.render(), "test-provider/test-model");
	await next.command("provider");
	assert.equal(next.notifications.at(-1), "pi-bar provider prefix: shown");
	await next.command("provider invalid");
	assert.equal(next.render(), "test-provider/test-model");
	await next.command("provider hide");
	assert.equal(next.render(), "test-model");
	assert.equal(JSON.parse(readFileSync(config, "utf8")).showProvider, false);
	await next.shutdown();

	for (const setting of [{}, { showProvider: "true" }, { showProvider: null }]) {
		writeFileSync(config, JSON.stringify(setting));
		const legacy = harness();
		await legacy.start();
		assert.equal(legacy.render(), "test-model");
		await legacy.shutdown();
	}
});

test("Show provider is available in the existing configurator and saves immediately", async () => {
	process.env.PI_BAR_SHOW = "model";
	const h = harness();
	await h.start();
	const opened = h.command("");
	assert.match(h.customRender(), /Show provider/);
	h.input("Show provider");
	h.input("\r");
	assert.equal(h.render(), "test-provider/test-model");
	assert.equal(JSON.parse(readFileSync(config, "utf8")).showProvider, true);
	h.input("\r");
	assert.equal(h.render(), "test-model");
	h.input("\x1b");
	await opened;
	await h.shutdown();
});

test("metrics are opt-in, restore historical usage, persist and never walk history during render", async () => {
	const entry = messageEntry("a", assistant(makeUsage({ input: 10, cacheRead: 90, cacheWrite: 100, output: 25, cost: 0.123 })));
	const h = harness([entry]);
	await h.start();
	assert.equal(h.render(), "test-model  ❯  think:medium  ❯  12.0% / 200k");
	await h.command("segments only cache_hit_ratio cost tokens");
	assert.equal(h.render(), "CH:45%  ❯  ≈$0.123  ❯  ↑200 ↓25");
	const reads = h.reads();
	for (let width = 0; width <= 240; width++) h.render(width);
	assert.equal(h.reads(), reads);
	await h.shutdown();
	const resumed = harness([entry]);
	await resumed.start();
	assert.equal(resumed.render(), "CH:45%  ❯  ≈$0.123  ❯  ↑200 ↓25");
	await resumed.shutdown();
});

test("metrics hide before usage, use finalized entries, and reset for a new session", async () => {
	process.env.PI_BAR_SHOW = "cache_hit_ratio,cost,tokens";
	const h = harness();
	await h.start();
	assert.equal(h.render(), "");
	const message = assistant(makeUsage({ input: 10, output: 5, cost: 0.1 }));
	await h.emit("message_end", { message });
	assert.equal(h.render(), "", "message_end is not yet persisted/finalized");
	// A later extension changes usage before Pi persists the response.
	message.usage = makeUsage({ input: 20, cacheRead: 80, output: 7, cost: 0.2 });
	h.entries().push(messageEntry("a", message));
	await h.emit("tool_call", { toolName: "read", input: {} });
	assert.equal(h.render(), "CH:80%  ❯  ≈$0.200  ❯  ↑100 ↓7");
	await h.emit("turn_end");
	await h.emit("agent_end");
	assert.equal(h.render(), "CH:80%  ❯  ≈$0.200  ❯  ↑100 ↓7");
	await h.shutdown();
	h.replaceSession([]);
	await h.start();
	assert.equal(h.render(), "");
	h.entries().push(messageEntry("free", assistant(makeUsage({ input: 12, output: 3 }))));
	await h.emit("turn_end");
	assert.equal(h.render(), "CH:0%  ❯  ≈$0.000  ❯  ↑12 ↓3");
	await h.shutdown();
});

test("tree and compaction lifecycle keeps lifetime totals and active-branch cache ratio separate", async () => {
	process.env.PI_BAR_SHOW = "cache_hit_ratio,cost,tokens";
	const a = messageEntry("a", assistant(makeUsage({ input: 10, cacheRead: 90, cost: 0.1 })));
	const b = messageEntry("b", assistant(makeUsage({ input: 50, cacheRead: 50, cost: 0.2 })));
	const h = harness([a, b]);
	h.setBranch([a]);
	await h.start();
	assert.equal(h.render(), "CH:90%  ❯  ≈$0.300  ❯  ↑200 ↓0");
	h.entries().push(summaryEntry("compaction", "compact", makeUsage({ input: 100, output: 10, cost: 0.05 })));
	await h.emit("session_compact");
	assert.equal(h.render(), "CH:90%  ❯  ≈$0.350  ❯  ↑300 ↓10");
	h.entries().push(summaryEntry("branch_summary", "summary", makeUsage({ input: 100, output: 5, cost: 0.01 })));
	h.setBranch([b]);
	await h.emit("session_before_tree");
	await h.emit("session_tree");
	assert.equal(h.render(), "CH:50%  ❯  ≈$0.360  ❯  ↑400 ↓15");
	h.setBranch([]);
	await h.emit("session_tree");
	assert.equal(h.render(), "≈$0.360  ❯  ↑400 ↓15");
	await h.shutdown();
});

async function waitFor(check: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await nextTick();
	}
	assert.ok(check(), "asynchronous progress callback did not finish");
}

function fakeProgressProvider(h: ReturnType<typeof harness>) {
	const pending: Array<(stopReason?: "stop" | "error" | "aborted") => void> = [];
	const stream = () => {
		const events = createAssistantMessageEventStream();
		pending.push((stopReason = "stop") => {
			const response = assistant(makeUsage({ input: 80, cacheRead: 20, output: 10, cost: 0.005 }), { stopReason });
			events.push(stopReason === "stop"
				? { type: "done", reason: "stop", message: response }
				: { type: "error", reason: stopReason, error: response });
			events.end();
		});
		return events;
	};
	registerApiProvider({ api: "pi-bar-test", stream, streamSimple: stream }, "pi-bar-tests");
	const model: Model<"pi-bar-test"> = {
		id: "progress-test", name: "Progress test", provider: "test-provider", api: "pi-bar-test", baseUrl: "https://example.invalid",
		reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
		cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	};
	h.ctx.modelRegistry = {
		find: () => model,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "not-a-real-key" }),
	} as unknown as ExtensionContext["modelRegistry"];
	return pending;
}

test("progress calls persist only numeric usage, survive reload and never replace cache ratio", async (t) => {
	process.env.PI_BAR_SHOW = "cache_hit_ratio,cost,tokens,progress";
	const h = harness([messageEntry("main", assistant(makeUsage({ input: 10, cacheRead: 90, cost: 0.1 })))]);
	const pending = fakeProgressProvider(h);
	t.after(async () => { await h.shutdown(); unregisterApiProviders("pi-bar-tests"); });
	await h.start();
	await h.emit("before_agent_start", { prompt: "Secret prompt must not appear in usage entries" });
	await waitFor(() => pending.length === 1);
	// Supersede the display job, but keep its reported usage in this session.
	await h.command("segments hide progress");
	pending.shift()!();
	await waitFor(() => h.entries().some((entry) => entry.type === "custom"));
	const recorded = h.entries().find((entry) => entry.type === "custom")!;
	assert.equal(recorded.type, "custom");
	if (recorded.type !== "custom") return;
	assert.equal(recorded.customType, PROGRESS_USAGE_ENTRY_TYPE);
	assert.deepEqual(recorded.data, { input: 100, output: 10, cost: 0.005 });
	assert.doesNotMatch(JSON.stringify(recorded), /Secret prompt|Reviewing footer/);
	assert.equal(h.render(), "CH:90%  ❯  ≈$0.105  ❯  ↑200 ↓10");
	await h.emit("agent_end");
	assert.equal(h.render(), "CH:90%  ❯  ≈$0.105  ❯  ↑200 ↓10");
	await h.shutdown();
	const resumed = harness(h.entries());
	await resumed.start();
	assert.equal(resumed.render(), "CH:90%  ❯  ≈$0.105  ❯  ↑200 ↓10");
	await resumed.shutdown();
});

test("failed and aborted progress calls still count their reported usage", async (t) => {
	process.env.PI_BAR_SHOW = "cost,tokens,progress";
	const h = harness();
	const pending = fakeProgressProvider(h);
	t.after(async () => { await h.shutdown(); unregisterApiProviders("pi-bar-tests"); });
	await h.start();
	for (const [index, reason] of (["error", "aborted"] as const).entries()) {
		await h.emit("before_agent_start", { prompt: `Request ${index}` });
		await waitFor(() => pending.length === 1);
		pending.shift()!(reason);
		await waitFor(() => h.entries().length === index + 1);
		assert.equal(h.render(), `≈$${(0.005 * (index + 1)).toFixed(3)}  ❯  ↑${100 * (index + 1)} ↓${10 * (index + 1)}`);
	}
});

test("late progress responses cannot write into a replacement session", async (t) => {
	process.env.PI_BAR_SHOW = "cost,tokens,progress";
	const h = harness();
	const pending = fakeProgressProvider(h);
	t.after(async () => { await h.shutdown(); unregisterApiProviders("pi-bar-tests"); });
	await h.start();
	await h.emit("before_agent_start", { prompt: "Old session" });
	await waitFor(() => pending.length === 1);
	await h.shutdown();
	h.replaceSession([]);
	await h.start();
	pending.shift()!();
	for (let tick = 0; tick < 10; tick++) await nextTick();
	assert.deepEqual(h.entries(), []);
	assert.equal(h.render(), "");
});
