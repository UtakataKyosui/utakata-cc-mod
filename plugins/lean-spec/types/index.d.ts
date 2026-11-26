/** チェックリストの 1 項目。done: 確かめられた、todo: まだ確かめていない、fail: 確かめた結果だめだった */
export type CheckItem = { label: string; state: 'done' | 'todo' | 'fail'; note: string; children: CheckItem[] }

/** 仕様 1 件分。上半分が検証すべきこと、items が検証できたこと */
export type SpecCard = {
  id: string
  feature: string
  property: string
  harm: string
  scope: string
  items: CheckItem[]
  trusted: boolean
}

export type Checklist = { specs: SpecCard[]; message: string; updatedAt: string }

declare module 'claude-code' {
  interface PluginState {
    'lean-spec': { checklist: Shaped<Checklist> }
  }
}
