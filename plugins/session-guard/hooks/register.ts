import type { On } from "claude-code";

import {
  ancestorsOf,
  currentJjWorkspace,
  isInClaudeWorktree,
  isMainClaude,
  lsofCwd,
  parsePs,
  selfPsPid,
  vcsMessage,
  worktreeGuardContext,
} from "./worktree-guard";

const MAX_PARALLEL = 10;

export function register(on: On) {
  on("classic.SessionStart", async ($, e, next) => {
    const stat = await $.fs.stat(e.cwd, { resolve: true }).catch(() => null);
    const cwd = stat?.realPath ?? e.cwd;

    // 既に worktree 内、または default 以外の jj workspace なら分離済み
    if (isInClaudeWorktree(cwd)) return next(e);
    // 元スクリプトの -d と同じく、ディレクトリのときだけ jj / git のリポジトリとみなす
    const hasJj = await $.fs
      .stat(`${cwd}/.jj`)
      .then((s) => s.kind === "dir")
      .catch(() => false);
    if (hasJj) {
      const ws = await $.process
        .run(["jj", "workspace", "list"], { cwd, timeoutMs: 3000 })
        .catch(() => null);
      const current =
        ws !== null && ws.exitCode === 0
          ? currentJjWorkspace(ws.stdout)
          : "default:";
      if (current !== "default:") return next(e);
    }

    const ps = await $.process
      .run(["sh", "-c", "echo $$; exec ps -eo pid,ppid,args"], {
        timeoutMs: 3000,
      })
      .catch(() => null);
    if (ps === null) return next(e);
    const rows = parsePs(ps.stdout);
    const selfPid = selfPsPid(ps.stdout);
    const self = rows.find((row) => row.pid === selfPid);
    const ancestors =
      self === undefined ? new Set<number>() : ancestorsOf(rows, self.ppid);

    const candidates = rows.filter(
      (row) => !ancestors.has(row.pid) && isMainClaude(row.args),
    );
    const cwds = await Promise.all(
      candidates.map((row) =>
        $.process
          .run(["lsof", "-p", String(row.pid), "-a", "-d", "cwd", "-Fn"], {
            timeoutMs: 3000,
          })
          .then((r) => lsofCwd(r.stdout))
          .catch(() => ""),
      ),
    );
    const count = Math.min(cwds.filter((c) => c === cwd).length, MAX_PARALLEL);
    if (count === 0) return next(e);

    const hasGit = await $.fs
      .stat(`${cwd}/.git`)
      .then((s) => s.kind === "dir")
      .catch(() => false);
    const result = await next(e);
    return {
      ...result,
      additionalContext: [
        ...(result.additionalContext ?? []),
        worktreeGuardContext(count, cwd, vcsMessage(hasJj, hasGit)),
      ],
    };
  });
}
