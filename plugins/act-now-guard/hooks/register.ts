import type { EngineInterface, On, PluginOptions } from "claude-code";
import {
  DENY_MESSAGE,
  isFromPerson,
  parseVerdict,
  readSettings,
  systemOneRequest,
  verdictByKeywords,
  type Settings,
  type Verdict,
} from "./guard";

/** LocalJev の応答を待つ上限。超えたら判定なしで通す。 */
const DECIDE_TIMEOUT_MS = 5000;

async function classify($: EngineInterface, endpoint: string, prompt: string): Promise<Verdict | undefined> {
  const request = $.http
    .fetch(`${endpoint}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(systemOneRequest(prompt)),
    })
    .then((res) => (res.ok ? parseVerdict(res.text) : undefined))
    .catch(() => undefined);
  const timeout = $.clock.sleep(DECIDE_TIMEOUT_MS).then(() => undefined);
  return Promise.race([request, timeout]);
}

/** 計画フェーズへの入口を止めるかどうか。observe ではステータスに出すだけで止めない。 */
async function shouldDeny(
  $: EngineInterface,
  settings: Settings,
  agentId: string | undefined,
  lastPrompt: string | undefined,
): Promise<boolean> {
  // 計画に入るかどうかは親の判断に限る。サブエージェント内の呼び出しは対象外
  if (agentId !== undefined || lastPrompt === undefined) return false;
  const verdict = verdictByKeywords(lastPrompt) ?? (await classify($, settings.endpoint, lastPrompt));
  if (verdict !== "execute") return false;
  if (settings.mode === "apply") return true;
  try {
    $.ui.status("act-now-guard(observe): 計画フェーズ不要と判定");
  } catch {
    // 表示先が無い場面（headless など）でも判定は続ける
  }
  return false;
}

export function register(on: On, options: PluginOptions) {
  const settings = readSettings(options);
  /** 直近に利用者が送った依頼文。計画フェーズへ入ろうとした時点で、これを判定する。 */
  let lastPrompt: string | undefined;

  on("prompt.submit", ($, e, next) => {
    if (isFromPerson(e.origin.kind) && e.text.trim() !== "") lastPrompt = e.text;
    return next(e);
  });

  // EnterPlanMode は遅延読み込みのツールで、生成した型の組み込みツール一覧に載らないため正規表現で照合する
  on("tool.call", { tool: /^EnterPlanMode$/ }, async ($, e, next) =>
    (await shouldDeny($, settings, e.agentId, lastPrompt)) ? { deny: DENY_MESSAGE } : next(e),
  );

  on("tool.call", { tool: "Agent" }, async ($, e, next) =>
    e.subagent_type === "Plan" && (await shouldDeny($, settings, e.agentId, lastPrompt))
      ? { deny: DENY_MESSAGE }
      : next(e),
  );
}
