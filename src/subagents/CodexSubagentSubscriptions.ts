import type {
    ApprovalHandler,
    CodexAppServerClient,
    ElicitationHandler,
} from "../CodexAppServerClient";
import type {ServerNotification} from "../app-server";
import {isRootAgentPath} from "./CodexAgentPath";

type Subscription = {
    rootSessionId: string;
    supportsSubagents: boolean;
    dispatch(event: ServerNotification): void;
    enqueueInteraction(event: ServerNotification): void;
    approvalHandler: ApprovalHandler;
    elicitationHandler: ElicitationHandler;
    waitForRootNotifications(): Promise<void>;
    waitForChildSession(childThreadId: string): Promise<string | null>;
};

type SessionSubscription = {
    current: Subscription;
    children: Set<string>;
    activate?: (subscription: Subscription | null) => void;
};

/** Discovers child threads and keeps their output/interaction boundary negotiated. */
export class CodexSubagentSubscriptions {
    private readonly sessions = new Map<string, SessionSubscription>();

    constructor(private readonly client: CodexAppServerClient) {}

    /** Observe native resume before it can launch autonomous work. */
    prepare(rootSessionId: string): void {
        if (this.sessions.has(rootSessionId)) return;
        const buffered: ServerNotification[] = [];
        let activate!: (subscription: Subscription | null) => void;
        const ready = new Promise<Subscription | null>(resolve => { activate = resolve; });
        const current = async (): Promise<Subscription> => {
            const subscription = await ready;
            if (!subscription) throw new Error("Session closed while opening");
            return subscription;
        };
        this.subscribe({
            rootSessionId,
            supportsSubagents: true,
            dispatch: event => { buffered.push(event); },
            enqueueInteraction: event => { buffered.push(event); },
            approvalHandler: {
                handleCommandExecution: async params => (await current()).approvalHandler.handleCommandExecution(params),
                handleFileChange: async params => (await current()).approvalHandler.handleFileChange(params),
                handlePermissionsRequest: async params => (await current()).approvalHandler.handlePermissionsRequest(params),
            },
            elicitationHandler: {
                handleElicitation: async params => (await current()).elicitationHandler.handleElicitation(params),
                handleUserInput: async params => (await current()).elicitationHandler.handleUserInput(params),
            },
            waitForRootNotifications: async () => (await current()).waitForRootNotifications(),
            waitForChildSession: async id => (await current()).waitForChildSession(id),
        });
        this.sessions.get(rootSessionId)!.activate = subscription => {
            activate(subscription);
            if (subscription) for (const event of buffered) {
                const threadId = (event.params as {threadId?: unknown}).threadId;
                if (!subscription.supportsSubagents && typeof threadId === "string" && threadId !== rootSessionId) {
                    subscription.enqueueInteraction(this.rootAttributed(event, rootSessionId));
                } else subscription.dispatch(event);
            }
            buffered.length = 0;
        };
    }

    subscribe(subscription: Subscription): void {
        const existing = this.sessions.get(subscription.rootSessionId);
        if (existing) {
            existing.current = subscription;
            existing.activate?.(subscription);
            delete existing.activate;
            return;
        }

        const session = {current: subscription, children: new Set<string>()};
        this.sessions.set(subscription.rootSessionId, session);
        this.client.onServerNotification(subscription.rootSessionId, (event) => {
            // Register synchronously: app-server may emit child output directly
            // after the spawning collaboration item.
            this.discover(session, event);
            session.current.dispatch(event);
        });
        this.registerInteractiveHandlers(session, subscription.rootSessionId);
    }

    clear(rootSessionId: string): void {
        for (const childSessionId of this.sessions.get(rootSessionId)?.children ?? []) {
            this.client.clearThreadHandlers(childSessionId);
        }
        this.sessions.get(rootSessionId)?.activate?.(null);
        this.sessions.delete(rootSessionId);
    }

    private discover(session: SessionSubscription, event: ServerNotification): void {
        if (event.method !== "item/started" && event.method !== "item/completed") {
            return;
        }
        const item = event.params.item;
        const childSessionIds = item.type === "collabAgentToolCall" && item.tool === "spawnAgent"
            ? item.receiverThreadIds
            : item.type === "subAgentActivity" && item.kind !== "interrupted" && !isRootAgentPath(item.agentPath)
                ? [item.agentThreadId]
                : [];
        for (const childSessionId of childSessionIds) {
            if (childSessionId.trim() === "") continue;
            if (childSessionId === session.current.rootSessionId
                || childSessionId === event.params.threadId
                || session.children.has(childSessionId)) {
                continue;
            }
            session.children.add(childSessionId);
            this.client.onServerNotification(childSessionId, (childEvent) => {
                const eventThreadId = (childEvent.params as {threadId?: unknown}).threadId;
                if (eventThreadId !== childSessionId) return;
                this.discover(session, childEvent);
                if (session.current.supportsSubagents) session.current.dispatch(childEvent);
                else session.current.enqueueInteraction(this.rootAttributed(childEvent, session.current.rootSessionId));
            });
            // Hidden children keep only root-attributed permission requests.
            this.registerInteractiveHandlers(session, childSessionId);
        }
    }

    private registerInteractiveHandlers(session: SessionSubscription, targetSessionId: string): void {
        this.client.onApprovalRequest(targetSessionId, {
            handleCommandExecution: async (params) => {
                await session.current.waitForRootNotifications();
                const current = session.current;
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {decision: "cancel"};
                return await current.approvalHandler.handleCommandExecution(
                    {...params, threadId: sessionId},
                );
            },
            handleFileChange: async (params) => {
                await session.current.waitForRootNotifications();
                const current = session.current;
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {decision: "cancel"};
                return await current.approvalHandler.handleFileChange(
                    {...params, threadId: sessionId},
                );
            },
            handlePermissionsRequest: async (params) => {
                await session.current.waitForRootNotifications();
                const current = session.current;
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {permissions: {}, scope: "turn", strictAutoReview: false};
                return await current.approvalHandler.handlePermissionsRequest(
                    {...params, threadId: sessionId},
                );
            },
        });
        this.client.onElicitationRequest(targetSessionId, {
            handleElicitation: async (params) => {
                await session.current.waitForRootNotifications();
                const current = session.current;
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {action: "cancel", content: null, _meta: null};
                return await current.elicitationHandler.handleElicitation(
                    {...params, threadId: sessionId},
                );
            },
            handleUserInput: async (params) => {
                await session.current.waitForRootNotifications();
                const current = session.current;
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {answers: {}};
                return await current.elicitationHandler.handleUserInput(
                    {...params, threadId: sessionId},
                );
            },
        });
    }

    private async interactionSessionId(
        subscription: Subscription,
        targetSessionId: string,
    ): Promise<string | null> {
        if (targetSessionId === subscription.rootSessionId) return targetSessionId;
        if (!subscription.supportsSubagents) return subscription.rootSessionId;
        return await subscription.waitForChildSession(targetSessionId);
    }

    private rootAttributed(event: ServerNotification, rootSessionId: string): ServerNotification {
        if (typeof (event.params as {threadId?: unknown}).threadId !== "string") return event;
        return {
            ...event,
            params: {...event.params, threadId: rootSessionId},
        } as ServerNotification;
    }
}
