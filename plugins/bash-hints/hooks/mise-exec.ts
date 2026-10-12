// prefer-mise-exec.sh の移植: mise.toml があるプロジェクトでベア pnpm/node/npx
// を検出し mise exec -- 経由の実行を提案する。

// 元スクリプトの sed と grep は行ごとに処理するため、クォートの除去と判定は改行をまたがない
export const bareRunnerHint = (command: string): string | null => {
  const stripped = command.replace(/'[^'\n]*'/g, "").replace(/"[^"\n]*"/g, "");

  const hints: string[] = [];

  if (/(^|[;&][^\S\n]*)pnpm[^\S\n]/m.test(stripped)) {
    hints.push(
      "【mise exec 推奨】ベアの `pnpm` が検出されました。このプロジェクトは mise.toml でバージョン管理されています。\n`mise exec -- pnpm <args>` に変更してください。\n正しいバージョンの pnpm/Node.js が使われ、バージョン不一致によるエラーを防げます。",
    );
  }

  if (/(^|[;&][^\S\n]*)node[^\S\n]/m.test(stripped)) {
    hints.push(
      "【mise exec 推奨】ベアの `node` が検出されました。`mise exec -- node <args>` に変更してください。",
    );
  }

  if (/(^|[;&][^\S\n]*)npx[^\S\n]/m.test(stripped)) {
    hints.push(
      "【mise exec 推奨】ベアの `npx` が検出されました。`mise exec -- npx <args>` に変更してください。",
    );
  }

  return hints.length === 0
    ? null
    : hints.join("\n").split("\n").slice(0, 3).join("\n");
};
