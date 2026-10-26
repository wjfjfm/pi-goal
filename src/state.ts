export type Status = "active" | "paused" | "complete" | "closed";
export const AGENT_TURN_BUDGET = 20;
export interface Goal { text: string; status: Status; elapsedMs: number; setAt?: number; resumedAt?: number; agentTurnsRemaining?: number }
export class GoalState {
  goal: Goal | undefined;
  private since: number | undefined;
  constructor(private now = Date.now) {}
  elapsed() {
    return (this.goal?.elapsedMs ?? 0) + (this.since === undefined ? 0 : Math.max(0, this.now() - this.since));
  }
  snapshot(): Goal | undefined {
    return this.goal && { ...this.goal, elapsedMs: this.elapsed() };
  }
  set(text: string, agent = false) {
    this.since = this.now();
    this.goal = { text, status: "active", elapsedMs: 0, setAt: this.since,
      ...(agent ? { agentTurnsRemaining: AGENT_TURN_BUDGET } : {}) };
  }
  consumeTurn() {
    if (this.goal?.status !== "active" || this.goal.agentTurnsRemaining === undefined) return false;
    this.goal = { ...this.goal, agentTurnsRemaining: Math.max(0, this.goal.agentTurnsRemaining - 1) };
    return this.goal.agentTurnsRemaining === 0;
  }
  transition(status: Status) {
    if (!this.goal) return;
    const now = this.now();
    this.goal = { ...this.goal, elapsedMs: this.elapsed(), status,
      ...(status === "active" && this.goal.status !== "active" ? { resumedAt: now,
        ...(this.goal.agentTurnsRemaining !== undefined ? { agentTurnsRemaining: AGENT_TURN_BUDGET } : {}) } : {}) };
    this.since = status === "active" ? now : undefined;
  }
  restore(value: unknown) {
    this.goal = undefined;
    this.since = undefined;
    if (!value || typeof value !== "object") return;
    const g = value as Goal;
    if (typeof g.text !== "string" || !g.text.trim() ||
        !["active", "paused", "complete", "closed"].includes(g.status) ||
        !Number.isFinite(g.elapsedMs) || g.elapsedMs < 0) return;
    const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
    this.goal = { text: g.text, elapsedMs: g.elapsedMs, status: g.status === "active" ? "paused" : g.status,
      ...(timestamp(g.setAt) ? {setAt:g.setAt} : {}),
      ...(timestamp(g.resumedAt) ? {resumedAt:g.resumedAt} : {}),
      ...(g.agentTurnsRemaining !== undefined ? {agentTurnsRemaining: Number.isInteger(g.agentTurnsRemaining) && g.agentTurnsRemaining >= 0 && g.agentTurnsRemaining <= AGENT_TURN_BUDGET ? g.agentTurnsRemaining : 0} : {}) };
  }
}
export function reminder(text: string, kind: "set" | "changed" | "resumed" | "still active") {
  return `goal ${kind}: ${text}\n\nUse codemode tools.goal_show({}) to inspect the goal, or tools.goal_update({status:"complete"|"pause"}) when done or blocked.`;
}
export function duration(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m ${s % 60}s`;
}
