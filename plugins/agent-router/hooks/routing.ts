import type { PluginOptions } from "claude-code";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type RoleSpec = { model: string; effort: Effort };

export type Settings = {
  mode: "apply" | "observe";
  endpoint: string;
  confidenceThreshold: number;
};

/** LocalJev に渡す choice の選択肢。roles.json のキーのうち、ここにあるものだけを判定対象にする。 */
export const ROLE_CRITERIA: Readonly<Record<string, string>> = {
  implement: "コードを新しく書く、または既存コードを直す（バグ修正やエラー解消を含む）",
  review: "変更済みのコードや PR を読み、問題点を洗い出す",
  refute: "すでに挙がった指摘や主張が正しいかを疑い、反証を試みる",
  fix: "既存の PR に付いたレビューコメントに対応して修正する",
  triage: "Issue や PR を分類・整理する",
  design: "設計や計画を立てる。複数の領域にまたがる方針を決める",
};

/** 名前だけでは定義ファイルを引けないが、エンジンが固有の設定を持つエージェント。 */
const BUILT_IN_DEFINED = new Set(["Explore", "Plan", "statusline-setup", "claude-code-guide"]);

/** 定義を持たず、呼び出し元の依頼内容でしか性質が決まらないエージェント。 */
const GENERIC = new Set(["general-purpose", "claude"]);

const EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

/** 判定に送る依頼文の上限。長い入力は LocalJev の精度と速度をともに落とす。 */
const MAX_STATE_CHARS = 2000;

export function readSettings(options: PluginOptions): Settings {
  const threshold = Number(options.confidenceThreshold);
  return {
    mode: options.mode === "observe" ? "observe" : "apply",
    endpoint: typeof options.endpoint === "string" && options.endpoint !== ""
      ? options.endpoint.replace(/\/+$/, "")
      : "http://127.0.0.1:8080",
    confidenceThreshold: Number.isFinite(threshold) ? threshold : 0.5,
  };
}

export function parseRoles(text: string): Record<string, RoleSpec> {
  const raw = JSON.parse(text) as Record<string, { model?: unknown; effort?: unknown }>;
  const roles: Record<string, RoleSpec> = {};
  for (const [name, spec] of Object.entries(raw)) {
    if (typeof spec.model === "string" && typeof spec.effort === "string" && EFFORTS.has(spec.effort)) {
      roles[name] = { model: spec.model, effort: spec.effort as Effort };
    }
  }
  return roles;
}

export type Frontmatter = { hasModel: boolean; hasEffort: boolean };

export function readFrontmatter(markdown: string): Frontmatter {
  const block = markdown.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  return {
    hasModel: /^model:\s*\S/m.test(block),
    hasEffort: /^effort:\s*\S/m.test(block),
  };
}

export type Scope = { model: boolean; effort: boolean };

export type AgentKind =
  | { kind: "skip" }
  | { kind: "generic" }
  | { kind: "defined-file"; name: string };

export function classifyAgentType(subagentType: string, fork: boolean): AgentKind {
  if (fork) return { kind: "skip" };
  if (subagentType.includes(":") || BUILT_IN_DEFINED.has(subagentType)) return { kind: "skip" };
  if (GENERIC.has(subagentType)) return { kind: "generic" };
  return { kind: "defined-file", name: subagentType };
}

/**
 * 書き換えてよい項目を決める。呼び出し側の model 指定と、定義ファイルに書かれた値は上書きしない。
 * 定義ファイルが見つからないエージェントは正体が分からないため触らない。
 */
export function scopeFor(kind: AgentKind, explicitModel: boolean, definition: Frontmatter | undefined): Scope {
  if (kind.kind === "skip") return { model: false, effort: false };
  if (kind.kind === "generic") return { model: !explicitModel, effort: true };
  if (definition === undefined) return { model: false, effort: false };
  return { model: !explicitModel && !definition.hasModel, effort: !definition.hasEffort };
}

export function systemOneRequest(description: string, prompt: string, roles: Record<string, RoleSpec>) {
  const criteria = Object.fromEntries(
    Object.entries(ROLE_CRITERIA).filter(([name]) => name in roles),
  );
  return {
    model: "jev-latest",
    state: `${description}\n\n${prompt.slice(0, MAX_STATE_CHARS)}`,
    questions: {
      role: {
        type: "choice",
        instructions: "このサブエージェントに任せる作業はどのロールにあたるか",
        criteria,
      },
    },
  };
}

type ChoiceAnswer = { choice: string; confidence: number };

export type Decision = { role: string; confidence: number; spec: RoleSpec };

export function pickRole(
  responseText: string,
  roles: Record<string, RoleSpec>,
  threshold: number,
): Decision | undefined {
  const body = JSON.parse(responseText) as { answers?: { role?: Partial<ChoiceAnswer> } };
  const answer = body.answers?.role;
  if (typeof answer?.choice !== "string" || typeof answer.confidence !== "number") return undefined;
  const spec = roles[answer.choice];
  if (spec === undefined || answer.confidence < threshold) return undefined;
  return { role: answer.choice, confidence: answer.confidence, spec };
}

export function statusLine(decision: Decision, scope: Scope, mode: Settings["mode"]): string {
  const model = scope.model ? decision.spec.model : "(既定)";
  const effort = scope.effort ? decision.spec.effort : "(既定)";
  const prefix = mode === "observe" ? "agent-router(observe)" : "agent-router";
  return `${prefix}: ${decision.role} → ${model}/${effort} (${decision.confidence.toFixed(2)})`;
}

export type WorkflowPhase = { title: string; detail?: string };

export type WorkflowMeta = { end: number; description?: string; phases: WorkflowPhase[] };

/** shim を差し込み済みかを見分ける印。scriptPath での再実行では、永続化されたスクリプトに shim が残っている。 */
export const SHIM_MARKER = "// agent-router:workflow-shim";

const STRING_LITERAL = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`;

function unquote(body: string): string {
  return body.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
}

/** `{` から対応する `}` の次の位置を返す。文字列リテラル内の括弧は数えない。 */
function matchBrace(text: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return undefined;
}

/** Workflow スクリプト先頭の `export const meta = {...}` から description と phases を読む。 */
export function readWorkflowMeta(script: string): WorkflowMeta | undefined {
  const head = script.match(/^\s*export\s+const\s+meta\s*=\s*/);
  if (!head) return undefined;
  const close = matchBrace(script, head[0].length);
  if (close === undefined) return undefined;
  const end = script[close] === ";" ? close + 1 : close;
  const meta = script.slice(head[0].length, close);

  const description = meta.match(new RegExp(String.raw`\bdescription\s*:\s*` + STRING_LITERAL))?.[2];
  const phases: WorkflowPhase[] = [];
  const list = meta.match(/\bphases\s*:\s*\[([\s\S]*)\]/)?.[1] ?? "";
  for (const entry of list.match(/\{[^{}]*\}/g) ?? []) {
    const title = entry.match(new RegExp(String.raw`\btitle\s*:\s*` + STRING_LITERAL))?.[2];
    if (title === undefined) continue;
    const detail = entry.match(new RegExp(String.raw`\bdetail\s*:\s*` + STRING_LITERAL))?.[2];
    phases.push(detail === undefined ? { title: unquote(title) } : { title: unquote(title), detail: unquote(detail) });
  }
  return { end, description: description === undefined ? undefined : unquote(description), phases };
}

export type WorkflowRoutes = { phases: Record<string, RoleSpec>; fallback?: RoleSpec };

/**
 * agent() と phase() を包み、フェーズに対応する model と effort を当てる。
 * スクリプトが opts に書いた model / effort と、定義を持つ agentType は上書きしない。
 */
export function workflowShim(routes: WorkflowRoutes): string {
  return [
    SHIM_MARKER,
    `const __agentRouterRoutes = ${JSON.stringify(routes)};`,
    `const __agentRouterGeneric = ${JSON.stringify([...GENERIC])};`,
    "let __agentRouterPhase;",
    "{ const original = phase; phase = (title) => { __agentRouterPhase = title; return original(title); }; }",
    "{ const original = agent; agent = (prompt, opts) => {",
    "  const o = opts ?? {};",
    "  const route = __agentRouterRoutes.phases[o.phase ?? __agentRouterPhase] ?? __agentRouterRoutes.fallback;",
    "  if (!route || (o.agentType !== undefined && !__agentRouterGeneric.includes(o.agentType))) return original(prompt, opts);",
    "  return original(prompt, { ...o, model: o.model ?? route.model, effort: o.effort ?? route.effort });",
    "}; }",
  ].join("\n");
}

export function injectShim(script: string, meta: WorkflowMeta, routes: WorkflowRoutes): string {
  return `${script.slice(0, meta.end)}\n${workflowShim(routes)}\n${script.slice(meta.end)}`;
}

export function workflowStatusLine(
  decisions: { label: string; decision: Decision }[],
  mode: Settings["mode"],
): string {
  const prefix = mode === "observe" ? "agent-router(observe)" : "agent-router";
  const parts = decisions.map(({ label, decision: d }) => `${label}=${d.role}→${d.spec.model}/${d.spec.effort}`);
  return `${prefix}: workflow ${parts.join(", ")}`;
}
