import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Numeric-only entries; never add progress prompts or responses to session context. */
export const PROGRESS_USAGE_ENTRY_TYPE = "pi-bar-progress-usage";

export type UsageTotals = {
	/** All prompt tokens, including cache reads and writes. */
	input: number;
	/** Includes reasoning tokens when reported as part of output. */
	output: number;
	/** Reported/catalog dollar estimate, not an invoice. */
	cost: number;
};

function nonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function totalsFromUsage(usage: Partial<Usage> | undefined): UsageTotals {
	return {
		input: nonNegative(usage?.input) + nonNegative(usage?.cacheRead) + nonNegative(usage?.cacheWrite),
		output: nonNegative(usage?.output),
		cost: nonNegative(usage?.cost?.total),
	};
}

export function hasUsage(totals: UsageTotals): boolean {
	return totals.input > 0 || totals.output > 0 || totals.cost > 0;
}

export function promptCacheHitRate(usage: Partial<Usage> | undefined): number | null {
	const promptTokens = totalsFromUsage(usage).input;
	return promptTokens > 0 && Number.isFinite(promptTokens)
		? (nonNegative(usage?.cacheRead) / promptTokens) * 100
		: null;
}

function totalsFromEntry(entry: SessionEntry): UsageTotals {
	if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
		return totalsFromUsage(entry.message.usage);
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return totalsFromUsage(entry.usage);
	}
	if (entry.type === "custom" && entry.customType === PROGRESS_USAGE_ENTRY_TYPE) {
		const data = entry.data as Partial<UsageTotals> | undefined;
		if (data && [data.input, data.output, data.cost].every(
			(value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
		)) {
			return { input: data.input!, output: data.output!, cost: data.cost! };
		}
	}
	return { input: 0, output: 0, cost: 0 };
}

/**
 * Totals cover the entire session file, including abandoned branches. Cache hit
 * rate follows the active branch instead. Consume persisted entries after Pi's
 * message_end hooks finish, so later extensions' usage corrections are honored.
 * Rendering only reads a snapshot; it never walks session history.
 */
export class FooterUsageTracker {
	private totals: UsageTotals = { input: 0, output: 0, cost: 0 };
	private cacheHitRate: number | null = null;
	private cursor = 0;
	private lastEntryId: string | undefined;

	reset(): void {
		this.totals = { input: 0, output: 0, cost: 0 };
		this.cacheHitRate = null;
		this.cursor = 0;
		this.lastEntryId = undefined;
	}

	syncEntries(entries: readonly SessionEntry[]): void {
		// Session replacement or a rewritten prefix requires a fresh snapshot.
		if (entries.length < this.cursor || (this.cursor > 0 && entries[this.cursor - 1]?.id !== this.lastEntryId)) {
			this.reset();
		}
		for (; this.cursor < entries.length; this.cursor++) {
			const entry = entries[this.cursor];
			const totals = totalsFromEntry(entry);
			this.totals.input += totals.input;
			this.totals.output += totals.output;
			this.totals.cost += totals.cost;
			if (entry.type === "message" && entry.message.role === "assistant") {
				this.cacheHitRate = promptCacheHitRate(entry.message.usage);
			}
		}
		this.lastEntryId = entries.at(-1)?.id;
	}

	restoreBranch(branch: readonly SessionEntry[]): void {
		this.cacheHitRate = null;
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type === "message" && entry.message.role === "assistant") {
				this.cacheHitRate = promptCacheHitRate(entry.message.usage);
				break;
			}
		}
	}

	snapshot(): UsageTotals & { cacheHitRate: number | null } {
		return { ...this.totals, cacheHitRate: this.cacheHitRate };
	}
}
