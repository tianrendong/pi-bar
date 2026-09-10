import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export function makeUsage(options: Partial<Omit<Usage, "cost">> & { cost?: number } = {}): Usage {
	const { cost = 0, ...tokens } = options;
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		...tokens,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return usage;
}

export function assistant(usage: Usage, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Reviewing footer metrics" }],
		api: "pi-bar-test",
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

export function messageEntry(id: string, message: SessionMessageEntry["message"]): SessionMessageEntry {
	return { type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message };
}

export function summaryEntry(type: "compaction" | "branch_summary", id: string, usage: Usage): SessionEntry {
	const base = { id, parentId: null, timestamp: new Date(0).toISOString(), summary: "Summary", usage };
	return type === "compaction"
		? { ...base, type, firstKeptEntryId: "root", tokensBefore: 100 }
		: { ...base, type, fromId: "root" };
}
