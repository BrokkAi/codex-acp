import {afterEach, describe, expect, it, vi} from "vitest";
import {createServer, type Server, type RequestListener} from "node:http";
import type {AddressInfo} from "node:net";
import {DeepSeekProviderRouting, DeepSeekToolHistoryProxy, repairDeepSeekToolHistory} from "../DeepSeekToolHistoryProxy";
import type {JsonValue} from "../app-server/serde_json/JsonValue";
import {createCodexMockTestFixture, createTestModel} from "./acp-test-utils";
import {CodexAcpClient} from "../CodexAcpClient";

const call = (id: string): JsonValue => ({type: "function_call", call_id: id, name: "exec_command", arguments: '{"cmd":"actual command"}'});
const result = (id: string): JsonValue => ({type: "function_call_output", call_id: id, output: "actual result"});
const hook: JsonValue = {type: "message", role: "developer", content: [{type: "input_text", text: "new supervisor instruction"}]};
const reason: JsonValue = {type: "reasoning", content: [{type: "reasoning_text", text: "reasoning is preserved"}]};

describe("DeepSeek mailbox tool history compatibility", () => {
    const cleanup: Array<() => void> = [];
    afterEach(() => {
        cleanup.splice(0).forEach(close => close());
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    // Hard-won: openai/codex#46193: a hook between a call and its real output is rejected as missing output.
    it("preserves whole parallel tool batches and moves only interleaved developer context", async () => {
        const scenarios = [
            [reason, call("A"), hook, result("A")],
            [reason, call("A"), call("B"), hook, result("B"), hook, result("A")],
            [reason, call("A"), hook, call("B"), result("A"), result("B")],
            [reason, call("A"), hook, result("A"), reason, call("B"), hook, result("B")],
            [{type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: "patch"}, hook,
                {type: "custom_tool_call_output", call_id: "patch", output: [{type: "input_text", text: "patched"}]}],
        ] as JsonValue[][];
        await expect(scenarios.map(repairDeepSeekToolHistory)).toMatchFileSnapshot("data/deepseek-tool-history.json");
        for (const input of scenarios) {
            const repaired = repairDeepSeekToolHistory(input);
            expect(repaired).toHaveLength(input.length);
            for (const original of input) expect(repaired).toContain(original);
            expect(repairDeepSeekToolHistory(repaired)).toBe(repaired);
        }
    });

    it("passes complete, incomplete, duplicate, and unfamiliar histories through unchanged", () => {
        const cases: JsonValue[][] = [
            [reason, call("A"), result("A"), hook],
            [reason, call("A"), call("B"), result("A"), result("B")],
            [reason, call("A"), hook],
            [reason, call("A"), hook, reason, result("A")],
            [call("A"), hook, {type: "message", role: "user", content: "interrupt"}, result("A")],
            [call("A"), hook, call("A"), result("A")],
            [{type: "function_call_output", output: "standalone context"}],
        ];
        for (const input of cases) expect(repairDeepSeekToolHistory(input)).toBe(input);
    });

    async function upstream(handler: RequestListener): Promise<string> {
        const server: Server = createServer(handler);
        cleanup.push(() => {server.close(); server.closeAllConnections();});
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    }

    it("forwards repaired requests, auth and streamed responses; complete requests retain body bytes", async () => {
        const requests: Array<{path: string | undefined; auth: string | undefined; body: string}> = [];
        const base = await upstream(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            requests.push({path: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString()});
            res.writeHead(200, {"Content-Type": "text/event-stream", "x-upstream": "preserved"});
            res.write("data: first\n\n");
            setImmediate(() => res.end("data: second\n\n"));
        });
        const proxy = new DeepSeekToolHistoryProxy(base);
        cleanup.push(() => proxy.close());
        const url = await proxy.start();
        const broken = JSON.stringify({model: "deepseek-flash", stream: true, input: [reason, call("A"), hook, result("A")]});
        const complete = JSON.stringify({input: [reason, call("A"), result("A"), hook], preservedUnicode: "λ".repeat(100_000)}, null, 4) + "\n";
        for (const [path, body] of [["responses?trace=test", broken], ["responses/compact", complete], ["other", complete]] as const) {
            const response = await fetch(`${url}/${path}`, {method: "POST", headers: {"Content-Type": "application/json", Authorization: "Bearer test-only"}, body});
            expect(response.status).toBe(200);
            expect(response.headers.get("x-upstream")).toBe("preserved");
            expect(await response.text()).toBe("data: first\n\ndata: second\n\n");
        }
        expect(requests[0]).toEqual({path: "/v1/responses?trace=test", auth: "Bearer test-only", body: JSON.stringify({model: "deepseek-flash", stream: true, input: [reason, call("A"), result("A"), hook]})});
        expect(requests[1]!.body).toBe(complete);
        expect(requests[2]!.body).toBe(complete);
        const missingRoute = new URL(url); missingRoute.pathname = "/responses";
        expect((await fetch(missingRoute)).status).toBe(404);
        expect(requests).toHaveLength(3);
    });

    it("propagates upstream 503s and aborts upstream streaming when Codex disconnects", async () => {
        let closed!: () => void;
        const cancelled = new Promise<void>(resolve => {closed = resolve;});
        const base = await upstream((req, res) => {
            if (req.url === "/v1/responses?error") {
                res.writeHead(503, {"Retry-After": "1", "Content-Type": "application/json"}).end('{"error":"provider unavailable"}');
            } else {
                res.writeHead(200, {"Content-Type": "text/event-stream"});
                res.write("data: start\n\n");
                res.on("close", closed);
            }
        });
        const proxy = new DeepSeekToolHistoryProxy(base); cleanup.push(() => proxy.close());
        const url = await proxy.start();
        const failed = await fetch(`${url}/responses?error`);
        expect(failed.status).toBe(503);
        expect(failed.headers.get("retry-after")).toBe("1");
        expect(await failed.text()).toBe('{"error":"provider unavailable"}');
        const response = await fetch(`${url}/responses`);
        const reader = response.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        await reader.cancel();
        await cancelled;
    });

    for (const mode of ["agent", "agent-full-access"]) {
        it(`routes new and resumed ${mode} sessions through the bridge without changing auth or other providers`, async () => {
            vi.stubEnv("INITIAL_AGENT_MODE", mode);
            const fixture = createCodexMockTestFixture();
            const server = fixture.getCodexAppServerClient();
            const config = {model_provider: "deepseek", model_providers: {
                deepseek: {name: "DeepSeek", wire_api: "responses", base_url: "https://api.deepseek.com/v1", env_key: "DEEPSEEK_API_KEY", http_headers: {"X-Extra": "keep"}},
                other: {base_url: "https://other.example/v1", wire_api: "responses"},
            }};
            const read = vi.spyOn(server, "configRead").mockResolvedValue({config} as never);
            vi.spyOn(server, "listModels").mockResolvedValue({data: [createTestModel()], nextCursor: null});
            const start = vi.spyOn(server, "threadStart").mockResolvedValue({thread: {id: "session"}, model: "gpt-5", reasoningEffort: "medium"} as never);
            const resume = vi.spyOn(server, "threadResume").mockResolvedValue({thread: {id: "session"}, model: "gpt-5", reasoningEffort: "medium", modelProvider: "deepseek"} as never);
            await fixture.getCodexAcpClient().newSession({cwd: "/workspace", mcpServers: []});
            const provider = (start.mock.calls[0]![0].config!["model_providers"] as any).deepseek;
            expect(provider).toMatchObject({base_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//), supports_websockets: false});
            await fixture.getCodexAcpClient().resumeSession({sessionId: "session", cwd: "/workspace"});
            expect((resume.mock.calls[0]![0].config!["model_providers"] as any).deepseek.base_url).toBe(provider.base_url);
            // A config override may select a different provider, retaining native routing.
            const other = new CodexAcpClient(server, {}, "other");
            await other.newSession({cwd: "/workspace", mcpServers: []});
            expect(start.mock.calls.at(-1)![0].config).not.toHaveProperty("model_providers");
            expect(read).toHaveBeenCalled();
        });
    }

    it("cleans up its listener and keeps explicit provider fields when applying a partial override", async () => {
        const routing = new DeepSeekProviderRouting(); cleanup.push(() => routing.close());
        const configured = await routing.configForSession({model_providers: {deepseek: {http_headers: {"X-Test": "yes"}}}}, {
            model_provider: "deepseek", model_providers: {deepseek: {base_url: "https://api.deepseek.com/v1", wire_api: "responses", env_key: "KEEP_KEY", auth: ""}},
        }, null);
        const provider = (configured["model_providers"] as any).deepseek;
        expect(provider).toMatchObject({http_headers: {"X-Test": "yes"}});
        expect(provider).not.toHaveProperty("env_key");
        expect(provider).not.toHaveProperty("auth");
        routing.close();
        await expect(fetch(`${provider.base_url}/responses`)).rejects.toThrow();
    });
});
