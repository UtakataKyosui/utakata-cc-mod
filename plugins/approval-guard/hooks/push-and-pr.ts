// dotclaude の hooks/confirm-force-push.sh と hooks/check-pr-closes-issue.sh を移したもの。
// 元のシェルは grep で行ごとに判定するため、\s の代わりに改行を含まない空白 [^\S\n] を使う。

const FORCE_PUSH =
  /git[^\S\n]+push\b.*([^\S\n]-f\b|[^\S\n]--force\b|[^\S\n]--force-with-lease\b|[^\S\n]--force-if-includes\b)/;

export const FORCE_PUSH_REASON =
  "Force push が検出されました。リモートブランチの履歴が書き換わります。本当に実行しますか？";

export function isForcePush(command: string): boolean {
  return FORCE_PUSH.test(command);
}

const BODY_FILE_ARG = /--body-file[^\S\n]+(\S+)/;

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
