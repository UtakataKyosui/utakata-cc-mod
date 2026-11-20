// 子プロセス実行の共通基盤。シェルを経由せず argv 配列だけを受け取り、失敗は握りつぶさず fail-closed にする。

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Exec = (argv: string[], opts: { timeoutMs: number }) => Promise<RunResult>
export type Run = (argv: string[], timeoutMs?: number) => Promise<RunResult>

/** exitCode の予約値。外部ツールの終了コードと衝突しない負数。 */
export const EXIT = { SPAWN_FAILED: -1, OUTPUT_TOO_LARGE: -2, INVALID_ARGV: -3 } as const

export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 30_000

export const validArgv = (argv: unknown): argv is string[] =>
  Array.isArray(argv) && argv.length > 0 && argv.every(a => typeof a === 'string' && !a.includes('\0'))

/**
 * Exec を包み、argv 検証・例外の吸収・出力上限を課す。
 * 上限超過は部分出力を渡さず OUTPUT_TOO_LARGE として失敗させる (切り詰めた JSON を正常扱いしない)。
 */
export const createRun = (exec: Exec, maxOutput = MAX_OUTPUT_BYTES): Run => async (argv, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  if (!validArgv(argv)) return { exitCode: EXIT.INVALID_ARGV, stdout: '', stderr: 'invalid argv' }
  try {
    const r = await exec(argv, { timeoutMs })
    if (r.stdout.length > maxOutput) return { exitCode: EXIT.OUTPUT_TOO_LARGE, stdout: '', stderr: `stdout exceeds ${maxOutput} bytes` }
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr.slice(0, 4096) }
  } catch (err) {
    return { exitCode: EXIT.SPAWN_FAILED, stdout: '', stderr: String(err) }
  }
}

/** JSON を解析し validator を通ったときだけ値を返す。壊れた入力・形の違う入力は undefined。 */
export const parseJson = <T>(text: string, validate: (v: unknown) => v is T): T | undefined => {
  try {
    const v: unknown = JSON.parse(text)
    return validate(v) ? v : undefined
  } catch {
    return undefined
  }
}

export type Version = [number, number, number]

export const parseVersion = (text: string): Version | undefined => {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined
}

export const compareVersions = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

export type Probe =
  | { state: 'ok'; version: Version }
  | { state: 'missing' | 'failed' | 'unparseable' }
  | { state: 'too-old'; version: Version }

/** CLI の存在とバージョンを調べる。ok 以外は「使わない」側に倒す。 */
export const probe = async (run: Run, argv: string[], min?: Version): Promise<Probe> => {
  const r = await run(argv)
  if (r.exitCode === EXIT.SPAWN_FAILED || r.exitCode === 127) return { state: 'missing' }
  if (r.exitCode !== 0) return { state: 'failed' }
  const version = parseVersion(`${r.stdout}\n${r.stderr}`)
  if (!version) return { state: 'unparseable' }
  return min && compareVersions(version, min) < 0 ? { state: 'too-old', version } : { state: 'ok', version }
}
