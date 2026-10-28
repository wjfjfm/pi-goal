import { randomUUID } from "node:crypto";
import timers from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GoalState, duration } from "./state.js";

const ENTRY="pi-goal-state", MESSAGE="pi-goal", MAX_RETRIES=10;
const REPEAT_INTERVAL_MS=60_000, CONTINUATION_BUDGET=10, REFILL_PERIOD_MS=600_000;
export default function goalExtension(pi: ExtensionAPI) {
  const state=new GoalState();
  let pendingGoal: string | undefined, uiContext: ExtensionContext | undefined;
  let retryCount=0, retryRequested=false, afterBacktrack=false;
  let retryAbort: AbortController | undefined;
  let lastContinueAt: number | undefined, remaining=CONTINUATION_BUDGET, refillPeriodStartedAt=Date.now();
  function refillContinuation() { lastContinueAt=undefined; remaining=CONTINUATION_BUDGET; }
  function resetContinuation() { refillContinuation(); refillPeriodStartedAt=Date.now(); }
  function continuationExhausted() {
    const now=Date.now();
    if (now<refillPeriodStartedAt || (lastContinueAt!==undefined && now<lastContinueAt)) {
      refillPeriodStartedAt=now; lastContinueAt=undefined;
    }
    if (now-refillPeriodStartedAt>=REFILL_PERIOD_MS) resetContinuation();
    if (lastContinueAt!==undefined && now-lastContinueAt<REPEAT_INTERVAL_MS) remaining=Math.max(0,remaining-1);
    lastContinueAt=now;
    return remaining===0;
  }
  function cancelRetry() { retryAbort?.abort(); retryAbort=undefined; retryCount=0; retryRequested=false; }
  function summary() {
    const g=state.goal;
    return g ? `Goal: ${g.text}\nStatus: ${g.status}\nRunning time: ${duration(state.elapsed())}` : "No goal set. Use /goal <text>.";
  }
  function updateStatus(ctx=uiContext) {
    if (ctx?.hasUI) ctx.ui.setStatus(MESSAGE,state.goal?.status==="active" ? `Goal: ${state.goal.status} (${duration(state.elapsed())})` : undefined);
  }
  function save() { pi.appendEntry(ENTRY,state.snapshot()); updateStatus(); }
  function message(kind: string) {
    return {customType:MESSAGE,content:`Goal ${kind}:\n${summary()}\n\nOnly the user may set, replace, resume or clear the goal. Use codemode tools.goal_show() to inspect it, or tools.goal_update({status:"complete"}) when satisfied / tools.goal_update({status:"blocked"}) when unable to proceed. Do not expand scope or bypass required permissions or confirmations. Resume means retry, not that previous blockers are resolved.`,display:false};
  }
  function digest() {
    return {customType:MESSAGE,content:`[pursuing goal (${duration(state.elapsed())}); codemode tools.goal_show() for detail]`,display:true};
  }
  pi.registerTool({name:"goal_show",label:"Show goal",exposure:"codemode",annotations:{readOnlyHint:true},
    description:"Show the single user-set goal and its status. Read-only.",
    parameters:Type.Object({},{additionalProperties:false}),
    async execute(_id,_args,signal) {
      if (signal?.aborted) throw new Error("Goal query cancelled.");
      const goal=state.snapshot().goal;
      return {content:[{type:"text",text:goal ? `Goal: ${goal.text}\nStatus: ${goal.status}` : "No goal set."}],
        details:{goal,pendingDelivery:!!pendingGoal,continuationBudget:{remaining,capacity:CONTINUATION_BUDGET}}};
    }});
  pi.registerTool({name:"goal_update",label:"Report goal outcome",exposure:"codemode",
    description:"Report the active user goal as complete when satisfied, or blocked when unable to proceed or awaiting user input. Blocked stops automatic continuation. Only the user can set/change the goal, resume it or clear it. Cannot update a paused, blocked, cleared or undelivered goal.",
    parameters:Type.Object({status:Type.Union([Type.Literal("complete"),Type.Literal("blocked")])},{additionalProperties:false}),
    async execute(_id,args,signal) {
      if (signal?.aborted) throw new Error("Goal update cancelled.");
      if (pendingGoal) throw new Error("Goal is awaiting delivery; wait for the next turn.");
      if (state.goal?.status!=="active") throw new Error("No active goal. Only the user can resume it.");
      if (args.status!=="complete" && args.status!=="blocked") throw new Error("Only complete or blocked is allowed.");
      cancelRetry(); state.transition(args.status); refillContinuation(); save();
      return {content:[{type:"text",text:`Goal ${args.status}.`}],details:{goal:state.snapshot().goal}};
    }});
  function deliver(kind: string) {
    pendingGoal=randomUUID();
    pi.sendMessage({...message(kind),details:{goalDelivery:pendingGoal}},{triggerTurn:true,deliverAs:"steer"});
  }
  function ensureCodemode(ctx: ExtensionContext) {
    if (!pi.getAllTools().some(t=>t.name==="codemode")) { ctx.ui.notify("Goal requires the codemode tool.","error"); return false; }
    const active=pi.getActiveTools(); if (!active.includes("codemode")) pi.setActiveTools([...active,"codemode"]);
    return true;
  }
  async function action(args: string,ctx: ExtensionCommandContext) {
    uiContext=ctx;
    if (!args || args==="show") { ctx.ui.notify(summary(),"info"); return; }
    if (["pause","clear","exit"].includes(args)) {
      if (!state.goal) return;
      const status=args==="clear" || args==="exit" ? "closed" : "paused";
      if (status==="paused" && state.goal.status!=="active") return;
      if (state.goal.status===status) return;
      cancelRetry(); pendingGoal=undefined; state.transition(status); refillContinuation(); save();
      ctx.ui.notify(status==="closed" ? "Goal cleared." : "Goal paused; current tools are not interrupted.","info"); return;
    }
    if (["resume","continue"].includes(args)) {
      if (state.goal?.status!=="active" && state.goal?.status!=="paused" && state.goal?.status!=="blocked") { ctx.ui.notify("No paused or blocked goal to resume.","info"); return; }
      if (!ensureCodemode(ctx)) return;
      if (state.goal.status!=="active") state.resume();
      resetContinuation(); cancelRetry(); save(); deliver("resumed"); return;
    }
    if (/^(?:add|update|delete)(?:\s|$)/.test(args) || /(?:^|\s)--parent(?:-id)?(?:\s|=|$)/.test(args)) {
      ctx.ui.notify("Goal is a single user-set objective. Use /goal <text> to set or replace it, or /goal pause / resume / clear.","info"); return;
    }
    if (!ensureCodemode(ctx)) return;
    const wasActive=state.goal?.status==="active";
    state.set(args); cancelRetry();
    if (wasActive) refillContinuation(); else resetContinuation();
    save(); deliver("set by user");
  }
  pi.registerCommand("goal",{description:"Set or replace one goal with <text>, view it with /goal, or pause / resume / clear.",
    async handler(args,ctx) { try { await action(args.trim(),ctx); } catch(error) { ctx.ui.notify(error instanceof Error ? error.message : String(error),"error"); } }});
  function restore(ctx: ExtensionContext) {
    cancelRetry(); resetContinuation(); uiContext=ctx; pendingGoal=undefined; afterBacktrack=false;
    const entry=[...ctx.sessionManager.getBranch()].reverse().find(e=>e.type==="custom" && e.customType===ENTRY);
    state.restore(entry?.type==="custom" ? entry.data : undefined); updateStatus(ctx);
    if (state.goal) ctx.ui.notify("Goal restored; automatic execution is not resumed.","info");
  }
  async function retryError(entries: SessionBoundaryDraft[],ctx: ExtensionContext) {
    if (retryAbort || pendingGoal || ctx.hasPendingMessages()) return;
    if (retryCount>=MAX_RETRIES) { state.transition("paused"); save(); ctx.ui.notify("Goal paused after 10 automatic retries.","warning"); return; }
    const attempt=++retryCount, controller=new AbortController(); retryAbort=controller;
    const abort=()=>controller.abort(); ctx.signal?.addEventListener("abort",abort,{once:true});
    ctx.ui.notify(`Goal error; retry in ${2 ** (attempt-1)}s (${attempt}/${MAX_RETRIES}).`,"warning");
    try {
      await timers.setTimeout(1000*2**(attempt-1),undefined,{signal:controller.signal});
      if (state.goal?.status!=="active" || controller.signal.aborted || pendingGoal || ctx.hasPendingMessages()) return;
      if (attempt===1) { retryRequested=true; return {entries:[...entries,{type:"custom_message" as const,...message("retrying")}],continue:true}; }
      const last=[...ctx.sessionManager.getBranch()].reverse().find(e=>e.type==="message" && e.message.role!=="system");
      if (last?.type!=="message" || last.message.role!=="assistant" || last.message.stopReason!=="error") return;
      retryRequested=true; return {entries:[...entries,{type:"context_edit" as const,targetId:last.id,replacement:null}],continue:true};
    } catch(error) {
      if (!controller.signal.aborted) throw error;
      if (retryAbort===controller && ctx.signal?.aborted && state.goal?.status==="active") { state.transition("paused"); save(); }
    } finally { ctx.signal?.removeEventListener("abort",abort); if (retryAbort===controller) retryAbort=undefined; }
  }
  pi.on("message_start",({message:incoming})=>{
    if (incoming.role==="custom" && incoming.customType===MESSAGE && (incoming.details as {goalDelivery?:string} | undefined)?.goalDelivery===pendingGoal) pendingGoal=undefined;
  });
  pi.on("tool_result",event=>{ if (event.toolName==="backtrack" && !event.isError) afterBacktrack=true; });
  pi.on("session_compact",()=>{ if (state.goal?.status==="active") pi.sendMessage(digest(),{triggerTurn:false}); });
  pi.on("agent_start",()=>{retryRequested=false;});
  pi.on("agent_settled",(_event,ctx)=>{
    if (retryRequested && state.goal?.status==="active") { cancelRetry(); state.transition("paused"); save(); ctx.ui.notify("Goal paused after interruption.","info"); }
  });
  pi.on("turn_end",(event,ctx)=>{
    if (state.goal?.status==="active") save();
    updateStatus(ctx);
    if (afterBacktrack) {
      afterBacktrack=false;
      if (state.goal?.status==="active") return {entries:[...event.entries,{type:"custom_message" as const,...digest()}]};
    }
  });
  pi.on("session_start",(_event,ctx)=>restore(ctx));
  pi.on("session_tree",(_event,ctx)=>restore(ctx));
  pi.on("session_shutdown",()=>{cancelRetry(); if (state.goal?.status==="active") {state.transition("paused");save();}});
  pi.on("agent_before_settle",(event,ctx)=>{
    if (state.goal?.status!=="active") return;
    if (event.outcome==="error" && !ctx.signal?.aborted) { if (!event.continue) return retryError(event.entries,ctx); return; }
    if (event.outcome!=="completed" || ctx.signal?.aborted) { cancelRetry(); state.transition("paused"); save(); ctx.ui.notify("Goal paused after interruption.","info"); return; }
    retryCount=0; save();
    if (pendingGoal || ctx.hasPendingMessages() || event.continue) return;
    if (continuationExhausted()) {
      cancelRetry(); state.transition("paused"); save();
      ctx.ui.notify("Goal paused: possible loop (repeat-reminder budget exhausted; unchanged goal repeated within 1 minute). Use /goal resume to continue.","warning"); return;
    }
    return {entries:[...event.entries,{type:"custom_message" as const,...message("still active")}],continue:true};
  });
}
