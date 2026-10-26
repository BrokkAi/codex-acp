import type {Usage} from "@agentclientprotocol/sdk/unstable";
import {PromptTokenUsage as CodexPromptTokenUsage, toPromptUsage, toTokenCount, ZERO_TOKEN_COUNT, type TokenCount} from "./TokenCount";
import type {TokenUsageBreakdown} from "./app-server/v2";

export const USAGE_SCOPE_META_KEY = "mjolnir.dev/usage-scope";

/** Adds turn attribution and coverage to upstream's prompt-wide accumulator. */
export class PromptTokenUsage {
    private baseline: TokenCount | null;
    private prompt: {status: "active" | "complete"; usage: CodexPromptTokenUsage} | null = null;
    private complete = true;
    private reportedZero = false;
    private turns = new Map<string, boolean>();

    constructor(start: boolean | TokenCount) {
        this.baseline = typeof start === "boolean" ? (start ? ZERO_TOKEN_COUNT : null) : start;
    }

    beginPrompt(): void {
        this.prompt = {status: "active", usage: new CodexPromptTokenUsage(this.baseline)};
        this.complete = true;
        this.reportedZero = false;
        this.turns.clear();
    }

    beginTurn(turnId: string): void {
        if (this.prompt?.status === "active" && !this.turns.has(turnId)) this.turns.set(turnId, false);
    }

    endPrompt(): void {
        if (this.prompt) this.prompt.status = "complete";
        if ([...this.turns.values()].some(reported => !reported)) this.baseline = null;
    }

    observe(turnId: string, total: TokenUsageBreakdown, last: TokenUsageBreakdown): void {
        const valid = (count: TokenUsageBreakdown) => Object.values(count).every(value => Number.isSafeInteger(value) && value >= 0);
        if (!valid(total) || !valid(last)) {
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
        this.reportedZero ||= Object.values(total).every(value => value === 0);
        current.observe(converted, toTokenCount(last));
    }

    observeModelOutput(): void {
        if (this.prompt?.status === "active") this.prompt.usage.observeModelOutput();
    }

    usage(): TokenCount | null {
        const usage = this.prompt?.usage.usage() ?? (this.reportedZero ? ZERO_TOKEN_COUNT : null);
        return usage && Object.values(usage).every(value => Number.isSafeInteger(value) && value >= 0) ? usage : null;
    }

    report(): Usage | null {
        const usage = this.usage();
        if (usage === null) return null;
        const complete = this.complete && this.prompt?.usage.hasCompleteBaseline() && [...this.turns.values()].every(Boolean);
        return {...toPromptUsage(usage), _meta: {[USAGE_SCOPE_META_KEY]: complete ? "turn" : "unspecified"}};
    }
}
