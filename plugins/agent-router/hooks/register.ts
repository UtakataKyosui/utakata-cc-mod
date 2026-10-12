import type { EngineInterface, On, PluginOptions } from "claude-code";
import {
  classifyAgentType,
  injectShim,
  parseRoles,
  pickRole,
  readFrontmatter,
  readSettings,
  readWorkflowMeta,
  scopeFor,
  SHIM_MARKER,
  statusLine,
  systemOneRequest,
  workflowStatusLine,
  type Decision,
  type Effort,
  type Frontmatter,
  type RoleSpec,
  type WorkflowRoutes,
} from "./routing";

/** LocalJev の応答を待つ上限。超えたら判定なしで起動する。 */
const DECIDE_TIMEOUT_MS = 5000;

async function readOptional($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path);
  } catch {
    return undefined;
  }
}

/** 作業ディレクトリがリポジトリの下位にあっても見つかるよう、祖先ディレクトリまで遡る段数。 */
const PROJECT_AGENT_MAX_DEPTH = 8;

async function projectAgentText($: EngineInterface, name: string): Promise<string | undefined> {
  for (let depth = 0; depth < PROJECT_AGENT_MAX_DEPTH; depth++) {
    const text = await readOptional($, `${"../".repeat(depth)}.claude/agents/${name}.md`);
    if (text !== undefined) return text;
  }
  return undefined;
}

async function agentDefinition($: EngineInterface, name: string): Promise<Frontmatter | undefined> {
  const home = await $.env.get("HOME");
  const text =
    (await projectAgentText($, name)) ??
    (home ? await readOptional($, `${home}/.claude/agents/${name}.md`) : undefined);
  return text === undefined ? undefined : readFrontmatter(text);
}

async function loadRoles($: EngineInterface): Promise<Record<string, RoleSpec> | undefined> {
  const home = await $.env.get("HOME");
  if (!home) return undefined;
  const text = await readOptional($, `${home}/.claude/skills/agent-routing/data/roles.json`);
  return text === undefined ? undefined : parseRoles(text);
}

async function decide(
  $: EngineInterface,
  endpoint: string,
  threshold: number,
  roles: Record<string, RoleSpec>,
  description: string,
  prompt: string,
): Promise<Decision | undefined> {
  const request = $.http
    .fetch(`${endpoint}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(systemOneRequest(description, prompt, roles)),
    })
    .then((res) => (res.ok ? pickRole(res.text, roles, threshold) : undefined))
    .catch(() => undefined);
  const timeout = $.clock.sleep(DECIDE_TIMEOUT_MS).then(() => undefined);
  return Promise.race([request, timeout]);
}

function showStatus($: EngineInterface, text: string) {
  try {
    $.ui.status(text);
  } catch {
    // 表示先が無い場面（headless など）でも振り分けは続ける
  }
}

export function register(on: On, options: PluginOptions) {
  const settings = readSettings(options);
  /** 起動済みサブエージェントの id と、その turn.step に当てる effort。SendMessage で再開されたときも当てるため、完了しても消さない。 */
  const effortByAgent = new Map<string, Effort>();
  /** agent.spawn の結果が返る前に最初の turn.step が来た場合に、description から引くための控え。同じ description の起動も 1 件ずつ別に持つ。 */
  const pendingByDescription = new Map<string, { effort: Effort }[]>();

  on("agent.spawn", async ($, e, next) => {
    const kind = classifyAgentType(e.subagentType, e.fork === true);
    if (kind.kind === "skip") return next(e);
    const definition = kind.kind === "defined-file" ? await agentDefinition($, kind.name) : undefined;
    const scope = scopeFor(kind, e.model !== undefined, definition);
    if (!scope.model && !scope.effort) return next(e);

    const roles = await loadRoles($);
    if (roles === undefined) return next(e);
    const decision = await decide($, settings.endpoint, settings.confidenceThreshold, roles, e.description, e.prompt);
    if (decision === undefined) return next(e);
    showStatus($, statusLine(decision, scope, settings.mode));
    if (settings.mode === "observe") return next(e);

    const pending = { effort: decision.spec.effort };
    if (scope.effort) pendingByDescription.set(e.description, [...(pendingByDescription.get(e.description) ?? []), pending]);
    try {
      const result = await next(scope.model ? { ...e, model: decision.spec.model } : e);
      if (scope.effort && result.agentId !== undefined) effortByAgent.set(result.agentId, pending.effort);
      return result;
    } finally {
      const rest = (pendingByDescription.get(e.description) ?? []).filter((p) => p !== pending);
      if (rest.length === 0) pendingByDescription.delete(e.description);
      else pendingByDescription.set(e.description, rest);
    }
  });

  on("turn.step", async function* ($, e, next) {
    const agentId = e.agentId;
    if (agentId === undefined || e.effort === undefined) return yield* next(e);
    let effort = effortByAgent.get(agentId);
    if (effort === undefined && pendingByDescription.size > 0) {
      const agent = (await $.agent.list()).find((a) => a.id === agentId);
      const queue = agent ? pendingByDescription.get(agent.description) : undefined;
      const claimed = queue?.shift();
      if (agent && queue !== undefined && queue.length === 0) pendingByDescription.delete(agent.description);
      if (agent && claimed !== undefined) {
        effort = claimed.effort;
        effortByAgent.set(agentId, effort);
      }
    }
    return yield* next(effort === undefined ? e : { ...e, effort });
  });

  // Workflow の agent() は agent.spawn を通らないため、スクリプトに shim を差し込んで model と effort を当てる
  on("tool.call", { tool: "Workflow" }, async ($, e, next) => {
    if (e.tool !== "Workflow" || e.script === undefined || e.script.includes(SHIM_MARKER)) return next(e);
    const meta = readWorkflowMeta(e.script);
    if (meta === undefined) return next(e);
    const roles = await loadRoles($);
    if (roles === undefined) return next(e);

    const summary = meta.description ?? "";
    const targets = [
      // title だけでは判定を誤りやすいため、detail の無いフェーズは全体の判定に任せる
      ...meta.phases.flatMap((p) =>
        p.detail === undefined
          ? []
          : [{ label: p.title, description: `ワークフロー全体の目的は「${summary}」。このサブエージェントはそのうち「${p.title}」フェーズだけを担当する`, prompt: p.detail }],
      ),
      ...(summary === "" ? [] : [{ label: "*", description: summary, prompt: "" }]),
    ];
    const decided = await Promise.all(
      targets.map(async (t) => ({
        label: t.label,
        decision: await decide($, settings.endpoint, settings.confidenceThreshold, roles, t.description, t.prompt),
      })),
    );
    const decisions = decided.filter((d): d is { label: string; decision: Decision } => d.decision !== undefined);
    if (decisions.length === 0) return next(e);
    showStatus($, workflowStatusLine(decisions, settings.mode));
    if (settings.mode === "observe") return next(e);

    const routes: WorkflowRoutes = { phases: {} };
    for (const { label, decision } of decisions) {
      if (label === "*") routes.fallback = decision.spec;
      else routes.phases[label] = decision.spec;
    }
    return next({ ...e, script: injectShim(e.script, meta, routes) });
  });
}
