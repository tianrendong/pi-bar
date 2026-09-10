import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { after, beforeEach, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createAssistantMessageEventStream, registerApiProvider, unregisterApiProviders, type Model } from "@earendil-works/pi-ai";
import { initTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { assistant, makeUsage } from "./fixtures.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-bar-progress-model-test-"));
const config = join(directory, "config.json");
const agentDir = join(directory, "agent");
const cwd = join(directory, "project");
const envKeys = ["PI_BAR_CONFIG", "PI_BAR_SHOW", "PI_BAR_PROGRESS_MODEL", "PI_CODING_AGENT_DIR"];
const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
process.env.PI_BAR_CONFIG = config;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: statusFooter, resolveProgressModelPreference } = await import("../extensions/status-footer.ts");
initTheme("dark", false);

beforeEach(() => {
	for (const path of [config, agentDir, cwd]) rmSync(path, { recursive: true, force: true });
	mkdirSync(cwd, { recursive: true });
	delete process.env.PI_BAR_SHOW;
	delete process.env.PI_BAR_PROGRESS_MODEL;
});
after(() => {
	for (const [key, value] of previousEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(directory, { recursive: true, force: true });
});

const OPENAI = "openai/gpt-4.1-mini";
const ANTHROPIC = "anthropic/claude-haiku-4-5";
const API = "pi-bar-picker-test";
const SOURCE = "pi-bar-picker-tests";

function writeJson(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
}

function preference() {
	const value = resolveProgressModelPreference(cwd);
	return value ? `${value.provider}/${value.id}` : "auto";
}

function model(provider: string, id: string, name = id): Model<typeof API> {
	return {
		provider, id, name, api: API, baseUrl: "https://example.invalid",
		reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 120,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const gpt = model("openai", "gpt-4.1-mini", "GPT 4.1 Mini");
const haiku = model("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5");
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Handler = (event: never, ctx: ExtensionContext) => unknown;

function harness(initialModels = [gpt, haiku]) {
	const handlers = new Map<string, Handler>();
	let command: Command;
	let footer: Component | undefined;
	let custom: Component | undefined;
	let models = initialModels;
	let availabilityReads = 0;
	const authRequests: string[] = [];
	const notifications: Array<{ message: string; type: string }> = [];
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const tui = { requestRender() {} };
	const mainModel = model("chat-provider", "chat-model");
	const ctx = {
		cwd, mode: "tui", hasUI: true, model: mainModel,
		getContextUsage: () => undefined,
		sessionManager: { getEntries: () => [], getBranch: () => [] },
		modelRegistry: {
			getAvailable: () => { availabilityReads++; return models; },
			getAll: () => [...models, model("unconfigured", "should-not-appear")],
			find: (provider: string, id: string) => models.find((item) => item.provider === provider && item.id === id),
			getApiKeyAndHeaders: async (item: Model<typeof API>) => {
				authRequests.push(`${item.provider}/${item.id}`);
				return { ok: true, apiKey: "not-a-real-key" };
			},
		},
		ui: {
			notify: (message: string, type: string) => notifications.push({ message, type }),
			setFooter: (factory: Function | undefined) => {
				footer = factory?.(tui, theme, { getExtensionStatuses: () => new Map() });
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
		setModel: () => { throw new Error("Progress settings must not change the chat model"); },
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	statusFooter(pi);
	const emit = async (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx);
	return {
		ctx, mainModel, authRequests, notifications, emit,
		start: () => emit("session_start"),
		shutdown: () => emit("session_shutdown"),
		command: (args: string) => command.handler(args, ctx as ExtensionCommandContext),
		complete: (prefix: string) => command.getArgumentCompletions!(prefix),
		render: () => footer!.render(200)[0],
		uiLines: (width = 160) => custom!.render(width),
		uiText: () => stripVTControlCharacters(custom!.render(160).join("\n")),
		input: (data: string) => custom!.handleInput!(data),
		availabilityReads: () => availabilityReads,
		setModels: (next: typeof models) => { models = next; },
	};
}

function openPicker(h: ReturnType<typeof harness>) {
	const closed = h.command("");
	h.input("Progress model");
	h.input("\r");
	return { closed };
}

async function choose(h: ReturnType<typeof harness>, query: string) {
	const { closed } = openPicker(h);
	h.input(query);
	h.input("\r");
	h.input("\x1b");
	await closed;
}

async function waitFor(check: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await nextTick();
	}
	assert.ok(check(), "asynchronous progress callback did not finish");
}

test("registered model autocomplete reads current configured models without resolving credentials", async (t) => {
	const router = model("openrouter", "anthropic/claude-haiku-4.5");
	const h = harness([gpt, haiku, gpt, router, model("bad", "\x1b[31munsafe-id"), model(" padded", "model")]);
	t.after(() => h.shutdown());
	const complete = async (prefix: string) => (await h.complete(prefix))?.map((item) => item.value) ?? [];
	assert.deepEqual(await complete("progress-model "), [], "no registry access before session start");
	await h.start();
	assert.deepEqual(await complete("pro"), ["provider", "progress-model"]);
	await complete("segments show ");
	assert.equal(h.availabilityReads(), 0, "unrelated completion never walks model catalogs");
	assert.deepEqual(await complete("progress-model "), [
		"progress-model auto", `progress-model ${ANTHROPIC}`, `progress-model ${OPENAI}`, "progress-model openrouter/anthropic/claude-haiku-4.5",
	]);
	assert.deepEqual(await complete("progress-model GPT"), [`progress-model ${OPENAI}`]);
	assert.deepEqual(await complete("progress-model openrouter/anthropic/clau"), ["progress-model openrouter/anthropic/claude-haiku-4.5"]);
	h.setModels([haiku]);
	assert.deepEqual(await complete("progress-model "), ["progress-model auto", `progress-model ${ANTHROPIC}`]);
	h.setModels([]);
	assert.deepEqual(await complete("progress-model "), ["progress-model auto"]);
	assert.deepEqual(h.authRequests, []);
	assert.equal(existsSync(config), false, "completion never writes settings");
	await h.shutdown();
	const reads = h.availabilityReads();
	assert.deepEqual(await complete("progress-model "), []);
	assert.equal(h.availabilityReads(), reads, "old session registry is released");
});

test("progress-model commands share picker persistence without enabling progress or changing chat models", async (t) => {
	const existing = { segments: ["model"], showProvider: true, statusFilter: { mode: "all", hidden: ["plan"] }, progressModel: ANTHROPIC };
	writeJson(config, existing);
	const h = harness();
	t.after(() => h.shutdown());
	await h.start();
	await h.command("progress-model");
	assert.equal(h.notifications.at(-1)?.message, `pi-bar progress model: ${ANTHROPIC}`);
	await h.command(`progress-model ${OPENAI}`);
	assert.equal(h.notifications.at(-1)?.message, `pi-bar progress model: ${OPENAI}`);
	assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { ...existing, progressModel: OPENAI });
	const { closed } = openPicker(h);
	assert.match(h.uiText(), /openai\/gpt-4\.1-mini\s+selected/);
	h.input("\x1b");
	h.input("\x1b");
	await closed;
	await h.command("progress-model auto");
	assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { ...existing, progressModel: "auto" });
	await h.emit("before_agent_start", { prompt: "Still hidden" });
	assert.deepEqual(h.authRequests, []);
	assert.strictEqual(h.ctx.model, h.mainModel);
	assert.equal(h.render(), "chat-provider/chat-model");
});

test("invalid and unavailable progress-model arguments leave settings untouched", async (t) => {
	writeJson(config, { progressModel: ANTHROPIC });
	const original = readFileSync(config, "utf8");
	const h = harness();
	t.after(() => h.shutdown());
	await h.start();
	for (const argument of ["gpt", "auto extra", "openai/", "/model", "missing/unlisted", "openai/\x1b[31munsafe", `${OPENAI} extra`]) {
		await h.command(`progress-model ${argument}`);
		assert.equal(h.notifications.at(-1)?.type, "warning", argument);
		assert.equal(readFileSync(config, "utf8"), original);
	}
	assert.deepEqual(h.authRequests, []);
});

test("progress preference order preserves legacy settings until an explicit pi-bar choice", () => {
	assert.equal(preference(), "auto");
	writeJson(join(agentDir, "settings.json"), { progress: { model: ANTHROPIC } });
	assert.equal(preference(), ANTHROPIC);
	writeJson(join(agentDir, "settings.json"), { bar: { progressModel: OPENAI }, progress: { model: ANTHROPIC } });
	assert.equal(preference(), OPENAI);
	writeJson(join(cwd, ".pi", "settings.json"), { progress: { model: ANTHROPIC } });
	assert.equal(preference(), ANTHROPIC);
	writeJson(join(cwd, ".pi", "settings.json"), { bar: { progressModel: "auto" }, progress: { model: ANTHROPIC } });
	assert.equal(preference(), "auto");
	writeJson(config, { progressModel: `  ${OPENAI}  ` });
	assert.equal(preference(), OPENAI);
	writeJson(config, { progressModel: "auto" });
	assert.equal(preference(), "auto", "explicit Auto must not reactivate legacy Pi settings");
	process.env.PI_BAR_PROGRESS_MODEL = ANTHROPIC;
	assert.equal(preference(), ANTHROPIC);
	process.env.PI_BAR_PROGRESS_MODEL = "auto";
	assert.equal(preference(), "auto");
});

test("invalid saved preferences are ignored; provider and nested model IDs are retained", () => {
	writeJson(join(agentDir, "settings.json"), { bar: { progressModel: OPENAI } });
	for (const progressModel of [null, 5, {}, [], false, "", "  ", "missing-slash", "/model", "openai/", "openai/bad model", "openai/\x1b[31mbad"]) {
		writeJson(config, { progressModel });
		assert.equal(preference(), OPENAI);
	}
	writeJson(config, { progressModel: "openrouter/anthropic/claude-haiku-4.5" });
	assert.equal(preference(), "openrouter/anthropic/claude-haiku-4.5");
});

test("Progress model sits directly below Progress update, whether progress is shown or hidden", async (t) => {
	for (const enabled of [true, false]) {
		writeJson(config, { segments: enabled ? ["model", "progress"] : ["model"], progressModel: OPENAI });
		const h = harness();
		t.after(() => h.shutdown());
		await h.start();
		const closed = h.command("");
		const lines = h.uiText().split("\n");
		const progressIndex = lines.findIndex((line) => line.includes("Progress update"));
		assert.ok(progressIndex >= 0);
		assert.match(lines[progressIndex], enabled ? /shown/ : /hidden/);
		assert.match(lines[progressIndex + 1], /Progress model\s+openai\/gpt-4\.1-mini/);
		assert.match(lines[progressIndex + 2], /Extension statuses/);
		assert.equal(lines.filter((line) => line.includes("Progress model")).length, 1);
		h.input("\x1b");
		await closed;
		await h.shutdown();
	}
});

test("searchable picker lists only configured models, saves immediately and preserves other settings", async (t) => {
	const existing = { segments: ["model", "progress"], showProvider: true, statusFilter: { mode: "all", hidden: ["plan"] } };
	writeJson(config, existing);
	const piSettings = join(agentDir, "settings.json");
	writeJson(piSettings, { defaultModel: "chat-model", bar: { progressModel: ANTHROPIC }, unrelated: { keep: true } });
	const originalPiSettings = readFileSync(piSettings, "utf8");
	const h = harness([gpt, haiku, gpt]);
	t.after(() => h.shutdown());
	await h.start();
	const { closed } = openPicker(h);
	assert.match(h.uiText(), /Auto/);
	assert.match(h.uiText(), /anthropic\/claude-haiku-4-5\s+selected/);
	assert.doesNotMatch(h.uiText(), /unconfigured|not-a-real-key/);
	assert.ok(h.uiText().indexOf(ANTHROPIC) < h.uiText().indexOf(OPENAI), "models sorted by provider/id");
	h.input("gpt");
	assert.match(h.uiText(), /openai\/gpt-4\.1-mini/);
	assert.doesNotMatch(h.uiText(), /claude-haiku/);
	h.input("\r");
	assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { ...existing, progressModel: OPENAI });
	assert.match(h.uiText(), /Progress model\s+openai\/gpt-4\.1-mini/);
	assert.equal(preference(), OPENAI);
	assert.strictEqual(h.ctx.model, h.mainModel);
	assert.deepEqual(h.authRequests, [], "opening/selecting models never resolves credentials or makes API calls");
	assert.equal(readFileSync(piSettings, "utf8"), originalPiSettings, "Pi settings are never overwritten");
	h.input("\x1b");
	await closed;
	await h.command("segments show tokens");
	await h.command("provider hide");
	await h.command("status hide mcp");
	assert.equal(JSON.parse(readFileSync(config, "utf8")).progressModel, OPENAI, "other settings retain the preference");
	await h.shutdown();

	const reloaded = harness();
	t.after(() => reloaded.shutdown());
	await reloaded.start();
	const next = openPicker(reloaded);
	assert.match(reloaded.uiText(), /openai\/gpt-4\.1-mini\s+selected/);
	reloaded.input("Auto");
	reloaded.input("\r");
	assert.equal(JSON.parse(readFileSync(config, "utf8")).progressModel, "auto");
	assert.equal(preference(), "auto");
	reloaded.input("\x1b");
	await next.closed;
});

test("cancel and unavailable current models leave the saved preference untouched", async (t) => {
	writeJson(config, { progressModel: "missing/unlisted", segments: ["model"] });
	const original = readFileSync(config, "utf8");
	const h = harness();
	t.after(() => h.shutdown());
	await h.start();
	const { closed } = openPicker(h);
	assert.match(h.uiText(), /missing\/unlisted\s+unavailable/);
	h.input("no-such-model");
	assert.match(h.uiText(), /No matching settings/);
	h.input("\r");
	h.input("\x1b");
	assert.match(h.uiText(), /Progress model\s+missing\/unlisted/);
	h.input("\x1b");
	await closed;
	assert.equal(readFileSync(config, "utf8"), original);
});

test("empty availability explains login and reopening uses the latest available models", async (t) => {
	const h = harness([]);
	t.after(() => h.shutdown());
	await h.start();
	const first = openPicker(h);
	assert.match(h.uiText(), /No models with configured credentials/);
	assert.match(h.uiText(), /\/login/);
	h.input("\x1b");
	h.input("\x1b");
	await first.closed;
	assert.equal(existsSync(config), false);
	h.setModels([gpt]);
	await choose(h, "gpt");
	assert.equal(h.availabilityReads(), 2);
	assert.equal(preference(), OPENAI);
});

test("environment overrides, including auto, are clearly read-only in the configurator", async () => {
	writeJson(config, { progressModel: ANTHROPIC });
	const original = readFileSync(config, "utf8");
	for (const value of [OPENAI, "auto"]) {
		process.env.PI_BAR_PROGRESS_MODEL = value;
		const h = harness();
		await h.start();
		const { closed } = openPicker(h);
		assert.match(h.uiText(), /Controlled by PI_BAR_PROGRESS_MODEL \(read-only\)/);
		assert.equal(h.availabilityReads(), 0);
		assert.equal(preference(), value);
		h.input("\x1b");
		await closed;
		assert.equal(await h.complete("progress-model "), null);
		await h.command("progress-model");
		assert.equal(h.notifications.at(-1)?.message, `pi-bar progress model: ${value} (PI_BAR_PROGRESS_MODEL, read-only)`);
		await h.command(`progress-model ${OPENAI}`);
		assert.equal(h.notifications.at(-1)?.type, "warning");
		assert.match(h.notifications.at(-1)!.message, /controlled by PI_BAR_PROGRESS_MODEL/);
		assert.equal(h.availabilityReads(), 0);
		await h.shutdown();
		assert.equal(readFileSync(config, "utf8"), original);
	}
});

test("selecting a progress model never enables a hidden segment", async (t) => {
	writeJson(config, { segments: ["model"] });
	const h = harness();
	t.after(() => h.shutdown());
	await h.start();
	await choose(h, "gpt");
	await h.emit("before_agent_start", { prompt: "Progress is disabled" });
	assert.deepEqual(h.authRequests, []);
	assert.equal(h.render(), "chat-model");
	assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { segments: ["model"], progressModel: OPENAI });
});

test("save failures report an error and restore the displayed effective preference", async (t) => {
	writeJson(join(agentDir, "settings.json"), { bar: { progressModel: ANTHROPIC } });
	mkdirSync(config); // Atomic rename cannot replace a directory.
	const h = harness();
	t.after(() => h.shutdown());
	await h.start();
	const { closed } = openPicker(h);
	h.input("gpt");
	h.input("\r");
	assert.equal(h.notifications.at(-1)?.type, "error");
	assert.match(h.notifications.at(-1)!.message, /Could not save the progress model/);
	assert.equal(preference(), ANTHROPIC);
	assert.match(h.uiText(), /Progress model\s+anthropic\/claude-haiku-4-5/);
	h.input("\x1b");
	await closed;
	const notifications = h.notifications.length;
	await h.command(`progress-model ${OPENAI}`);
	assert.equal(h.notifications.length, notifications + 1, "failed save must not emit a success notice");
	assert.equal(h.notifications.at(-1)?.type, "error");
	assert.equal(preference(), ANTHROPIC);
});

test("picker uses terminal-safe labels and stays within narrow terminal widths", async (t) => {
	const h = harness([
		model("provider", "目录".repeat(50), "\x1b]0;injected-title\x07Wide model\nname"),
		model("bad", "\x1b[31munsafe-id"),
	]);
	t.after(() => h.shutdown());
	await h.start();
	const { closed } = openPicker(h);
	h.input("\x1b[B");
	assert.doesNotMatch(h.uiText(), /injected-title|unsafe-id/);
	for (const width of [0, 1, 8, 20, 40, 100]) {
		for (const line of h.uiLines(width)) assert.ok(visibleWidth(line) <= width, `width ${width}`);
	}
	h.input("\x1b");
	h.input("\x1b");
	await closed;
});

test("non-TUI modes do not attempt to open terminal-only configuration", async (t) => {
	const h = harness();
	t.after(() => h.shutdown());
	h.ctx.mode = "rpc";
	await h.start();
	await h.command("");
	assert.match(h.notifications.at(-1)!.message, /requires TUI mode/);
	assert.equal(h.availabilityReads(), 0);
});

test("changing models cancels old-provider jobs and uses the new model without reload", async (t) => {
	const pending: Array<{ model: string; signal?: AbortSignal; finish(text: string): void }> = [];
	const stream = (item: Model<any>, _context: unknown, options?: { signal?: AbortSignal }) => {
		const events = createAssistantMessageEventStream();
		let finished = false;
		pending.push({
			model: `${item.provider}/${item.id}`,
			signal: options?.signal,
			finish: (text) => {
				if (finished) return;
				finished = true;
				events.push({
					type: "done", reason: "stop",
					message: assistant(makeUsage(), {
						api: API, provider: item.provider, model: item.id,
						content: [{ type: "text", text }],
					}),
				});
				events.end();
			},
		});
		return events;
	};
	registerApiProvider({ api: API, stream, streamSimple: stream }, SOURCE);
	writeJson(config, { progressModel: ANTHROPIC });
	const h = harness();
	t.after(async () => {
		await h.shutdown();
		for (const request of pending) request.finish("Reviewing cleanup");
		unregisterApiProviders(SOURCE);
	});
	await h.start();
	await h.emit("before_agent_start", { prompt: "Old provider task" });
	await waitFor(() => pending.length === 1);
	assert.equal(pending[0].model, ANTHROPIC);
	// The picker can see a disk edit that the running engine has not loaded yet.
	writeJson(config, { progressModel: OPENAI });
	await choose(h, "gpt");
	assert.equal(pending[0].signal?.aborted, true);
	pending[0].finish("Reviewing old provider task");
	await nextTick();
	assert.doesNotMatch(h.render(), /old provider/);

	await h.emit("before_agent_start", { prompt: "New provider task" });
	await waitFor(() => pending.length === 2);
	assert.equal(pending[1].model, OPENAI);
	assert.deepEqual(h.authRequests, [ANTHROPIC, OPENAI]);
	pending[1].finish("Reviewing new provider task");
	await waitFor(() => h.render().includes("Reviewing new provider task"));
	assert.strictEqual(h.ctx.model, h.mainModel);
	await choose(h, "gpt");
	assert.match(h.render(), /Reviewing new provider task/, "reselecting the same model does not reset progress");

	await choose(h, "Auto");
	await h.emit("before_agent_start", { prompt: "Automatic model task" });
	await waitFor(() => pending.length === 3);
	assert.equal(pending[2].model, ANTHROPIC);
	await h.command(`progress-model ${OPENAI}`);
	assert.equal(pending[2].signal?.aborted, true, "command cancels old-model jobs like the picker");
	pending[2].finish("Reviewing automatic model task");
	await nextTick();
	assert.doesNotMatch(h.render(), /automatic model task/);
	await h.emit("before_agent_start", { prompt: "Command-selected task" });
	await waitFor(() => pending.length === 4);
	assert.equal(pending[3].model, OPENAI);
	pending[3].finish("Reviewing command-selected task");
	await waitFor(() => h.render().includes("Reviewing command-selected task"));
	assert.strictEqual(h.ctx.model, h.mainModel);
});
