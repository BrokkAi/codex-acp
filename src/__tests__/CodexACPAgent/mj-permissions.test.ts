import {afterEach, describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import {AgentMode} from "../../AgentMode";
import {ModelId} from "../../ModelId";
import {CodexAcpClient} from "../../CodexAcpClient";

describe("Mj initial permission modes", () => {
    afterEach(() => vi.unstubAllEnvs());

    for (const mode of [AgentMode.Agent, AgentMode.AgentFullAccess]) {
        it(`establishes ${mode.id} and preserves it across ordinary prompts`, async () => {
            vi.stubEnv("INITIAL_AGENT_MODE", mode.id);
            const fixture = createCodexMockTestFixture();
            const server = fixture.getCodexAppServerClient();
            const client = new CodexAcpClient(server, {
                default_permissions: "project",
                permissions: {project: {extends: ":workspace", filesystem: {"/project/.agents/docs": "write"}}},
            });
            vi.spyOn(server, "listSkills").mockResolvedValue({data: []});
            vi.spyOn(server, "configRead").mockResolvedValue({config: {
                sandbox_workspace_write: {writable_roots: ["/shared/cache"], network_access: true},
            }} as any);
            vi.spyOn(server, "listModels").mockResolvedValue({data: [createTestModel()], nextCursor: null});
            const start = vi.spyOn(server, "threadStart").mockResolvedValue({
                thread: {id: "session"}, model: "gpt-5", reasoningEffort: "medium",
            } as any);
            const turn = vi.spyOn(server, "runTurn").mockResolvedValue({threadId: "session", turn: {id: "turn", items: [], status: "completed", error: null}} as any);
            await client.newSession({cwd: "/project", additionalDirectories: ["/extra"], mcpServers: []});
            expect(start.mock.calls[0]![0]).toMatchObject({runtimeWorkspaceRoots: ["/project", "/extra"]});
            const config = start.mock.calls[0]![0].config!;
            expect(config["approval_policy"]).toBe(mode.approvalPolicy);
            expect(config["approvals_reviewer"]).toBe(mode.approvalsReviewer);
            expect(config["default_permissions"]).toBe(mode === AgentMode.Agent ? "project" : ":danger-full-access");
            expect(config["sandbox_workspace_write"]).toEqual({writable_roots: ["/shared/cache", "/extra"], network_access: true});
            for (let i = 0; i < 2; i++) {
                await client.sendPrompt({sessionId: "session", prompt: [{type: "text", text: "continue"}]},
                    mode, ModelId.create("gpt-5", "medium"), null, false, "/project", ["/extra"]);
            }
            expect(turn).toHaveBeenCalledTimes(2);
            for (const [request] of turn.mock.calls) {
                expect(request.approvalPolicy).toBe(mode.approvalPolicy);
                expect(request.approvalsReviewer).toBe(mode.approvalsReviewer);
                expect(request.sandboxPolicy).toEqual(mode === AgentMode.Agent ? undefined : {type: "dangerFullAccess"});
            }
        });
    }
});
