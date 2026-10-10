import {randomBytes} from "node:crypto";
import {createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse} from "node:http";
import {request as httpsRequest} from "node:https";
import type {AddressInfo} from "node:net";
import {pipeline} from "node:stream";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import {logger} from "./Logger";

type JsonObject = {[key: string]: JsonValue | undefined};

/** Codex records PostToolUse context before the actual result. DeepSeek rejects
 * that ordering even when every result is present (openai/codex#46193).
 * Move only interleaved developer context after a complete tool batch. Never
 * invent results, reorder separate reasoning steps, or split parallel calls.
 */
export function repairDeepSeekToolHistory(input: JsonValue[]): JsonValue[] {
    const repaired: JsonValue[] = [];
    for (let i = 0; i < input.length;) {
        if (!callKey(input[i])) {
            repaired.push(input[i++]!);
            continue;
        }
        const start = i;
        const calls: JsonValue[] = [];
        const outputs: JsonValue[] = [];
        const contexts: JsonValue[] = [];
        const pending = new Set<string>();
        let complete = false;
        for (; i < input.length; i++) {
            const item = input[i]!;
            const call = callKey(item);
            const output = outputKey(item);
            if (call && !pending.has(call)) {
                calls.push(item);
                pending.add(call);
            } else if (output && pending.delete(output)) {
                outputs.push(item);
            } else if (isObject(item) && item["type"] === "message" && item["role"] === "developer") {
                contexts.push(item);
            } else {
                break;
            }
            if (pending.size === 0) {
                i++;
                complete = true;
                break;
            }
        }
        if (complete && contexts.length > 0) {
            repaired.push(...calls, ...outputs, ...contexts);
        } else {
            // Unknown/incomplete batches retain their exact contents and order.
            repaired.push(...input.slice(start, i));
        }
    }
    return repaired.every((item, index) => item === input[index]) ? input : repaired;
}

function callKey(value: JsonValue | undefined): string | null {
    if (!isObject(value) || typeof value["call_id"] !== "string") return null;
    if (value["type"] === "function_call") return `function:${value["call_id"]}`;
    if (value["type"] === "custom_tool_call") return `custom:${value["call_id"]}`;
    return null;
}

function outputKey(value: JsonValue | undefined): string | null {
    if (!isObject(value) || typeof value["call_id"] !== "string") return null;
    if (value["type"] === "function_call_output") return `function:${value["call_id"]}`;
    if (value["type"] === "custom_tool_call_output") return `custom:${value["call_id"]}`;
    return null;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function repairBody(body: Buffer): Buffer {
    let request: JsonValue;
    try {
        request = JSON.parse(body.toString("utf8"));
    } catch {
        return body; // Let the provider report malformed requests itself.
    }
    if (!isObject(request) || !Array.isArray(request["input"])) return body;
    const original = request["input"];
    const repaired = repairDeepSeekToolHistory(original);
    if (repaired === original) return body;
    logger.log("Reordered DeepSeek tool batch context", {items: original.length});
    return Buffer.from(JSON.stringify({...request, input: repaired}));
}

const HOP_HEADERS = new Set(["host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
function forwardedHeaders(headers: IncomingMessage["headers"]): IncomingMessage["headers"] {
    const excluded = new Set([...HOP_HEADERS, ...(headers.connection ?? "").toLowerCase().split(",").map(value => value.trim())]);
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

/** An adapter-owned forwarder, not a separate daemon. The random route limits
 * access to the configured Codex process; the upstream is fixed, not caller-supplied.
 * Bodies, authorization headers, and tool contents are never logged.
 */
export class DeepSeekToolHistoryProxy {
    private readonly server: Server;
    private readonly prefix = `/${randomBytes(24).toString("hex")}`;
    private readonly upstream: URL;
    private startPromise: Promise<string> | null = null;

    constructor(baseUrl: string) {
        this.upstream = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
        this.server = createServer((request, response) => {
            void this.forward(request, response).catch(() => {
                if (!response.headersSent) response.writeHead(502, {"Content-Type": "application/json"});
                response.end(JSON.stringify({error: {message: "DeepSeek compatibility forwarder failed", type: "proxy_error"}}));
            });
        });
        // Codex's own timeout/cancellation governs upstream requests.
        this.server.requestTimeout = 0;
    }

    start(): Promise<string> {
        return this.startPromise ??= new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(0, "127.0.0.1", () => {
                this.server.off("error", reject);
                this.server.unref();
                const address = this.server.address() as AddressInfo;
                resolve(`http://127.0.0.1:${address.port}${this.prefix}`);
            });
        });
    }

    close(): void {
        this.server.close();
        this.server.closeAllConnections();
    }

    private async forward(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
        if (!incoming.url?.startsWith(`${this.prefix}/`)) {
            outgoing.writeHead(404).end();
            return;
        }
        const suffix = incoming.url.slice(this.prefix.length + 1);
        // Preserve the provider's base path, and forbid network-path URLs.
        const url = new URL(this.upstream);
        const route = new URL(`http://localhost/${suffix}`);
        url.pathname += route.pathname.slice(1);
        url.search = route.search;
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        let body: Buffer = Buffer.concat(chunks);
        const headers = forwardedHeaders(incoming.headers);
        if (incoming.method === "POST" && /(?:^|\/)responses(?:\/compact)?$/.test(url.pathname)
            && String(headers["content-type"] ?? "").startsWith("application/json")
            && !headers["content-encoding"]) {
            body = repairBody(body);
        }
        headers["content-length"] = String(body.length);
        const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
            method: incoming.method, headers,
        });
        const cancel = () => request.destroy();
        outgoing.on("close", cancel);
        request.on("error", () => {
            if (!outgoing.headersSent) outgoing.writeHead(502, {"Content-Type": "application/json"});
            outgoing.end(JSON.stringify({error: {message: "DeepSeek upstream connection failed", type: "proxy_error"}}));
        });
        request.on("response", response => {
            outgoing.writeHead(response.statusCode ?? 502, forwardedHeaders(response.headers));
            pipeline(response, outgoing, () => outgoing.off("close", cancel));
        });
        request.end(body);
    }
}

export class DeepSeekProviderRouting {
    private readonly proxies = new Map<string, DeepSeekToolHistoryProxy>();

    async configForSession(config: JsonObject, effectiveConfig: JsonObject, providerId: string | null): Promise<JsonObject> {
        const id = providerId ?? config["model_provider"] ?? effectiveConfig["model_provider"];
        if (typeof id !== "string") return config;
        const nativeProviders = isObject(effectiveConfig["model_providers"]) ? effectiveConfig["model_providers"] : {};
        const overrideProviders = isObject(config["model_providers"]) ? config["model_providers"] : {};
        const native = nativeProviders[id];
        const override = overrideProviders[id];
        const provider: JsonObject = {...(isObject(native) ? native : {}), ...(isObject(override) ? override : {})};
        if (typeof provider["base_url"] !== "string" || provider["wire_api"] !== "responses") return config;
        const url = new URL(provider["base_url"]);
        if (url.protocol !== "https:" || url.hostname !== "api.deepseek.com") return config;
        let proxy = this.proxies.get(url.href);
        if (!proxy) {
            proxy = new DeepSeekToolHistoryProxy(url.href);
            this.proxies.set(url.href, proxy);
        }
        return {
            ...config,
            // config/read contains redacted/processed native fields (including auth)
            // that cannot be round-tripped as config overrides. Let Codex inherit
            // its original provider and override only our routing and explicit inputs.
            model_providers: {...overrideProviders, [id]: {...(isObject(override) ? override : {}), base_url: await proxy.start(), supports_websockets: false}},
        };
    }

    close(): void {
        for (const proxy of this.proxies.values()) proxy.close();
        this.proxies.clear();
    }
}
