import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import type {ThreadGoal, ThreadResumeResponse, ThreadReadResponse} from "../../app-server/v2";
import {toThreadGoalSnapshot} from "../../ThreadGoalSnapshot";

const sessionId = "goal-recovery";
const storedGoal: ThreadGoal = {
    threadId: sessionId, objective: "Finish the campaign", status: "active",
    createdAt: 100, updatedAt: 110, tokenBudget: 9000, tokensUsed: 1234, timeUsedSeconds: 50,
};

async function fixtureForGoal() {
    const fixture = createCodexMockTestFixture();
    const agent = fixture.getCodexAcpAgent();
    const client = fixture.getCodexAcpClient();
    const app = fixture.getCodexAppServerClient();
    vi.spyOn(client, "authRequired").mockResolvedValue(false);
    vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
    vi.spyOn(app, "listModels").mockResolvedValue({data: [createTestModel()], nextCursor: null});
    const goal = {value: {...storedGoal}};
    vi.spyOn(client, "getGoal").mockImplementation(async () => goal.value);
    vi.spyOn(app, "threadGoalSet").mockImplementation(async params => {
        goal.value = {...goal.value, status: params.status ?? goal.value.status};
        return {goal: goal.value};
    });
    vi.spyOn(app, "threadRead").mockResolvedValue({thread: {status: {type: "idle"}}} as ThreadReadResponse);
    const response = {
        thread: {id: sessionId, status: {type: "idle"}, turns: [], historyMode: "legacy"},
        model: "model-id", modelProvider: "openai", reasoningEffort: "medium",
    } as unknown as ThreadResumeResponse;
    vi.spyOn(app, "threadResume").mockResolvedValue(response);
    await agent.initialize({protocolVersion: 1, clientCapabilities: {_meta: {execution: {version: 1}}}});
    return {fixture, agent, client, app, goal, response};
}

function started(id: string) {
    return {method: "turn/started", params: {threadId: sessionId, turn: {
        id, items: [], status: "inProgress", error: null, startedAt: 100, completedAt: null, durationMs: null,
    }}};
}

describe("goal recovery", () => {
    it("observes autonomous output during native resume and before any ACP prompt", async () => {
        const {fixture, agent, client, app, response} = await fixtureForGoal();
        const text = "autonomous output ".repeat(6000);
        vi.mocked(app.threadResume).mockImplementation(async () => {
            fixture.sendServerNotification(started("autonomous"));
            fixture.sendServerNotification({method: "item/agentMessage/delta", params: {
                threadId: sessionId, turnId: "autonomous", itemId: "message", delta: text,
            }});
            return response;
        });
        const result = await agent.resumeSession({sessionId, cwd: "/workspace", mcpServers: []});
        await client.waitForSessionNotifications(sessionId);
        expect(result._meta?.["execution"]).toMatchObject({status: "running", turnId: "autonomous"});
        expect(result._meta?.["goal"]).toMatchObject({objective: storedGoal.objective, tokensUsed: 1234, tokenBudget: 9000});
        const updates = fixture.getAcpConnectionEvents([]).filter(e => e.method === "sessionUpdate").map(e => e.args[0].update);
        expect(updates.filter(u => u.content?.text === text)).toHaveLength(1);
        fixture.sendServerNotification({method: "turn/completed", params: {threadId: sessionId,
            turn: {id: "autonomous", status: "completed", items: [], error: null}}});
        await client.waitForSessionNotifications(sessionId);
        expect(agent.getSessionState(sessionId).currentTurnId).toBeNull();
        await agent.closeSession({sessionId});
    });

    it("pauses an active stored goal before explicit native resume", async () => {
        const {agent, app, goal, response} = await fixtureForGoal();
        vi.mocked(app.threadResume).mockImplementation(async () => {
            expect(goal.value.status).toBe("paused");
            return response;
        });
        const result = await agent.resumeSession({sessionId, cwd: "/workspace", mcpServers: [], _meta: {goal: {resumePolicy: "pause"}}});
        expect(result._meta?.["goal"]).toMatchObject({status: "paused", tokensUsed: 1234, tokenBudget: 9000});
        expect(app.threadGoalSet).toHaveBeenCalledWith({threadId: sessionId, status: "paused"});
        await agent.closeSession({sessionId});
    });

    it("does not duplicate an already-running native goal continuation", async () => {
        const {fixture, agent, client} = await fixtureForGoal();
        await agent.resumeSession({sessionId, cwd: "/workspace", mcpServers: []});
        fixture.sendServerNotification(started("native-resume"));
        await client.waitForSessionNotifications(sessionId);
        const resume = vi.spyOn(client, "resumeGoal");
        await agent.extMethod("_session/goal", {sessionId, action: "resume", expectedGoal: {objective: storedGoal.objective, createdAt: 100000}});
        expect(resume).not.toHaveBeenCalled();
        await agent.closeSession({sessionId});
    });
    it("routes an approval raised during resume without waiting for a prompt", async () => {
        const {fixture, agent, app, response} = await fixtureForGoal();
        fixture.setPermissionResponse({outcome: {outcome: "selected", optionId: "decline"}});
        let approval!: Promise<{decision: unknown}>;
        vi.mocked(app.threadResume).mockImplementation(async () => {
            fixture.sendServerNotification(started("approval-turn"));
            approval = fixture.sendServerRequest("item/commandExecution/requestApproval", {
                threadId: sessionId, turnId: "approval-turn", itemId: "command",
                command: "echo ready", cwd: "/workspace", reason: "Resume validation",
                availableDecisions: ["accept", "decline", "cancel"], commandActions: [],
            });
            return response;
        });
        await agent.resumeSession({sessionId, cwd: "/workspace", mcpServers: []});
        expect(await approval).toEqual({decision: "decline"});
        await agent.closeSession({sessionId});
    });

    it.each(["paused", "blocked", "budgetLimited", "usageLimited", "complete"] as const)(
        "does not reactivate a stored %s goal while opening", async status => {
            const {agent, app, goal} = await fixtureForGoal();
            goal.value.status = status;
            await agent.resumeSession({sessionId, cwd: "/workspace", mcpServers: [], _meta: {goal: {resumePolicy: "pause"}}});
            expect(app.threadGoalSet).not.toHaveBeenCalled();
            await agent.closeSession({sessionId});
        },
    );

    it.each(["pause", "resume"])("rejects a stale %s decision", async action => {
        const {agent, client} = await fixtureForGoal();
        await agent.resumeSession({sessionId, cwd: "/workspace", mcpServers: []});
        const resume = vi.spyOn(client, "resumeGoal");
        await expect(agent.extMethod("_session/goal", {sessionId, action, expectedGoal: {objective: "a replaced goal", createdAt: 100000}})).rejects.toMatchObject({code: -32600});
        expect(resume).not.toHaveBeenCalled();
        await agent.closeSession({sessionId});
    });

    it("resumes a goal stopped by the account usage limit", async () => {
        const {agent, client, goal} = await fixtureForGoal();
        goal.value.status = "usageLimited";
        await agent.resumeSession({sessionId, cwd: "/workspace", mcpServers: []});
        const resume = vi.spyOn(client, "resumeGoal").mockImplementation(async (_session, onTurnStarted) => {
            onTurnStarted?.("resumed");
            return null;
        });
        await agent.extMethod("_session/goal", {sessionId, action: "resume", expectedGoal: {objective: storedGoal.objective, createdAt: 100000}});
        expect(resume).toHaveBeenCalledOnce();
        await agent.closeSession({sessionId});
    });

    it.each([
        ["budgetLimited", 1234],
        ["usageLimited", 9000],
    ] as const)("leaves a %s goal with %d tokens used for the user", async (status, tokensUsed) => {
        const {agent, client, goal} = await fixtureForGoal();
        goal.value = {...goal.value, status, tokensUsed};
        await agent.resumeSession({sessionId, cwd: "/workspace", mcpServers: []});
        const resume = vi.spyOn(client, "resumeGoal");
        await agent.extMethod("_session/goal", {sessionId, action: "resume", expectedGoal: {objective: storedGoal.objective, createdAt: 100000}});
        expect(resume).not.toHaveBeenCalled();
        await agent.closeSession({sessionId});
    });

    it.each([
        ["usageLimited", 1234, "usage"],
        ["usageLimited", 9000, "budget"],
        ["budgetLimited", 1234, "budget"],
        ["active", 1234, undefined],
    ] as const)("publishes a %s goal with %d tokens used as limit reason %s", (status, tokensUsed, reason) => {
        const snapshot = toThreadGoalSnapshot({...storedGoal, status, tokensUsed});
        expect(snapshot.limitReason).toBe(reason);
        expect(snapshot.status).toBe(status === "active" ? "active" : "limited");
    });

});
