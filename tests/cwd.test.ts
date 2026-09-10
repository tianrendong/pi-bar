import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const directory = mkdtempSync(join(tmpdir(), "pi-bar-cwd-test-"));
const config = join(directory, "config.json");
const envKeys = ["PI_BAR_CONFIG", "PI_BAR_SHOW", "PI_BAR_PROGRESS_MODEL", "PI_BAR_CWD_MAX_WIDTH"];
const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
process.env.PI_BAR_CONFIG = config;
process.env.PI_BAR_PROGRESS_MODEL = "auto";
// tests/tsconfig.json mirrors Pi's loader alias from pi-ai to pi-ai/compat.
const { default: statusFooter, formatCwd, parseCwdMaxWidth } = await import("../extensions/status-footer.ts");

beforeEach(() => {
	rmSync(config, { force: true });
	delete process.env.PI_BAR_SHOW;
	delete process.env.PI_BAR_CWD_MAX_WIDTH;
});
after(() => {
	for (const [key, value] of previousEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(directory, { recursive: true, force: true });
});

test("POSIX home, descendants, siblings, root and missing directory", () => {
	assert.equal(formatCwd("/home/me", "/home/me", 36, posix), "~");
	assert.equal(formatCwd("/home/me/project", "/home/me", 36, posix), "~/project");
	assert.equal(formatCwd("/home/me-too/project", "/home/me", 36, posix), "/home/me-too/project");
	assert.equal(formatCwd("/", "/home/me", 36, posix), "/");
	assert.equal(formatCwd("", "/home/me", 36, posix), "—");
	assert.equal(formatCwd("/work", "", 36, posix), "/work");
});

test("Windows drive paths, case-insensitive home, siblings and UNC", () => {
	assert.equal(formatCwd("C:\\Users\\Me\\project", "c:\\users\\me", 36, win32), "~\\project");
	assert.equal(formatCwd("C:\\Users\\MeToo", "C:\\Users\\Me", 36, win32), "C:\\Users\\MeToo");
	assert.equal(formatCwd("D:\\repo", "C:\\Users\\Me", 36, win32), "D:\\repo");
	assert.equal(formatCwd("C:\\", "C:\\Users\\Me", 36, win32), "C:\\");
	assert.equal(formatCwd("\\\\server\\share\\repo", "C:\\Users\\Me", 36, win32), "\\\\server\\share\\repo");
});

test("compaction retains trailing directories within column budget", () => {
	assert.equal(formatCwd("/home/me/very-long-parent/work/project", "/home/me", 20, posix), "~/…/work/project");
	assert.equal(formatCwd("/long-parent-name/work/project", "/home/me", 18, posix), "/…/work/project");
	assert.equal(formatCwd("C:\\long-parent-name\\work\\project", "D:\\home", 20, win32), "C:\\…\\work\\project");
	for (const leaf of ["x".repeat(80), "目录".repeat(10), "目录".repeat(20), "👩‍💻".repeat(20), "e\u0301".repeat(80)]) {
		for (const width of [0, 1, 8, 16, 36]) {
			const rendered = formatCwd(`/home/me/long-parent/${leaf}`, "/home/me", width, posix);
			assert.ok(visibleWidth(rendered) <= width, `width ${width}: ${JSON.stringify(rendered)}`);
			assert.ok(!rendered.includes("\ufffd"));
		}
	}
});

test("directory text cannot emit terminal controls or newlines", () => {
	const rendered = formatCwd("/work/\x1b[31mrepo\x1b[0m\n\x1b]0;title\x07", "/home/me", 36, posix);
	assert.equal(rendered, "/work/repo");
	assert.doesNotMatch(rendered, /[\x00-\x1f\x7f-\x9f]/);
	assert.equal(formatCwd("/home/me/dir\\name", "/home/me", 36, posix), "~/dir\\name");
});

test("width setting accepts integers >= 8 and rejects malformed values", () => {
	for (const raw of [undefined, "", "abc", "7", "-1", "8.5", "36px", "1e2", "Infinity", "9007199254740992"]) {
		assert.equal(parseCwdMaxWidth(raw), 36, String(raw));
	}
	assert.equal(parseCwdMaxWidth("8"), 8);
	assert.equal(parseCwdMaxWidth(" 48 "), 48);
});

function harness(cwd: string) {
	const handlers = new Map<string, Function>();
	let command: { handler: Function };
	let footer: { render(width: number): string[]; dispose(): void };
	const pi = {
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerCommand: (_name: string, definition: { handler: Function }) => { command = definition; },
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		hasUI: true,
		model: { id: "test-model" },
		getContextUsage: () => undefined,
		sessionManager: { getBranch: () => [] },
		ui: {
			notify: () => {},
			setFooter: (factory: Function | undefined) => {
				if (factory) footer = factory(
					{ requestRender() {} },
					{ fg: (_color: string, text: string) => text },
					{ getExtensionStatuses: () => new Map() },
				);
			},
		},
	} as unknown as ExtensionContext;
	statusFooter(pi);
	return {
		start: () => handlers.get("session_start")!({}, ctx),
		shutdown: () => handlers.get("session_shutdown")!({}, ctx),
		command: (args: string) => command.handler(args, ctx),
		render: (width = 120) => footer.render(width)[0],
	};
}

test("CWD is opt-in, persists through commands and reload, respects env and new sessions", async () => {
	const first = harness("/project/cwd-marker");
	await first.start();
	assert.doesNotMatch(first.render(), /cwd-marker/);
	await first.command("segments show cwd");
	assert.match(first.render(), /cwd-marker/);
	assert.ok(JSON.parse(readFileSync(config, "utf8")).segments.includes("cwd"));
	await first.shutdown();

	const resumed = harness("/project/cwd-marker");
	await resumed.start();
	assert.match(resumed.render(), /cwd-marker/);
	await resumed.command("segments only cwd");
	assert.equal(resumed.render(), "/project/cwd-marker");
	await resumed.command("segments hide cwd");
	assert.equal(resumed.render(), "");
	await resumed.shutdown();

	const hidden = harness("/project/cwd-marker");
	await hidden.start();
	assert.equal(hidden.render(), "");
	await hidden.shutdown();

	process.env.PI_BAR_SHOW = "cwd";
	const switched = harness("/other");
	await switched.start();
	assert.equal(switched.render(), "/other");
	await switched.shutdown();

	process.env.PI_BAR_CWD_MAX_WIDTH = "8";
	const next = harness("/project/new-directory");
	await next.start();
	assert.ok(next.render().length > 0);
	assert.ok(visibleWidth(next.render()) <= 8);
	assert.ok(visibleWidth(next.render(4)) <= 4);
	assert.doesNotMatch(next.render(), /cwd-marker|test-model/);
	await next.shutdown();
});
