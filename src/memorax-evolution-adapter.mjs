export function createMemoraxEvolutionAdapter() {
  return {
    async supports({ agentDriverId }) {
      return agentDriverId === "codex";
    },

    async run({ exchange, runId, evaluation }) {
      const outcome = evaluation?.passed === true ? "positive"
        : evaluation?.passed === false ? "negative"
          : "neutral";
      const prompt = [
        "Use $memorax-code-session-evolution to ensure exactly one task-run Evolution operation for this current session.",
        `Pass task_run_id=${JSON.stringify(runId)} and outcome=${JSON.stringify(outcome)} to evolve_session.`,
        "If an unrelated legacy operation is already running, wait for it to become terminal, then call evolve_session again with the same task_run_id and outcome; never create an operation without these fields.",
        "The Skill must wait internally for that one operation to reach a terminal state in this same Codex turn.",
        "Leave Candidate activation decisions as not_now.",
        "This is an Evolution-control turn: do not invoke $memorax-code-runtime-guide or create a Runtime Guide.",
        "Report EVOLUTION_STATUS with the terminal status.",
      ].join(" ");
      const response = await exchange(prompt);
      const toolObserved = (response.events ?? []).some((event) => event?.type === "item.completed"
        && event.item?.type === "mcp_tool_call"
        && ["evolve_session", "get_evolution", "run_evolution", "memorax_code_run_session_evolution"].includes(event.item.tool ?? event.item.name));
      const status = latestOperationStatus(response.events) ?? reportedStatus(response.message);
      if (toolObserved && ["completed", "completed_with_pending_work", "failed"].includes(status)) {
        return { status, turns: 1 };
      }
      return {
        status: "failed",
        turns: 1,
        reason: toolObserved ? "operation_not_terminal" : "evolution_tool_not_used",
      };
    },
  };
}

export function createDeferredEvolutionAdapter() {
  return {
    async supports({ agentDriverId }) {
      return agentDriverId === "codex";
    },

    async run() {
      return { status: "deferred", turns: 0, reason: "evolution_deferred" };
    },
  };
}

function latestOperationStatus(events = []) {
  let latest;
  for (const event of events) {
    if (event?.type !== "item.completed" || event.item?.type !== "mcp_tool_call") continue;
    for (const content of event.item.result?.content ?? []) {
      if (content?.type !== "text" || typeof content.text !== "string") continue;
      let payload;
      try { payload = JSON.parse(content.text); } catch { continue; }
      const status = payload?.view?.operation?.operation?.status
        ?? payload?.operation?.operation?.status;
      if (["queued", "running", "completed", "completed_with_pending_work", "failed"].includes(status)) latest = status;
    }
  }
  return latest;
}

function reportedStatus(message) {
  return message?.match(/\bEVOLUTION_STATUS:\s*(queued|running|completed|completed_with_pending_work|failed)\b/iu)?.[1]?.toLowerCase();
}
