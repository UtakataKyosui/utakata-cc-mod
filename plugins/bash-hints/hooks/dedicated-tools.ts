// prefer-dedicated-tools.sh の移植: cat/head/tail/grep/find/sed の代わりに
// 専用ツール（Read/Grep/Glob/Edit）を使うよう誘導するヒントを組み立てる。

const HEREDOC_RE = /<</;
const CAT_HEAD_TAIL_RE = /^(cat|head|tail)\s/;
const REDIRECT_RE = />>?|<</;
const SED_READ_RE = /^sed\s+-n/;
const SED_RANGE_RE = /'[0-9]+,[0-9]+p'|"[0-9]+,[0-9]+p"/;
const SED_INPLACE_RE = /^sed\s+(-i|--in-place)/;
const GREP_RECURSIVE_RE = /^(grep\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)|rg)\s/;
// 単一ファイル向けの判定から外す再帰フラグ。元スクリプトはこちらではフラグ直後の空白を求めない
const GREP_RECURSIVE_FLAG_RE = /^grep\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/;
const GREP_RE = /^grep\s/;
const GREP_FILE_ARG_RE = /\s[^-][^\s]*(\/|\.)[^\s]*/;
const FIND_RE = /^find\s/;
const FIND_EXCLUDE_RE = /-exec|-delete|-print0|-ok|-ls/;

const firstWord = (segment: string) => segment.trim().split(/\s+/)[0];

export const dedicatedToolsHint = (command: string): string | null => {
  // 元スクリプトは read -ra が 1 行しか読まないため、最初の | ; & 改行 までの
  // 1 セグメントだけを検査している。その挙動に合わせる
  const segments = [command.split(/[|;&\n]/)[0].trim()].filter(
    (seg) => seg.length > 0 && !HEREDOC_RE.test(seg),
  );

  const hints: string[] = [];

  for (const seg of segments) {
    if (CAT_HEAD_TAIL_RE.test(seg) && !REDIRECT_RE.test(seg)) {
      hints.push(
        `【Read ツール推奨】\`${firstWord(seg)}\` の代わりに Read ツールを使用してください。Read はオフセット・行数指定（offset/limit）をサポートし、画像・PDF も処理できます。例: offset=80, limit=20 で 80〜99行目を取得`,
      );
    }

    if (SED_READ_RE.test(seg) && SED_RANGE_RE.test(seg)) {
      hints.push(
        "【Read ツール推奨】`sed -n 'N,Mp'` の代わりに Read ツールの offset/limit を使用してください。例: Read(file, offset=N-1, limit=M-N+1)",
      );
    }

    if (SED_INPLACE_RE.test(seg)) {
      hints.push(
        "【Edit ツール推奨】`sed -i` の代わりに Edit ツールを使用してください。Edit は old_string → new_string の置換で、undo サポートとエンコーディング保持があります。",
      );
    }

    if (GREP_RECURSIVE_RE.test(seg)) {
      hints.push(
        `【Grep ツール推奨】\`${firstWord(seg)}\` の代わりに Grep ツールを使用してください。Grep は glob パターンによるファイル絞り込み（例: glob: '*.tsx'）、context 行数指定、output_mode 切り替えをサポートします。`,
      );
    }

    if (
      GREP_RE.test(seg) &&
      !GREP_RECURSIVE_FLAG_RE.test(seg) &&
      GREP_FILE_ARG_RE.test(seg)
    ) {
      hints.push(
        "【Grep ツール推奨】単一ファイルへの `grep` も Grep ツールで代替できます。Grep ツールは output_mode: 'content' でマッチ行を返し、-C で前後のコンテキストも表示できます。",
      );
    }

    if (FIND_RE.test(seg) && !FIND_EXCLUDE_RE.test(seg)) {
      hints.push(
        "【Glob ツール推奨】`find` の代わりに Glob ツールを使用してください。Glob は `**/*.ts` 形式のパターンマッチをサポートし、更新日時順にソートされた結果を返します。",
      );
    }
  }

  return hints.length === 0 ? null : hints.slice(0, 5).join("\n");
};
