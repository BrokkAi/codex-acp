import type {
    ApprovalHandler,
    CodexAppServerClient,
    ElicitationHandler,
} from "../CodexAppServerClient";
import type {ServerNotification} from "../app-server";
import type {Thread} from "../app-server/v2";
import {isRootAgentPath} from "./CodexAgentPath";

export type SubagentInteraction = <T>(
    sessionId: string, itemId: string | undefined, request: () => Promise<T>, turnId?: string | null,
) => Promise<T>;

type Subscription = {
    rootSessionId: string;
    supportsSubagents: boolean;
    dispatch(event: ServerNotification): void;
    enqueueInteraction(event: ServerNotification): void;
    approvalHandler: ApprovalHandler;
    elicitationHandler: ElicitationHandler;
    waitForRootNotifications(): Promise<void>;
    waitForChildSession(childThreadId: string): Promise<string | null>;
    withUserAction?: SubagentInteraction;
    observeWorkEnd?: (event: ServerNotification) => void;
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
            session.current.observeWorkEnd?.(event);
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

    redispatch(rootSessionId: string, notifications: ServerNotification[]): void {
        const session = this.sessions.get(rootSessionId);
        if (session) for (const notification of notifications) session.current.dispatch(notification);
    }

    isChildThread(threadId: string): boolean {
        return [...this.sessions.values()].some(session => session.children.has(threadId));
    }

    async restoreChild(rootSessionId: string, parentThreadId: string, thread: Thread): Promise<Thread | null> {
        const session = this.sessions.get(rootSessionId);
        if (!session || session.children.has(thread.id) || thread.parentThreadId !== parentThreadId
            || (parentThreadId !== rootSessionId && !session.children.has(parentThreadId))) return null;
        if (!this.attachChild(session, thread.id)) return null;
        if (thread.status.type === "notLoaded") return null;
        try {
            const response = await this.client.threadResume({threadId: thread.id, excludeTurns: true});
            if (this.sessions.get(rootSessionId) === session && response.thread.id === thread.id
                && response.thread.parentThreadId === parentThreadId && response.thread.status.type !== "notLoaded") return response.thread;
        } catch (error) {
            this.detachChild(session, thread.id);
            throw error;
        }
        this.detachChild(session, thread.id);
        return null;
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
            this.attachChild(session, childSessionId);
        }
    }

    private attachChild(session: SessionSubscription, childSessionId: string): boolean {
        if ([...this.sessions.values()].some(other => other !== session
            && (other.current.rootSessionId === childSessionId || other.children.has(childSessionId)))) return false;
        session.children.add(childSessionId);
        this.client.onServerNotification(childSessionId, event => {
            if ((event.params as {threadId?: unknown}).threadId !== childSessionId) return;
            this.discover(session, event);
            session.current.observeWorkEnd?.(event);
            if (session.current.supportsSubagents) session.current.dispatch(event);
            else session.current.enqueueInteraction(this.rootAttributed(event, session.current.rootSessionId));
        });
        this.registerInteractiveHandlers(session, childSessionId);
        return true;
    }

    private detachChild(session: SessionSubscription, childSessionId: string): void {
        if (this.sessions.get(session.current.rootSessionId) !== session || !session.children.delete(childSessionId)) return;
        if (!this.sessions.has(childSessionId)) this.client.clearThreadHandlers(childSessionId);
    }

    private registerInteractiveHandlers(session: SessionSubscription, targetSessionId: string): void {
        this.client.onApprovalRequest(targetSessionId, {
            handleCommandExecution: async (params) => {
                await session.current.waitForRootNotifications();
                const current = session.current;
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {decision: "cancel"};
                const request = () => current.approvalHandler.handleCommandExecution({...params, threadId: sessionId});
                return current.withUserAction ? current.withUserAction(sessionId, params.itemId, request, params.turnId) : request();
            },
            handleFileChange: async (params) => {
                await session.current.waitForRootNotifications();
                const current = session.current;
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {decision: "cancel"};
                const request = () => current.approvalHandler.handleFileChange({...params, threadId: sessionId});
                return current.withUserAction ? current.withUserAction(sessionId, params.itemId, request, params.turnId) : request();
            },
            handlePermissionsRequest: async (params) => {
                await session.current.waitForRootNotifications();
                const current = session.current;
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {permissions: {}, scope: "turn", strictAutoReview: false};
                const request = () => current.approvalHandler.handlePermissionsRequest({...params, threadId: sessionId});
                return current.withUserAction ? current.withUserAction(sessionId, params.itemId, request, params.turnId) : request();
            },
        });
        this.client.onElicitationRequest(targetSessionId, {
            handleElicitation: async (params) => {
                await session.current.waitForRootNotifications();
                const current = session.current;
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {action: "cancel", content: null, _meta: null};
                const request = () => current.elicitationHandler.handleElicitation({...params, threadId: sessionId});
                return current.withUserAction ? current.withUserAction(sessionId, undefined, request, params.turnId) : request();
            },
            handleUserInput: async (params) => {
                await session.current.waitForRootNotifications();
                const current = session.current;
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {answers: {}};
                const request = () => current.elicitationHandler.handleUserInput({...params, threadId: sessionId});
                return current.withUserAction ? current.withUserAction(sessionId, params.itemId, request, params.turnId) : request();
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
