import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BenchError } from "./errors.mjs";
import { writeJsonAtomic } from "./files.mjs";

export function createModelUserAgent({
  stateDir,
  baseUrl,
  apiKey,
  model,
  scenario,
  thinking = false,
  reasoningEffort = "high",
  fetchImpl = fetch,
}) {
  for (const [label, value] of Object.entries({ stateDir, baseUrl, apiKey, model })) required(value, label);
  if (typeof thinking !== "boolean") throw new BenchError("invalid_configuration", "thinking must be boolean");
  if (!new Set(["high", "max"]).has(reasoningEffort)) {
    throw new BenchError("invalid_configuration", "reasoningEffort must be high or max");
  }
  const endpoint = `${baseUrl.replace(/\/$/u, "")}/chat/completions`;
  return {
    async next(input) {
      const recordPath = join(stateDir, "decisions", `${sha256(input.operationId)}.json`);
      const existing = await readOptionalJson(recordPath);
      if (existing?.status === "completed") return existing.result;
      await writeJsonAtomic(recordPath, { operationId: input.operationId, phase: input.phase, status: "pending" });

      let diagnostic;
      for (;;) {
        const response = await completeJson({
          endpoint,
          apiKey,
          model,
          thinking,
          reasoningEffort,
          fetchImpl,
          body: prompt(input, scenario, diagnostic),
        });
        try {
          const result = parseObject(response);
          if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("decision must be an object");
          await writeJsonAtomic(recordPath, { operationId: input.operationId, phase: input.phase, status: "completed", result });
          return result;
        } catch (error) {
          diagnostic = error.message;
        }
      }
    },
  };
}

function prompt(input, scenario, diagnostic) {
  const finalAcceptanceAudit = input.phase === "delivery_review" && input.finalAcceptanceAudit === true;
  const actions = finalAcceptanceAudit
    ? "message（发起一次最终契约验收；不得 accept）"
    : input.phase === "implementation"
    ? "message（继续推动）或 deliver（请求最终交付）"
    : input.phase === "delivery_review"
      ? "accept（接受交付）或 message（要求 Agent 自查遗漏）"
      : "message（把测试结果交给 Agent，并要求只确认收到）";
  return [
    { role: "system", content: [
      "你是推动软件项目的 User Agent。README 是唯一需求权威，冻结 Plan 是统一执行路线。",
      "Scenario 只决定如何推进项目；不得新增、复述或暗示具体功能、方法名、字段、测试断言或实现方式。",
      "每轮只推动一个自然阶段，要求 Agent 自己对照 README/Plan 判断完成度。",
      "决策前必须检查完整 conversation。如果最近连续三次 User Agent 消息都在推动 Agent 继续开发，且期间没有询问项目状态，本轮必须用 action=message 主动询问状态，不得再次要求继续开发。",
      "状态询问只能要求 Agent 对照 README 和冻结 Plan 说明当前阶段、已完成内容、公开验证证据、剩余材料工作以及是否可以交付；不得要求修改代码。收到状态报告后，再判断继续开发、最终审计或正式交付。",
      ...(finalAcceptanceAudit ? [
        "本轮是强制最终契约验收，不是普通状态询问。必须返回 action=message，不得 accept。",
        "要求 Agent 重新完整阅读 README，以 README 为唯一预期来源，逐项比较实际运行结果、公开接口、OpenAPI、UI 调用、持久化结果和测试断言；必须执行真实黑盒请求，不能只依赖自写测试、类型或代码阅读。",
        "要求 Agent 发现缺口后继续修复并重新验证；只有全部可观察要求都有执行证据时才能再次声明交付。你不得自行补充任何具体功能、字段、接口或测试要求。",
      ] : []),
      `根据当前阶段选择合适的 action，通常为：${actions}。只返回 JSON：{\"action\":\"...\",\"message\":\"...\"}。`,
    ].join("\n") },
    { role: "user", content: JSON.stringify({
      phase: input.phase,
      task: input.task,
      scenario,
      evaluation: input.evaluation,
      ...(finalAcceptanceAudit ? { finalAcceptanceAudit: true } : {}),
      conversation: input.transcript,
      correction: diagnostic,
    }) },
  ];
}

async function completeJson({ endpoint, apiKey, model, thinking, reasoningEffort, fetchImpl, body }) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      ...(thinking
        ? { thinking: { type: "enabled" }, reasoning_effort: reasoningEffort }
        : { temperature: 0.15 }),
      response_format: { type: "json_object" },
      messages: body,
    }),
  });
  if (!response.ok) throw new BenchError("user_provider_failure", `User model returned HTTP ${response.status}`);
  const value = await response.json();
  return value?.choices?.[0]?.message?.content;
}

function parseObject(text) {
  if (typeof text !== "string") throw new Error("missing model response");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("response is not JSON");
  return JSON.parse(fenced.slice(start, end + 1));
}

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function required(value, label) { if (typeof value !== "string" || !value.trim()) throw new BenchError("invalid_configuration", `${label} is required`); }
