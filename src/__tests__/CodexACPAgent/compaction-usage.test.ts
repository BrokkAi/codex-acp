import {afterEach, describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import {
    connectSession, createTurn, itemCompleted, itemStarted, sessionId, settle, turnCompleted,
    turnId, turnStarted, userMessageItem, type PromptSession,
} from "./v2-prompt-harness";

function breakdown(requests: number) {
    return {
        totalTokens: 100 * requests,
        inputTokens: 80 * requests,
        cachedInputTokens: 40 * requests,
        cacheWriteInputTokens: 10 * requests,
        outputTokens: 20 * requests,
        reasoningOutputTokens: 5 * requests,
    };
}

function usageUpdate(total: number, last = 1): ServerNotification {
    return {
        method: "thread/tokenUsage/updated",
        params: {
            threadId: sessionId,
            turnId,
            tokenUsage: {total: breakdown(total), last: breakdown(last), modelContextWindow: 128000},
        },
    };
}

function rawResponse(responseId: string, options: {threadId?: string; turnId?: string; requests?: number} = {}): ServerNotification {
    return {
        method: "rawResponse/completed",
        params: {
            threadId: options.threadId ?? sessionId,
            turnId: options.turnId ?? turnId,
            responseId,
            usage: breakdown(options.requests ?? 1),
            usageMetadata: null,
        },
    };
}

function expectedUsage(requests: number, scope = "turn") {
    return {
        totalTokens: 100 * requests,
        inputTokens: 30 * requests,
        cachedReadTokens: 40 * requests,
        cachedWriteTokens: 10 * requests,
        outputTokens: 20 * requests,
        thoughtTokens: 5 * requests,
        _meta: {"mjolnir.dev/usage-scope": scope},
    };
}

const compaction = {type: "contextCompaction", id: "compact-item"} as const;

describe.each([1, 2] as const)("compaction usage over ACP v%s", version => {
    let client: PromptSession;
    afterEach(() => client?.connection.close());

    async function expectUsage(prompt: Promise<unknown>, usage: ReturnType<typeof expectedUsage>, stopReason = "end_turn") {
        const response = await prompt;
        await client.promptRunFinished();
        await settle();
        const result = version === 1 ? response : client.transcript.filter(entry =>
            "sessionUpdate" in entry && entry.sessionUpdate.sessionUpdate === "state_update" && entry.sessionUpdate.state === "idle"
        ).at(-1);
        expect(result).toMatchObject(version === 1 ? {stopReason, usage} : {sessionUpdate: {stopReason, usage}});
    }

    it.each([
        {label: "remote", cumulative: 1, raw: true, scope: "turn", requests: 3},
        {label: "local", cumulative: 2, raw: true, scope: "turn", requests: 3},
        {label: "unmeasured", cumulative: 1, raw: false, scope: "unspecified", requests: 2},
    ])("reports ordinary requests around $label compaction", async ({cumulative, raw, scope, requests}) => {
        client = await connectSession(version);
        const prompt = client.sendPrompt([{type: "text", text: "Continue"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted());
        const messageId = client.turnStartParams[0]!['clientUserMessageId'];
        client.emit(itemCompleted(userMessageItem(typeof messageId === "string" ? messageId : null, "Continue")));
        if (version === 2) await prompt;

        client.emit(rawResponse("ordinary-1"));
        client.emit(usageUpdate(1));
        client.emit(itemStarted(compaction));
        if (raw) {
            client.emit(rawResponse("ordinary-1")); // Replay of an earlier ordinary request.
            client.emit(rawResponse("other-turn", {turnId: "other-turn", requests: 10}));
            client.emit(rawResponse("child", {threadId: "child-thread", requests: 10}));
            client.emit(rawResponse("compaction"));
            client.emit(rawResponse("compaction"));
        }
        client.emit(usageUpdate(cumulative));
        client.emit(itemCompleted(compaction));
        client.emit({method: "thread/compacted", params: {threadId: sessionId, turnId}});
        client.emit(rawResponse("ordinary-2"));
        client.emit(usageUpdate(cumulative + 1));
        client.emit(turnCompleted());

        await expectUsage(prompt, expectedUsage(requests, scope));
    });

    it.each([
        {label: "completed", status: "completed", turnStart: true, requests: 1},
        {label: "interrupted", status: "interrupted", turnStart: true, requests: 1},
        {label: "the compaction item starts the turn", status: "completed", turnStart: false, requests: 1},
        {label: "the raw response explicitly reports zero usage", status: "completed", turnStart: false, requests: 0},
    ] as const)("reports standalone remote /compact usage when $label", async ({status, turnStart, requests}) => {
        client = await connectSession(version);
        const start = vi.fn(async () => ({}));
        client.setCodexResponse("thread/compact/start", start);
        const prompt = client.sendPrompt([{type: "text", text: "/compact"}]);
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        if (version === 2) await prompt;

        if (turnStart) client.emit(turnStarted());
        client.emit(itemStarted(compaction));
        client.emit(rawResponse("compaction", {requests}));
        if (status === "completed") {
            if (requests > 0) client.emit(usageUpdate(0, 0));
            client.emit(itemCompleted(compaction));
        }
        client.emit({method: "turn/completed", params: {threadId: sessionId, turn: createTurn(status)}});

        await expectUsage(prompt, expectedUsage(requests), status === "completed" ? "end_turn" : "cancelled");
    });
});
