import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cwdVariants, formatExtensionStatuses, layoutFooter, type FooterSegment } from "../extensions/status-footer.ts";

const segments: FooterSegment[] = [
	{ name: "model", text: "claude-opus-4.7" },
	{ name: "thinking", text: "think:medium", alternatives: ["think:med"] },
	{ name: "context", text: "12.0% / 1.0M", alternatives: ["12.0%"] },
	{ name: "cwd", text: "~/projects/pi/pi-bar", alternatives: ["pi/pi-bar", "pi-bar"] },
	{ name: "progress", text: "Fixing footer layout and reviewing regression coverage" },
	{ name: "extensions", text: "" },
];
const badges = ["MCP: 2/2", "Plan active", "Queue: 2"];

test("status text is display-ready, sanitized, and filtered by original keys", () => {
	const statuses = new Map([
		["mcp", "\x1b[31mMCP: 2/2\x1b[0m"],
		["plan-mode", "Plan\nactive\x1b]0;untrusted title\x07"],
		["queue", "2"],
		["empty", "\x1b[31m \x1b[0m"],
	]);
	const seen = new Set<string>();
	assert.deepEqual(formatExtensionStatuses(statuses, { mode: "all", hidden: new Set() }, seen), ["MCP: 2/2", "Plan active", "2"]);
	assert.deepEqual([...seen], ["mcp", "plan-mode", "queue"]);
	assert.deepEqual(formatExtensionStatuses(statuses, { mode: "all", hidden: new Set(["mcp"]) }, seen), ["Plan active", "2"]);
	assert.deepEqual(formatExtensionStatuses(statuses, { mode: "only", shown: new Set(["mcp"]) }, seen), ["MCP: 2/2"]);
	assert.equal(formatExtensionStatuses(statuses, { mode: "only", shown: new Set() }, seen), null);
});

test("wide layout preserves full segments and complete badges with roomy spacing", () => {
	assert.equal(layoutFooter(segments, badges, 240), [...segments.slice(0, -1).map((s) => s.text), ...badges].join("  ❯  "));
});

test("screenshot layout uses two-space gaps, tightening only under width pressure", () => {
	const input: FooterSegment[] = [
		{ name: "model", text: "gpt-6-astra" },
		{ name: "thinking", text: "think:max" },
		{ name: "context", text: "59.8% / 272k", alternatives: ["59.8%"] },
		{ name: "cwd", text: "~/pi/pi-chrome", alternatives: ["pi/pi-chrome", "pi-chrome"] },
	];
	const roomy = input.map((segment) => segment.text).join("  ❯  ");
	const compact = input.map((segment) => segment.text).join(" ❯ ");
	const width = visibleWidth(roomy);
	assert.equal(layoutFooter(input, [], width), roomy);
	assert.equal(layoutFooter(input, [], width - 1), compact);
	assert.equal(layoutFooter(input, [], visibleWidth(compact)), compact);
	assert.equal(layoutFooter(input, [], width), roomy, "resize restores spacing without changing settings");
});

test("flexible progress shrinks without squeezing gaps when fixed segments fit", () => {
	const input: FooterSegment[] = [
		{ name: "model", text: "model" },
		{ name: "progress", text: "Reviewing ".repeat(100) },
		{ name: "extensions", text: "" },
	];
	const rendered = layoutFooter(input, ["MCP: 2/2", "Plan active"], 60);
	assert.ok(rendered.startsWith("model  ❯  Reviewing"));
	assert.ok(rendered.endsWith("  ❯  MCP: 2/2  ❯  Plan active"));
	assert.ok(rendered.includes("…"));
	assert.ok(visibleWidth(rendered) <= 60);
});

test("long progress shrinks before directory, context, or badges", () => {
	const input = segments.map((s) => s.name === "progress" ? { ...s, text: "Reviewing ".repeat(100) } : s);
	const rendered = layoutFooter(input, badges, 130);
	assert.ok(visibleWidth(rendered) <= 130);
	assert.match(rendered, /12\.0% \/ 1\.0M/);
	assert.match(rendered, /~\/projects\/pi\/pi-bar/);
	assert.ok(rendered.endsWith(badges.join(" ❯ ")));
	assert.ok(rendered.includes("…"));
	assert.equal(input.find((s) => s.name === "progress")!.text, "Reviewing ".repeat(100), "input stays immutable");
});

test("narrow layout protects core values and counts whole trailing badges", () => {
	for (const width of [50, 60, 70, 80, 90]) {
		const rendered = layoutFooter(segments, badges, width);
		assert.ok(visibleWidth(rendered) <= width);
		assert.match(rendered, /claude-opus-4\.7/);
		assert.match(rendered, /think:(medium|med)/);
		assert.match(rendered, /12\.0%/);
		const present = badges.filter((badge) => rendered.includes(badge));
		assert.deepEqual(present, badges.slice(0, present.length));
		assert.match(rendered, new RegExp(`\\+${badges.length - present.length}$`));
	}
});

test("badges never render partially, including oversized first badge and digit transitions", () => {
	const onlyStatuses: FooterSegment[] = [{ name: "extensions", text: "" }];
	assert.equal(layoutFooter(onlyStatuses, ["x".repeat(100), "ok"], 10), "+2");
	assert.equal(layoutFooter(onlyStatuses, ["first", "second", "third"], 11), "first ❯ +2");
	assert.equal(layoutFooter(onlyStatuses, Array.from({ length: 12 }, () => "badge"), 3), "+12");
	assert.equal(layoutFooter(onlyStatuses, badges, 1), "");
	assert.equal(layoutFooter(onlyStatuses, [], 80), "");
});

test("hidden and empty segments add no separators or phantom overflow", () => {
	assert.equal(layoutFooter([], badges, 80), "");
	assert.equal(layoutFooter([{ name: "model", text: "model" }, { name: "progress", text: "" }], badges, 80), "model");
	assert.equal(layoutFooter([{ name: "context", text: "—" }], [], 80), "—");
});

test("CWD alternatives preserve leaf on POSIX, Windows and safe Unicode paths", () => {
	assert.deepEqual(cwdVariants("/home/me/projects/pi-bar", "/home/me", 36, posix), ["~/projects/pi-bar", "projects/pi-bar", "pi-bar"]);
	assert.deepEqual(cwdVariants("C:\\work\\project", "D:\\home", 36, win32), ["C:\\work\\project", "work\\project", "project"]);
	for (const text of cwdVariants("/home/me/parent/目录\x1b]0;title\x07", "/home/me", 8, posix)) {
		assert.ok(visibleWidth(text) <= 8);
		assert.doesNotMatch(text, /[\x00-\x1f\x7f-\x9f]/);
	}
});

test("all widths stay bounded with Unicode, ANSI colors and every visibility combination", () => {
	const color = (text: string) => `\x1b[38;2;120;80;200m${text}\x1b[39m`;
	const unicodeSegments = segments.map((s) => ({ ...s, text: color(s.name === "progress" ? "正在检查👩‍💻代码".repeat(20) : s.text), alternatives: s.alternatives?.map(color) }));
	const coloredBadges = [color("缓存 90%"), color("👩‍💻 working"), color("e\u0301".repeat(20))];
	for (let mask = 0; mask < 64; mask++) {
		const input = unicodeSegments.filter((_, index) => mask & (1 << index));
		for (let width = 0; width <= 180; width++) {
			const rendered = layoutFooter(input, coloredBadges, width, color("❯"));
			assert.ok(visibleWidth(rendered) <= width, `${mask}/${width}: ${JSON.stringify(rendered)}`);
			assert.doesNotMatch(rendered, /[\r\n\ufffd]/);
		}
	}
	assert.equal(layoutFooter(segments, badges, NaN), "");
	assert.equal(layoutFooter(segments, badges, -1), "");
});

test("extreme widths clip long model names before thinking/context and keep lone flexible segments useful", () => {
	const input: FooterSegment[] = [
		{ name: "model", text: "very-long-model-name-".repeat(20) },
		{ name: "thinking", text: "think:max" },
		{ name: "context", text: "95%" },
	];
	const rendered = layoutFooter(input, [], 40);
	assert.ok(visibleWidth(rendered) <= 40);
	assert.ok(rendered.endsWith("think:max ❯ 95%"));
	for (const name of ["cwd", "progress"] as const) {
		const result = layoutFooter([{ name, text: "long-project-or-progress" }], [], 8);
		assert.ok(visibleWidth(result) > 0 && visibleWidth(result) <= 8);
	}
});

test("semantic colors survive layout and resizing restores full content", () => {
	const core: FooterSegment[] = [
		{ name: "model", text: "\x1b[36mmodel\x1b[39m" },
		{ name: "thinking", text: "\x1b[35mthink:max\x1b[39m" },
		{ name: "context", text: "\x1b[31m95% / 1M\x1b[39m", alternatives: ["\x1b[31m95%\x1b[39m"] },
	];
	const wide = layoutFooter(core, [], 80);
	const narrow = layoutFooter(core, [], 25);
	assert.match(narrow, /\x1b\[35mthink:max/);
	assert.match(narrow, /\x1b\[31m95%/);
	assert.equal(layoutFooter(core, [], 80), wide);
});
