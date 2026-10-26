import { randomUUID } from "node:crypto";
export const statuses = ["todo", "doing", "blocked", "done", "cancelled"] as const;
export type Status = typeof statuses[number];
export type Actor = "user" | "assistant";
export interface Goal {
  id: string; text: string; status: Status; parentId?: string;
  // Missing only for legacy records whose author cannot be recovered.
  setBy?: Actor; updatedBy?: Actor; setAt?: number; updatedAt?: number; deletedAt?: number;
}
export interface Run {
  status: "active" | "paused" | "complete";
  ids: string[]; elapsedMs: number; resumedAt?: number;
}
export interface Snapshot { version: 2; goals: Goal[]; run: Run | null }
const timestamp = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 8.64e15;
const actor = (v: unknown): v is Actor => v === "user" || v === "assistant";
export class GoalState {
  goals: Goal[] = [];
  run: Run | null = null;
  private since: number | undefined;
  constructor(private now = Date.now) {}
  elapsed() { return (this.run?.elapsedMs ?? 0) + (this.since === undefined ? 0 : Math.max(0, this.now() - this.since)); }
  snapshot(): Snapshot { return {version:2, goals:this.goals.map(g=>({...g})), run:this.run && {...this.run,ids:[...this.run.ids],elapsedMs:this.elapsed()}}; }
  visible() { return this.goals.filter(g=>g.deletedAt === undefined); }
  outline() {
    const children = new Map<string | undefined, Goal[]>();
    for (const g of this.visible()) {
      const group = children.get(g.parentId) ?? [];
      group.push(g); children.set(g.parentId, group);
    }
    const stack = (children.get(undefined) ?? []).map(goal=>({goal,depth:0})).reverse();
    const rows: {goal: Goal; depth: number}[] = [];
    while (stack.length) {
      const row = stack.pop()!; rows.push(row);
      const nested = children.get(row.goal.id) ?? [];
      for (let i=nested.length-1;i>=0;i--) stack.push({goal:nested[i],depth:row.depth+1});
    }
    return rows;
  }
  get(id: string) {
    const g = this.goals.find(g=>g.id === id);
    if (!g) throw new Error(`Unknown goal: ${id}`);
    return g;
  }
  add(text: string, by: Actor, parentId?: string) {
    text = text.trim();
    if (!text) throw new Error("Goal text must not be blank.");
    if (parentId !== undefined) {
      const parent = this.get(parentId);
      if (parent.deletedAt !== undefined) throw new Error("Parent goal was deleted.");
      if (parent.status === "cancelled" || parent.status === "done") throw new Error("Reopen the parent goal before adding children.");
    }
    const now = this.now();
    const g: Goal = {id:randomUUID(),text,status:"todo",...(parentId === undefined ? {} : {parentId}),setBy:by,updatedBy:by,setAt:now,updatedAt:now};
    this.goals = [...this.goals,g];
    return {...g};
  }
  update(id: string, patch: {text?: string; status?: Status}, by: Actor) {
    const g = this.get(id);
    if (g.deletedAt !== undefined) throw new Error("Goal was deleted.");
    if (by === "assistant" && g.status === "cancelled") throw new Error("Cancelled goals can only be reopened by the user.");
    if (patch.text === undefined && patch.status === undefined) throw new Error("Specify text or status.");
    if (patch.text !== undefined && !patch.text.trim()) throw new Error("Goal text must not be blank.");
    if (patch.status !== undefined && !statuses.includes(patch.status)) throw new Error("Invalid goal status.");
    const next = {...g,...(patch.status === undefined ? {} : {status:patch.status}),...(patch.text === undefined ? {} : {text:patch.text.trim()}),updatedBy:by,updatedAt:this.now()};
    this.goals = this.goals.map(item=>item.id === id ? next : item);
    // Rewording revokes execution scope; it never silently authorizes a different task.
    if (patch.text !== undefined && patch.text.trim() !== g.text && this.run) this.run = {...this.run,ids:this.run.ids.filter(key=>key !== id)};
    return {...next};
  }
  delete(id: string, by: Actor) {
    const g = this.get(id);
    if (g.deletedAt !== undefined) throw new Error("Goal was already deleted.");
    if (this.visible().some(child=>child.parentId === id)) throw new Error("Delete child goals before deleting their parent.");
    const next = {...g,deletedAt:this.now(),updatedAt:this.now(),updatedBy:by};
    this.goals = this.goals.map(item=>item.id === id ? next : item);
    return {...next};
  }
  runnable() { return this.visible().filter(g=>this.run?.ids.includes(g.id) && (g.status === "todo" || g.status === "doing")); }
  start() {
    const ids = this.visible().filter(g=>g.status === "todo" || g.status === "doing").map(g=>g.id);
    if (!ids.length) throw new Error("No todo/doing goals. Unblock a goal before resuming.");
    this.run = {status:"active",ids,elapsedMs:this.elapsed(),resumedAt:this.now()};
    this.since = this.now();
  }
  transition(status: Run["status"]) {
    if (!this.run) return;
    this.run = {...this.run,status,elapsedMs:this.elapsed()};
    this.since = status === "active" ? this.now() : undefined;
  }
  reconcile() {
    if (this.run?.status !== "active" || this.runnable().length) return false;
    const blocked = this.visible().some(g=>this.run!.ids.includes(g.id) && g.status === "blocked");
    this.transition(blocked ? "paused" : "complete");
    return true;
  }
  restore(value: unknown) {
    this.goals = []; this.run = null; this.since = undefined;
    if (!value || typeof value !== "object") return;
    const v = value as Record<string,unknown>;
    if (v.version !== 2) {
      if (typeof v.text !== "string" || !v.text.trim() || !["active","paused","complete","closed"].includes(String(v.status)) || typeof v.elapsedMs !== "number" || !Number.isFinite(v.elapsedMs) || v.elapsedMs < 0) return;
      // Old budget presence recorded assistant origin; absence cannot prove user origin.
      const g: Goal = {id:"legacy",text:v.text,status:v.status === "complete" ? "done" : v.status === "closed" ? "cancelled" : "todo",
        ...(v.agentTurnsRemaining !== undefined ? {setBy:"assistant" as const} : {}),...(timestamp(v.setAt) ? {setAt:v.setAt} : {})};
      this.goals = [g];
      this.run = {status:v.status === "complete" ? "complete" : "paused",ids:[g.id],elapsedMs:v.elapsedMs,...(timestamp(v.resumedAt) ? {resumedAt:v.resumedAt} : {})};
      return;
    }
    if (!Array.isArray(v.goals)) return;
    const seen = new Set<string>();
    for (const raw of v.goals) {
      if (!raw || typeof raw !== "object") continue;
      const g = raw as Goal;
      if (typeof g.id !== "string" || !g.id || seen.has(g.id) || typeof g.text !== "string" || !g.text.trim() || !statuses.includes(g.status)) continue;
      seen.add(g.id);
      this.goals.push({id:g.id,text:g.text,status:g.status,...(typeof g.parentId === "string" && g.parentId ? {parentId:g.parentId} : {}),...(actor(g.setBy) ? {setBy:g.setBy} : {}),...(actor(g.updatedBy) ? {updatedBy:g.updatedBy} : {}),
        ...(timestamp(g.setAt) ? {setAt:g.setAt} : {}),...(timestamp(g.updatedAt) ? {updatedAt:g.updatedAt} : {}),...(timestamp(g.deletedAt) ? {deletedAt:g.deletedAt} : {})});
    }
    // Older v2 records are roots. Repair malformed links without losing tasks.
    const byId = new Map(this.goals.map(g=>[g.id,g]));
    for (const g of this.goals) {
      const path = new Set([g.id]);
      let cursor = g;
      while (cursor.parentId !== undefined) {
        const parent = byId.get(cursor.parentId);
        if (!parent || path.has(parent.id) || (cursor.deletedAt === undefined && parent.deletedAt !== undefined)) {
          delete cursor.parentId; break;
        }
        path.add(parent.id); cursor = parent;
      }
    }
    const r = v.run as Run | null;
    if (!r || !["active","paused","complete"].includes(r.status) || !Array.isArray(r.ids) || !Number.isFinite(r.elapsedMs) || r.elapsedMs < 0) return;
    this.run = {status:r.status === "active" ? "paused" : r.status,ids:r.ids.filter(id=>seen.has(id)),elapsedMs:r.elapsedMs,
      ...(timestamp(r.resumedAt) ? {resumedAt:r.resumedAt} : {})};
  }
}
export function duration(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m ${s % 60}s`;
}
