import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, visibleWidth, type Component } from "@earendil-works/pi-tui";

const directory = mkdtempSync(join(tmpdir(), "pi-bar-menu-test-"));
const config = join(directory, "config.json");
const envKeys = ["PI_BAR_CONFIG", "PI_BAR_SHOW", "PI_BAR_PROGRESS_MODEL"];
const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
process.env.PI_BAR_CONFIG = config;
process.env.PI_BAR_PROGRESS_MODEL = "auto";
const { default: statusFooter, completeBarArguments } = await import("../extensions/status-footer.ts");
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

function harness(statuses = new Map<string, string>()) {
	const handlers = new Map<string, Handler>();
	let command: Command;
	let footer: (Component & { dispose?(): void }) | undefined;
	let custom: Component | undefined;
	const notifications: Array<{ message: string; type: string }> = [];
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const tui = { requestRender() {} };
	const ctx = {
		cwd: directory, mode: "tui", hasUI: true,
		model: { provider: "test-provider", id: "test-model" },
		getContextUsage: () => undefined,
		sessionManager: { getEntries: () => [], getBranch: () => [] },
		modelRegistry: { getAvailable: () => [] },
		ui: {
			notify: (message: string, type: string) => notifications.push({ message, type }),
			setFooter: (factory: Function | undefined) => {
				footer?.dispose?.();
				footer = factory?.(tui, theme, { getExtensionStatuses: () => statuses });
			},
			custom: (factory: Function) => new Promise((resolve) => {
				custom = factory(tui, theme, {}, (value: unknown) => { custom = undefined; resolve(value); });
			}),
		},
	} as unknown as ExtensionContext;
	statusFooter({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (_name: string, definition: Command) => { command = definition; },
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI);
	const emit = async (name: string) => handlers.get(name)?.({} as never, ctx);
	return {
		ctx, statuses, notifications,
		start: async () => { await emit("session_start"); footer?.render(200); },
		shutdown: () => emit("session_shutdown"),
		command: (args: string) => command.handler(args, ctx as ExtensionCommandContext),
		render: () => footer!.render(200)[0],
		uiLines: (width = 160) => custom!.render(width),
		uiText: () => stripVTControlCharacters(custom!.render(160).join("\n")),
		input: (data: string) => custom!.handleInput!(data),
		isOpen: () => custom !== undefined,
	};
}

const saved = () => JSON.parse(readFileSync(config, "utf8"));
const values = (prefix: string, keys: string[] = []) => completeBarArguments(prefix, keys)?.map((item) => item.value) ?? [];

test("top-level menu advertises tasks with explanations, not duplicate legacy groups", () => {
	assert.deepEqual(completeBarArguments("")?.map(({ value, description }) => [value, description]), [
		["settings", "Open all footer settings"],
		["show", "Show footer items"],
		["hide", "Hide footer items"],
		["badges", "Choose extension badges"],
		["provider", "Show or hide provider prefix"],
		["progress-model", "Choose progress model"],
		["help", "Commands and examples"],
	]);
	assert.deepEqual(values("se"), ["settings"]);
	for (const prefix of ["badges ", "provider ", "show ", "hide "]) {
		assert.ok(completeBarArguments(prefix)?.every((item) => item.description), prefix);
	}
});

test("direct visibility and badge completion retain lists, aliases, case, and all shortcuts", () => {
	assert.equal(values("show ")[0], "show all");
	assert.deepEqual(values("show model,co"), ["show model,context", "show model,cost"]);
	assert.deepEqual(values("  hide\tMODEL,co"), ["  hide\tMODEL,context", "  hide\tMODEL,cost"]);
	assert.deepEqual(values("show model thinking to"), ["show model thinking tokens"]);
	assert.ok(!values("hide model,").includes("hide model,model"));
	assert.ok(!values("show model,").includes("show model,all"));
	assert.equal(completeBarArguments("show all "), null);
	assert.equal(completeBarArguments("hide all,mo"), null);
	assert.deepEqual(values("badges hide plan,m", ["plan", "mcp"]), ["badges hide plan,mcp"]);
	assert.deepEqual(values("badges show M", ["mcp", "MCP"]), ["badges show MCP"]);
	assert.deepEqual(values("status hide plan,m", ["plan", "mcp"]), ["status hide plan,mcp"]);
	assert.deepEqual(values("segments show model,co"), ["segments show model,context", "segments show model,cost"]);
});

test("real Pi menu shows descriptions and inserts the new command paths correctly", async () => {
	const provider = new CombinedAutocompleteProvider([{
		name: "bar", getArgumentCompletions: (prefix) => completeBarArguments(prefix, ["mcp"]),
	}], directory);
	for (const [line, expected] of [
		["/bar se", "/bar settings"],
		["/bar show model,ca", "/bar show model,cache_hit_ratio"],
		["/bar hide pro", "/bar hide progress"],
		["/bar badges hide m", "/bar badges hide mcp"],
	]) {
		const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		assert.ok(suggestions);
		assert.ok(suggestions.items[0].description);
		assert.deepEqual(provider.applyCompletion([line], 0, line.length, suggestions.items[0], suggestions.prefix).lines, [expected]);
	}
});

test("settings keeps related controls together and large badge lists out of the main panel", async (t) => {
	const h = harness(new Map(Array.from({ length: 120 }, (_, index) => [`addon-${index}`, `Addon ${index}`])));
	t.after(() => h.shutdown());
	await h.start();
	const closed = h.command("settings");
	const text = h.uiText();
	const lines = text.split("\n");
	assert.match(text, /pi-bar settings/);
	assert.match(text, /Changes save immediately/);
	assert.match(text, /Esc to close/);
	assert.doesNotMatch(text, /Esc to cancel|addon-119|Status:/);
	const modelIndex = lines.findIndex((line) => /\bModel\s+shown$/.test(line));
	assert.ok(modelIndex >= 0);
	assert.match(lines[modelIndex + 1], /Show provider\s+hidden/);
	const progressIndex = lines.findIndex((line) => /Progress update\s+shown/.test(line));
	assert.match(lines[progressIndex + 1], /Progress model\s+auto/);
	assert.match(lines[progressIndex + 2], /Extension badges\s+shown/);
	assert.match(lines[progressIndex + 3], /Choose badges\s+120\/120 enabled/);
	h.input("no-such-setting-xyz");
	assert.match(h.uiText(), /No matching settings/);
	assert.match(h.uiText(), /Esc to close/);
	h.input("\r");
	h.input("\x1b");
	await closed;
	assert.equal(existsSync(config), false, "browsing settings does not write configuration");
});

test("new settings command and legacy aliases open the same panel; list and help are read-only", async (t) => {
	const h = harness();
	t.after(() => h.shutdown());
	await h.start();
	for (const args of ["", "settings", "config", "configure", "edit", "segments", "segment settings", "footer config", "segments edit"]) {
		const closed = h.command(args);
		assert.match(h.uiText(), /pi-bar settings/, args);
		h.input("\x1b");
		await closed;
	}
	for (const args of ["list", "ls", "segments list", "footer ls"]) {
		await h.command(args);
		assert.match(h.notifications.at(-1)!.message, /pi-bar footer: showing:/);
		assert.equal(h.isOpen(), false);
	}
	await h.command("help");
	const help = h.notifications.at(-1)!;
	assert.equal(help.type, "info");
	assert.match(help.message, /Open \/bar for all footer settings/);
	assert.match(help.message, /\/bar show cost tokens/);
	assert.match(help.message, /Current configuration:/);
	assert.match(help.message, /Enabled items may wait for data/);
	assert.match(help.message, /Old commands still work/);
	await h.command("unknown");
	assert.match(h.notifications.at(-1)!.message, /\/bar help/);
	assert.equal(existsSync(config), false);
});

test("show/hide shortcuts preserve preferences and legacy behavior; invalid input changes nothing", async (t) => {
	const prefs = { showProvider: true, progressModel: "auto", statusFilter: { mode: "all", hidden: ["plan"] } };
	writeFileSync(config, JSON.stringify({ ...prefs, segments: ["model", "progress", "extensions"] }));
	const h = harness();
	t.after(() => h.shutdown());
	await h.start();
	await h.command("hide progress extensions");
	assert.deepEqual(saved(), { ...prefs, segments: ["model"] });
	await h.command("show tokens,cost");
	assert.deepEqual(saved().segments, ["model", "cost", "tokens"]);
	await h.command("segments show thinking");
	assert.deepEqual(saved().segments, ["model", "thinking", "cost", "tokens"]);
	await h.command("hide all");
	assert.deepEqual(saved(), { ...prefs, segments: [] });
	assert.equal(h.render(), "");
	await h.command("show ALL");
	assert.equal(saved().segments.length, 9);
	const before = readFileSync(config, "utf8");
	for (const args of ["hide cost typo", "show all model", "show", "hide ,", "badges show", "badges hide ,", "badges only"]) {
		await h.command(args);
		assert.equal(h.notifications.at(-1)?.type, "warning", args);
		assert.equal(readFileSync(config, "utf8"), before, args);
	}
});

test("badge submenu saves live, previews published text, and returns to settings", async (t) => {
	const prefs = { segments: ["extensions"], showProvider: true, progressModel: "auto" };
	writeFileSync(config, JSON.stringify(prefs));
	const statuses = new Map([["mcp", "\x1b[31mMCP ready\x1b[0m"], ["plan", "Plan active"]]);
	const h = harness(statuses);
	t.after(() => h.shutdown());
	await h.start();
	const closed = h.command("");
	h.input("Choose badges");
	h.input("\r");
	assert.match(h.uiText(), /Extension badges/);
	assert.match(h.uiText(), /Esc to go back/);
	h.input("mcp");
	assert.match(h.uiText(), /Badge: mcp\s+shown/);
	assert.match(h.uiText(), /MCP ready/);
	h.input("\r");
	assert.deepEqual(saved(), { ...prefs, statusFilter: { mode: "all", hidden: ["mcp"] } });
	assert.equal(h.render(), "Plan active");
	h.input("\x1b");
	assert.equal(h.isOpen(), true, "Esc returns from submenu rather than closing settings");
	assert.match(h.uiText(), /Choose badges\s+1\/2 enabled/);
	h.input("\x1b");
	await closed;
	const standalone = h.command("badges");
	h.input("mcp");
	assert.match(h.uiText(), /Badge: mcp\s+hidden/);
	h.input("\r");
	assert.equal(h.render(), "MCP ready  ❯  Plan active");
	h.input("\x1b");
	await standalone;
	await h.shutdown();
	const reloaded = harness(statuses);
	t.after(() => reloaded.shutdown());
	await reloaded.start();
	assert.equal(reloaded.render(), "MCP ready  ❯  Plan active");
});

test("new badge defaults preserve existing choices, including badges discovered while settings are open", async (t) => {
	const h = harness(new Map([["mcp", "MCP ready"], ["plan", "Plan active"]]));
	t.after(() => h.shutdown());
	await h.start();
	await h.command("badges hide plan");
	const closed = h.command("badges");
	h.input("\r"); // New badges: hidden.
	assert.deepEqual(saved().statusFilter, { mode: "only", shown: ["mcp"] });
	h.statuses.set("queue", "Queue active");
	assert.doesNotMatch(h.render(), /Plan active|Queue active/);
	h.input("\r"); // New badges: shown, without changing known choices.
	assert.deepEqual(saved().statusFilter, { mode: "all", hidden: ["plan", "queue"] });
	h.statuses.set("later", "Later badge");
	assert.match(h.render(), /Later badge/);
	assert.doesNotMatch(h.render(), /Queue active/);
	h.input("\x1b");
	await closed;
});

test("badge controls work with no statuses and cannot accidentally enable the whole badge segment", async (t) => {
	const h = harness();
	t.after(() => h.shutdown());
	await h.start();
	for (const args of ["badges", "status", "statuses settings"]) {
		const closed = h.command(args);
		assert.match(h.uiText(), /No badges yet/);
		assert.match(h.uiText(), /New badges\s+shown/);
		h.input("\x1b");
		await closed;
	}
	assert.equal(existsSync(config), false);
	await h.command("hide extensions");
	const closed = h.command("badges");
	assert.match(h.uiText(), /All badges are hidden/);
	assert.match(h.uiText(), /\/bar show extensions/);
	h.input("\r");
	assert.deepEqual(saved().statusFilter, { mode: "only", shown: [] });
	assert.ok(!saved().segments.includes("extensions"));
	h.input("\x1b");
	await closed;
});

test("badge keys cannot collide with controls and stay sanitized in settings and list output", async (t) => {
	const key = "\x1b]0;injected-title\x07目录".repeat(20);
	const h = harness(new Map([["__future", "Real badge"], [key, "\x1b]0;injected-preview\x07👩‍💻 Ready\n"]]));
	t.after(() => h.shutdown());
	await h.start();
	const closed = h.command("badges");
	h.input("__future");
	h.input("\r");
	assert.deepEqual(saved().statusFilter, { mode: "all", hidden: ["__future"] });
	h.input("\x1b");
	await closed;
	await h.command("badges list");
	assert.doesNotMatch(h.notifications.at(-1)!.message, /\x1b|injected-title/);
	const root = h.command("settings");
	for (const width of [0, 1, 8, 20, 40, 80, 120]) {
		for (const line of h.uiLines(width)) assert.ok(visibleWidth(line) <= width);
	}
	h.input("Choose badges");
	h.input("\r");
	h.input("目录");
	assert.match(h.uiText(), /👩‍💻 Ready/);
	assert.doesNotMatch(h.uiText(), /injected-title|injected-preview/);
	for (const width of [0, 1, 8, 20, 40, 80, 120]) {
		for (const line of h.uiLines(width)) {
			assert.ok(visibleWidth(line) <= width);
			assert.doesNotMatch(line, /[\r\n\ufffd]/);
		}
	}
	h.input("\x1b");
	h.input("\x1b");
	await root;
});

test("terminal menus are guarded in RPC, JSON, and print modes", async (t) => {
	const h = harness();
	t.after(() => h.shutdown());
	await h.start();
	for (const mode of ["rpc", "json", "print"] as const) {
		h.ctx.mode = mode;
		for (const args of ["settings", "badges", "status"]) {
			await h.command(args);
			assert.equal(h.isOpen(), false);
			assert.match(h.notifications.at(-1)!.message, /requires TUI mode/);
		}
	}
});
