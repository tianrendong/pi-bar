import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatExtensionStatuses, layoutFooter, type FooterSegment } from "../extensions/status-footer.ts";

const RESET = "\x1b[0m";
function badge(text: string): string {
	return formatExtensionStatuses(new Map([["speed", text]]), { mode: "all", hidden: new Set() }, new Set())?.[0] ?? "";
}

test("extension badge foreground, background, and text attributes survive with isolated styles", () => {
	const raw = "\x1b[1;41;32mTPS: 42";
	assert.equal(badge(raw), `${RESET}${raw}${RESET}`);
	assert.equal(badge("Plain badge"), "Plain badge");
});

test("valid basic, indexed, RGB, and colon SGR colors are preserved", () => {
	for (const parameters of [
		"", "0", ";31", "1;2;3;4;9;22;23;24;29;39;49", "91;104",
		"38;5;123", "48;5;255", "38;2;255;0;128", "48;2;0;64;255",
		"38:5:123", "48:2:255:0:128", "38:2::255:0:128", "38:2:0:255:0:128",
		"4:3", "58;2;1;2;3;59",
	]) {
		const color = `\x1b[${parameters}m`;
		assert.equal(badge(`${color}速度👩‍💻`), `${RESET}${color}速度👩‍💻${RESET}`, parameters);
		assert.equal(visibleWidth(badge(`${color}TPS: 42`)), 7, parameters);
	}
	assert.equal(badge("\x9b32mTPS"), `${RESET}\x1b[32mTPS${RESET}`, "C1 CSI is normalized");
});

test("malformed SGR, mouse reports, and non-styling CSI controls are discarded", () => {
	for (const parameters of [
		"38;2;255;0", "38;5;256", "38;5;", "38:2::256:0:0", "38:2:1:255:0:0",
		"38:2:255::0", "48;2;1;2;", "31 ", "31\n", "?31", "<0;10;20", "999",
	]) {
		assert.equal(badge(`A\x1b[${parameters}mB`), "AB", JSON.stringify(parameters));
	}
	assert.equal(badge("A\x1b[2JB\x1b[?25lC\x1b[<0;10;20MD"), "ABCD");
	assert.equal(badge("A\x1b( #0B"), "AB", "all generic ESC intermediate bytes are removed");
});

test("string-control payloads and incomplete escapes never reach badge output", () => {
	for (const [introducer, terminator] of [
		["\x1b]", "\x07"], ["\x1b]", "\x1b\\"], ["\x1bP", "\x1b\\"],
		["\x1bX", "\x1b\\"], ["\x1b^", "\x1b\\"], ["\x1b_", "\x1b\\"],
		["\x9d", "\x9c"], ["\x90", "\x9c"], ["\x98", "\x9c"], ["\x9e", "\x9c"], ["\x9f", "\x9c"],
	]) {
		assert.equal(badge(`A${introducer}0;secret\x1b[31m${terminator}B`), "AB", JSON.stringify(introducer));
		assert.equal(badge(`A${introducer}unterminated`), "A", JSON.stringify(introducer));
	}
	for (const tail of ["\x1b", "\x1b[31", "\x9b31", "\x1b("]) assert.equal(badge(`TPS${tail}`), "TPS");
	assert.equal(badge("A\x1b]8;;https://example.com\x07link\x1b]8;;\x07B"), "AlinkB");
	assert.equal(badge("A\x1b]52;c;clipboard\x07B"), "AB");
});

test("whitespace is normalized transparently through SGR and empty styled statuses are omitted", () => {
	const colored = badge("\x1b[31m \t TPS\n\x1b[32m \n 42  \x1b[0m  ");
	assert.equal(stripVTControlCharacters(colored), "TPS 42");
	assert.equal(badge("A  \x1b[41m B"), `${RESET}A \x1b[41mB${RESET}`, "spaces keep their original style boundary");
	const seen = new Set<string>();
	const parts = formatExtensionStatuses(new Map([
		["color-only", "\x1b[31m\x1b[0m"],
		["whitespace", "\x1b[31m \t \x1b[0m"],
		["hidden", "\x1b[31mHidden"],
		["plain", "Ready"],
	]), { mode: "all", hidden: new Set(["hidden"]) }, seen);
	assert.deepEqual(parts, ["Ready"]);
	assert.deepEqual([...seen], ["hidden", "plain"]);
});

test("colored badges remain whole across overflow and cannot style separators or overflow counts", () => {
	const segments: FooterSegment[] = [{ name: "extensions", text: "" }];
	const first = badge("\x1b[1;41;32mTPS: 42");
	const second = badge("Ready");
	const full = layoutFooter(segments, [first, second], 80);
	assert.equal(full, `${first}  ❯  Ready`);
	assert.equal(layoutFooter(segments, [first, second], 12), `${first} ❯ +1`);
	assert.equal(layoutFooter(segments, [first, second], 5), "+2");
	for (let width = 0; width <= 80; width++) {
		const line = layoutFooter(segments, [first, second], width);
		assert.ok(visibleWidth(line) <= width);
		if (line.includes("TPS:")) {
			assert.ok(line.includes(`TPS: 42${RESET}`), "no partial badge or unclosed style");
		}
	}
	assert.equal(layoutFooter(segments, [first, second], 80), full);
});
