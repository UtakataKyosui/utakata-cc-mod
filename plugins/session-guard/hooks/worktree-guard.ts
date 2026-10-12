// worktree-guard.sh の移植（純粋関数のみ。ps / lsof / jj の呼び出しは register.ts に置く）。
// 同じ作業ディレクトリで動く並行 Claude Code セッションを数え、workspace への移行を促す。

export type PsRow = { pid: number; ppid: number; args: string };

// ps -eo pid,ppid,args の出力を行ごとに読む（見出し行は捨てる）
export const parsePs = (stdout: string): PsRow[] =>
  stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3].trim() }));

// `sh -c 'echo $$; exec ps -eo pid,ppid,args'` で走らせた ps の PID（先頭行）。exec しても
// PID は変わらないため、この PID の行が自分の起動した ps だと確定できる。コマンド文字列で
// 探すと、同時に起動した別セッションの ps と取り違えうる
export const selfPsPid = (stdout: string): number | null => {
  const first = stdout.split("\n")[0]?.trim() ?? "";
  return /^\d+$/.test(first) ? Number(first) : null;
};

// 元スクリプトの grep '/.claude/worktrees/' は . を任意の 1 文字として扱う
export const isInClaudeWorktree = (cwd: string): boolean =>
  /\/.claude\/worktrees\//m.test(cwd);

// 自セッションの claude は ps を起動した親なので、ps 自身の親から祖先をすべて除外対象にする
export const ancestorsOf = (
  rows: readonly PsRow[],
  start: number,
): Set<number> => {
  const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]));
  const ancestors = new Set<number>();
  let pid: number | undefined = start;
  while (pid !== undefined && pid > 1 && !ancestors.has(pid)) {
    ancestors.add(pid);
    pid = parentOf.get(pid);
  }
  return ancestors;
};

// コマンドが claude で始まるメインプロセスだけを対象にする（引数なし起動とフルパスを含む）
export const isMainClaude = (args: string): boolean =>
  /^claude$|\/claude$|^claude |\/claude /.test(args);

// `jj workspace list` に (current) の行が無いときは元スクリプトと同じく default 扱いにする
export const currentJjWorkspace = (stdout: string): string => {
  const line = stdout.split("\n").find((l) => l.includes("(current)"));
  return line === undefined ? "default:" : (line.trim().split(/\s+/)[0] ?? "");
};

export const vcsMessage = (hasJj: boolean, hasGit: boolean): string =>
  hasJj
    ? "jj リポジトリが検出されました。`jj workspace add .claude/worktrees/<name> --name <name>` で workspace を作成するか、EnterWorktree ツールを使用してください。"
    : hasGit
      ? "Git リポジトリが検出されました。EnterWorktree ツールで Git Worktree に移行してください。"
      : "EnterWorktree ツールまたは手動でディレクトリを分離してください。";

export const SHARED_WORKTREE_MESSAGE =
  "この worktree（workspace）を別のセッションと共有しています。EnterWorktree ツールで別の worktree に移行してください。";

export const worktreeGuardContext = (
  count: number,
  cwd: string,
  vcs: string,
): string =>
  `WORKTREE-GUARD: ${count} 件の並行 Claude Code セッションがこのディレクトリ (${cwd}) で動作中です。ファイル競合を防ぐため、編集を開始する前に必ず isolated workspace に移行してください。\n\n${vcs}\n\n移行せずにファイルを編集すると他のセッションと競合する可能性があります。/worktree-guard skill で対話的に設定できます。`;

export const lsofCwd = (stdout: string): string =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1))
    .join("\n");
