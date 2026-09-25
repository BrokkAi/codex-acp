import {GOAL_CONTROL_METHOD, type GoalLimitReason, type GoalSnapshot, type GoalStatus} from "./GoalExtension";
import type {ThreadGoal} from "./app-server/v2";

export type ThreadGoalSnapshot = GoalSnapshot;

function toGoalStatus(status: ThreadGoal["status"]): GoalStatus {
    switch (status) {
        case "active":
        case "paused":
        case "blocked":
        case "complete":
            return status;
        case "usageLimited":
        case "budgetLimited":
            return "limited";
    }
}

/**
 * Codex lets a budget-limited goal move to `usageLimited` when the account limit is also hit, so a
 * spent budget is read from the counters as well as from the status.
 */
export function goalLimitReason(goal: ThreadGoal): GoalLimitReason | undefined {
    switch (goal.status) {
        case "budgetLimited":
            return "budget";
        case "usageLimited":
            return goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget ? "budget" : "usage";
        case "active":
        case "paused":
        case "blocked":
        case "complete":
            return undefined;
    }
}

function toUnixMilliseconds(timestampSeconds: number): number {
    return timestampSeconds * 1000;
}

export function toThreadGoalSnapshot(goal: ThreadGoal): ThreadGoalSnapshot {
    const limitReason = goalLimitReason(goal);
    return {
        objective: goal.objective.trim(),
        status: toGoalStatus(goal.status),
        ...(limitReason === undefined ? {} : {limitReason}),
        tokenBudget: goal.tokenBudget,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
        createdAt: toUnixMilliseconds(goal.createdAt),
        updatedAt: toUnixMilliseconds(goal.updatedAt),
        controlMethod: GOAL_CONTROL_METHOD,
    };
}

export function sameThreadGoalSnapshot(
    left: ThreadGoalSnapshot | null | undefined,
    right: ThreadGoalSnapshot | null,
): boolean {
    if (left === undefined) return false;
    if (left === null || right === null) return left === right;
    return left.objective === right.objective
        && left.status === right.status
        && left.limitReason === right.limitReason
        && left.tokenBudget === right.tokenBudget
        && left.createdAt === right.createdAt;
}
