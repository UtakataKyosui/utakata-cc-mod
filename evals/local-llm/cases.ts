import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Required } from './judge'
import type { Kind } from './schema'

export const ROOT = import.meta.dir

export type SearchInput = { pattern: string; path?: string; purpose: string }
export type WebInput = { url: string; query: string }
export type LogInput = { id: string; description: string; command: string[] }

export type EvalCase = {
  id: string
  kind: Kind
  title: string
  fixture: string
  input: SearchInput | WebInput | LogInput
  required: Required[]
  distractors: string[]
  oracle: string[]
  bait: string[]
}

type File = { schemaVersion: number; cases: EvalCase[] }

export const loadCases = (): EvalCase[] => (JSON.parse(readFileSync(join(ROOT, 'cases/cases.json'), 'utf8')) as File).cases

export const loadFixture = (c: EvalCase): string => readFileSync(join(ROOT, c.fixture), 'utf8')
