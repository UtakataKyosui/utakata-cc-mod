// 行ごとに判定するため、\s の代わりに改行を含まない空白 [^\S\n] を使う。

// `git -C dir push` のように、サブコマンドの前に置けるグローバルオプションを許す。
// `.*` ではなく区切り文字を除く範囲に限り、`git push && rm -f x` を誤検出しない。
const GIT_GLOBAL_OPTIONS =
  /(?:[^\S\n]+(?:(?:-C|-c|--git-dir|--work-tree|--namespace)[^\S\n]+\S+|--[\w-]+(?:=\S+)?|-[pP]))*/
    .source;

const FORCE_PUSH = new RegExp(
  `git${GIT_GLOBAL_OPTIONS}[^\\S\\n]+push\\b[^&|;\\n]*([^\\S\\n]-f\\b|[^\\S\\n]--force\\b|[^\\S\\n]--force-with-lease\\b|[^\\S\\n]--force-if-includes\\b)`,
);

export const FORCE_PUSH_REASON =
  "Force push が検出されました。リモートブランチの履歴が書き換わります。本当に実行しますか？";

export function isForcePush(command: string): boolean {
  return FORCE_PUSH.test(command);
}

const BODY_FILE_ARG = /--body-file[^\S\n]+(\S+)/;

const BODY_FLAG = /(?:^|[^\S\n])(?:--body|-b)(?=[^\S\n]|=)/;

const TITLE_ARG =
  /(?:--title|-t)(?:[^\S\n]+|=)(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g;

const CLOSE_KEYWORD = /(closes|fixes|resolves)[^\S\n]+#[0-9]+/i;

const NOT_ISSUE_NOTE =
  /(issue[^\S\n]*(対応|に対応)[^\S\n]*で[^\S\n]*(は[^\S\n]*)?ない|not[^\S\n]+(an?[^\S\n]+)?issue|no[^\S\n]+issue|issue[^\S\n]*-?[^\S\n]*free|standalone[^\S\n]+pr)/i;

export const MISSING_CLOSE_KEYWORD = [
  "❌ PR 本文に Issue close キーワードがありません。",
  "   Issue 対応の PR には --body に以下のいずれかを含めてください:",
  "     Closes #nnn  /  Fixes #nnn  /  Resolves #nnn",
  "   Issue 対応でない PR の場合は、本文に以下のいずれかを含めてください:",
  "     「Issue 対応ではない」 / 「not an issue」 / 「no issue」",
].join("\n");

/**
 * Issue 参照を探す範囲。--body 以降に絞り、--title など本文以外の引数に
 * Closes キーワードがあっても本文にあるものとして扱わない。
 */
export function bodyScopeOf(command: string): string {
  const flag = BODY_FLAG.exec(command);
  const scope = flag === null ? command : command.slice(flag.index);
  return scope.replace(TITLE_ARG, "");
}

export function mentionsIssue(text: string): boolean {
  return CLOSE_KEYWORD.test(text) || NOT_ISSUE_NOTE.test(text);
}

/**
 * --body-file の引数。フラグはあるのに引数を取れないときは空文字を返し、
 * 元のシェルと同じく検査を見送る合図にする。
 */
export function bodyFileOf(command: string): string | undefined {
  if (!command.includes("--body-file")) return undefined;
  return command.match(BODY_FILE_ARG)?.[1] ?? "";
}
