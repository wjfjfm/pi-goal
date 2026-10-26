import { randomUUID } from "node:crypto";
import timers from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GoalState, duration, statuses, type Status } from "./state.js";

const ENTRY = "pi-goal-state", MESSAGE = "pi-goal", MAX_RETRIES = 10;
export default function goalExtension(pi: ExtensionAPI) {
  const state = new GoalState();
  let pendingGoal: string | undefined, uiContext: ExtensionContext | undefined;
  let retryCount = 0, retryRequested = false, afterBacktrack = false;
  let retryAbort: AbortController | undefined;
  function cancelRetry() { retryAbort?.abort(); retryAbort=undefined; retryCount=0; retryRequested=false; }
  function summary() {
    const r=state.snapshot().run;
    return `${state.outline().map(({goal:g,depth})=>`${"  ".repeat(depth)}[${g.status}] ${g.id} ${g.text} (set by ${g.setBy ?? "unknown (legacy)"})`).join("\n") || "No goals."}\nRun: ${r?.status ?? "idle"}; running time: ${duration(state.elapsed())}${r ? `; turns remaining: ${r.turnsRemaining}\nAuthorized IDs: ${r.ids.join(", ")}` : ""}`;
  }
  function updateStatus(ctx=uiContext) {
    if (ctx?.hasUI) ctx.ui.setStatus(MESSAGE,state.goals.length ? `Goals: ${state.visible().length} · ${state.run?.status ?? "idle"} (${duration(state.elapsed())})` : undefined);
  }
  function save() { pi.appendEntry(ENTRY,state.snapshot()); updateStatus(); }
  function message(kind: string) {
    return {customType:MESSAGE,content:`Goals ${kind}:\n${summary()}\n\nUse codemode tools.goal_show({}), goal_add({text,parentId?}), goal_update({id,text?,status?}), goal_delete({id}). Status: todo/doing/blocked/done/cancelled. Work only on authorized IDs while the run is active. New or reworded items require user /goal resume to enter execution scope. Listing or doing is not permission. Do not expand scope, bypass confirmations, or recreate cancelled tasks. Mark blocked when awaiting user input.`,display:true};
  }
  function digest() {
    const goals=state.visible(), count=(s: Status)=>goals.filter(g=>g.status===s).length;
    return {customType:MESSAGE,content:`[goal status: ${count("todo")} todo, ${count("doing")} doing, ${count("blocked")} blocked, ${count("done")} done, ${count("cancelled")} cancelled; run: ${state.run?.status ?? "idle"}; use codemode tools.goal_show({}) for details]`,display:true};
  }
  function reconcile() { if (state.reconcile()) cancelRetry(); }
  function guard(signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("Goal operation cancelled.");
    if (pendingGoal) throw new Error("User changes are awaiting delivery; inspect the updated list next turn.");
  }
  const result=(value: unknown)=>({content:[{type:"text" as const,text:JSON.stringify(value,(key,v)=>["setAt","updatedAt","deletedAt","resumedAt"].includes(key) && typeof v === "number" ? new Date(v).toISOString() : v,2)}],details:value});
  pi.registerTool({name:"goal_show",label:"Show goals",exposure:"codemode",annotations:{readOnlyHint:true},
    description:"Read shared TODOs in depth-first order with parentId links (absent for roots), or one by ID, immutable setBy (user/assistant), latest editor, timestamps, run scope and budget. List omits soft-deleted items; lookup includes them. Legacy unknown authors are not invented.",
    parameters:Type.Object({id:Type.Optional(Type.String({minLength:1}))}),
    async execute(_id,args,signal) {
      if (signal?.aborted) throw new Error("Goal query cancelled.");
      const s=state.snapshot();
      return result({...s,goals:args.id ? [{...state.get(args.id)}] : state.outline().map(({goal})=>({...goal})),pendingDelivery:!!pendingGoal});
    }});
  pi.registerTool({name:"goal_add",label:"Add goal",exposure:"codemode",
    description:"Add an assistant-authored TODO for user-requested work. Optional parentId creates a child under an existing non-deleted, non-done, non-cancelled goal; omit for a root. Parent/child statuses are independent. Does not start execution, authorize new scope, renew budgets or bypass pause. Never recreate user-cancelled tasks. Required permissions still apply.",
    parameters:Type.Object({text:Type.String({minLength:1}),parentId:Type.Optional(Type.String({minLength:1}))}),
    async execute(_id,args,signal) { guard(signal); const g=state.add(args.text,"assistant",args.parentId); save(); return result(g); }});
  pi.registerTool({name:"goal_update",label:"Update goal",exposure:"codemode",
    description:"Edit TODO text/status without starting execution or renewing budgets. setBy is immutable; updatedBy records assistant. Cannot edit deleted or cancelled items. Rewording revokes execution scope. Respect user edits and permissions.",
    parameters:Type.Object({id:Type.String({minLength:1}),text:Type.Optional(Type.String({minLength:1})),status:Type.Optional(Type.Union(statuses.map(s=>Type.Literal(s))))}),
    async execute(_id,args,signal) { guard(signal); const g=state.update(args.id,args,"assistant"); reconcile(); save(); return result(g); }});
  pi.registerTool({name:"goal_delete",label:"Delete goal",exposure:"codemode",
    description:"Soft-delete an erroneous/duplicate TODO, retaining history and author. Delete children first; parents with non-deleted children cannot be deleted. Ask consent before deleting user-created or user-edited items. Does not reset budget or authorize other work. Blocked work is not a reason to delete.",
    parameters:Type.Object({id:Type.String({minLength:1})}),
    async execute(_id,args,signal) { guard(signal); const g=state.delete(args.id,"assistant"); reconcile(); save(); return result(g); }});
  function deliver(kind: string, triggerTurn: boolean) {
    pendingGoal=randomUUID();
    pi.sendMessage({...message(kind),details:{goalDelivery:pendingGoal}},{triggerTurn,deliverAs:"steer"});
  }
  function ensureCodemode(ctx: ExtensionContext) {
    if (!pi.getAllTools().some(t=>t.name==="codemode")) { ctx.ui.notify("Goal requires the codemode tool.","error"); return false; }
    const active=pi.getActiveTools(); if (!active.includes("codemode")) pi.setActiveTools([...active,"codemode"]);
    return true;
  }
  async function action(args: string,ctx: ExtensionCommandContext) {
    uiContext=ctx;
    if (!args || args==="show") { ctx.ui.notify(summary(),"info"); return; }
    if (["pause","parse"].includes(args)) {
      cancelRetry(); state.transition("paused"); save(); ctx.ui.notify("Goal run paused; current tools are not interrupted.","info"); return;
    }
    if (["resume","continue"].includes(args)) {
      if (state.run?.status==="active") return;
      if (!ensureCodemode(ctx)) return;
      state.start(); cancelRetry(); save(); deliver("resumed",true); return;
    }
    if (["clear","exit"].includes(args)) {
      cancelRetry(); state.transition("paused");
      for (const g of state.visible()) if (!["done","cancelled"].includes(g.status)) state.update(g.id,{status:"cancelled"},"user");
      save(); deliver("cancelled by user",false); return;
    }
    const match=/^(add|delete|update)\s+([\s\S]+)$/.exec(args);
    if (match) {
      const [,op,rest]=match;
      if (op==="add") {
        const child=/^--parent\s+(\S+)\s+([\s\S]+)$/.exec(rest);
        if (/^--parent(?:\s|$)/.test(rest) && !child) throw new Error("Use /goal add --parent <id> <text>.");
        state.add(child ? child[2] : rest,"user",child?.[1]);
      }
      else if (op==="delete") state.delete(rest.trim(),"user");
      else {
        const edit=/^(\S+)\s+(todo|doing|blocked|done|cancelled|text)(?:\s+([\s\S]+))?$/.exec(rest);
        if (!edit || (edit[2]==="text" && !edit[3]) || (edit[2]!=="text" && edit[3])) throw new Error("Use /goal update <id> <status> or /goal update <id> text <text>.");
        state.update(edit[1],edit[2]==="text" ? {text:edit[3]} : {status:edit[2] as Status},"user");
      }
      cancelRetry(); reconcile(); save(); deliver("changed by user",false); return;
    }
    if (["add","delete","update"].includes(args)) throw new Error("Missing goal text or ID.");
    if (!ensureCodemode(ctx)) return;
    const g=state.add(args,"user");
    if (state.run?.status==="active") state.run={...state.run,ids:[...state.run.ids,g.id]};
    else state.start();
    cancelRetry(); save(); deliver("added by user",true);
  }
  pi.registerCommand("goal",{description:"Shared TODOs: add [--parent <id>] <text>, update <id> <status>|text <text>, delete <id>, show, pause, resume; <text> adds and starts.",
    async handler(args,ctx) { try { await action(args.trim(),ctx); } catch(error) { ctx.ui.notify(error instanceof Error ? error.message : String(error),"error"); } }});
  function restore(ctx: ExtensionContext) {
    cancelRetry(); uiContext=ctx; pendingGoal=undefined; afterBacktrack=false;
    const entry=[...ctx.sessionManager.getBranch()].reverse().find(e=>e.type==="custom" && e.customType===ENTRY);
    state.restore(entry?.type==="custom" ? entry.data : undefined); updateStatus(ctx);
    if (state.goals.length) ctx.ui.notify("Goals restored; automatic execution is not resumed.","info");
  }
  async function retryError(entries: SessionBoundaryDraft[],ctx: ExtensionContext) {
    if (retryAbort || pendingGoal || ctx.hasPendingMessages()) return;
    if (retryCount>=MAX_RETRIES) { state.transition("paused"); save(); ctx.ui.notify("Goal run paused after 10 automatic retries.","warning"); return; }
    const attempt=++retryCount, controller=new AbortController(); retryAbort=controller;
    const abort=()=>controller.abort(); ctx.signal?.addEventListener("abort",abort,{once:true});
    ctx.ui.notify(`Goal error; retry in ${2 ** (attempt-1)}s (${attempt}/${MAX_RETRIES}).`,"warning");
    try {
      await timers.setTimeout(1000 * 2 ** (attempt-1),undefined,{signal:controller.signal});
      if (state.run?.status!=="active" || controller.signal.aborted || pendingGoal || ctx.hasPendingMessages()) return;
      if (attempt===1) { retryRequested=true; return {entries:[...entries,{type:"custom_message" as const,...message("retrying")}],continue:true}; }
      const last=[...ctx.sessionManager.getBranch()].reverse().find(e=>e.type==="message" && e.message.role!=="system");
      if (last?.type!=="message" || last.message.role!=="assistant" || last.message.stopReason!=="error") return;
      retryRequested=true; return {entries:[...entries,{type:"context_edit" as const,targetId:last.id,replacement:null}],continue:true};
    } catch(error) {
      if (!controller.signal.aborted) throw error;
      if (retryAbort===controller && ctx.signal?.aborted && state.run?.status==="active") { state.transition("paused"); save(); }
    } finally { ctx.signal?.removeEventListener("abort",abort); if (retryAbort===controller) retryAbort=undefined; }
  }
  pi.on("message_start",({message:incoming})=>{
    if (incoming.role==="custom" && incoming.customType===MESSAGE && (incoming.details as {goalDelivery?:string} | undefined)?.goalDelivery===pendingGoal) pendingGoal=undefined;
  });
  pi.on("tool_result",event=>{ if (event.toolName==="backtrack" && !event.isError) afterBacktrack=true; });
  pi.on("session_compact",()=>{ pi.sendMessage(digest(),{triggerTurn:false}); });
  pi.on("agent_start",()=>{retryRequested=false;});
  pi.on("agent_settled",(_event,ctx)=>{
    if (retryRequested && state.run?.status==="active") { cancelRetry(); state.transition("paused"); save(); ctx.ui.notify("Goal run paused after interruption.","info"); }
  });
  pi.on("turn_end",(event,ctx)=>{
    if (!pendingGoal && state.run?.status==="active") {
      if (state.consumeTurn()) { cancelRetry(); state.transition("paused"); ctx.ui.notify("Goal run paused: 20-turn budget exhausted. Use /goal resume.","warning"); }
      save();
    }
    updateStatus(ctx);
    if (afterBacktrack) { afterBacktrack=false; return {entries:[...event.entries,{type:"custom_message" as const,...digest()}]}; }
  });
  pi.on("session_start",(_event,ctx)=>restore(ctx));
  pi.on("session_tree",(_event,ctx)=>restore(ctx));
  pi.on("session_shutdown",()=>{cancelRetry(); if (state.run?.status==="active") {state.transition("paused");save();}});
  pi.on("agent_before_settle",(event,ctx)=>{
    if (state.run?.status!=="active") return;
    if (event.outcome==="error" && !ctx.signal?.aborted) { if (!event.continue) return retryError(event.entries,ctx); return; }
    if (event.outcome!=="completed" || ctx.signal?.aborted) { cancelRetry(); state.transition("paused"); save(); ctx.ui.notify("Goal run paused after interruption.","info"); return; }
    retryCount=0; reconcile(); save();
    if (state.run?.status!=="active" || pendingGoal || ctx.hasPendingMessages() || event.continue) return;
    return {entries:[...event.entries,{type:"custom_message" as const,...message("still active")}],continue:true};
  });
}
