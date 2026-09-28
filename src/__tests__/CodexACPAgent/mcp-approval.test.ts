import {afterEach, describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";

function fixture() {
    const f = createCodexMockTestFixture();
    const native = f.getCodexAppServerClient();
    vi.spyOn(native, "configRead").mockResolvedValue({config: {}} as never);
    vi.spyOn(native, "listSkills").mockResolvedValue({data: []});
    vi.spyOn(native, "listModels").mockResolvedValue({data: [createTestModel({id: "gpt-5"})], nextCursor: null});
    const response = {thread: {id: "thread-id"}, model: "gpt-5", reasoningEffort: "medium", materialized: false};
    vi.spyOn(native, "threadReadWithHistory").mockResolvedValue({thread: {id: "thread-id"}} as never);
    const start = vi.spyOn(native, "threadStart").mockResolvedValue(response as never);
    const resume = vi.spyOn(native, "threadResume").mockResolvedValue(response as never);
    const fork = vi.spyOn(native, "threadFork").mockResolvedValue(response as never);
    vi.spyOn(native, "threadUnsubscribe").mockResolvedValue({status: "unsubscribed"});
    return {client: f.getCodexAcpClient(), start, resume, fork};
}

const unmarked = {name: "third-party", command: "analyzer", args: [], env: []};
const owned = {name: "owned", command: "worker", args: ["mcp"], env: [],
    _meta: {codex: {defaultToolsApprovalMode: "approve"}}};

describe("MCP approval metadata", () => {
    afterEach(() => vi.unstubAllEnvs());

    it.each(["newSession", "loadSession", "resumeSession", "forkSession"] as const)(
        "preserves server-specific policy through %s without changing Guardian", async method => {
            const {client, start, resume, fork} = fixture();
            await client[method]({cwd: "/workspace", sessionId: "thread-id", mcpServers: [owned, unmarked]});
            const request = [...start.mock.calls, ...resume.mock.calls, ...fork.mock.calls][0]![0];
            expect(request.config).toMatchObject({
                approval_policy: "on-request", approvals_reviewer: "auto_review",
                mcp_servers: {
                    owned: {command: "worker", args: ["mcp"], env: {}, default_tools_approval_mode: "approve"},
                    "third-party": {command: "analyzer", args: [], env: {}},
                },
            });
            expect((request.config?.["mcp_servers"] as any)["third-party"]).not.toHaveProperty("default_tools_approval_mode");
        });

    it.each(["auto", "prompt", "writes", "approve"])("forwards %s on HTTP servers", async mode => {
        const {client, start} = fixture();
        await client.newSession({cwd: "/workspace", mcpServers: [{type: "http", name: "remote",
            url: "https://example.com/mcp", headers: [], _meta: {codex: {defaultToolsApprovalMode: mode}}}]});
        expect(start.mock.calls[0]![0].config?.["mcp_servers"]).toEqual({remote: {
            url: "https://example.com/mcp", http_headers: {}, default_tools_approval_mode: mode,
        }});
    });

    it.each([null, true, "never", [], {}])("rejects invalid approval mode %j before starting a thread", async mode => {
        const {client, start} = fixture();
        await expect(client.newSession({cwd: "/workspace", mcpServers: [{...owned,
            _meta: {codex: {defaultToolsApprovalMode: mode}}}]})).rejects.toThrow("defaultToolsApprovalMode");
        expect(start).not.toHaveBeenCalled();
    });

    it.each([null, "approve", []])("rejects malformed codex metadata %j", async codex => {
        const {client, start} = fixture();
        await expect(client.newSession({cwd: "/workspace", mcpServers: [{...owned,
            _meta: {codex}}]})).rejects.toThrow("_meta.codex must be an object");
        expect(start).not.toHaveBeenCalled();
    });

    it("leaves yolo and unmarked server configuration unchanged", async () => {
        vi.stubEnv("INITIAL_AGENT_MODE", "agent-full-access");
        const {client, start} = fixture();
        await client.newSession({cwd: "/workspace", mcpServers: [unmarked]});
        expect(start.mock.calls[0]![0].config).toMatchObject({approval_policy: "never",
            approvals_reviewer: "user", default_permissions: ":danger-full-access",
            mcp_servers: {"third-party": {command: "analyzer", args: [], env: {}}}});
        expect((start.mock.calls[0]![0].config?.["mcp_servers"] as any)["third-party"])
            .not.toHaveProperty("default_tools_approval_mode");
    });
});
