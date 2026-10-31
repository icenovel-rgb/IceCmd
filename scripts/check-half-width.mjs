import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/terminal/halfWidth.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { toHalfWidth: half, typedForPty: typed } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

// The IME's full-width mode and Windows voice typing emit U+3000 and U+FF01–FF5E.
// D2Coding draws U+3000 as a centred dot; cmd does not read ｅｃｈｏ as echo.
assert.equal(half("\uac00\u3000\ub098\uff1f"), "\uac00 \ub098?");
assert.equal(half("\uff57\uff49\uff4e\uff44\uff4f\uff57\uff53"), "windows");
assert.equal(half("\uff45\uff43\uff48\uff4f\u3000\uff11\uff0b\uff11\uff01"), "echo 1+1!");
assert.equal(half("\uff5e\uff01\uff0e"), "~!.");
// One unit for one: the macOS replacement guard counts characters on the textarea.
assert.equal(half("\u3000\uff1f\u3000").length, 3);
// Outside the block nothing moves: middle dots, Hangul, emoji, half-width kana.
assert.equal(half("\u00b7 \u30fb \uac00 \u2615 \uff61"), "\u00b7 \u30fb \uac00 \u2615 \uff61");
console.log("PASS: full-width spaces and ASCII become half-width, one for one.");

// Typed and spoken text is converted on its way to the PTY.
assert.equal(typed("\uac00\u3000\ub098", false), "\uac00 \ub098");
assert.equal(typed("\uff53\uff45\uff54\u3000/a 1\uff0b1\r", false), "set /a 1+1\r");
// A paste is the user's text, not a keystroke: a full-width path must arrive as it is.
assert.equal(typed("D:\\\uff21\uff22\u3000\uc790\ub8cc", true), "D:\\\uff21\uff22\u3000\uc790\ub8cc");
assert.equal(typed("\x1b[200~\uff21\u3000\uff22\x1b[201~", false), "\x1b[200~\uff21\u3000\uff22\x1b[201~");
// Terminal replies (cursor position, mouse, focus) pass through untouched.
for (const reply of ["\x1b[12;40R", "\x1b[<35;79;20M", "\x1b[I", "\x7f", "\r"]) {
  assert.equal(typed(reply, false), reply);
}
console.log("PASS: typed text converted, pastes and terminal replies left alone.");
