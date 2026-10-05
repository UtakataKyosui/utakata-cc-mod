// 必要情報の取りこぼしの判定。応答に残っているかを、空白の違いを無視した部分一致で見る。
export type Required = { id: string; text: string }

export type Judgement = { found: string[]; missed: string[] }

export const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** required のうち、text のどこにも現れないものを missed に返す。 */
export const judge = (text: string, required: readonly Required[]): Judgement => {
  const hay = normalize(text)
  const found: string[] = []
  const missed: string[] = []
  for (const r of required) (hay.includes(normalize(r.text)) ? found : missed).push(r.id)
  return { found, missed }
}

/** 誤誘導・指示文など、返却に含まれてはいけない断片のうち、含まれている件数。 */
export const countDistractors = (text: string, distractors: readonly string[]): number => {
  const hay = normalize(text)
  return distractors.filter(d => hay.includes(normalize(d))).length
}

/** 初回の結果と追加取得の結果を合わせた判定。 */
export const judgeAll = (texts: readonly string[], required: readonly Required[]): Judgement => judge(texts.join('\n'), required)
