export type Mode = 'threshold' | 'turns' | 'every'

export type Config = {
  mode: Mode
  thresholdPercent: number
  everyNTurns: number
}

const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, n))
}

export const readConfig = (options: Record<string, unknown>): Config => ({
  mode: options.mode === 'turns' || options.mode === 'every' ? options.mode : 'threshold',
  thresholdPercent: clamp(options.thresholdPercent, 30, 1, 99),
  everyNTurns: clamp(options.everyNTurns, 3, 1, 1000),
})

export const isDue = (cfg: Config, turnsSinceCompact: number, percent: number | undefined): boolean => {
  if (cfg.mode === 'every') return true
  if (cfg.mode === 'turns') return turnsSinceCompact >= cfg.everyNTurns
  return percent !== undefined && percent >= cfg.thresholdPercent
}

export const HANDOFF_RULE = [
  'This session is compacted automatically. Nothing but the Handoff block below is guaranteed to survive, so anything not written down outside the conversation can be lost.',
  '',
  'Before you finish a turn, persist what should outlive it:',
  '- Issue: file a GitHub Issue (gh issue create) for each follow-up task, bug, open question or deferred decision that is concrete and actionable. Search existing Issues first and comment on a match instead of duplicating it. Skip speculation and anything you resolved this turn.',
  '- Docs: write design decisions, constraints, procedures and findings that a later reader needs into the repository docs (README, docs/, ADR, code comments), updating the existing page when there is one.',
  '- Code: commit finished work in meaningful units. Leave no unrecorded uncommitted state.',
  'Do this only for the main task at hand; if the repository has no remote or gh is unavailable, put the Issue text in the docs instead and say so.',
  '',
  'End every final answer with this block, short and concrete, with nothing after it:',
  '',
  '## Handoff',
  '- Done: what was carried out this turn.',
  '- Result: what now works or is confirmed; what failed or is unverified.',
  '- Next: the next concrete action(s), including any pending user request.',
  '- Refs: paths, branches, commits, Issue/PR numbers and doc pages written or touched this turn.',
].join('\n')

export const INSTRUCTIONS = [
  'Keep only the following, concisely, as four short sections: Done, Result, Next, Refs.',
  "Take them from the latest '## Handoff' block in the transcript when there is one; carry its Refs over verbatim and add any Issue/PR numbers, branches, paths or commits that Next depends on.",
  "Carry over the previous summary's Next items that are still open, and drop the ones now done.",
  'Drop everything else: file contents, tool output, exploration, reasoning.',
  'Assume all of it is recoverable from the codebase, docs, Issues and PRs.',
].join('\n')
