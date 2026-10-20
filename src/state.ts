export type Status = "active" | "paused" | "complete" | "closed";
export interface Goal { text: string; status: Status; elapsedMs: number }
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
  set(text: string) {
    this.goal = { text, status: "active", elapsedMs: 0 };
    this.since = this.now();
  }
  transition(status: Status) {
    if (!this.goal) return;
    this.goal = { ...this.goal, elapsedMs: this.elapsed(), status };
    this.since = status === "active" ? this.now() : undefined;
  }
  restore(value: unknown) {
    this.goal = undefined;
    this.since = undefined;
    if (!value || typeof value !== "object") return;
    const g = value as Goal;
    if (typeof g.text !== "string" || !g.text.trim() ||
        !["active", "paused", "complete", "closed"].includes(g.status) ||
        !Number.isFinite(g.elapsedMs) || g.elapsedMs < 0) return;
    this.goal = { text: g.text, elapsedMs: g.elapsedMs, status: g.status === "active" ? "paused" : g.status };
  }
}
export function reminder(text: string, kind: "set" | "changed" | "resumed" | "still active") {
  return `goal ${kind}: ${text}\n\nUse codemode tools.goal_update({status:"complete"|"pause"}) when done or blocked.`;
}
export function duration(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m ${s % 60}s`;
}
