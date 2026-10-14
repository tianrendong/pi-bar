import type { ContextUsage, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ContextSource = Pick<ExtensionContext, "sessionManager" | "model" | "getContextUsage">;
type ContextSnapshot = {
	manager: ContextSource["sessionManager"];
	sessionId: string;
	leafId: string | null;
	entryCount: number | undefined;
	model: ContextSource["model"];
	provider: string | undefined;
	modelId: string | undefined;
	contextWindow: number | undefined;
	usage: ContextUsage | undefined;
};

/**
 * Context reconstruction walks the complete historical branch, even after
 * compaction. Redraws must reuse its result until the session or model changes.
 * Only constant-time metadata is checked here; never copy entries to count them.
 * Lifecycle invalidation also covers usage/model routing before persistence.
 */
export class FooterContextUsageCache {
	private snapshot: ContextSnapshot | undefined;

	reset(): void {
		this.snapshot = undefined;
	}

	get(ctx: ContextSource): ContextUsage | undefined {
		const manager = ctx.sessionManager as ContextSource["sessionManager"] & { getEntryCount?(): number };
		const sessionId = manager.getSessionId();
		const leafId = manager.getLeafId();
		// Older Pi versions do not expose a cheap count. Leaf changes and the
		// lifecycle resets still invalidate their append-only session context.
		const entryCount = manager.getEntryCount?.();
		const model = ctx.model;
		const provider = model?.provider;
		const modelId = model?.id;
		const contextWindow = model?.contextWindow;
		const cached = this.snapshot;
		if (cached && cached.manager === manager && cached.sessionId === sessionId &&
			cached.leafId === leafId && cached.entryCount === entryCount &&
			cached.model === model && cached.provider === provider &&
			cached.modelId === modelId && cached.contextWindow === contextWindow) {
			return cached.usage;
		}

		const usage = ctx.getContextUsage();
		this.snapshot = { manager, sessionId, leafId, entryCount, model, provider, modelId, contextWindow, usage };
		return usage;
	}
}
