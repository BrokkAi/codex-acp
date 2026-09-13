import {RequestError} from "@agentclientprotocol/sdk";
import type {JsonValue} from "./app-server/serde_json/JsonValue";

export const CODEX_COLLABORATION_TOOL_NAMES = [
    "spawn_agent",
    "send_input",
    "send_message",
    "followup_task",
    "resume_agent",
    "wait_agent",
    "list_agents",
    "close_agent",
    "interrupt_agent",
] as const;

const CODEX_COLLABORATION_TOOLS = new Set<string>(CODEX_COLLABORATION_TOOL_NAMES);

type JsonObject = { [key: string]: JsonValue | undefined };

/**
 * Reads the Codex-private counterpart to Claude Code's disallowedTools option.
 * Codex currently exposes its collaboration tools as one feature family, so
 * disallowing any member removes the complete family from the model's tools.
 */
export function readDisallowedTools(meta?: Record<string, unknown> | null): string[] {
    const codex = meta?.["codex"];
    if (codex === undefined) return [];
    if (!isRecord(codex)) {
        throw RequestError.invalidParams(undefined, "_meta.codex must be an object");
    }

    const options = codex["options"];
    if (options === undefined) return [];
    if (!isRecord(options)) {
        throw RequestError.invalidParams(undefined, "_meta.codex.options must be an object");
    }

    const value = options["disallowedTools"];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw RequestError.invalidParams(undefined, "_meta.codex.options.disallowedTools must be an array");
    }

    const tools: string[] = [];
    const seen = new Set<string>();
    for (const tool of value) {
        if (typeof tool !== "string" || tool.length === 0) {
            throw RequestError.invalidParams(
                undefined,
                "_meta.codex.options.disallowedTools entries must be non-empty strings",
            );
        }
        if (!CODEX_COLLABORATION_TOOLS.has(tool)) {
            throw RequestError.invalidParams(
                undefined,
                `Codex ACP cannot disallow native tool ${JSON.stringify(tool)}; supported tools: ${CODEX_COLLABORATION_TOOL_NAMES.join(", ")}`,
            );
        }
        if (!seen.has(tool)) {
            seen.add(tool);
            tools.push(tool);
        }
    }
    return tools;
}

export function applyDisallowedTools(config: JsonObject, disallowedTools: string[]): JsonObject {
    if (disallowedTools.length === 0) return config;

    const configuredFeatures = isJsonValueObject(config["features"])
        ? config["features"]
        : {};
    const configuredAgents = isJsonValueObject(config["agents"])
        ? config["agents"]
        : {};
    return {
        ...config,
        // Model metadata can independently select a multi-agent version. This
        // master switch makes Config::multi_agent_version_override Disabled.
        agents: {
            ...configuredAgents,
            enabled: false,
        },
        features: {
            ...configuredFeatures,
            multi_agent: false,
            multi_agent_v2: false,
        },
    };
}

export function createDisallowedToolsMeta(disallowedTools: string[]): Record<string, unknown> | undefined {
    return disallowedTools.length === 0
        ? undefined
        : {codex: {options: {disallowedTools}}};
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValueObject(value: JsonValue | undefined): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
