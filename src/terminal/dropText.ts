/**
 * Turns dropped paths into the text a shell should receive.
 *
 * Nothing is executed and no newline is sent: the path lands at the cursor and
 * the user decides what to do with it, which is how dragging onto a terminal
 * behaves everywhere else.
 *
 * 따옴표 규칙은 받는 셸의 것이어야 한다 — cmd 와 zsh 는 서로 다른 글자를 문법으로
 * 읽으므로, 한쪽 규칙으로 감싼 경로는 다른 쪽에서 그대로 깨진다.
 */
import { isWindows } from "../platform";

/*
 * Quoted only when it would otherwise be misread. `cmd` splits on spaces, and
 * treats `&`, `^`, `(`, `)`, `;`, `,`, `=` and `%` as syntax — a bare
 * `D:\Naver MYBOX\...` would arrive as two arguments.
 */
const CMD_NEEDS_QUOTES = /[\s&^();,=%!]/;

/*
 * POSIX 셸(zsh·bash)에서는 **큰따옴표로는 모자란다** — 그 안에서도 `$`·`` ` ``·`\`
 * 는 살아 있어서 `/Users/me/$HOME 백업` 같은 이름이 다른 것으로 바뀐다. 작은따옴표
 * 안에서는 아무것도 해석되지 않으므로 그쪽을 쓰고, 작은따옴표 자신만 밖으로 꺼내
 * 이어 붙인다(`'\''`). 감쌀 필요가 없는 글자만으로 된 경로는 그대로 둔다.
 */
const POSIX_NEEDS_QUOTES = /[^\w@%+=:,./~-]/;

export const quoteForShell = (path: string): string => {
  if (isWindows) return CMD_NEEDS_QUOTES.test(path) ? `"${path}"` : path;
  if (!POSIX_NEEDS_QUOTES.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
};

/** Several paths at once are separated the way arguments are. */
export const dropTextFor = (paths: string[]): string => paths.map(quoteForShell).join(" ");
