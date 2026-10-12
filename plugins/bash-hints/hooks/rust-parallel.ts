// suggest-rust-parallel.sh の移植: && チェーン(3+)や for ループを検出し
// rust-parallel を提案する。

// 前段の結果や状態に依存しやすいコマンドは並列化を提案しない
const SEQUENTIAL_RE = /^(git|jj|gh|mise|cd|echo|printf|test|\[|export|source)$/;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ヒアドキュメント本体を " HEREDOC " に置き換える。<<TAG / <<-TAG /
// <<"TAG" / <<'TAG' から TAG 単独行までを一つのトークンにたたむ。
const stripHeredocs = (input: string): string => {
  const startRe = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let out = "";
  let pos = 0;
  for (;;) {
    startRe.lastIndex = pos;
    const m = startRe.exec(input);
    if (m === null) break;
    out += input.slice(pos, m.index);
    const tag = m[2];
    const bodyStart = m.index + m[0].length;
    const endRe = new RegExp(`^\\s*${escapeRegExp(tag)}\\s*$`, "gm");
    endRe.lastIndex = bodyStart;
    const endMatch = endRe.exec(input);
    if (endMatch === null) {
      out += m[0];
      pos = bodyStart;
    } else {
      out += " HEREDOC ";
      pos = endMatch.index + endMatch[0].length;
    }
  }
  out += input.slice(pos);
  return out;
};

// ヒアドキュメント・クォート文字列・コメント内の && や for はコマンド連結
// ではないため、解析前に落としておく（誤検出防止）。
const stripShellNoise = (command: string): string => {
  let s = stripHeredocs(command);
  s = s.replace(/\$'(?:[^'\\]|\\.)*'/g, " STR "); // $'...'
  s = s.replace(/'[^']*'/g, " STR "); // '...'
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, " STR "); // "..."
  s = s.replace(/(^|\s)#[^\n]*/g, "$1"); // コメント
  return s;
};

const chainHint = (command: string): string | null => {
  const segments = command
    .split(/&&|\n/)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);

  if (segments.length < 3) return null;

  const bases: string[] = [];
  for (const seg of segments) {
    const base = seg.split(/\s+/)[0] ?? "";
    if (/^["{]/.test(base)) continue; // JSON キー ("key": や {) はコマンドではない
    if (base === "-") continue; // Markdown リスト項目の行頭文字
    if (SEQUENTIAL_RE.test(base)) continue;
    if (base !== "") bases.push(base);
  }

  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);

  const repeated = [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))[0];

  if (repeated === undefined) return null;

  const [cmd, count] = repeated;
  return `【rust-parallel 推奨】\`${cmd}\` が ${count} 回の \`&&\` チェーンで検出されました。独立しているなら並列化できます:
  printf 'arg1\\narg2\\narg3\\n' | rust-parallel ${cmd}`;
};

// 元スクリプトの grep は行ごとに判定するため、for と do の検出は改行をまたがない
const forLoopHint = (command: string): string | null => {
  if (!/for[^\S\n]+[a-zA-Z_][a-zA-Z0-9_]*[^\S\n]+in[^\S\n]/.test(command))
    return null;

  const doMatch = command.match(/do[^\S\n]+[^;\n]+/);
  const loopCmd = doMatch === null ? "" : doMatch[0].replace(/^do\s*/, "");
  const baseLoop = loopCmd.trim().split(/\s+/)[0] ?? "";

  if (baseLoop === "") return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(baseLoop)) return null; // 変数代入は対象外
  if (SEQUENTIAL_RE.test(baseLoop)) return null;

  return `【rust-parallel 推奨】\`for\` ループは rust-parallel で並列化できます:
  echo '...' | rust-parallel ${baseLoop}  # または
  find ... | rust-parallel ${baseLoop}`;
};

export const rustParallelHint = (command: string): string | null => {
  const stripped = stripShellNoise(command);
  const hints = [chainHint(stripped), forLoopHint(stripped)].filter(
    (hint): hint is string => hint !== null,
  );
  return hints.length === 0 ? null : hints.join("\n\n");
};
