// 実機の出力ではなく、gdu / 本プラグインの文書化された形式から手で作ったサンプル。
export const reportSample = {
  "schema": "repo-storage-report-1",
  "readOnly": true,
  "generatedAt": "2026-11-20T00:00:00.000Z",
  "degraded": ["gdu 未導入: du -sk による使用量のみ (見かけサイズは不明)"],
  "totalDiscovered": 1,
  "analyzed": 1,
  "skipped": 0,
  "counts": { "PROTECTED": 0, "DIRTY": 0, "UNKNOWN": 0, "CANDIDATE": 1 },
  "repos": [
    {
      "path": "/home/me/ghq/github.com/me/old",
      "source": "ghq",
      "verdict": { "category": "CANDIDATE", "reasons": ["STALE", "REMOTE_UNVERIFIED"] },
      "usageBytes": 104857600,
      "sizeSource": "du",
      "lastCommit": "2024-01-02",
      "branchesNoUpstream": 0,
      "stash": 0,
      "extraWorktrees": 0,
      "caches": [{ "name": "node_modules", "path": "/home/me/ghq/github.com/me/old/node_modules", "bytes": 52428800, "ignored": true }]
    }
  ]
} as const
