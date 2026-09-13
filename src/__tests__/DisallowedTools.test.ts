import {describe, expect, it} from "vitest";
import {
    applyDisallowedTools,
    createDisallowedToolsMeta,
    readDisallowedTools,
} from "../DisallowedTools";

describe("Codex disallowedTools metadata", () => {
    it("reads and deduplicates the Claude-shaped private option", () => {
        expect(readDisallowedTools({
            codex: {options: {disallowedTools: ["spawn_agent", "spawn_agent", "wait_agent"]}},
        })).toEqual(["spawn_agent", "wait_agent"]);
    });

    it("disables both collaboration feature generations while preserving other features", () => {
        expect(applyDisallowedTools({
            agents: {
                max_concurrent_threads_per_session: 8,
                enabled: true,
            },
            features: {
                web_search: true,
                multi_agent: true,
                multi_agent_v2: {enabled: true, wait_agent_enabled: true},
            },
        }, ["spawn_agent"])).toEqual({
            agents: {
                max_concurrent_threads_per_session: 8,
                enabled: false,
            },
            features: {
                web_search: true,
                multi_agent: false,
                multi_agent_v2: false,
            },
        });
    });

    it("rejects malformed and unenforceable policies", () => {
        expect(() => readDisallowedTools({
            codex: {options: {disallowedTools: "spawn_agent"}},
        })).toThrow("disallowedTools must be an array");
        expect(() => readDisallowedTools({
            codex: {options: {disallowedTools: ["exec_command"]}},
        })).toThrow("cannot disallow native tool \"exec_command\"");
    });

    it("reconstructs metadata only for a non-empty policy", () => {
        expect(createDisallowedToolsMeta([])).toBeUndefined();
        expect(createDisallowedToolsMeta(["spawn_agent"])).toEqual({
            codex: {options: {disallowedTools: ["spawn_agent"]}},
        });
    });
});
