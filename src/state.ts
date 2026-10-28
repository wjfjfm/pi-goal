export type Status = "active" | "paused" | "blocked" | "complete" | "closed";
export interface Goal {
  text: string; status: Status; elapsedMs: number;
  setBy?: "user"; setAt?: number; resumedAt?: number;
}
export interface Snapshot { version: 3; goal: Goal | null }
const statuses: Status[] = ["active", "paused", "blocked", "complete", "closed"];
const timestamp = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 8.64e15;
export class GoalState {
  goal: Goal | null = null;
  private since: number | undefined;
  constructor(private now = Date.now) {}
  elapsed() { return (this.goal?.elapsedMs ?? 0) + (this.since === undefined ? 0 : Math.max(0,this.now()-this.since)); }
  snapshot(): Snapshot { return {version:3,goal:this.goal && {...this.goal,elapsedMs:this.elapsed()}}; }
  set(text: string) {
    text=text.trim();
    if (!text) throw new Error("Goal text must not be blank.");
    const now=this.now();
    this.goal={text,status:"active",elapsedMs:0,setBy:"user",setAt:now};
    this.since=now;
  }
  transition(status: Status) {
    if (!this.goal || this.goal.status === status) return;
    const now=this.now();
    this.goal={...this.goal,status,elapsedMs:this.elapsed(),...(status === "active" ? {resumedAt:now} : {})};
    this.since=status === "active" ? now : undefined;
  }
  resume() {
    if (this.goal?.status !== "paused" && this.goal?.status !== "blocked") throw new Error("No paused or blocked goal to resume.");
    this.transition("active");
  }
  restore(value: unknown) {
    this.goal=null; this.since=undefined;
    if (!value || typeof value !== "object") return;
    const v=value as Record<string,unknown>;
    let raw: unknown=v.version === 3 ? v.goal : v;
    if (v.version === 2) {
      // Keep only the latest user-created root. Do not adopt assistant tasks or
      // resurrect an older root when the latest one was cancelled/deleted.
      if (!Array.isArray(v.goals)) return;
      const g=[...v.goals].reverse().find(g=>g && typeof g === "object" && g.setBy === "user" && !g.parentId);
      if (!g || !["todo","doing","blocked","done","cancelled"].includes(g.status)) return;
      raw={text:g.text,setBy:"user",setAt:g.setAt,elapsedMs:0,
        status:g.deletedAt !== undefined || g.status === "cancelled" ? "closed" : g.status === "done" ? "complete" : g.status === "blocked" ? "blocked" : "paused"};
    }
    if (!raw || typeof raw !== "object") return;
    const g=raw as Goal & {agentTurnsRemaining?: unknown};
    if (typeof g.text !== "string" || !g.text.trim() || !statuses.includes(g.status) || !Number.isFinite(g.elapsedMs) || g.elapsedMs < 0) return;
    // Earlier assistant-created single goals are not new user authorization.
    if (g.agentTurnsRemaining !== undefined) return;
    this.goal={text:g.text,status:g.status === "active" ? "paused" : g.status,elapsedMs:g.elapsedMs,
      ...(g.setBy === "user" ? {setBy:"user"} : {}),...(timestamp(g.setAt) ? {setAt:g.setAt} : {}),...(timestamp(g.resumedAt) ? {resumedAt:g.resumedAt} : {})};
  }
}
export function duration(ms: number) {
  const s=Math.floor(ms/1000);
  return `${Math.floor(s/3600)}h ${Math.floor(s/60)%60}m ${s%60}s`;
}
