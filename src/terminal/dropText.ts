/**
 * Turns dropped paths into the text a shell should receive.
 *
 * Nothing is executed and no newline is sent: the path lands at the cursor and
 * the user decides what to do with it, which is how dragging onto a terminal
 * behaves everywhere else.
 */

/*
 * Quoted only when it would otherwise be misread. `cmd` splits on spaces, and
 * treats `&`, `^`, `(`, `)`, `;`, `,`, `=` and `%` as syntax — a bare
 * `D:\Naver MYBOX\...` would arrive as two arguments.
 */
const NEEDS_QUOTES = /[\s&^();,=%!]/;

export const quoteForShell = (path: string): string =>
  NEEDS_QUOTES.test(path) ? `"${path}"` : path;

/** Several paths at once are separated the way arguments are. */
export const dropTextFor = (paths: string[]): string => paths.map(quoteForShell).join(" ");
