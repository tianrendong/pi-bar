import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextUsage, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FooterContextUsageCache } from "../extensions/context-usage.ts";

function source(cheapCount = true) {
	const state = { sessionId: "session", leafId: "leaf", entryCount: 1, reads: 0, fail: false };
	let usage: ContextUsage | undefined = { tokens: 10, percent: 1, contextWindow: 1_000 };
	const manager = {
		getSessionId: () => state.sessionId,
		getLeafId: () => state.leafId,
		...(cheapCount ? { getEntryCount: () => state.entryCount } : {}),
		getEntries: () => { throw new Error("cache must never copy session entries"); },
		getBranch: () => { throw new Error("cache must never traverse the branch"); },
	};
	const ctx = {
		sessionManager: manager,
		model: { provider: "test", id: "model", contextWindow: 1_000 },
		getContextUsage: () => {
			state.reads++;
			if (state.fail) throw new Error("unavailable");
			return usage;
		},
	} as unknown as Pick<ExtensionContext, "sessionManager" | "model" | "getContextUsage">;
	return { ctx, state, setUsage: (next: ContextUsage | undefined) => { usage = next; } };
}

test("context cache hits use only cheap metadata, including on older Pi", () => {
	for (const cheapCount of [true, false]) {
		const h = source(cheapCount);
		const cache = new FooterContextUsageCache();
		const first = cache.get(h.ctx);
		for (let frame = 0; frame < 10_000; frame++) assert.equal(cache.get(h.ctx), first);
		assert.equal(h.state.reads, 1);
		h.state.leafId = "next";
		cache.get(h.ctx);
		assert.equal(h.state.reads, 2);
	}
});

test("entry-count changes invalidate even if the selected leaf does not move", () => {
	const h = source();
	const cache = new FooterContextUsageCache();
	cache.get(h.ctx);
	h.state.entryCount++;
	cache.get(h.ctx);
	assert.equal(h.state.reads, 2);
});

test("manager replacement and in-place model identity changes invalidate the cache", () => {
	const h = source();
	const cache = new FooterContextUsageCache();
	cache.get(h.ctx);
	Object.assign(h.ctx, { sessionManager: { ...h.ctx.sessionManager } });
	cache.get(h.ctx);
	Object.assign(h.ctx.model!, { provider: "other" });
	cache.get(h.ctx);
	Object.assign(h.ctx.model!, { id: "other" });
	cache.get(h.ctx);
	assert.equal(h.state.reads, 4);
});

test("undefined and unknown-token results are cached until explicit invalidation", () => {
	const h = source();
	const cache = new FooterContextUsageCache();
	for (const usage of [undefined, { tokens: null, percent: null, contextWindow: 1_000 }]) {
		cache.reset();
		h.setUsage(usage);
		const before = h.state.reads;
		assert.equal(cache.get(h.ctx), usage);
		assert.equal(cache.get(h.ctx), usage);
		assert.equal(h.state.reads, before + 1);
	}
});

test("failed recomputation does not install a stale result under the new key", () => {
	const h = source();
	const cache = new FooterContextUsageCache();
	cache.get(h.ctx);
	h.state.leafId = "new";
	h.state.fail = true;
	assert.throws(() => cache.get(h.ctx), /unavailable/);
	h.state.fail = false;
	h.setUsage({ tokens: 20, percent: 2, contextWindow: 1_000 });
	assert.equal(cache.get(h.ctx)?.tokens, 20);
	assert.equal(h.state.reads, 3);
});
