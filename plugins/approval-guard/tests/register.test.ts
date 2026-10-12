import type { On, ToolCallArgs } from "claude-code";
import { test, expect, mock } from "claude-code/testing";

const ASK = "AskUserQuestion";
const ASK_MATCHER = /^AskUserQuestion$/;
const BASH = "Bash";

/** 生成した型のツール一覧に AskUserQuestion が無いため、$.tool.call に渡せる型へここで一度だけ変換する。 */
function question(text: string): ToolCallArgs {
  const input = {
    tool: ASK,
    questions: [
      {
        question: text,
        header: "確認",
        multiSelect: false,
        options: [
          { label: "はい", description: "実行する" },
          { label: "いいえ", description: "実行しない" },
        ],
      },
    ],
  };
  return input as unknown as ToolCallArgs;
}

function answerWith(on: On, label: string) {
  on("tool.call", { tool: ASK_MATCHER }, () => ({
    result: { answers: { 確認: label } },
  }));
}

function bashSucceeds(on: On) {
  on("tool.call", { tool: BASH }, () => ({
    result: { stdout: "ok", stderr: "" },
  }));
}

/** Bash の成功と、承認の記録が読む時計を用意する。 */
function world(on: On) {
  bashSucceeds(on);
  return mock.clock(on, { now: 1_000_000 });
}

test("宛先の書かれていない承認質問は拒否される", async ($, on) => {
  answerWith(on, "はい");
  const r = await $.tool.call(question("Approve を送信しますか？"));
  expect(r.deny).toBeDefined();
});

test("マージや close を話題にするだけの設計相談は素通りする", async ($, on) => {
  answerWith(on, "マージ");
  world(on);
  const a = await $.tool.call(
    question("リベースとマージのどちらで進めますか？"),
  );
  expect(a.deny).toBe(undefined);
  const b = await $.tool.call(question("モーダルの close 挙動はどうしますか？"));
  expect(b.deny).toBe(undefined);
});

test("承認と無関係な質問は素通りする", async ($, on) => {
  answerWith(on, "はい");
  const r = await $.tool.call(question("どのライブラリを使いますか？"));
  expect(r.deny).toBe(undefined);
});

test("承認なしのレビュー投稿は拒否される", async ($, on) => {
  bashSucceeds(on);
  const r = await $.tool.call({
    tool: BASH,
    command: "gh pr review --approve 1234",
  });
  expect(r.deny).toBeDefined();
});

test("承認した番号と一致すれば通り、レビュー投稿は一度で使い切る", async ($, on) => {
  answerWith(on, "はい");
  world(on);
  await $.tool.call(question("#1234 に Approve を送信しますか？"));

  const first = await $.tool.call({
    tool: BASH,
    command: "gh pr review --approve 1234",
  });
  expect(first.deny).toBe(undefined);

  const second = await $.tool.call({
    tool: BASH,
    command: "gh pr review --approve 1234",
  });
  expect(second.deny).toBeDefined();
});

test("承認した番号と違う宛先は拒否される", async ($, on) => {
  answerWith(on, "はい");
  world(on);
  await $.tool.call(question("#1234 に Approve を送信しますか？"));
  const r = await $.tool.call({
    tool: BASH,
    command: "gh pr review --approve 5678",
  });
  expect(r.deny).toBeDefined();
});

test("1 桁の番号でも承認と宛先を突き合わせる", async ($, on) => {
  answerWith(on, "はい");
  world(on);
  await $.tool.call(question("#1 を merge しますか？"));
  const other = await $.tool.call({
    tool: BASH,
    command: "gh pr merge 2 --repo owner/repo --merge",
  });
  expect(other.deny).toBeDefined();
  const ok = await $.tool.call({
    tool: BASH,
    command: "gh pr merge 1 --repo owner/repo --merge",
  });
  expect(ok.deny).toBe(undefined);
});

/** 実際の AskUserQuestion の結果のように、質問と選択肢を回答と一緒に返す。 */
function answerWithOptions(on: On, label: string) {
  on("tool.call", { tool: ASK_MATCHER }, () => ({
    result: {
      questions: [
        { question: "#1 を merge しますか？", options: [{ label: "#1 を merge する" }, { label: "merge しない" }] },
      ],
      answers: { "#1 を merge しますか？": label },
    },
  }));
}

test("選択肢に否定の語があっても、肯定を選べば承認が記録される", async ($, on) => {
  answerWithOptions(on, "#1 を merge する");
  world(on);
  await $.tool.call(question("#1 を merge しますか？"));
  const r = await $.tool.call({ tool: BASH, command: "gh pr merge 1 --repo owner/repo --merge" });
  expect(r.deny).toBe(undefined);
});

test("選択肢に肯定の語があっても、否定を選べば承認は記録されない", async ($, on) => {
  answerWithOptions(on, "merge しない");
  world(on);
  await $.tool.call(question("#1 を merge しますか？"));
  const r = await $.tool.call({ tool: BASH, command: "gh pr merge 1 --repo owner/repo --merge" });
  expect(r.deny).toBeDefined();
});

test("否定の回答では承認が記録されない", async ($, on) => {
  answerWith(on, "送信しない");
  bashSucceeds(on);
  await $.tool.call(question("#1234 に Approve を送信しますか？"));
  const r = await $.tool.call({
    tool: BASH,
    command: "gh pr review --approve 1234",
  });
  expect(r.deny).toBeDefined();
});

test("レビューの承認では merge は通らない", async ($, on) => {
  answerWith(on, "はい");
  world(on);
  await $.tool.call(question("#1234 に Approve を送信しますか？"));
  const r = await $.tool.call({
    tool: BASH,
    command: "gh pr merge 1234 --squash",
  });
  expect(r.deny).toBeDefined();
});

test("merge の承認は再試行のために使い切らない", async ($, on) => {
  answerWith(on, "はい");
  world(on);
  await $.tool.call(question("#42 を merge してよいですか？"));

  const first = await $.tool.call({
    tool: BASH,
    command: "gh pr merge 42 --squash --repo o/r",
  });
  expect(first.deny).toBe(undefined);

  const retry = await $.tool.call({
    tool: BASH,
    command: "gh pr merge 42 --squash --repo o/r",
  });
  expect(retry.deny).toBe(undefined);
});

test("merge の承認は 180 秒を過ぎると失効する", async ($, on) => {
  answerWith(on, "はい");
  const clock = world(on);
  await $.tool.call(question("#42 を merge してよいですか？"));
  await clock.advance(181_000);
  const r = await $.tool.call({
    tool: BASH,
    command: "gh pr merge 42 --squash --repo o/r",
  });
  expect(r.deny).toBeDefined();
});

test("gh api 経由の merge と close も照合される", async ($, on) => {
  answerWith(on, "はい");
  world(on);

  const before = await $.tool.call({
    tool: BASH,
    command: "gh api --method PUT /repos/o/r/pulls/42/merge",
  });
  expect(before.deny).toBeDefined();

  await $.tool.call(question("#42 を close してよいですか？"));
  const mismatch = await $.tool.call({
    tool: BASH,
    command: 'gh api --method PATCH /repos/o/r/issues/43 -f state=closed',
  });
  expect(mismatch.deny).toBeDefined();

  const ok = await $.tool.call({
    tool: BASH,
    command: 'gh api --method PATCH /repos/o/r/issues/42 -f state=closed',
  });
  expect(ok.deny).toBe(undefined);
});

test("宛先番号のない close は拒否される", async ($, on) => {
  answerWith(on, "はい");
  world(on);
  await $.tool.call(question("#42 を close してよいですか？"));
  const r = await $.tool.call({ tool: BASH, command: "gh pr close" });
  expect(r.deny).toBeDefined();
});

test("create / edit の本文に merge が含まれても素通りする", async ($, on) => {
  bashSucceeds(on);
  const r = await $.tool.call({
    tool: BASH,
    command: 'gh pr create --title t --body "Closes #12 後で gh pr merge する"',
  });
  expect(r.deny).toBe(undefined);
});

test("不可逆でないコマンドは素通りする", async ($, on) => {
  bashSucceeds(on);
  const r = await $.tool.call({ tool: BASH, command: "echo hi" });
  expect(r.deny).toBe(undefined);
});

test("チェーンされた複数の不可逆操作は、すべての宛先が承認と一致しなければ拒否される", async ($, on) => {
  answerWith(on, "はい");
  world(on);
  await $.tool.call(question("#42 を merge しますか？"));
  const r = await $.tool.call({
    tool: BASH,
    command: "gh pr merge 42 --squash && gh pr merge 43 --squash",
  });
  expect(r.deny).toContain("#43");
  const ok = await $.tool.call({
    tool: BASH,
    command: "gh pr merge 42 --squash && echo done",
  });
  expect(ok.deny).toBe(undefined);
});

test("クォート内の区切り文字ではコマンドを分けない", async ($, on) => {
  answerWith(on, "はい");
  world(on);
  await $.tool.call(question("#42 を merge しますか？"));
  const r = await $.tool.call({
    tool: BASH,
    command: 'gh pr merge 42 --subject "a && gh pr merge 43"',
  });
  expect(r.deny).toBe(undefined);
});

test("レビューの短いフラグも宛先を照合する", async ($, on) => {
  bashSucceeds(on);
  for (const command of ["gh pr review 1234 -a", "gh pr review -r 1234"]) {
    const r = await $.tool.call({ tool: BASH, command });
    expect(r.deny).toBeDefined();
  }
});

test("gh api の -X も宛先を照合する", async ($, on) => {
  bashSucceeds(on);
  for (const command of [
    "gh api -X PATCH /repos/o/r/issues/42 -f state=closed",
    "gh api repos/o/r/pulls/42/merge -X PUT",
    "gh api --method=PATCH /repos/o/r/issues/42 -f state=closed",
  ]) {
    const r = await $.tool.call({ tool: BASH, command });
    expect(r.deny).toBeDefined();
  }
});
