// prefer-background-over-sleep.sh の移植: sleep N (N > 2) を検出して deny する。

// 元スクリプトの sed と grep は行ごとに処理するため、クォートの除去と判定は改行をまたがない
const SLEEP_RE = /\bsleep[^\S\n]+([0-9]+(?:\.[0-9]+)?)/;

export const sleepDenyReason = (command: string): string | null => {
  const stripped = command.replace(/'[^'\n]*'/g, "").replace(/"[^"\n]*"/g, "");
  const match = stripped.match(SLEEP_RE);
  if (match === null) return null;

  const duration = match[1];
  if (Number(duration) <= 2) return null;

  return `sleep ${duration} は実際の壁時計時間を ${duration} 秒浪費します。代わりに以下を検討してください:
1. Bash ツールの run_in_background: true パラメータでコマンドをバックグラウンド実行し、完了通知を待つ
2. ポーリング不要なワークフローに再設計する
3. gh run watch などの完了待機コマンドを使う`;
};
