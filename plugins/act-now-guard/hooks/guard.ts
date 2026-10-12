import type { PluginOptions } from "claude-code";

export type Verdict = "execute" | "plan";

export type Settings = {
  mode: "apply" | "observe";
  endpoint: string;
};

/** 利用者が計画を明示的に求めた語。含まれていれば判定せずに計画を許す。 */
const PLAN_REQUESTED = /計画|設計|プラン|アーキテクチャ|方針を(決め|立て)|\bplan\b|\bdesign\b/i;

/** 修正や対応を求める語。含まれていれば判定せずに実行扱いにする。 */
const EXECUTE_REQUESTED = /直して|修正して|対応して|\bfix\b/i;

/** 判定に送る依頼文の上限。長い入力は LocalJev の精度と速度をともに落とす。 */
const MAX_STATE_CHARS = 2000;

export const DENY_MESSAGE =
  "act-now-guard: この依頼は計画フェーズが要らない種類と判定した（rules/execution-vs-planning.md）。" +
  "計画モードや Plan エージェントに入らず、そのまま実装に着手すること。" +
  "変更が 3 ファイルを超えて複数のサブシステムにまたがるなど、本当に計画が必要なら、その理由を添えて利用者に一言確認すること。";

export function readSettings(options: PluginOptions): Settings {
  return {
    mode: options.mode === "observe" ? "observe" : "apply",
    endpoint: typeof options.endpoint === "string" && options.endpoint !== ""
      ? options.endpoint.replace(/\/+$/, "")
      : "http://127.0.0.1:8080",
  };
}

/** 利用者が自分で送った依頼文の送り主。タスク完了の通知や他のプラグインが送った文は判定材料にしない。 */
const PERSON_ORIGINS = new Set(["composer", "sdk", "bridge"]);

export function isFromPerson(originKind: string): boolean {
  return PERSON_ORIGINS.has(originKind);
}

export function verdictByKeywords(text: string): Verdict | undefined {
  if (PLAN_REQUESTED.test(text)) return "plan";
  if (EXECUTE_REQUESTED.test(text)) return "execute";
  return undefined;
}

export function systemOneRequest(prompt: string) {
  return {
    model: "jev-latest",
    state: prompt.slice(0, MAX_STATE_CHARS),
    questions: {
      phase: {
        type: "choice",
        instructions: "この依頼に、着手の前に独立した計画フェーズが要るか",
        criteria: {
          execute: "バグ修正、エラー解消、レビュー対応、変更箇所がはっきりした小さな作業。すぐ実装してよい",
          plan: "複数のサブシステムにまたがる変更、アーキテクチャ上の判断、方針が決まっていない大きな作業",
        },
      },
    },
  };
}

export function parseVerdict(responseText: string): Verdict | undefined {
  const body = JSON.parse(responseText) as { answers?: { phase?: { choice?: unknown } } };
  const choice = body.answers?.phase?.choice;
  return choice === "execute" || choice === "plan" ? choice : undefined;
}
