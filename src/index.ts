import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { GoalState, reminder, duration } from "./state.js";

const ENTRY = "pi-goal-state";
const MESSAGE = "pi-goal";
export default function goalExtension(pi: ExtensionAPI) {
  const state = new GoalState();
  // A replacement cannot be completed by tools from the still-running old turn.
  let pendingGoal: string | undefined;
  function save() { pi.appendEntry(ENTRY, state.snapshot()); }
  function expose() {
    pi.registerTool({
      name: "goal_update", label: "Update goal",
      description: "Complete the active goal when its requirements are satisfied, or pause it when blocked or awaiting user input.",
      exposure: state.goal?.status === "active" && !pendingGoal ? "codemode" : "hidden",
      parameters: Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("pause")]) }),
      async execute(_id, args, signal) {
        if (signal?.aborted) throw new Error("Goal update cancelled.");
        if (pendingGoal) throw new Error("New goal is awaiting delivery.");
        if (state.goal?.status !== "active") throw new Error("No active goal.");
        state.transition(args.status === "pause" ? "paused" : "complete");
        save();
        expose();
        return { content: [{ type: "text", text: args.status === "pause" ? "Goal paused." : "Goal completed." }], details: undefined };
      },
    });
  }
  function message(kind: "set" | "changed" | "still active") {
    return { customType: MESSAGE, content: reminder(state.goal!.text, kind), display: true };
  }
  function restore(ctx: ExtensionContext) {
    const entry = [...ctx.sessionManager.getBranch()].reverse()
      .find(e => e.type === "custom" && e.customType === ENTRY);
    pendingGoal = undefined;
    state.restore(entry?.type === "custom" ? entry.data : undefined);
    expose();
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
    if (args === "exit") args = "clear";
    if (args === "parse" || args === "pause" || args === "clear") {
      if (!state.goal) return ctx.ui.notify("No goal set.", "info");
      if (args !== "clear" && state.goal.status !== "active") return;
      state.transition(args === "clear" ? "closed" : "paused");
      save(); expose();
      ctx.ui.notify(args === "clear" ? "Goal cleared." : "Goal paused; the current agent turn is not interrupted.", "info");
      return;
    }
    if (args === "continue") {
      if (state.goal?.status !== "paused") return ctx.ui.notify("No paused goal.", "info");
      if (!ensureCodemode(ctx)) return;
      state.transition("active");
      save(); expose();
      return;
    }
    if (!ensureCodemode(ctx)) return;
    const kind = state.goal ? "changed" : "set";
    pendingGoal = randomUUID();
    state.set(args);
    save(); expose();
    pi.sendMessage({ ...message(kind), details: { goalDelivery: pendingGoal } },
      { triggerTurn: true, deliverAs: "steer" });
  }
  pi.registerCommand("goal", {
    description: "Set a goal, view status, or pause / continue / clear.",
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
              ? `Goal: ${state.goal.text}\nStatus: ${state.goal.status}\nRunning time: ${duration(state.elapsed())}\n\n[p] Pause  [c] Continue  [x] Clear goal  [Esc] Back`
              : "No goal set. Use /goal <text>.\n\n[Esc] Back");
            return view.render(width);
          },
          invalidate() { view.invalidate(); },
          handleInput(data) {
            if (matchesKey(data, Key.escape)) done(undefined);
            else if (data === "p") done("pause");
            else if (data === "c") done("continue");
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
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => {
    if (state.goal?.status === "active") { state.transition("paused"); save(); }
  });
  pi.on("agent_before_settle", (event, ctx) => {
    if (state.goal?.status !== "active") return;
    if (event.outcome !== "completed" || ctx.signal?.aborted) {
      pendingGoal = undefined;
      state.transition("paused"); save(); expose();
      return;
    }
    save();
    if (pendingGoal || ctx.hasPendingMessages() || event.continue) return;
    return {
      entries: [...event.entries, { type: "custom_message" as const, ...message("still active") }],
      continue: true,
    };
  });
}
