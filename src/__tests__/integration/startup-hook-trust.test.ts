import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {expect, it} from "vitest";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {prepareCodexHookConfig} from "../../CodexHookConfig";
import {listCodexHooks} from "../../CodexHookTrust";
import {startCodexConnection} from "../../CodexJsonRpcConnection";
import {CodexAppServerSupervisor} from "../../app-server-recovery/CodexAppServerSupervisor";
import {codexTestEnvironment} from "../acp-test-utils";
import {describeIntegration} from "./integration-fixture";

// Mj hashes recursively sorted JSON of Codex's TOML command-hook identity.
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    }
    return value;
}

describeIntegration("integration: caller-trusted startup hooks", () => {
    it("preserves a precomputed Mj hook hash and leaves other hooks untrusted after app-server replacement", async () => {
        fs.mkdirSync(path.join(process.cwd(), "tmp"), {recursive: true});
        const root = fs.mkdtempSync(path.join(process.cwd(), "tmp", "startup-hook-trust-"));
        const command = "mj worker mailbox-hook --socket /unused/control.sock --event PostToolUse";
        const identity = {event_name: "post_tool_use", hooks: [{type: "command", command, timeout: 20, async: false}]};
        const trustedHash = `sha256:${createHash("sha256").update(JSON.stringify(canonical(identity))).digest("hex")}`;
        const prepared = prepareCodexHookConfig({hooks: {
            PostToolUse: [{hooks: [{type: "command", command, timeout: 20}]}, {hooks: [{type: "command", command: "echo untrusted"}]}],
            state: {"/<session-flags>/config.toml:post_tool_use:0:0": {enabled: true, trusted_hash: trustedHash}},
        }});
        const env = codexTestEnvironment({CODEX_HOME: root});
        const initial = startCodexConnection(undefined, env, prepared.appServerStartupArgs, {disposeOnExit: false});
        const state = {connection: initial, codexPath: undefined, appServerStartupArgs: prepared.appServerStartupArgs, stderr: ""};
        const supervisor = new CodexAppServerSupervisor(state, (codexPath, args) => startCodexConnection(codexPath, env, args, {disposeOnExit: false}));
        try {
            for (let generation = 0; generation < 2; generation++) {
                const client = new CodexAppServerClient(state.connection.connection);
                await client.initialize({clientInfo: {name: "startup-hook-trust-test", version: "1", title: null}, capabilities: {experimentalApi: true, requestAttestation: false}});
                const entry = await listCodexHooks(client, root);
                expect(entry.errors).toEqual([]);
                expect(entry.hooks).toEqual(expect.arrayContaining([
                    expect.objectContaining({command, currentHash: trustedHash, trustStatus: "trusted", source: "sessionFlags"}),
                    expect.objectContaining({command: "echo untrusted", trustStatus: "untrusted"}),
                ]));
                if (generation === 0) {
                    state.connection.process.kill("SIGKILL");
                    await supervisor.current.exited;
                    supervisor.spawn();
                }
            }
        } finally {
            await supervisor.stop();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });
});
