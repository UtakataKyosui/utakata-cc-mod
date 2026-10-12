// pueue-daemon-guard.sh の移植: pueue コマンド実行前に pueued デーモンの
// 稼働チェックを行い、未起動なら additionalContext で通知する（deny はしない）。

export const PUEUE_MESSAGE =
  "⚠️ Pueue デーモンが起動していません。pueue コマンドを実行する前に `pueued -d` でデーモンを起動してください。または `/pueue-task` スキルを使用するとデーモン確認・起動を自動で行います。";

// pueue コマンドが含まれるか確認（pueued デーモン起動コマンド自体は除外）。
// 元スクリプトの grep は行ごとに判定するため、空白は改行をまたがない
export const pueueCommandDetected = (command: string): boolean =>
  /(^|&&[^\S\n]*|;[^\S\n]*)pueue[^\S\n]/m.test(command);
