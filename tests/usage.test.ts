import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { FooterUsageTracker, hasUsage, promptCacheHitRate, PROGRESS_USAGE_ENTRY_TYPE, totalsFromUsage } from "../extensions/usage.ts";
import { assistant, makeUsage, messageEntry, summaryEntry } from "./fixtures.ts";

function progressEntry(id: string, data: unknown): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: new Date(0).toISOString(), customType: PROGRESS_USAGE_ENTRY_TYPE, data };
}

test("cache-hit denominator includes cache writes, not output or reasoning", () => {
	const usage = makeUsage({ input: 10, cacheRead: 90, cacheWrite: 100, output: 500, reasoning: 300, cacheWrite1h: 80 });
	assert.equal(promptCacheHitRate(usage), 45);
	assert.equal(promptCacheHitRate(makeUsage({ cacheRead: 200 })), 100);
	assert.equal(promptCacheHitRate(makeUsage({ cacheWrite: 200 })), 0);
	assert.equal(promptCacheHitRate(makeUsage()), null);
	assert.equal(promptCacheHitRate(undefined), null);
	assert.equal(promptCacheHitRate({ input: 20 }), 0);
	assert.deepEqual(totalsFromUsage(usage), { input: 200, output: 500, cost: 0 });
});

test("missing, malformed and non-finite usage cannot produce NaN counters", () => {
	const malformed = makeUsage({ input: NaN, cacheRead: -1, cacheWrite: Infinity, output: -100, cost: Infinity });
	assert.deepEqual(totalsFromUsage(malformed), { input: 0, output: 0, cost: 0 });
	assert.equal(promptCacheHitRate(malformed), null);
	assert.deepEqual(totalsFromUsage(undefined), { input: 0, output: 0, cost: 0 });
	assert.equal(hasUsage(totalsFromUsage(makeUsage())), false);
	assert.equal(hasUsage(totalsFromUsage(makeUsage({ input: 100, cost: 0 }))), true, "free/subscription usage still has token counts");
});

test("totals include assistants, tools, summaries and numeric-only progress usage exactly once", () => {
	const entries: SessionEntry[] = [
		messageEntry("assistant", assistant(makeUsage({ input: 10, cacheRead: 90, cacheWrite: 100, output: 20, cost: 0.1 }))),
		messageEntry("tool", {
			role: "toolResult", toolCallId: "call", toolName: "subagent", content: [], isError: false, timestamp: 1,
			usage: makeUsage({ input: 30, output: 4, cost: 0.02 }),
		}),
		summaryEntry("compaction", "compact", makeUsage({ input: 40, output: 6, cost: 0.03 })),
		summaryEntry("branch_summary", "summary", makeUsage({ input: 50, output: 8, cost: 0.04 })),
		progressEntry("progress", { input: 60, output: 10, cost: 0.005 }),
		progressEntry("malformed", { input: Infinity, output: 500, cost: 100 }),
		progressEntry("missing", null),
		messageEntry("ordinary-tool", { role: "toolResult", toolCallId: "read", toolName: "read", content: [], isError: false, timestamp: 1 }),
		messageEntry("user", { role: "user", content: "Hi", timestamp: 1 }),
	];
	const tracker = new FooterUsageTracker();
	tracker.syncEntries(entries);
	assert.equal(tracker.snapshot().input, 380);
	assert.equal(tracker.snapshot().output, 48);
	assert.ok(Math.abs(tracker.snapshot().cost - 0.195) < 1e-12);
	assert.equal(tracker.snapshot().cacheHitRate, 45, "side calls must not replace main-model cache hit ratio");
	const snapshot = tracker.snapshot();
	tracker.syncEntries([...entries]);
	assert.deepEqual(tracker.snapshot(), snapshot, "repeated lifecycle events do not double-count");
	entries.push(messageEntry("next", assistant(makeUsage({ input: 20, cacheRead: 80, output: 2, cost: 0.001 }))));
	tracker.syncEntries(entries);
	assert.equal(tracker.snapshot().input, 480);
	assert.equal(tracker.snapshot().output, 50);
	assert.equal(tracker.snapshot().cacheHitRate, 80);
	assert.ok(Math.abs(tracker.snapshot().cost - 0.196) < 1e-12);
});

test("tree navigation changes latest cache ratio, not historical spend", () => {
	const a = messageEntry("a", assistant(makeUsage({ input: 10, cacheRead: 90, cost: 0.1 })));
	const b = messageEntry("b", assistant(makeUsage({ input: 50, cacheRead: 50, cost: 0.2 })));
	const tracker = new FooterUsageTracker();
	tracker.syncEntries([a, b]);
	tracker.restoreBranch([a]);
	assert.equal(tracker.snapshot().cacheHitRate, 90);
	assert.equal(tracker.snapshot().input, 200);
	assert.ok(Math.abs(tracker.snapshot().cost - 0.3) < 1e-12);
	tracker.restoreBranch([]);
	assert.equal(tracker.snapshot().cacheHitRate, null);
	assert.equal(tracker.snapshot().input, 200);
	tracker.restoreBranch([a, b]);
	assert.equal(tracker.snapshot().cacheHitRate, 50);
	tracker.restoreBranch([a, messageEntry("error", assistant(makeUsage(), { stopReason: "error" }))]);
	assert.equal(tracker.snapshot().cacheHitRate, null, "zero-usage error is not reported as a prior response's cache hit");
});

test("reloads, session replacement, empty histories and rewritten prefixes reset correctly", () => {
	const a = messageEntry("a", assistant(makeUsage({ input: 100, output: 5, cost: 1 })));
	const b = messageEntry("b", assistant(makeUsage({ input: 50, output: 7, cost: 2 })));
	const tracker = new FooterUsageTracker();
	tracker.syncEntries([a]);
	const reloaded = new FooterUsageTracker();
	reloaded.syncEntries([a]);
	assert.deepEqual(reloaded.snapshot(), tracker.snapshot());
	tracker.syncEntries([b]);
	assert.deepEqual(tracker.snapshot(), { input: 50, output: 7, cost: 2, cacheHitRate: 0 });
	tracker.reset();
	tracker.syncEntries([b]);
	assert.equal(tracker.snapshot().cost, 2);
	tracker.syncEntries([]);
	assert.deepEqual(tracker.snapshot(), { input: 0, output: 0, cost: 0, cacheHitRate: null });
});
