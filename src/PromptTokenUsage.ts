import type {Usage} from "@agentclientprotocol/sdk/unstable";
import {
    combineTokenCounts, isValidTokenCount, PromptTokenUsage as CodexPromptTokenUsage, sameCount, toPromptUsage,
    toTokenCount, ZERO_TOKEN_COUNT, type TokenCount,
} from "./TokenCount";
import type {TokenUsageBreakdown} from "./app-server/v2";

type Compaction = {
    itemId: string;
    before: TokenCount | null;
    rawUsage: TokenCount | null;
    finished: boolean;
};

export const USAGE_SCOPE_META_KEY = "mjolnir.dev/usage-scope";

/** Adds turn attribution and coverage to upstream's prompt-wide accumulator. */
export class PromptTokenUsage {
    private baseline: TokenCount | null;
    private prompt: {status: "active" | "complete"; usage: CodexPromptTokenUsage} | null = null;
    private complete = true;
    private reportedZero = false;
    private turns = new Map<string, boolean>();
    private compactions = new Map<string, Compaction>();
    private responseIds = new Set<string>();
    private uncountedCompactionUsage: TokenCount | null = null;

    constructor(start: boolean | TokenCount) {
        this.baseline = typeof start === "boolean" ? (start ? ZERO_TOKEN_COUNT : null) : start;
    }

    beginPrompt(): void {
        this.prompt = {status: "active", usage: new CodexPromptTokenUsage(this.baseline)};
        this.complete = true;
        this.reportedZero = false;
        this.turns.clear();
        this.compactions.clear();
        this.responseIds.clear();
        this.uncountedCompactionUsage = null;
    }

    beginTurn(turnId: string): void {
        if (this.prompt?.status === "active" && !this.turns.has(turnId)) this.turns.set(turnId, false);
    }

    beginCompaction(turnId: string, itemId: string): void {
        if (this.prompt?.status !== "active" || !this.turns.has(turnId)) return;
        if (this.compactions.get(turnId)?.itemId === itemId) return;
        if (this.compactions.has(turnId)) this.finishCompaction(turnId);
        this.compactions.set(turnId, {itemId, before: this.baseline, rawUsage: null, finished: false});
    }

    observeRawResponse(turnId: string, responseId: string, usage: TokenUsageBreakdown | null): void {
        if (this.prompt?.status !== "active" || !this.turns.has(turnId) || this.responseIds.has(responseId)) return;
        this.responseIds.add(responseId);
        const compaction = this.compactions.get(turnId);
        if (!compaction || compaction.finished || usage === null) return;
        if (!isValidTokenCount(usage)) {
            this.complete = false;
            return;
        }
        compaction.rawUsage = combineTokenCounts(compaction.rawUsage ?? ZERO_TOKEN_COUNT, toTokenCount(usage), (x, y) => x + y);
    }

    finishCompaction(turnId: string, itemId?: string): void {
        if (this.prompt?.status !== "active" || !this.turns.has(turnId)) return;
        const compaction = this.compactions.get(turnId);
        if (!compaction || (itemId !== undefined && compaction.itemId !== itemId)) {
            // A completion without its start cannot establish which totals include this work.
            this.complete = false;
            return;
        }
        if (compaction.finished) return;
        compaction.finished = true;

        const {before, rawUsage} = compaction;
        const delta = before && this.baseline && combineTokenCounts(this.baseline, before, (x, y) => x - y);
        if (delta === null || !isValidTokenCount(delta)) {
            this.complete = false;
        } else if (rawUsage !== null) {
            const missing = combineTokenCounts(rawUsage, delta, (x, y) => x - y);
            if (isValidTokenCount(rawUsage) && isValidTokenCount(missing)) {
                if (!sameCount(missing, ZERO_TOKEN_COUNT)) {
                    this.uncountedCompactionUsage = combineTokenCounts(
                        this.uncountedCompactionUsage ?? ZERO_TOKEN_COUNT, missing, (x, y) => x + y,
                    );
                } else if (sameCount(rawUsage, ZERO_TOKEN_COUNT)) {
                    this.reportedZero = true;
                }
                this.turns.set(turnId, true);
            } else {
                this.complete = false;
            }
        } else if (sameCount(delta, ZERO_TOKEN_COUNT)) {
            this.complete = false;
        }
    }

    endPrompt(): void {
        for (const turnId of this.compactions.keys()) this.finishCompaction(turnId);
        if (this.prompt) this.prompt.status = "complete";
        if ([...this.turns.values()].some(reported => !reported)) this.baseline = null;
    }

    observe(turnId: string, total: TokenUsageBreakdown, last: TokenUsageBreakdown): void {
        const valid = isValidTokenCount(total) && isValidTokenCount(last);
        for (const [id, compaction] of this.compactions) {
            if (!compaction.finished && (id !== turnId || !valid)) {
                compaction.before = null;
            }
        }
        if (!valid) {
            this.complete = false;
            this.baseline = null;
            return;
        }
        const converted = toTokenCount(total);
        this.baseline = converted;
        if (this.prompt?.status !== "active") return;
        const current = this.prompt.usage;
        if (!this.turns.has(turnId)) {
            this.complete = false;
            current.exclude(converted);
            return;
        }
        this.turns.set(turnId, true);
        this.reportedZero ||= sameCount(converted, ZERO_TOKEN_COUNT);
        current.observe(converted, toTokenCount(last));
    }

    observeModelOutput(): void {
        if (this.prompt?.status === "active") this.prompt.usage.observeModelOutput();
    }

    usage(): TokenCount | null {
        let usage = this.prompt?.usage.usage() ?? (this.reportedZero ? ZERO_TOKEN_COUNT : null);
        if (this.uncountedCompactionUsage !== null) {
            usage = combineTokenCounts(usage ?? ZERO_TOKEN_COUNT, this.uncountedCompactionUsage, (x, y) => x + y);
        }
        return usage && isValidTokenCount(usage) ? usage : null;
    }

    report(): Usage | null {
        for (const turnId of this.compactions.keys()) this.finishCompaction(turnId);
        const usage = this.usage();
        if (usage === null) return null;
        const complete = this.complete && this.prompt?.usage.hasCompleteBaseline() && [...this.turns.values()].every(Boolean);
        return {...toPromptUsage(usage), _meta: {[USAGE_SCOPE_META_KEY]: complete ? "turn" : "unspecified"}};
    }
}
