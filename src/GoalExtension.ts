import type {SessionId} from "@agentclientprotocol/sdk";

export const GOAL_EXTENSION_VERSION = 1;
export const GOAL_CONTROL_METHOD = "_session/goal";
export const LEGACY_GOAL_CONTROL_METHOD = "_codex/session/goal_control";

export const GOAL_CONTROL_ACTIONS = ["set", "pause", "resume", "clear"] as const;
export type GoalControlAction = typeof GOAL_CONTROL_ACTIONS[number];

export type GoalCapability = {
    version: typeof GOAL_EXTENSION_VERSION;
    controlMethod: typeof GOAL_CONTROL_METHOD;
    actions: GoalControlAction[];
    resumePolicies?: Array<"preserve" | "pause">;
}

export type GoalStatus = "active" | "paused" | "blocked" | "limited" | "complete";

/**
 * Why a `limited` goal stopped. `usage` is the account's usage limit, which ends when the limit
 * resets. `budget` is the goal's own token budget, which only the user can raise; it wins whenever
 * the budget is spent, even if Codex recorded the usage limit last.
 */
export type GoalLimitReason = "usage" | "budget";

export type GoalSnapshot = {
    objective: string;
    status: GoalStatus;
    limitReason?: GoalLimitReason;
    iterations?: number;
    lastReason?: string | null;
    createdAt?: number;
    updatedAt?: number;
    tokenBudget?: number | null;
    tokensUsed?: number;
    timeUsedSeconds?: number;
    controlMethod: typeof GOAL_CONTROL_METHOD;
}

export type GoalControlRequest =
    | { sessionId: SessionId; action: "set"; objective: string }
    | { sessionId: SessionId; action: Exclude<GoalControlAction, "set">; expectedGoal?: {objective: string; createdAt: number} }
