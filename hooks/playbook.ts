const SUBCOMMANDS = new Set(['clear', 'status', 'off', 'stop'])

export const isGoalStatement = (args: string): boolean => {
  const text = args.trim()
  return text !== '' && !SUBCOMMANDS.has(text.toLowerCase())
}

export const buildPlaybook = (goal: string): string =>
  `<goal-orchestration>
/goal で次のゴールが設定された。

ゴール: ${goal.trim()}

このゴールは、次の手順でオーケストレーションして達成すること。
ただし、1〜2ファイルの小さな変更や単発の調査のように、分解しても独立したタスクが1つにしかならない場合は、
分解・委譲を省いて直接取り組んでよい。

1. 分解
   ゴールを、独立して検証できる粒度のタスクに分解する。各タスクに「完了条件」を1つ付ける。
2. TODO 化と順序付け
   TaskCreate / TodoWrite でタスクを TODO に登録する。各タスクに依存関係を明示し、
   依存のないタスク同士は同一グループ (並列実行可)、依存があるものは後続グループとして番号を振る。
3. 委譲
   各タスクを Agent ツールで SubAgent に委譲する。同一グループの独立タスクは、1メッセージ内で
   複数の Agent 呼び出しを並べて並列に起動する。後続グループは前グループの完了後に起動する。
   SubAgent は会話履歴を持たないため、プロンプトに次を必ず含める:
   - ゴール全体と、そのタスクが占める位置づけ
   - このタスクの目的と完了条件
   - 対象ファイル・ディレクトリ、守るべき規約 (CLAUDE.md / AGENTS.md の該当箇所)
   - 前グループの成果 (変更ファイル、決定事項、未解決事項)
   - 触ってはいけない範囲 (並列タスクと衝突しうるファイル)
   - 返してほしい報告の形式 (変更点の要約、検証結果、残課題)
   調査だけのタスクは Explore、設計は Plan、実装・検証は general-purpose を使い分ける。
4. 統合と検証
   グループが終わるごとに SubAgent の報告を確認し、完了条件を満たしたタスクだけを完了にする。
   未達ならその理由を添えて同じタスクを再委譲する。全タスク完了後、ゴール全体の達成を自分で検証する。

委譲する場合、自分で行うのは分解・順序付け・委譲・報告の統合・最終検証のみ。実装の本体は SubAgent に任せる。
</goal-orchestration>`
