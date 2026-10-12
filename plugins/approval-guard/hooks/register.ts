import type { On } from "claude-code";

import {
  bodyFileOf,
  FORCE_PUSH_REASON,
  isForcePush,
  MISSING_CLOSE_KEYWORD,
  mentionsIssue,
} from "./push-and-pr";

type Kind = "review" | "close";

type Approval = {
  prs: string[];
  kinds: Set<Kind>;
  at: number;
};

/** close / merge の承認を再利用できる時間。スタック merge や失敗後の再試行に対応する。 */
const CLOSE_REUSE_MS = 180_000;

const PR_NUMBER = /#(\d{1,6})/g;

/** matcher。不可逆操作を含みうる Bash コマンドだけをフックへ入れる。 */
const IRREVERSIBLE =
  /gh (pr|issue) (review|close|merge)|\/pulls\/\d+\/(reviews|merge)|--method (PUT|PATCH) .*\/(pulls|issues)\/\d+/;

const API_CLOSE =
  /gh api .*--method (PUT|PATCH) .*\/(pulls|issues)\/\d+(\/merge)?( |$|"|')/;

type Target = { kind: Kind; number: string | undefined; label: string };

/** `gh pr review --approve 1234` のように、サブコマンド以降の位置引数から番号を拾う。 */
function positionalNumber(command: string, sub: RegExp): string | undefined {
  const seg = command.match(sub)?.[1] ?? "";
  return seg.match(/(?:^|\s)#?(\d{1,6})(?=\s|$)/)?.[1];
}

function irreversibleTarget(command: string): Target | undefined {
  if (/\s(--help|-h)(\s|$)/.test(command)) return undefined;
  // create / edit は --body に "gh pr merge" のような文字列を含みうる
  if (/gh (issue|pr) (create|edit)/.test(command)) return undefined;

  const review =
    /gh pr review/.test(command) &&
    /(--approve|--request-changes)/.test(command);
  const reviewApi =
    /gh api .*\/pulls\/\d+\/reviews/.test(command) &&
    /(APPROVE|REQUEST_CHANGES)/.test(command);
  const closing =
    /gh (issue close|pr close|pr merge)/.test(command) ||
    API_CLOSE.test(command);

  if (review || reviewApi) {
    const label = /(--approve|APPROVE)/.test(command)
      ? "Approve"
      : "Request Changes";
    const number =
      command.match(/\/pulls\/(\d+)/)?.[1] ??
      positionalNumber(command, /gh pr review\b([^|;&]*)/);
    return { kind: "review", number, label };
  }
  if (closing) {
    const number =
      command.match(/\/(pulls|issues)\/(\d+)/)?.[2] ??
      positionalNumber(command, /gh (?:issue close|pr close|pr merge)\b([^|;&]*)/);
    const label = /merge/.test(command) ? "merge" : "close";
    return { kind: "close", number, label };
  }
  return undefined;
}

function numbersIn(text: string): string[] {
  return [...text.matchAll(PR_NUMBER)].map((m) => m[1]!);
}

function questionText(e: Record<string, unknown>): string {
  return JSON.stringify(e.questions ?? "");
}

/** 質問文だけ。選択肢の「実行する / 実行しない」を許可の言い回しと取り違えないため。 */
function questionsOnly(e: Record<string, unknown>): string {
  const qs = Array.isArray(e.questions) ? e.questions : [];
  return qs
    .map((q) => String((q as Record<string, unknown>)?.question ?? ""))
    .join(" ");
}

function kindsIn(text: string): Set<Kind> {
  const kinds = new Set<Kind>();
  if (/approve|request changes|レビュー(を)?(送信|投稿)/i.test(text)) {
    kinds.add("review");
  }
  if (/merge|マージ|close|クローズ/i.test(text)) kinds.add("close");
  return kinds;
}

/**
 * 不可逆操作の許可を求めている質問か。設計上の相談（「マージとリベースのどちらで進めるか」など）
 * を巻き込まないよう、許可を求める言い回しがあるものだけを対象にする。
 */
function isPermissionAsk(text: string): boolean {
  return /送信|投稿|実行|(して|を)(よい|いい|よろしい)|してもいい|(approve|merge|close)\s*(this|the|it|#|pr|issue)|request changes/i.test(
    text,
  );
}

function isAffirmative(answer: string): boolean {
  if (/しない|キャンセル|やめる|保留|cancel|don.?t/i.test(answer)) return false;
  return /はい|yes|する|承認|推奨|送信|投稿|merge|approve|request changes/i.test(
    answer,
  );
}

export function register(on: On) {
  // 同一セッション内のプロセス内変数。sentinel ファイルは要らない。
  let approval: Approval | undefined;

  // 生成した型の組み込みツール一覧に AskUserQuestion が無いため、文字列ではなく完全一致の正規表現で指定する
  on("tool.call", { tool: /^AskUserQuestion$/ }, async ($, e, next) => {
    const ev = e as Record<string, unknown>;
    const asked = questionText(ev);
    const kinds = kindsIn(asked);

    if (kinds.size === 0) return next(e);

    // 宛先の書かれていない承認質問は、質問そのものを拒否する（rules/irreversible-target-echo.md）
    if (isPermissionAsk(questionsOnly(ev)) && numbersIn(asked).length === 0) {
      return {
        deny: "対象を #NNNN の形式で質問文に書いてから聞くこと（宛先の復唱）",
      };
    }

    // 回答を受け取った後に失敗しうる処理を置かない。失敗して .catch が next(e) を
    // 呼び直すと、同じ質問を利用者に二度聞くことになる
    const now = await $.clock.now();
    const r = await next(e);

    // 選択肢の文言（「merge しない」など）で肯定・否定を取り違えないよう、選ばれた回答だけを見る
    const result = r.result as { answers?: unknown } | undefined;
    const answered = JSON.stringify(result?.answers ?? "");
    if (isAffirmative(answered)) {
      approval = {
        prs: [...numbersIn(asked), ...numbersIn(answered)],
        kinds,
        at: now,
      };
    }
    return r;
  }).catch(($, e, next) => next(e)); // 記録に失敗しても質問自体は壊さない

  on("tool.call", { tool: "Bash", command: IRREVERSIBLE }, async ($, e, next) => {
    const target = irreversibleTarget(
      String((e as Record<string, unknown>).command ?? ""),
    );
    if (target === undefined) return next(e);

    if (target.number === undefined) {
      return {
        deny: `${target.label} の宛先（PR/Issue 番号）を明示していない。カレントブランチ依存の実行は宛先の取り違えを検出できない`,
      };
    }
    if (!approval || !approval.kinds.has(target.kind)) {
      return {
        deny: `#${target.number} への ${target.label} の前に、AskUserQuestion で宛先と判定を明示して承認を取ること`,
      };
    }
    if (!approval.prs.includes(target.number)) {
      return {
        deny: `承認されたのは #${approval.prs.join(" #")} で、このコマンドの宛先は #${target.number}`,
      };
    }

    if (target.kind === "review") {
      approval = undefined; // レビュー投稿の承認は 1 回で使い切る
    } else if ((await $.clock.now()) - approval.at > CLOSE_REUSE_MS) {
      approval = undefined;
      return {
        deny: `#${target.number} への ${target.label} の承認が古い。改めて AskUserQuestion で確認すること`,
      };
    }
    return next(e);
  }).catch(() => ({ deny: "宛先照合フックが落ちたので不可逆操作を止めた" }));

  // ask を返せるのは classic.PreToolUse だけ。シェルフックでは deny が ask に勝つため、
  // 後続の判定を先に走らせ、deny が返ればそれを優先する
  on("classic.PreToolUse", { tool: "Bash" }, async ($, e, next) => {
    if (e.tool !== "Bash" || !isForcePush(e.command)) return next(e);

    const result = await next(e);
    if (result.deny !== undefined) return result;
    return {
      ask: FORCE_PUSH_REASON,
      ...(result.updatedInput === undefined ? {} : { updatedInput: result.updatedInput }),
      ...(result.additionalContext === undefined
        ? {}
        : { additionalContext: result.additionalContext }),
    };
  });

  // matcher。gh pr create を含む Bash コマンドだけをフックへ入れる
  on("tool.call", { tool: "Bash", command: /gh[^\S\n]+pr[^\S\n]+create\b/ }, async ($, e, next) => {
    const command = String((e as Record<string, unknown>).command ?? "");
    const bodyFile = bodyFileOf(command);

    if (bodyFile !== undefined) {
      // 引数が取れない・ファイルが読めないときは誤検出を避けて通す
      if (bodyFile === "") return next(e);
      const body = await $.fs.read(bodyFile).catch(() => undefined);
      if (body === undefined) return next(e);
      if (mentionsIssue(body)) return next(e);
    }
    if (mentionsIssue(command)) return next(e);

    return { deny: MISSING_CLOSE_KEYWORD };
  });
}
