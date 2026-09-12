import type {Usage} from "@agentclientprotocol/sdk";
import type {TokenUsageBreakdown} from "./app-server/v2";

export const USAGE_SCOPE_META_KEY = "mjolnir.dev/usage-scope";
const COUNTERS = ["totalTokens", "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningOutputTokens"] as const;
const zero = (): TokenUsageBreakdown => ({totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0});

/** Thread counters outlive prompts. Only deltas attributed to this prompt enter its report. */
export class PromptTokenUsage {
    private baseline: TokenUsageBreakdown | null;
    private tokens: TokenUsageBreakdown | null = null;
    private complete = true;
    private active = false;
    private turns = new Map<string, boolean>();

    constructor(freshThread: boolean) {
        this.baseline = freshThread ? zero() : null;
    }

    beginPrompt(): void {
        this.tokens = null;
        this.complete = this.baseline !== null;
        this.turns.clear();
        this.active = true;
    }

    beginTurn(turnId: string): void {
        if (this.active && !this.turns.has(turnId)) this.turns.set(turnId, false);
    }

    endPrompt(): void {
        this.active = false;
        if ([...this.turns.values()].some(reported => !reported)) this.baseline = null;
    }

    observe(turnId: string, total: TokenUsageBreakdown, last: TokenUsageBreakdown): void {
        const belongs = this.active && this.turns.has(turnId);
        const previous = this.baseline;
        this.baseline = {...total};
        if (!belongs) {
            // A concurrent unrelated turn breaks attribution for this prompt.
            if (this.active) this.complete = false;
            return;
        }
        this.turns.set(turnId, true);
        const delta = zero();
        if (previous === null) {
            this.complete = false;
            Object.assign(delta, last);
        } else {
            for (const key of COUNTERS) delta[key] = total[key] - previous[key];
        }
        if (COUNTERS.some(key => !Number.isSafeInteger(delta[key]) || delta[key] < 0)) {
            this.complete = false;
            return;
        }
        this.tokens ??= zero();
        for (const key of COUNTERS) {
            const sum = this.tokens[key] + delta[key];
            if (!Number.isSafeInteger(sum)) {
                this.complete = false;
                return;
            }
        }
        for (const key of COUNTERS) this.tokens[key] += delta[key];
    }

    report(): Usage | null {
        const tokens = this.tokens;
        if (tokens === null) return null;
        const complete = this.complete && [...this.turns.values()].every(Boolean);
        return {
            totalTokens: tokens.totalTokens,
            inputTokens: tokens.inputTokens,
            outputTokens: tokens.outputTokens,
            cachedReadTokens: tokens.cachedInputTokens,
            cachedWriteTokens: tokens.cacheWriteInputTokens,
            thoughtTokens: tokens.reasoningOutputTokens,
            _meta: {[USAGE_SCOPE_META_KEY]: complete ? "turn" : "unspecified"},
        };
    }
}
