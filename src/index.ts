import { randomUUID } from "node:crypto";
import timers from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { GoalState, reminder, duration } from "./state.js";

const ENTRY = "pi-goal-state";
const MESSAGE = "pi-goal";
const MAX_RETRIES = 10;
export default function goalExtension(pi: ExtensionAPI) {
  const state = new GoalState();
  // A replacement cannot be completed by tools from the still-running old turn.
  let pendingGoal: string | undefined;
  let uiContext: ExtensionContext | undefined;
  let retryCount = 0;
  let retryRequested = false;
  let retryAbort: AbortController | undefined;
  function cancelRetry() {
    retryAbort?.abort(); retryAbort = undefined; retryCount = 0; retryRequested = false;
  }
  async function retryError(entries: SessionBoundaryDraft[], ctx: ExtensionContext) {
    if (retryAbort || pendingGoal || ctx.hasPendingMessages()) return;
    if (retryCount >= MAX_RETRIES) {
      state.transition("paused"); save(); expose();
      ctx.ui.notify(`Goal paused after ${MAX_RETRIES} failed automatic retries. Use /goal resume to retry.`,"warning");
      return;
    }
    const attempt = ++retryCount;
    const controller = new AbortController();
    retryAbort = controller;
    const abort = () => controller.abort();
    ctx.signal?.addEventListener("abort",abort,{once:true});
    ctx.ui.notify(`Goal error; automatically resuming in ${2 ** (attempt-1)}s (${attempt}/${MAX_RETRIES}).`,"warning");
    try {
      await timers.setTimeout(1000 * 2 ** (attempt-1),undefined,{signal:controller.signal});
      if (state.goal?.status !== "active" || controller.signal.aborted) return;
      if (pendingGoal || ctx.hasPendingMessages()) return;
      retryRequested = true;
      // Keep one resume prompt. Later retries omit only the failed assistant
      // response from future context, so the runtime can retry the same prompt.
      // Raw history, UI and usage accounting remain intact.
      if (attempt === 1) return {entries:[...entries,{type:"custom_message" as const,...message("resumed")}],continue:true};
      const last = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role !== "system");
      if (last?.type !== "message" || last.message.role !== "assistant" || last.message.stopReason !== "error") return;
      return {entries:[...entries,{type:"context_edit" as const,targetId:last.id,replacement:null}],continue:true};
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      if (retryAbort === controller && ctx.signal?.aborted && state.goal?.status === "active") {
        state.transition("paused"); save(); expose();
      }
    } finally {
      ctx.signal?.removeEventListener("abort",abort);
      if (retryAbort === controller) retryAbort = undefined;
    }
  }
  function updateStatus(ctx = uiContext) {
    if (!ctx?.hasUI) return;
    const status = state.goal?.status;
    const text = status === "active" ? `Pursuing goal (${duration(state.elapsed())})`
      : status === "paused" ? "Goal paused (/goal resume)"
      : status === "complete" ? `Goal achieved (${duration(state.elapsed())})` : undefined;
    ctx.ui.setStatus("pi-goal", text);
  }
  function save() {
    pi.appendEntry(ENTRY, state.snapshot());
    updateStatus();
  }
  function expose() {
    pi.registerTool({
      name: "goal_update", label: "Update goal",
      description: "Complete the active goal when its requirements are satisfied, or pause it when blocked or awaiting user input.",
      exposure: state.goal?.status === "active" && !pendingGoal ? "codemode" : "hidden",
      parameters: Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("pause")]) }),
      async execute(_id, args, signal, _onUpdate, ctx) {
        if (signal?.aborted) throw new Error("Goal update cancelled.");
        if (pendingGoal) throw new Error("New goal is awaiting delivery.");
        if (state.goal?.status !== "active") throw new Error("No active goal.");
        cancelRetry();
        state.transition(args.status === "pause" ? "paused" : "complete");
        save();
        expose();
        ctx.ui.notify(args.status === "pause" ? "Goal paused." : "Goal completed.", "info");
        return { content: [{ type: "text", text: args.status === "pause" ? "Goal paused." : "Goal completed." }], details: undefined };
      },
    });
  }
  function message(kind: "set" | "changed" | "resumed" | "still active") {
    return { customType: MESSAGE, content: reminder(state.goal!.text, kind), display: true };
  }
  function restore(ctx: ExtensionContext) {
    cancelRetry();
    uiContext = ctx;
    const entry = [...ctx.sessionManager.getBranch()].reverse()
      .find(e => e.type === "custom" && e.customType === ENTRY);
    pendingGoal = undefined;
    state.restore(entry?.type === "custom" ? entry.data : undefined);
    expose();
    updateStatus(ctx);
    if (state.goal) ctx.ui.notify(`Goal restored: ${state.goal.status}.`, "info");
  }
  function ensureCodemode(ctx: ExtensionContext) {
    if (!pi.getAllTools().some(t => t.name === "codemode")) {
      ctx.ui.notify("Goal requires the codemode tool.", "error");
      return false;
    }
    const active = pi.getActiveTools();
    if (!active.includes("codemode")) pi.setActiveTools([...active, "codemode"]);
    return true;
  }
  async function action(args: string, ctx: ExtensionCommandContext) {
    uiContext = ctx;
    if (args === "exit") args = "clear";
    if (args === "parse" || args === "pause" || args === "clear") {
      if (!state.goal) return ctx.ui.notify("No goal set.", "info");
      if (args !== "clear" && state.goal.status !== "active") return;
      cancelRetry();
      state.transition(args === "clear" ? "closed" : "paused");
      save(); expose();
      ctx.ui.notify(args === "clear" ? "Goal cleared." : "Goal paused; the current agent turn is not interrupted.", "info");
      return;
    }
    if (args === "resume" || args === "continue") {
      if (state.goal?.status !== "paused") return ctx.ui.notify("No paused goal.", "info");
      if (!ensureCodemode(ctx)) return;
      cancelRetry();
      pendingGoal = randomUUID();
      state.transition("active");
      save(); expose();
      ctx.ui.notify("Goal active.", "info");
      pi.sendMessage({ ...message("resumed"), details: { goalDelivery: pendingGoal } },
        { triggerTurn: true, deliverAs: "steer" });
      return;
    }
    if (!ensureCodemode(ctx)) return;
    cancelRetry();
    const kind = state.goal ? "changed" : "set";
    pendingGoal = randomUUID();
    state.set(args);
    save(); expose();
    ctx.ui.notify(kind === "set" ? "Goal set: active." : "Goal changed: active.", "info");
    pi.sendMessage({ ...message(kind), details: { goalDelivery: pendingGoal } },
      { triggerTurn: true, deliverAs: "steer" });
  }
  pi.registerCommand("goal", {
    description: "Set a goal, view status, or pause / resume / clear.",
    async handler(args, ctx) {
      args = args.trim();
      if (args) return action(args, ctx);
      if (!ctx.hasUI) {
        ctx.ui.notify(state.goal ? `${state.goal.status}: ${state.goal.text} (${duration(state.elapsed())})` : "No goal set.", "info");
        return;
      }
      const selected = await ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
        const view = new Text("", 1, 1);
        const timer = setInterval(() => { view.invalidate(); tui.requestRender(); }, 1000);
        return {
          render(width) {
            view.setText(state.goal
              ? `Goal: ${state.goal.text}\nStatus: ${state.goal.status}\nRunning time: ${duration(state.elapsed())}\n\n[p] Pause  [r] Resume  [x] Clear goal  [Esc] Back`
              : "No goal set. Use /goal <text>.\n\n[Esc] Back");
            return view.render(width);
          },
          invalidate() { view.invalidate(); },
          handleInput(data) {
            if (matchesKey(data, Key.escape)) done(undefined);
            else if (data === "p") done("pause");
            else if (data === "r" || data === "c") done("resume");
            else if (data === "x") done("clear");
          },
          dispose() { clearInterval(timer); },
        };
      });
      if (selected) await action(selected, ctx);
    },
  });
  expose();
  pi.on("message_start", ({ message: incoming }) => {
    if (incoming.role !== "custom" || incoming.customType !== MESSAGE || !pendingGoal) return;
    const details = incoming.details as { goalDelivery?: string } | undefined;
    if (details?.goalDelivery !== pendingGoal) return;
    pendingGoal = undefined;
    expose();
  });
  pi.on("agent_start", () => { retryRequested = false; });
  pi.on("agent_settled", (_event,ctx) => {
    // Some runtimes expose no abort signal at the settle boundary. If the
    // requested retry never starts (e.g. Esc during backoff), do not leave an active goal stranded.
    if (retryRequested && state.goal?.status === "active") {
      cancelRetry(); state.transition("paused"); save(); expose();
      ctx.ui.notify("Goal paused after interruption.","info");
    }
  });
  // Refresh elapsed time on activity, without a timer forcing terminal redraws.
  pi.on("turn_end", (_event, ctx) => updateStatus(ctx));
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => {
    cancelRetry();
    if (state.goal?.status === "active") { state.transition("paused"); save(); }
  });
  pi.on("agent_before_settle", (event, ctx) => {
    if (state.goal?.status !== "active") return;
    if (event.outcome === "error" && !ctx.signal?.aborted) return retryError(event.entries,ctx);
    if (event.outcome !== "completed" || ctx.signal?.aborted) {
      cancelRetry();
      pendingGoal = undefined;
      state.transition("paused"); save(); expose();
      ctx.ui.notify(event.outcome === "error" ? "Goal paused after an error." : "Goal paused after interruption.", "info");
      return;
    }
    retryCount = 0;
    save();
    if (pendingGoal || ctx.hasPendingMessages() || event.continue) return;
    return {
      entries: [...event.entries, { type: "custom_message" as const, ...message("still active") }],
      continue: true,
    };
  });
}
