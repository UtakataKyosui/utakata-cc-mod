/** 修正・変更を頼む言い回し。誤検知しても確認ツールを 1 回呼べば先へ進めるので、広めに拾う。 */
const FIX_REQUEST =
  /直し|直す|直して|修正|変えて|変える|変更し|変更す|戻して|戻す|調整|揃えて|寄せて|ずらして|差し替え|入れ替え|大きく|小さく|広げ|狭め|ずれ|崩れ|おかし|指摘|\bfix\b|\btweak\b|\badjust\b/i

/** 利用者が送ったプロンプトか。通知や自動継続で届いたものでは状態を変えない。 */
const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'channel', 'slack-ping', 'unclassified'])

export const isHumanOrigin = (kind: unknown): boolean => typeof kind === 'string' && HUMAN_ORIGINS.has(kind)

export const isFixRequest = (text: unknown): boolean => typeof text === 'string' && FIX_REQUEST.test(text)

/** ファイルを書き換えるツール。 */
export const EDIT_TOOL = /^(Edit|MultiEdit|Write|NotebookEdit)$/

/** ファイルを書き換える Bash コマンド。/dev/null と fd への出力、=> と -> は除く。 */
const BASH_WRITE =
  /\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\btee\b|\bgit\s+(apply|restore|checkout\s+--)\b|\bpatch\b|(^|[^0-9&>=\-])>{1,2}\s*(?!\/dev\/null|&)["']?[\w./~$]/

export const isBashWrite = (command: unknown): boolean => typeof command === 'string' && BASH_WRITE.test(command)

export const CONFIRM_TOOL_NAME = 'confirm_fix_request'
export const CONFIRM_TOOL = /(^|__)confirm_fix_request$/

export type FixSpec = {
  quote: string
  target: string
  current: string
  expected: string
  unclear: string[]
}

const squash = (s: string): string => s.replace(/\s+/g, '')

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export const readSpec = (input: Record<string, unknown>): FixSpec => ({
  quote: str(input.quote),
  target: str(input.target),
  current: str(input.current),
  expected: str(input.expected),
  unclear: Array.isArray(input.unclear) ? input.unclear.map(str).filter(s => s !== '') : [],
})

export type Verdict = { ok: true; text: string } | { ok: false; text: string }

/** 確認ツールの入力を判定する。ok なら編集を解禁する。 */
export const judgeSpec = (spec: FixSpec, prompt: string): Verdict => {
  const missing = (['quote', 'target', 'current', 'expected'] as const).filter(k => spec[k] === '')
  if (missing.length > 0) {
    return { ok: false, text: `${missing.join(', ')} が空。埋められないなら、その点を AskUserQuestion で利用者に聞くこと。` }
  }
  if (!squash(prompt).includes(squash(spec.quote))) {
    return {
      ok: false,
      text: 'quote が直近の依頼文に見つからない。依頼文から、直す内容の根拠になる部分をそのまま抜き出すこと。依頼文に根拠がないなら AskUserQuestion で聞くこと。',
    }
  }
  if (spec.unclear.length > 0) {
    return {
      ok: false,
      text: [
        '決まっていない点がある。編集する前に AskUserQuestion で聞くこと。',
        ...spec.unclear.map(u => `- ${u}`),
        '選択肢には具体的な案（値・見た目・挙動）を書き、今の状態も添える。',
      ].join('\n'),
    }
  }
  return {
    ok: true,
    text: [
      '確認した修正内容:',
      `- 依頼: 「${spec.quote}」`,
      `- 対象: ${spec.target}`,
      `- 今: ${spec.current}`,
      `- 直した後: ${spec.expected}`,
      '編集してよい。完了を報告するときは、この内容と実際の変更前→変更後を並べて示すこと。',
    ].join('\n'),
  }
}

export const confirmToolSpec = {
  name: CONFIRM_TOOL_NAME,
  description: [
    '修正・変更の依頼を受けて、ファイルを編集する前に呼ぶ。依頼から読み取った「何を・どう直すか」を書く。',
    '依頼文だけで決まらない点（対象の範囲、変更後の値や見た目、どの画面・環境か、ほかの箇所も揃えるか など）は unclear に書く。',
    'unclear が空で、quote が依頼文と一致したときだけ編集が解禁される。推測で埋めず、迷う点は unclear に入れる。',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      quote: { type: 'string', description: '依頼文から、直す内容の根拠になる部分をそのまま抜き出したもの' },
      target: { type: 'string', description: '直す対象（ファイル・画面・要素）' },
      current: { type: 'string', description: '今の状態' },
      expected: { type: 'string', description: '直した後の状態。値・見た目・挙動を具体的に' },
      unclear: { type: 'array', items: { type: 'string' }, description: '依頼文だけでは決まらない点。なければ空配列' },
    },
    required: ['quote', 'target', 'current', 'expected', 'unclear'],
  },
}

export const denyText = (subagent: boolean): string =>
  [
    '修正依頼の中身（何を・どう直すか）をまだ確認していない。編集する前に、次のどちらかを行うこと。',
    `- 依頼文だけで対象と直した後の状態が決まるなら、${CONFIRM_TOOL_NAME} ツールに読み取った内容を書く`,
    '- 決まらない点があるなら、AskUserQuestion で利用者に聞く（選択肢に具体的な案と今の状態を書く）',
    ...(subagent ? ['サブエージェントからは利用者に聞けない。決まっていない点を親のエージェントに返すこと。'] : []),
  ].join('\n')

export const guidance = [
  '修正・変更の依頼を受けたら、何をどう直すかが決まるまで編集しない。',
  '- 決まっているかは、対象（どのファイル・画面・要素か）、直した後の状態（値・見た目・挙動）、範囲（ほかの箇所も揃えるか）、確認する環境、の 4 点で判断する',
  '- 1 つでも依頼文から決まらなければ、推測で埋めず AskUserQuestion で聞く。選択肢には具体的な案を書き、今の状態を添える',
  `- 決まっていれば ${CONFIRM_TOOL_NAME} ツールに読み取った内容を書いてから編集する。確認しないまま編集しようとすると拒否される`,
  '- 完了を報告するときは、依頼の言葉・確認した解釈・変更前→変更後を並べる。利用者が OK を出す対象を明示し、あとで「こうだっけ」とならないようにする',
  '- OK のあとに再び指摘されたら、前回確認した内容を示し、何が食い違ったかを確かめてから直す',
].join('\n')
