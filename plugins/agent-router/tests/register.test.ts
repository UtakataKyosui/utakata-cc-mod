import type { AgentSpawnInput, On } from "claude-code";
import { test, expect, mock } from "claude-code/testing";
import {
  classifyAgentType,
  pickRole,
  readFrontmatter,
  readWorkflowMeta,
  scopeFor,
  SHIM_MARKER,
  systemOneRequest,
  workflowShim,
} from "../hooks/routing";

type SpawnArgs = Pick<AgentSpawnInput, "prompt" | "description" | "subagentType"> & Partial<AgentSpawnInput>;

/** エンジンの呼び出し元が埋める項目を補って、agent.spawn の入力を作る。 */
function spawnInput(args: SpawnArgs): AgentSpawnInput {
  return {
    tool_use_id: "toolu_test",
    provider: { plugin: "engine", tier: "core" },
    parentModel: "claude-opus-5-5",
    background: false,
    fork: false,
    ...args,
  };
}

// テストキットでは /home 配下の fs.read がフックに届かないため、短いパスを使う
const HOME = "/h";

const ROLES = JSON.stringify({
  implement: { model: "sonnet", effort: "high" },
  review: { model: "sonnet", effort: "high" },
  refute: { model: "opus", effort: "xhigh" },
  triage: { model: "haiku", effort: "low" },
});

function answer(choice: string, confidence: number) {
  return JSON.stringify({ answers: { role: { choice, confidence, probabilities: {} } } });
}

/** roles.json と agents/*.md を読ませ、LocalJev の応答を返し、起動に使われた model を記録する。 */
function world(on: On, opts: { reply?: (state: string) => string; files?: Record<string, string> } = {}) {
  mock.env(on, { HOME });
  // 判定の打ち切りタイマーを止めておき、LocalJev の応答が先に届く状況にする
  mock.clock(on);
  const files: Record<string, string> = {
    [`${HOME}/.claude/skills/agent-routing/data/roles.json`]: ROLES,
    ...opts.files,
  };
  on("fs.read", ($, e) => {
    const text = files[e.path];
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`);
    return { value: text };
  });
  const calls = { http: 0 };
  on("http.fetch", ($, e) => {
    calls.http++;
    if (!opts.reply) throw new Error("ECONNREFUSED");
    const state = (JSON.parse(e.init?.body ?? "{}") as { state?: string }).state ?? "";
    return { value: { status: 200, ok: true, headers: {}, text: opts.reply(state) } };
  });
  const statuses: string[] = [];
  on("ui.status", ($, e) => {
    if (e.text !== undefined) statuses.push(e.text);
    return { value: undefined };
  });
  const spawned: { model: string | undefined }[] = [];
  on("agent.spawn", ($, e) => {
    spawned.push({ model: e.model });
    return { model: e.model ?? "inherit", agentId: `agent-${spawned.length}` };
  });
  const workflows: string[] = [];
  on("tool.call", { tool: "Workflow" }, ($, e) => {
    if (e.tool === "Workflow" && e.script !== undefined) workflows.push(e.script);
    return { result: "launched" };
  });
  return { calls, spawned, statuses, workflows };
}

test("レビュー依頼の汎用エージェントは roles.json の review の model で起動する", async ($, on) => {
  const w = world(on, { reply: () => answer("review", 0.9) });
  await $.agent.spawn(spawnInput({ prompt: "PR #1 の差分を読んで問題点を洗い出して", description: "PR レビュー", subagentType: "general-purpose" }));
  expect(w.spawned).toEqual([{ model: "sonnet" }]);
  expect(w.statuses).toEqual(["agent-router: review → sonnet/high (0.90)"]);
});

test("反証の依頼は opus で起動する", async ($, on) => {
  const w = world(on, { reply: () => answer("refute", 0.8) });
  await $.agent.spawn(spawnInput({ prompt: "この指摘が正しいか反証して", description: "反証", subagentType: "general-purpose" }));
  expect(w.spawned).toEqual([{ model: "opus" }]);
});

test("呼び出し側が model を指定したときは上書きしない", async ($, on) => {
  const w = world(on, { reply: () => answer("refute", 0.9) });
  await $.agent.spawn(spawnInput({ prompt: "反証して", description: "反証", subagentType: "general-purpose", model: "haiku" }));
  expect(w.spawned).toEqual([{ model: "haiku" }]);
});

test("確信度が下限未満なら書き換えない", async ($, on) => {
  const w = world(on, { reply: () => answer("refute", 0.3) });
  await $.agent.spawn(spawnInput({ prompt: "devcontainer を直して", description: "修正", subagentType: "general-purpose" }));
  expect(w.spawned).toEqual([{ model: undefined }]);
});

test("LocalJev に届かなくても起動は止めない", async ($, on) => {
  const w = world(on);
  const r = await $.agent.spawn(spawnInput({ prompt: "レビューして", description: "レビュー", subagentType: "general-purpose" }));
  expect("deny" in r).toBe(false);
  expect(w.spawned).toEqual([{ model: undefined }]);
});

test("定義ファイルに model があるエージェントは判定しない", async ($, on) => {
  const w = world(on, {
    reply: () => answer("refute", 0.9),
    files: { [`${HOME}/.claude/agents/role-verifier.md`]: "---\nname: role-verifier\nmodel: opus\neffort: xhigh\n---\n本文" },
  });
  await $.agent.spawn(spawnInput({ prompt: "反証して", description: "反証", subagentType: "role-verifier" }));
  expect(w.calls.http).toBe(0);
  expect(w.spawned).toEqual([{ model: undefined }]);
});

test("作業ディレクトリが下位にあっても祖先の .claude/agents の定義を読む", async ($, on) => {
  const w = world(on, {
    reply: () => answer("refute", 0.9),
    files: { "../../.claude/agents/role-verifier.md": "---\nname: role-verifier\nmodel: opus\neffort: xhigh\n---\n本文" },
  });
  await $.agent.spawn(spawnInput({ prompt: "反証して", description: "反証", subagentType: "role-verifier" }));
  expect(w.calls.http).toBe(0);
});

test("プラグインのエージェントと組み込みの Explore は判定しない", async ($, on) => {
  const w = world(on, { reply: () => answer("review", 0.9) });
  await $.agent.spawn(spawnInput({ prompt: "探して", description: "探索", subagentType: "Explore" }));
  await $.agent.spawn(spawnInput({ prompt: "計画して", description: "計画", subagentType: "change-driven:change-planner" }));
  expect(w.calls.http).toBe(0);
});

test("定義ファイルの frontmatter から model と effort の有無を読む", () => {
  expect(readFrontmatter("---\nname: a\nmodel: sonnet\n---\n")).toEqual({ hasModel: true, hasEffort: false });
  expect(readFrontmatter("---\r\nname: a\r\nmodel: sonnet\r\neffort: high\r\n---\r\n")).toEqual({ hasModel: true, hasEffort: true });
  expect(readFrontmatter("本文だけ")).toEqual({ hasModel: false, hasEffort: false });
});

test("書き換えてよい範囲は呼び出しの指定と定義の値で決まる", () => {
  const generic = classifyAgentType("general-purpose", false);
  expect(scopeFor(generic, true, undefined)).toEqual({ model: false, effort: true });
  const defined = classifyAgentType("codebase-conventions", false);
  expect(scopeFor(defined, false, { hasModel: true, hasEffort: false })).toEqual({ model: false, effort: true });
  expect(scopeFor(defined, false, undefined)).toEqual({ model: false, effort: false });
  expect(classifyAgentType("general-purpose", true)).toEqual({ kind: "skip" });
});

test("roles.json に無いロールは選択肢に入れず、判定されても採用しない", () => {
  const roles = { review: { model: "sonnet", effort: "high" as const } };
  const req = systemOneRequest("d", "p", roles);
  expect(Object.keys(req.questions.role.criteria)).toEqual(["review"]);
  expect(pickRole(answer("design", 0.99), roles, 0.5)).toBe(undefined);
});

test("依頼文は 2000 文字で切って送る", () => {
  const req = systemOneRequest("d", "x".repeat(5000), {});
  expect(req.state.length).toBe("d\n\n".length + 2000);
});

const REVIEW_WORKFLOW = `export const meta = {
  name: 'review-changes',
  description: 'Review changed files and verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify', detail: 'try to refute each finding' }],
}
phase('Review')
const found = await agent('find issues')
`;

/** 担当フェーズで答え分ける LocalJev。全体の判定は review にする。 */
function byPhase(state: string): string {
  if (state.includes("「Verify」フェーズ")) return answer("refute", 0.9);
  return answer("review", 0.8);
}

test("Workflow のフェーズごとにロールを判定し、agent() に model と effort を当てる", async ($, on) => {
  const w = world(on, { reply: byPhase });
  await $.tool.call({ tool: "Workflow", script: REVIEW_WORKFLOW });
  expect(w.workflows.length).toBe(1);
  const script = w.workflows[0] ?? "";
  expect(script.startsWith(REVIEW_WORKFLOW.slice(0, REVIEW_WORKFLOW.indexOf("phase("))) ).toBe(true);
  expect(script.includes(SHIM_MARKER)).toBe(true);
  expect(w.statuses).toEqual(["agent-router: workflow Verify=refute→opus/xhigh, *=review→sonnet/high"]);
});

test("shim にはフェーズと全体の振り分け先を埋め込む", () => {
  const shim = workflowShim({ phases: { Verify: { model: "opus", effort: "xhigh" } }, fallback: { model: "haiku", effort: "low" } });
  expect(shim.startsWith(SHIM_MARKER)).toBe(true);
  expect(shim.includes('{"phases":{"Verify":{"model":"opus","effort":"xhigh"}},"fallback":{"model":"haiku","effort":"low"}}')).toBe(true);
});

test("shim 済みのスクリプトと、LocalJev に届かない場合は書き換えない", async ($, on) => {
  const w = world(on);
  await $.tool.call({ tool: "Workflow", script: REVIEW_WORKFLOW });
  const already = `export const meta = { name: 'x', description: 'y' }\n${SHIM_MARKER}\n`;
  await $.tool.call({ tool: "Workflow", script: already });
  expect(w.workflows).toEqual([REVIEW_WORKFLOW, already]);
});

test("meta の description と phases を文字列リテラルから読む", () => {
  const meta = readWorkflowMeta(REVIEW_WORKFLOW);
  expect(meta?.description).toBe("Review changed files and verify each finding");
  expect(meta?.phases).toEqual([{ title: "Review" }, { title: "Verify", detail: "try to refute each finding" }]);
  expect(REVIEW_WORKFLOW.slice(meta?.end ?? 0).startsWith("\nphase(")).toBe(true);
  expect(readWorkflowMeta("const x = 1")).toBe(undefined);
  expect(readWorkflowMeta("export const meta = { name: 'a}b', description: \"it's\" };\nrest")?.description).toBe("it's");
});
