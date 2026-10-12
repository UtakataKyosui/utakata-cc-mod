import type { On } from "claude-code";
import { test, expect, mock, type Engine } from "claude-code/testing";
import { parseVerdict, systemOneRequest, verdictByKeywords } from "../hooks/guard";

function reply(choice: string) {
  return JSON.stringify({ answers: { phase: { choice, confidence: 0.9, probabilities: {} } } });
}

/** 依頼文の送信、LocalJev の応答、計画ツールの実行を用意する。 */
function world(on: On, opts: { verdict?: string } = {}) {
  // 判定の打ち切りタイマーを止めておき、LocalJev の応答が先に届く状況にする
  mock.clock(on);
  const calls = { http: 0 };
  on("http.fetch", () => {
    calls.http++;
    if (opts.verdict === undefined) throw new Error("ECONNREFUSED");
    return { value: { status: 200, ok: true, headers: {}, text: reply(opts.verdict) } };
  });
  on("prompt.submit", ($, e) => ({ text: e.text }));
  on("tool.call", { tool: /^EnterPlanMode$/ }, () => ({ result: {} }));
  on("tool.call", { tool: "Agent" }, () => ({ result: {} }));
  return calls;
}

async function submit($: Engine, text: string, kind = "composer") {
  await $.prompt.submit({ text, wait: false, origin: { kind } } as never);
}

/** EnterPlanMode は生成した型の組み込みツール一覧に載らないため、入力の型を外して呼ぶ。 */
function enterPlanMode($: Engine) {
  return $.tool.call({ tool: "EnterPlanMode" } as never);
}

test("「直して」の依頼で EnterPlanMode は止まり、LocalJev は呼ばない", async ($, on) => {
  const calls = world(on, { verdict: "plan" });
  await submit($, "devcontainer の起動エラーを直して");
  const r = await enterPlanMode($);
  expect(r.deny).toBeDefined();
  expect(calls.http).toBe(0);
});

test("「計画して」の依頼では EnterPlanMode を通す", async ($, on) => {
  world(on, { verdict: "execute" });
  await submit($, "認証基盤の刷新を計画して");
  const r = await enterPlanMode($);
  expect(r.deny).toBe(undefined);
});

test("語で決まらない依頼は LocalJev の判定に従う", async ($, on) => {
  const calls = world(on, { verdict: "execute" });
  await submit($, "README の誤字をなくしておいて");
  const r = await enterPlanMode($);
  expect(r.deny).toBeDefined();
  expect(calls.http).toBe(1);
});

test("LocalJev が plan と判定すれば通す", async ($, on) => {
  world(on, { verdict: "plan" });
  await submit($, "通知まわりをいい感じにしたい");
  const r = await enterPlanMode($);
  expect(r.deny).toBe(undefined);
});

test("LocalJev に届かなければ通す", async ($, on) => {
  world(on);
  await submit($, "README の誤字をなくしておいて");
  const r = await enterPlanMode($);
  expect(r.deny).toBe(undefined);
});

test("Plan エージェントの起動も止め、ほかのエージェントは止めない", async ($, on) => {
  world(on, { verdict: "plan" });
  await submit($, "型エラーを直して");
  const plan = await $.tool.call({ tool: "Agent", subagent_type: "Plan", description: "計画", prompt: "p" });
  expect(plan.deny).toBeDefined();
  const explore = await $.tool.call({ tool: "Agent", subagent_type: "Explore", description: "探索", prompt: "p" });
  expect(explore.deny).toBe(undefined);
});

test("タスクの完了通知は直近の依頼文を上書きしない", async ($, on) => {
  const calls = world(on, { verdict: "plan" });
  await submit($, "型エラーを直して");
  await submit($, "バックグラウンドの作業が終わった", "task-notification");
  const r = await enterPlanMode($);
  expect(r.deny).toBeDefined();
  expect(calls.http).toBe(0);
});

test("依頼文がまだ無ければ通す", async ($, on) => {
  world(on, { verdict: "execute" });
  const r = await enterPlanMode($);
  expect(r.deny).toBe(undefined);
});

test("計画を求める語は修正を求める語より優先する", () => {
  expect(verdictByKeywords("直す方針を計画して")).toBe("plan");
  expect(verdictByKeywords("PR のレビューコメントに対応して")).toBe("execute");
  expect(verdictByKeywords("通知をいい感じに")).toBe(undefined);
});

test("LocalJev の応答から判定を読み、想定外の選択肢は捨てる", () => {
  expect(parseVerdict(reply("execute"))).toBe("execute");
  expect(parseVerdict(reply("maybe"))).toBe(undefined);
  expect(systemOneRequest("x".repeat(5000)).state.length).toBe(2000);
});
