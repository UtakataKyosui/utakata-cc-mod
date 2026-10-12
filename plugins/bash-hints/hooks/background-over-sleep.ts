// prefer-background-over-sleep.sh の移植: sleep N (N > 2) を検出して deny する。

// 元スクリプトの sed と grep は行ごとに処理するため、クォートの除去と判定は改行をまたがない
const SLEEP_RE = /\bsleep[^\S\n]+([0-9]+(?:\.[0-9]+)?)/g;

// ヒアドキュメントの本文と行末のコメントは、この Bash 呼び出しでは実行されない
const HEREDOC_RE = /<<-?[^\S\n]*(['"]?)(\w+)\1[^\n]*\n(?:[\s\S]*?\n)?[^\S\n]*\2[^\S\n]*(?=\n|$)/g;
const COMMENT_RE = /(^|[^\S\n])#.*$/gm;

export const sleepDenyReason = (command: string): string | null => {
  const stripped = command
    .replace(HEREDOC_RE, "")
    .replace(/'[^'\n]*'/g, "")
    .replace(/"[^"\n]*"/g, "")
    .replace(COMMENT_RE, "$1");
  // 短い sleep が先にあっても、後ろの長い sleep を見逃さない
  const long = [...stripped.matchAll(SLEEP_RE)].find(
    (m) => Number(m[1]) > 2,
  );
  if (long === undefined) return null;

  const duration = long[1];

  return `sleep ${duration} は実際の壁時計時間を ${duration} 秒浪費します。代わりに以下を検討してください:
1. Bash ツールの run_in_background: true パラメータでコマンドをバックグラウンド実行し、完了通知を待つ
2. ポーリング不要なワークフローに再設計する
3. gh run watch などの完了待機コマンドを使う`;
};
