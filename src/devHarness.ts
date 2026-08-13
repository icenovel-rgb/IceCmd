/**
 * Dev-only end-to-end harness, enabled with VITE_ICECMD_HARNESS=1.
 *
 * It drives the real store, real PTYs and real xterm buffers, then reports each
 * check to the `tauri dev` console through `log_line`, because the app window
 * cannot always be watched while iterating.
 *
 * Layout checks assert on the *shell process*, not on screen contents: ConPTY
 * repaints its whole screen on resize and that repaint is not perfectly faithful,
 * so a missing line proves nothing. A shell variable, on the other hand, exists
 * only as long as that same cmd.exe does.
 *
 * The harness removes the projects it creates, leaving persisted state untouched.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { paneIds } from "./layout/tree";
import type { ToolUsage, UsageWindow } from "./types";
import { useWorkspace } from "./store/workspace";
import {
  cliUsage,
  loadState,
  logLine,
  openExternal,
  openInFileManager,
  openPath,
  revealPath,
  sessionAlive,
  writeSession,
} from "./terminal/ipc";
import { getEntry } from "./terminal/termRegistry";
import { bellIsSeen, clearAttention } from "./terminal/status";
import { dropTextFor } from "./terminal/dropText";
import { handleDropPayload, type DroppedPath } from "./sidebar/dnd";
import { checkForUpdate, currentVersion, isNewer } from "./update";

const PATH_PLAIN = "D:\\dev\\IceCmd";
const PATH_SPACES = "D:\\Naver MYBOX\\2. Works\\Personal\\IceCmd";

/** Unique per run so a stale buffer can never make a check pass. */
const MARK = `ICEMARK${Math.floor(Math.random() * 1e9).toString(36)}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
let probeCounter = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passed += 1;
  else failed += 1;
  void logLine(`harness ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * The pane's whole buffer as text, with wrapped rows put back together.
 *
 * Every check here asks whether some string is *in* the buffer, and a terminal
 * row is not a line: anything longer than the pane is broken across rows. Joined
 * naively with newlines, a state file of 2359 bytes reads as 235 and a path that
 * straddles the edge is never found — a check that fails, or passes, for reasons
 * that have nothing to do with what it is testing. `isWrapped` says which rows
 * are continuations, so the seam can be closed exactly where it was made.
 */
function screen(paneId: string): string {
  const term = getEntry(paneId)?.term;
  if (!term) return "";
  const buffer = term.buffer.active;
  let text = "";
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    if (row > 0 && !line.isWrapped) text += "\n";
    text += line.translateToString(true);
  }
  return text;
}

const layoutOf = (projectId: string) => useWorkspace.getState().layouts[projectId] ?? null;
const panesOf = (projectId: string) => paneIds(layoutOf(projectId));

/*
 * Anything a user starts with the mouse is checked by dispatching the real
 * events, not by calling the action it eventually reaches. Calling the store
 * asserts the destination; only the events assert that the road to it is open.
 */
const rightClick = (element: HTMLElement) => {
  // A real right-click delivers `pointerdown` before `contextmenu`, and an open
  // menu dismisses itself on that pointerdown. Sending only `contextmenu` would
  // skip the close-then-reopen that happens whenever the user right-clicks a
  // second row — the case most likely to break.
  element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 2 }));
  // Cancellable, or the app's own `preventDefault` is a silent no-op and the
  // check for it could never fail.
  element.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 140,
      clientY: 220,
    }),
  );
};

/*
 * Both drags in this app are pointer drags — Tauri owns the webview's HTML5 drag
 * pipeline on Windows, so `dragstart` never fires there. That means these can be
 * dispatched end to end, unlike an Explorer drop.
 */
const pointerAt = (type: string, x: number, y: number, button = 0) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    clientX: x,
    clientY: y,
    button,
    buttons: type === "pointerup" ? 0 : 1,
  });

const centreOf = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

/** Presses a menu item the way a mouse does. See the context-menu section. */
async function pressItem(item: HTMLElement): Promise<void> {
  item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  await sleep(120);
  item.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

const projectRow = (path: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(".project-item")).find(
    (row) => row.title === path,
  ) ?? null;

const menuItem = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".context-menu button")).find(
    (button) => (button.textContent ?? "").includes(label),
  ) ?? null;

/** The menu's items, in order — asserted whole so a stray item cannot hide. */
const menuLabels = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".context-menu button"))
    .map((button) => (button.textContent ?? "").trim())
    .join("|");

const dismissMenu = async () => {
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  await sleep(200);
};

/** Stores a value in the shell; only the same process can report it back. */
const tagShell = (paneId: string) => writeSession(paneId, `set ICEVAR=${MARK}\r`);

/**
 * Asks the shell to echo the stored value behind a fresh token. The token keeps
 * the answer distinguishable from the echoed command line and from earlier runs,
 * and an unset variable echoes literally, which cannot contain the mark.
 */
async function shellIsSameProcess(paneId: string): Promise<boolean> {
  probeCounter += 1;
  const token = `IDP${probeCounter}X${Math.floor(Math.random() * 1e6).toString(36)}`;
  await writeSession(paneId, `echo ${token}=%ICEVAR%\r`);
  await sleep(1100);
  return screen(paneId).includes(`${token}=${MARK}`);
}

/**
 * Runs a command in a live shell and returns the value it echoed back.
 *
 * Used to look at the real filesystem from inside the harness: the frontend can
 * only reach the one state file the backend hands it, so questions *about* that
 * file's neighbours have to be asked of something that can see the disk.
 *
 * The token is parked in a shell variable instead of being typed into the
 * command. The console echoes every keystroke, so a command *containing* the
 * token puts `TOKEN=…` on screen before the shell has answered anything, and the
 * probe then reads back its own question — which is what happened: every state
 * file measured `%~zA)`, the literal text of the command, and the checks built
 * on it passed without measuring a thing.
 */
async function askShell(paneId: string, command: string): Promise<string> {
  probeCounter += 1;
  const token = `ASK${probeCounter}X${Math.floor(Math.random() * 1e6).toString(36)}`;
  await writeSession(paneId, `set ICEPROBE=${token}\r`);
  await sleep(300);
  await writeSession(paneId, `${command.replace(/TOKEN/g, "%ICEPROBE%")}\r`);
  await sleep(1300);
  const answer = new RegExp(`${token}=(\\S*)`).exec(screen(paneId));
  return answer?.[1] ?? "";
}

const STATE_DIR = "%APPDATA%\\com.icenovel.icecmd";

/**
 * Byte size of a file, or "0" when it does not exist.
 *
 * The space before each `)` keeps the closing paren from being glued onto the
 * value that `echo` prints.
 */
const sizeProbe = (name: string) =>
  `@if exist "${STATE_DIR}\\${name}" (@for %A in ("${STATE_DIR}\\${name}") do @echo TOKEN=%~zA ) else (@echo TOKEN=0 )`;

/**
 * Two-launch persistence check. `persist1` leaves a split project behind on
 * purpose; `persist2` runs after a restart and asserts it came back, then cleans
 * up. Restored panes must be plain shells, never a re-launched CLI.
 */
async function runPersistStage(stage: "persist1" | "persist2"): Promise<void> {
  await logLine(`harness ${stage} start`);

  if (stage === "persist1") {
    const id = useWorkspace.getState().addProject(PATH_PLAIN, "IceCmd");
    if (!id) {
      check("persist1 addProject", false);
      return;
    }
    useWorkspace.getState().openCli(id, "claude");
    await sleep(1200);
    check("persist1 left a split project", panesOf(id).length === 2);
    // Give the debounced writer time to flush before the app is killed.
    await sleep(2000);
    await logLine("harness persist1 done — restart the app with persist2");
    return;
  }

  // The store is hydrated during App's first effect; give it a moment.
  await sleep(2500);
  const state = useWorkspace.getState();
  const project = state.projects.find((p) => p.path === PATH_PLAIN);
  check("project restored after restart", Boolean(project), `projects=${state.projects.length}`);
  if (!project) return;

  const restored = panesOf(project.id);
  check("layout shape restored", restored.length === 2, `panes=${restored.length}`);
  check(
    "restored panes are plain shells",
    restored.every((paneId) => state.panes[paneId]?.kind === "shell"),
    restored.map((paneId) => state.panes[paneId]?.kind).join(","),
  );
  await sleep(2500);
  check(
    "restored panes have live shells",
    restored.every((paneId) => screen(paneId).includes("D:\\dev\\IceCmd")),
  );

  useWorkspace.getState().removeProject(project.id);
  await sleep(1500);
  check("persist cleanup", useWorkspace.getState().projects.length === 0);
  await logLine(
    `harness done passed=${passed} failed=${failed} verdict=${failed === 0 ? "PASS" : "FAIL"}`,
  );
}

/** Reports real element geometry, for when a screenshot is ambiguous. */
function reportChrome(): Promise<void> {
  const box = (selector: string) => {
    const element = document.querySelector(selector);
    if (!element) return `${selector}=MISSING`;
    const rect = element.getBoundingClientRect();
    return `${selector}=[x${Math.round(rect.left)} w${Math.round(rect.width)}]`;
  };
  return logLine(
    `chrome innerW=${window.innerWidth} dpr=${window.devicePixelRatio} ` +
      [
        ".app-shell",
        ".sidebar-wrap",
        ".workspace",
        ".panel-resize-left",
        ".rightpanel-wrap",
        ".right-panel",
        ".cli-buttons",
      ]
        .map(box)
        .join(" "),
  );
}

/** Populates a realistic workspace and stops, so the UI can be looked at. */
async function runDemo(args: string): Promise<void> {
  const first = useWorkspace.getState().addProject(PATH_PLAIN, "IceCmd");
  const second = useWorkspace.getState().addProject(PATH_SPACES, "IceCmd-MYBOX");
  if (!first) return;
  useWorkspace.getState().setActiveProject(first);
  await sleep(2200);
  useWorkspace.getState().openCli(first, "shell");
  await sleep(1500);
  const target = panesOf(first)[0];
  useWorkspace.getState().splitPaneWith(target, "col", "shell");
  await sleep(2000);
  await writeSession(target, "dir /b\r");
  await sleep(600);
  await reportChrome();

  // Feed the BEL to xterm's parser directly. Sending it as PTY *input* does not
  // work: cmd's line editor swallows control bytes, so nothing reaches the output
  // stream. Writing it to the terminal is the same path a CLI's bell takes.
  if (args.includes("bell") && second) {
    const other = panesOf(second)[0];
    if (other) {
      getEntry(other)?.term.write("\x07");
      await sleep(1600);
      await logLine(`harness demo bell status=${useWorkspace.getState().status[second]}`);
    }
  }

  // The support modal is local component state, so drive it the way a user would.
  if (args.includes("support")) {
    (document.querySelector(".support-open") as HTMLButtonElement | null)?.click();
    await sleep(400);
  }
  await logLine("harness demo ready");
}

export async function runHarness(mode = "1"): Promise<void> {
  if (mode === "persist1" || mode === "persist2") {
    await runPersistStage(mode);
    return;
  }
  if (mode.startsWith("demo")) {
    await runDemo(mode);
    return;
  }
  await logLine(`harness start mark=${MARK}`);

  /*
   * Wait for the store to be filled from disk before touching it.
   *
   * Hydration is async and starts in the same effect as this harness, so adding
   * projects first means the restored state lands *on top of them* partway
   * through the run. It shifted every pane count by one and took seven unrelated
   * checks down with it. A project left behind by an interrupted run does the
   * same, so the slate is wiped once hydration is in — the dev build has its own
   * state file, and nothing here can reach the installed app's.
   */
  for (let i = 0; i < 100 && !useWorkspace.getState().hydrated; i += 1) await sleep(100);
  check("the store hydrated before the run began", useWorkspace.getState().hydrated);
  const leftover = useWorkspace.getState().projects;
  if (leftover.length > 0) {
    await logLine(`harness clearing ${leftover.length} project(s) left by an earlier run`);
    for (const project of leftover) useWorkspace.getState().removeProject(project.id);
    await sleep(1000);
  }
  check("the run starts with an empty workspace", useWorkspace.getState().projects.length === 0);

  // --- projects and their automatic terminal (R2, R3) ---
  const idPlain = useWorkspace.getState().addProject(PATH_PLAIN, "IceCmd");
  const idSpaces = useWorkspace.getState().addProject(PATH_SPACES, "IceCmd-MYBOX");
  if (!idPlain || !idSpaces) {
    check("addProject", false, "no project id returned");
    return;
  }
  check("two projects added", useWorkspace.getState().projects.length === 2);
  check("each project starts with one pane", panesOf(idPlain).length === 1);

  await sleep(3000);
  const panePlain = panesOf(idPlain)[0];
  const paneSpaces = panesOf(idSpaces)[0];
  check(
    "auto shell cwd (plain path)",
    screen(panePlain).includes("D:\\dev\\IceCmd"),
    // Printed so a failure says whether the prompt was wrong or merely late.
    `tail=${JSON.stringify(screen(panePlain).trim().slice(-60))}`,
  );
  check("auto shell cwd (path with spaces)", screen(paneSpaces).includes("Naver MYBOX"));

  // Noted before this run writes anything, to be compared at the end.
  const installedStateBefore = await askShell(panePlain, sizeProbe("state.json"));

  // --- CLI availability, without actually starting the CLIs ---
  await writeSession(paneSpaces, "where claude\r");
  await sleep(900);
  await writeSession(paneSpaces, "where codex\r");
  await sleep(1200);
  const whereOut = screen(paneSpaces);
  check("claude resolves on PATH", /claude\.cmd|claude\.exe/i.test(whereOut));
  check("codex resolves on PATH", /codex\.cmd|codex\.exe/i.test(whereOut));

  // --- the shell must survive layout changes (regression: remount killed it) ---
  useWorkspace.getState().setActiveProject(idPlain);
  await sleep(900);
  await tagShell(panePlain);
  await sleep(700);
  check("shell tag readable to begin with", await shellIsSameProcess(panePlain));

  /*
   * --- dragging a project to a new place in the sidebar ---
   *
   * The dangerous part is not the array. Reordering keyed children makes React
   * move their DOM nodes, and a pane's node holds a live terminal — so the list
   * order is asserted *and* the shell is asked whether it is still the same
   * process afterwards. `App` draws the stages in an order of its own precisely
   * so the answer is yes.
   */
  const sidebarOrder = () =>
    Array.from(document.querySelectorAll<HTMLElement>(".project-item")).map((row) => row.title);
  const firstRow = projectRow(PATH_PLAIN);
  const secondRow = projectRow(PATH_SPACES);
  check("both project rows are on screen", Boolean(firstRow && secondRow));
  if (firstRow && secondRow) {
    check(
      "the sidebar starts in the order the projects were added",
      sidebarOrder().join("|") === `${PATH_PLAIN}|${PATH_SPACES}`,
      sidebarOrder().join("|"),
    );

    const grab = centreOf(firstRow);
    const past = secondRow.getBoundingClientRect().bottom - 2;
    firstRow.dispatchEvent(pointerAt("pointerdown", grab.x, grab.y));
    // Two moves: the first crosses the threshold, the second says where.
    window.dispatchEvent(pointerAt("pointermove", grab.x, grab.y + 12));
    window.dispatchEvent(pointerAt("pointermove", grab.x, past));
    await sleep(120);
    check(
      "the row it will land under is marked while dragging",
      Boolean(document.querySelector(".project-item.reorder-after")),
    );
    check("the row being dragged is marked too", Boolean(document.querySelector(".reorder-source")));

    window.dispatchEvent(pointerAt("pointerup", grab.x, past));
    // The click that follows the release must not be read as choosing a project.
    firstRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await sleep(300);
    check(
      "dragging a project past the next one reorders the list",
      sidebarOrder().join("|") === `${PATH_SPACES}|${PATH_PLAIN}`,
      sidebarOrder().join("|"),
    );
    check(
      "the drag did not also select the project it dragged",
      useWorkspace.getState().activeProjectId === idPlain,
      `active=${useWorkspace.getState().activeProjectId}`,
    );
    check("reordering keeps the shell process alive", await shellIsSameProcess(panePlain));

    // Put it back, so the rest of the run sees the order it expects.
    useWorkspace.getState().moveProject(idPlain, 0);
    await sleep(200);
    check(
      "the order can be put back",
      sidebarOrder().join("|") === `${PATH_PLAIN}|${PATH_SPACES}`,
      sidebarOrder().join("|"),
    );
    // Saved order is the whole point of reordering; a session-only one is a toy.
    await sleep(900);
    const orderOnDisk = await loadState()
      .then((raw) => (raw ? (JSON.parse(raw) as { projects?: { path: string }[] }) : null))
      .catch(() => null);
    check(
      "the project order is written to state.json",
      orderOnDisk?.projects?.map((project) => project.path).join("|") ===
        `${PATH_PLAIN}|${PATH_SPACES}`,
      JSON.stringify(orderOnDisk?.projects?.map((project) => project.path)),
    );
  }

  useWorkspace.getState().openCli(idPlain, "shell");
  await sleep(2600);
  const afterSplit = panesOf(idPlain);
  check("openCli splits into two panes", afterSplit.length === 2, `panes=${afterSplit.length}`);
  check("split node created", layoutOf(idPlain)?.type === "split");
  check("splitting keeps the same shell process", await shellIsSameProcess(panePlain));

  const newPane = afterSplit.find((id) => id !== panePlain) ?? "";
  check("new pane has its own live shell", screen(newPane).includes("D:\\dev\\IceCmd"));
  check("new pane is a different shell", !(await shellIsSameProcess(newPane)));

  // --- switching projects must not disturb the shells (R6) ---
  useWorkspace.getState().setActiveProject(idSpaces);
  await sleep(800);
  useWorkspace.getState().setActiveProject(idPlain);
  await sleep(900);
  check("project switch keeps the same shell process", await shellIsSameProcess(panePlain));

  // --- closing a pane affects only that pane ---
  useWorkspace.getState().closePane(newPane);
  await sleep(1500);
  const closedAlive = await sessionAlive(newPane).catch(() => false);
  check("closed pane session is gone", !closedAlive);
  check("sibling absorbs the space", layoutOf(idPlain)?.type === "leaf");
  check("closing a pane keeps the sibling's shell", await shellIsSameProcess(panePlain));

  // --- rearranging panes by drag, and flipping a split's orientation ---
  useWorkspace.getState().openCli(idPlain, "shell");
  await sleep(2200);
  const pair = panesOf(idPlain);
  const other = pair.find((id) => id !== panePlain) ?? "";
  const rootBefore = layoutOf(idPlain);
  check("split is left/right to begin with", rootBefore?.type === "split" && rootBefore.dir === "row");

  useWorkspace.getState().flipSplitAt(idPlain, "");
  const flipped = layoutOf(idPlain);
  check(
    "divider flip turns it into top/bottom",
    flipped?.type === "split" && flipped.dir === "col",
    `dir=${flipped?.type === "split" ? flipped.dir : "n/a"}`,
  );

  // Dropping the other pane on this one's right edge must rebuild it as a row.
  useWorkspace.getState().movePaneTo(idPlain, other, panePlain, "right");
  await sleep(1200);
  const moved = layoutOf(idPlain);
  const movedRight =
    moved?.type === "split" &&
    moved.dir === "row" &&
    moved.a.type === "leaf" &&
    moved.a.paneId === panePlain &&
    moved.b.type === "leaf" &&
    moved.b.paneId === other;
  check("drag-drop places the pane on the chosen edge", movedRight);
  check("panes survive a drag-drop rearrange", panesOf(idPlain).length === 2);
  check("rearranged pane keeps its shell process", await shellIsSameProcess(panePlain));

  useWorkspace.getState().closePane(other);
  await sleep(1200);

  // --- zoom and panel widths ---
  const baseFont = useWorkspace.getState().ui.fontSize;
  useWorkspace.getState().nudgeFontSize(3);
  await sleep(500);
  const zoomed = useWorkspace.getState().ui.fontSize;
  check("Ctrl+ raises the font size", zoomed === baseFont + 3, `${baseFont} -> ${zoomed}`);
  check(
    "terminals adopt the new font size",
    getEntry(panePlain)?.term.options.fontSize === zoomed,
    `term=${getEntry(panePlain)?.term.options.fontSize}`,
  );
  useWorkspace.getState().nudgeFontSize(-99);
  check("font size clamps at the minimum", useWorkspace.getState().ui.fontSize === 9);
  useWorkspace.getState().setFontSize(baseFont);

  useWorkspace.getState().setSidebarWidth(9999);
  check("sidebar width clamps at the maximum", useWorkspace.getState().ui.sidebarWidth === 460);
  useWorkspace.getState().setSidebarWidth(320);
  useWorkspace.getState().setRightPanelWidth(300);
  await sleep(600);
  check(
    "panel widths applied",
    useWorkspace.getState().ui.sidebarWidth === 320 &&
      useWorkspace.getState().ui.rightPanelWidth === 300,
  );

  // --- UI scale: chrome only, and it must not touch the terminal font ---
  // Asserted as a relationship rather than a fixed number: the app window is
  // interactive while this runs, so a human at the keyboard can move the value.
  const fontBeforeScale = useWorkspace.getState().ui.fontSize;
  useWorkspace.getState().setUiScale(1.3);
  await sleep(500);
  const scaleNow = useWorkspace.getState().ui.uiScale;
  // Read as computed rather than as an inline style: what matters is that the
  // value reaches the chrome, not which element happens to declare it.
  const scaleAt = (selector: string) => {
    const element = document.querySelector(selector);
    return element ? getComputedStyle(element).getPropertyValue("--ui-scale").trim() : "";
  };
  check(
    "ui scale reaches the stylesheet",
    scaleAt(".app-shell") === String(scaleNow),
    `var=${scaleAt(".app-shell")} store=${scaleNow}`,
  );
  check(
    "ui scale reaches the status bar too",
    scaleAt(".usage-bar") === String(scaleNow),
    `var=${scaleAt(".usage-bar")} store=${scaleNow}`,
  );
  const storedWidth = useWorkspace.getState().ui.sidebarWidth;
  const paintedWidth = document.querySelector(".sidebar-wrap")?.getBoundingClientRect().width ?? 0;
  check(
    "painted sidebar width is stored width times the scale",
    Math.abs(paintedWidth - storedWidth * scaleNow) <= 2,
    `painted=${Math.round(paintedWidth)} expected=${Math.round(storedWidth * scaleNow)}`,
  );
  check(
    "ui scale leaves the terminal font alone",
    useWorkspace.getState().ui.fontSize === fontBeforeScale,
  );
  useWorkspace.getState().setUiScale(9);
  check("ui scale clamps at the maximum", useWorkspace.getState().ui.uiScale === 1.6);
  useWorkspace.getState().setUiScale(1);
  await sleep(400);

  // --- support link plumbing: only web links are accepted ---
  const rejected = await openExternal("file:///C:/Windows/System32/calc.exe")
    .then(() => false)
    .catch(() => true);
  check("open_external refuses non-web links", rejected);

  // --- open in Explorer: the menu item must exist, and only folders are accepted ---
  useWorkspace.getState().setActiveProject(idPlain);
  await sleep(500);
  check(
    "folder header offers open-in-Explorer",
    Boolean(document.querySelector('.tree-header-actions button[title="탐색기에서 열기"]')),
  );
  const fileRejected = await openInFileManager(`${PATH_PLAIN}\\package.json`)
    .then(() => false)
    .catch(() => true);
  check("open_in_file_manager refuses a file", fileRejected);
  const missingRejected = await openInFileManager(`${PATH_PLAIN}\\__no_such_dir__`)
    .then(() => false)
    .catch(() => true);
  check("open_in_file_manager refuses a missing path", missingRejected);

  // --- my saved sizes: a remembered pair, distinct from the factory default ---
  useWorkspace.getState().setFontSize(19);
  useWorkspace.getState().setUiScale(1.25);
  useWorkspace.getState().saveMySizes();
  await sleep(400);
  const saved = useWorkspace.getState().mySizes;
  check("saveMySizes remembers both values", saved?.fontSize === 19 && saved?.uiScale === 1.25,
    `saved=${JSON.stringify(saved)}`);

  useWorkspace.getState().setFontSize(11);
  useWorkspace.getState().setUiScale(0.9);
  await sleep(300);
  useWorkspace.getState().applyMySizes();
  await sleep(400);
  const restored = useWorkspace.getState().ui;
  check(
    "applyMySizes puts both values back",
    restored.fontSize === 19 && restored.uiScale === 1.25,
    `now=${restored.fontSize}px ${restored.uiScale}`,
  );
  check(
    "terminals follow the restored font size",
    getEntry(panePlain)?.term.options.fontSize === 19,
    `term=${getEntry(panePlain)?.term.options.fontSize}`,
  );
  /*
   * --- 설정: the sliders and the saved pair moved into a dialog of their own ---
   *
   * They are opened the way a user opens them, because the button is the part
   * that can go missing: the store reachable from here would keep working with
   * nothing on screen at all.
   */
  const settingsButton = document.querySelector<HTMLButtonElement>(".settings-open");
  check("the right panel offers a settings button", Boolean(settingsButton));
  settingsButton?.click();
  await sleep(350);
  check("the settings dialog opens", Boolean(document.querySelector(".settings-dialog")));
  check(
    "the size sliders live in the dialog now",
    Boolean(document.querySelector(".settings-dialog .scale-control")),
  );
  check(
    "apply button reports it is already applied",
    Boolean(document.querySelector(".mysize-apply:disabled")),
  );

  // --- the right-button setting, chosen the way it is chosen ---
  const prefButton = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(".pref-choice button")).find(
      (button) => (button.textContent ?? "").includes(label),
    ) ?? null;
  const pasteChoice = prefButton("바로 붙여넣기");
  const menuChoice = prefButton("메뉴 표시");
  check("both right-click choices are offered", Boolean(pasteChoice && menuChoice));
  pasteChoice?.click();
  await sleep(200);
  check(
    "choosing 바로 붙여넣기 reaches the store",
    useWorkspace.getState().prefs.rightClick === "paste",
    useWorkspace.getState().prefs.rightClick,
  );
  check(
    "the chosen side is the one that looks chosen",
    (document.querySelector(".pref-choice button.pref-on")?.textContent ?? "").includes(
      "바로 붙여넣기",
    ),
  );
  menuChoice?.click();
  await sleep(200);
  check(
    "and it can be put back",
    useWorkspace.getState().prefs.rightClick === "menu",
    useWorkspace.getState().prefs.rightClick,
  );

  const watchToggle = document.querySelector<HTMLInputElement>(".pref-toggle input");
  check("folder watching can be turned off", Boolean(watchToggle));
  check(
    "folder watching is on out of the box",
    watchToggle?.checked === true && useWorkspace.getState().prefs.watchFolders,
  );

  // A setting that does not survive the app is not a setting.
  await sleep(900);
  const prefsOnDisk = await loadState()
    .then((raw) => (raw ? (JSON.parse(raw) as { prefs?: { rightClick?: string } }) : null))
    .catch(() => null);
  check(
    "settings are written to state.json",
    prefsOnDisk?.prefs?.rightClick === "menu",
    JSON.stringify(prefsOnDisk?.prefs),
  );

  (document.querySelector(".settings-close") as HTMLButtonElement | null)?.click();
  await sleep(250);
  check("the dialog closes again", !document.querySelector(".settings-dialog"));

  // The saved pair must reach disk, or it is not a setting — it is a session quirk.
  await sleep(900);
  const onDisk = await loadState()
    .then((raw) => (raw ? (JSON.parse(raw) as { mySizes?: { fontSize: number } }) : null))
    .catch(() => null);
  check(
    "saved sizes are written to state.json",
    onDisk?.mySizes?.fontSize === 19,
    `disk=${JSON.stringify(onDisk?.mySizes)}`,
  );

  useWorkspace.getState().clearMySizes();
  await sleep(300);
  check("clearMySizes forgets it", useWorkspace.getState().mySizes === null);
  useWorkspace.getState().setFontSize(13);
  useWorkspace.getState().setUiScale(1);

  /*
   * --- the dev build must not touch the installed app's state ---
   *
   * They share a config directory, so before the filenames were split, a harness run
   * that cleared state.json also cleared the projects registered in the installed
   * app. That is data loss caused by a test, and it happened for real (2026-08-09).
   */
  const devState = await askShell(panePlain, sizeProbe("state.dev.json"));
  // Asserted before anything is concluded from it: a probe that cannot fail is
  // worth nothing, and this one silently answered with its own command text once.
  check("the disk probe answers with a byte count", /^\d+$/.test(devState), `answer=${devState}`);
  check("dev build writes its own state file", devState !== "0", `state.dev.json=${devState}B`);

  /*
   * Byte-equality was the wrong question, and it took until 0.6.2 to notice.
   *
   * This app is developed inside itself: the installed IceCmd is nearly always
   * open while the harness runs, and it saves its own state whenever a pane is
   * moved. So the file legitimately changes under the run, and the check failed
   * for a reason that had nothing to do with what it tests — the same trap as
   * everything else in this file.
   *
   * What must never happen is what actually happened in 2026-08-09: the dev
   * build clearing or replacing it. Cleared shows up as 0, and replaced shows up
   * as the dev build's own snapshot — which, after cleanup, holds no projects at
   * all and is an order of magnitude smaller than a real one.
   */
  const installedStateAfter = await askShell(panePlain, sizeProbe("state.json"));
  const detail = `state.json ${installedStateBefore}B -> ${installedStateAfter}B, state.dev.json=${devState}B`;
  check(
    "the dev build did not clear the installed app's state",
    /^[1-9]\d*$/.test(installedStateAfter),
    detail,
  );
  check(
    "the dev build did not replace it with its own snapshot",
    installedStateAfter !== devState,
    detail,
  );

  const backup = await askShell(panePlain, sizeProbe("state.dev.json.bak"));
  check("a one-generation backup is kept", /^[1-9]\d*$/.test(backup), `bak=${backup}B`);

  // --- update check: version comparison is where this silently goes wrong ---
  check("version compare: 0.2.0 > 0.1.0", isNewer("0.2.0", "0.1.0"));
  check("version compare: 0.10.0 > 0.9.0 (not a string compare)", isNewer("0.10.0", "0.9.0"));
  check("version compare: v-prefix tolerated", isNewer("v1.0.0", "0.9.9"));
  check("version compare: same version is not newer", !isNewer("0.2.0", "0.2.0"));
  check("version compare: older is not newer", !isNewer("0.1.9", "0.2.0"));
  check(
    "running version is baked in",
    /^\d+\.\d+\.\d+$/.test(currentVersion),
    `version=${currentVersion}`,
  );
  /*
   * The live sources are fetched here, not through `checkForUpdate`, because that
   * function swallows its own failures by design — asserting on it would pass while
   * offline. The webview's origin is `tauri.localhost`, so a source that answers 200
   * to curl can still be withheld from the app by CORS: a failure invisible in any
   * server log. Both sources are probed from inside the running webview.
   */
  const probe = (url: string) =>
    fetch(url, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("http"))))
      .then((payload) => payload as Record<string, unknown>)
      .catch(() => null);

  const site = await probe("https://icenovel.com/download/icecmd/latest.json");
  const siteVersion = (site?.win as { version?: string } | undefined)?.version;
  check(
    "site latest.json readable from the webview (CORS)",
    typeof siteVersion === "string",
    siteVersion ? `site=${siteVersion}` : "blocked or unreachable",
  );
  check(
    "site version is not behind what shipped",
    typeof siteVersion === "string" && !isNewer(currentVersion, siteVersion),
    `site=${siteVersion ?? "?"} running=${currentVersion}`,
  );

  const gh = await probe("https://api.github.com/repos/icenovel-rgb/IceCmd/releases/latest");
  check(
    "github fallback readable from the webview",
    typeof (gh as { tag_name?: string } | null)?.tag_name === "string",
    `tag=${(gh as { tag_name?: string } | null)?.tag_name ?? "?"}`,
  );

  /*
   * Which answer is correct depends on reality, so the check follows reality rather
   * than a hard-coded expectation. Run with ICECMD_FAKE_VERSION=0.1.0 to take the
   * "a newer version exists" branch — the banner path is otherwise only reachable
   * in the window between a release and installing it.
   */
  const offered = await checkForUpdate();
  const behind = typeof siteVersion === "string" && isNewer(siteVersion, currentVersion);
  if (behind) {
    check(
      "newer version is offered when behind",
      offered?.version === siteVersion,
      `offered=${offered?.version ?? "none"} site=${siteVersion}`,
    );
    check("installer link points at an .exe", Boolean(offered?.downloadUrl.endsWith(".exe")));
    // The banner renders after its own start delay; give it room before looking.
    await sleep(4500);
    const banner = document.querySelector(".update-banner");
    check("update banner is shown", Boolean(banner), banner?.textContent?.slice(0, 60) ?? "absent");
  } else {
    check(
      "no update offered when running the newest version",
      offered === null,
      offered ? `offered ${offered.version}` : "silent",
    );
    check("no banner when up to date", !document.querySelector(".update-banner"));
  }
  check(
    "footer shows either a version line or an update banner",
    Boolean(document.querySelector(".version-line, .update-banner")),
  );

  // --- status rollup (R5) ---
  await writeSession(panePlain, `echo ${MARK}-status\r`);
  await sleep(1300);
  const busy = useWorkspace.getState().status[idPlain];
  check("busy while output flows", busy === "busy", `status=${busy}`);
  await sleep(4500);
  const settled = useWorkspace.getState().status[idPlain];
  check("returns to idle once quiet", settled === "idle", `status=${settled}`);

  // A BEL must outrank busy and stay until the user looks at the project.
  // Fed to xterm's parser directly: sent as PTY input, cmd's line editor eats it.
  useWorkspace.getState().setActiveProject(idSpaces);
  getEntry(panePlain)?.term.write("\x07");
  await sleep(1600);
  const belled = useWorkspace.getState().status[idPlain];
  check("BEL raises the attention flag", belled === "attention", `status=${belled}`);

  clearAttention(idPlain);
  await sleep(1400);
  const cleared = useWorkspace.getState().status[idPlain];
  check("looking at the project clears attention", cleared !== "attention", `status=${cleared}`);
  useWorkspace.getState().setActiveProject(idPlain);

  /*
   * --- the bell rung on the project you are already looking at ---
   *
   * Clearing it used to happen in one place: pressing the project's row in the
   * sidebar. On the project already on screen there is no row left to press, so
   * that bell could never be cleared — and since attention outranks busy, one of
   * them pinned the indicator for the rest of the session and the working spinner
   * never came back. The check above missed it by ringing the bell on the *other*
   * project and then calling `clearAttention` by hand.
   */
  check("bellIsSeen: on screen, with the window in front", bellIsSeen(true, true));
  check("bellIsSeen: not while the app is behind something", !bellIsSeen(true, false));
  check("bellIsSeen: never for a project you are not on", !bellIsSeen(false, true));

  /*
   * Both halves are driven by standing in for `document.hasFocus()` — the one
   * part of this rule that belongs to the browser rather than to this app. A run
   * started in the background cannot bring its own window to the front (Windows
   * refuses, and `AppActivate` reports success while changing nothing), so
   * without the stand-in the half that matters most could only ever be skipped —
   * and it is the half every user meets.
   */
  const realHasFocus = document.hasFocus.bind(document);
  const pretendFocus = (focused: boolean) => {
    document.hasFocus = () => focused;
  };
  const statusNow = () => useWorkspace.getState().status[idPlain];

  pretendFocus(false);
  getEntry(panePlain)?.term.write("\x07");
  await sleep(1600);
  check("a bell waits while the window is not in front", statusNow() === "attention", `status=${statusNow()}`);

  pretendFocus(true);
  await sleep(1600);
  check(
    "a bell on the project you are looking at clears itself",
    statusNow() !== "attention",
    `status=${statusNow()}`,
  );

  // The symptom itself: before this, one bell pinned the indicator for good and
  // the working spinner never appeared again.
  await writeSession(panePlain, `echo ${MARK}-again\r`);
  await sleep(1300);
  check(
    "the working spinner comes back after a bell has been seen",
    statusNow() === "busy",
    `status=${statusNow()}`,
  );

  document.hasFocus = realHasFocus;
  clearAttention(idPlain);
  await sleep(1300);

  // A pane that has produced nothing has not started working — it has just started.
  const freshEntry = getEntry(panePlain);
  if (freshEntry) {
    const outputAt = freshEntry.lastOutputAt;
    freshEntry.lastOutputAt = Number.NEGATIVE_INFINITY;
    await sleep(1400);
    const quiet = useWorkspace.getState().status[idPlain];
    check("a pane that has never produced output is not reported as working", quiet === "idle", `status=${quiet}`);
    freshEntry.lastOutputAt = outputAt;
  }

  /*
   * --- a pane that comes back on screen is redrawn in full ---
   *
   * xterm paints only the rows it believes changed, and a renderer that was just
   * swapped in — or a canvas whose GPU surface was thrown away while the window
   * was hidden — has painted none of them. The symptom is a terminal showing only
   * its last line until you scroll. What can be asserted from here is that the
   * full redraw is issued; that the pixels arrive is for a person to see.
   */
  const paintTerm = getEntry(panePlain)?.term;
  check("the pane's terminal is reachable for the redraw check", Boolean(paintTerm));
  if (paintTerm) {
    let repaints = 0;
    const realRefresh = paintTerm.refresh.bind(paintTerm);
    paintTerm.refresh = (start: number, end: number) => {
      repaints += 1;
      realRefresh(start, end);
    };

    useWorkspace.getState().setActiveProject(idSpaces);
    await sleep(500);
    const afterLeaving = repaints;
    useWorkspace.getState().setActiveProject(idPlain);
    await sleep(800);
    check(
      "coming back to a project redraws its panes",
      repaints > afterLeaving,
      `redraws=${repaints - afterLeaving}`,
    );

    const beforeFocus = repaints;
    window.dispatchEvent(new Event("focus"));
    await sleep(300);
    check(
      "getting the window back redraws them too",
      repaints > beforeFocus,
      `redraws=${repaints - beforeFocus}`,
    );

    paintTerm.refresh = realRefresh;
  }

  /*
   * --- the context menu, pressed the way a hand presses it ---
   *
   * Every item in this menu was dead from 0.1.0 through 0.3.0 while 59 checks
   * reported PASS, because the checks called `removeProject()` and never opened
   * the menu. The press below is split into pointerdown and click on purpose:
   * dispatching `click` alone passes even with the bug present, since the bug is
   * that the button is unmounted between the two.
   */
  const spacesRow = projectRow(PATH_SPACES);
  check("the project row is reachable in the sidebar", Boolean(spacesRow));
  if (spacesRow) {
    rightClick(spacesRow);
    await sleep(300);
    check("right-click opens the project menu", Boolean(document.querySelector(".context-menu")));
    // Not pressed: it would throw an Explorer window over the app mid-run. The
    // press path it shares with the item below is what was broken.
    check("the menu offers open-in-Explorer", Boolean(menuItem("탐색기에서 열기")));

    const remove = menuItem("제거");
    check("the menu offers remove", Boolean(remove));
    if (remove) {
      remove.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await sleep(150);
      check("pressing an item does not dismiss the menu first", document.body.contains(remove));

      remove.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      remove.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(900);
      check(
        "the pressed item really removes the project",
        !useWorkspace.getState().projects.some((project) => project.id === idSpaces),
        `projects=${useWorkspace.getState().projects.length}`,
      );
      check("the menu closes once the item ran", !document.querySelector(".context-menu"));
    }
  }

  const plainRow = projectRow(PATH_PLAIN);
  check("the remaining project row is still there", Boolean(plainRow));
  if (plainRow) {
    rightClick(plainRow);
    await sleep(400);
    check(
      "the menu opens again on another row",
      Boolean(document.querySelector(".context-menu")),
      `menus=${document.querySelectorAll(".context-menu").length} rows=${
        document.querySelectorAll(".project-item").length
      } attached=${document.body.contains(plainRow)}`,
    );
    await dismissMenu();
    check("a press outside dismisses the menu", !document.querySelector(".context-menu"));
  }

  // --- the same menu, now in the folder tree ---
  const treeRows = () => Array.from(document.querySelectorAll<HTMLElement>(".tree-row"));
  const folderRow = treeRows().find((row) => row.classList.contains("tree-dir")) ?? null;
  const fileRow = treeRows().find((row) => !row.classList.contains("tree-dir")) ?? null;
  check("the folder tree has both a folder and a file to press", Boolean(folderRow && fileRow));
  await logLine(
    `harness tree rows=${treeRows().length} first=${treeRows()
      .slice(0, 6)
      .map((row) => `${row.dataset.path ?? "?"}${row.classList.contains("tree-dir") ? "/" : ""}`)
      .join(" ")}`,
  );

  check(
    "the folder header icon is drawn, not a glyph",
    Boolean(document.querySelector('.tree-header-actions button[title="탐색기에서 열기"] svg')),
  );

  if (fileRow) {
    rightClick(fileRow);
    await sleep(300);
    // Neither item is pressed: one hands the file to whatever program owns it,
    // the other throws an Explorer window over the app mid-run.
    check("a file offers open and reveal", menuLabels() === "열기|폴더에서 보기", menuLabels());
    await dismissMenu();
  }

  if (folderRow) {
    const folderPath = folderRow.dataset.path ?? "";
    rightClick(folderRow);
    await sleep(300);
    check(
      "a folder offers Explorer and a shell",
      menuLabels() === "탐색기에서 열기|여기서 cmd 열기",
      menuLabels(),
    );

    const here = menuItem("여기서 cmd 열기");
    check("the folder menu has the shell item", Boolean(here));
    if (here) {
      const before = panesOf(idPlain);
      await pressItem(here);
      await sleep(3000);
      const after = panesOf(idPlain);
      const created = after.find((id) => !before.includes(id)) ?? "";
      check(
        "opening a shell here adds a pane",
        after.length === before.length + 1,
        `${before.length} -> ${after.length}`,
      );
      check(
        "the new pane is told to start in the folder that was pressed",
        useWorkspace.getState().panes[created]?.cwd === folderPath,
        `cwd=${useWorkspace.getState().panes[created]?.cwd ?? "none"} want=${folderPath}`,
      );
      // The store holding the right cwd proves nothing about the process; ask the
      // shell where it actually landed.
      check(
        "the shell really started in that folder",
        screen(created).includes(folderPath),
        `want=${folderPath}`,
      );
      if (created) useWorkspace.getState().closePane(created);
      await sleep(800);
    }
  }

  /*
   * --- dropping files on a pane types their paths ---
   *
   * Tauri swallows OS drags before the webview sees them, so there is no DOM
   * event to dispatch; the payload handler is driven directly, built from the
   * pane's real rectangle and the real device pixel ratio (drop coordinates
   * arrive in physical pixels, and getting that conversion wrong would put every
   * drop in the wrong pane). Tauri's own delivery of the event is the one link
   * this cannot reach.
   */
  check("quoting: a plain path is left alone", dropTextFor([PATH_PLAIN]) === PATH_PLAIN);
  check(
    "quoting: a path with spaces is quoted",
    dropTextFor([PATH_SPACES]) === `"${PATH_SPACES}"`,
    dropTextFor([PATH_SPACES]),
  );
  check(
    "quoting: several paths are separated",
    dropTextFor([PATH_PLAIN, PATH_SPACES]) === `${PATH_PLAIN} "${PATH_SPACES}"`,
  );

  const host = document.querySelector<HTMLElement>(`[data-pane="${panePlain}"] .terminal-host`);
  check("the pane can be found on screen", Boolean(host));
  if (host) {
    const box = host.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const inside = { x: (box.left + box.width / 2) * scale, y: (box.top + box.height / 2) * scale };
    const outside = { x: -50, y: -50 };
    const dropped = `${PATH_SPACES}\\README.md`;

    let hovered: boolean | null = null;
    const target = {
      element: () => host,
      onHover: (state: boolean) => {
        hovered = state;
      },
      onDrop: (paths: DroppedPath[]) =>
        void writeSession(panePlain, dropTextFor(paths.map((entry) => entry.path))),
    };

    await handleDropPayload({ type: "over", position: inside }, target);
    check("a drag over the pane marks it as the target", hovered === true);
    await handleDropPayload({ type: "over", position: outside }, target);
    check("a drag outside it does not", hovered === false);

    await handleDropPayload({ type: "drop", paths: [dropped], position: outside }, target);
    await sleep(700);
    check(
      "a drop outside the pane types nothing",
      !screen(panePlain).includes("README.md"),
      "text arrived from a drop that missed",
    );

    await handleDropPayload({ type: "drop", paths: [dropped], position: inside }, target);
    await sleep(900);
    check(
      "a drop on the pane types the path, quoted",
      screen(panePlain).includes(`"${dropped}"`),
      `want="${dropped}"`,
    );
    // Nothing was executed and nothing should be: clear the line the drop typed.
    await writeSession(panePlain, "\x1b");
    await sleep(500);
  }

  /*
   * --- dragging a row out of the folder tree ---
   *
   * This is a pointer drag, not an HTML5 one. 0.5.0 built it on `dragstart` and
   * `drop`, and it passed here while being dead in the real app: `dragDropEnabled`
   * gives Tauri's native file-drop handler the webview's whole drag pipeline on
   * Windows, so those events never fire. Pointer events nothing intercepts can be
   * dispatched end to end, which is what happens below.
   */
  const dragRow =
    treeRows().find((row) => (row.dataset.path ?? "").endsWith("\\package.json")) ?? null;
  check("the folder tree has a row to drag", Boolean(dragRow));
  if (dragRow && host) {
    const draggedPath = dragRow.dataset.path ?? "";
    const from = centreOf(dragRow);
    const to = centreOf(host);

    dragRow.dispatchEvent(pointerAt("pointerdown", from.x, from.y));
    // The first move crosses the threshold, the second says where it landed.
    window.dispatchEvent(pointerAt("pointermove", from.x - 24, from.y));
    window.dispatchEvent(pointerAt("pointermove", to.x, to.y));
    await sleep(150);
    check(
      "the dragged row is carried under the pointer",
      (document.querySelector(".drag-ghost")?.textContent ?? "") === "package.json",
      document.querySelector(".drag-ghost")?.textContent ?? "no label",
    );
    check("the pane under the pointer is marked as the target", host.classList.contains("drop-active"));

    window.dispatchEvent(pointerAt("pointerup", to.x, to.y));
    await sleep(900);
    check(
      "dropping it on the pane types that row's own path",
      screen(panePlain).includes(draggedPath),
      `want=${draggedPath}`,
    );
    check("the label is gone once it is dropped", !document.querySelector(".drag-ghost"));
    check("the target mark is cleared after the drop", !host.classList.contains("drop-active"));
    check(
      "the pane it was dropped on is the focused one",
      useWorkspace.getState().focusedPane[idPlain] === panePlain,
      `focused=${useWorkspace.getState().focusedPane[idPlain]}`,
    );
    // Nothing was executed and nothing should be: clear the line the drop typed.
    await writeSession(panePlain, "\x1b");
    await sleep(600);
  }

  /*
   * --- the folder list follows the disk on its own ---
   *
   * The file is made by the shell inside the pane, not by this code. That is the
   * whole point: a change the app was never told about still has to arrive.
   */
  const probeName = `.icecmd-watch-${MARK.toLowerCase()}.tmp`;
  const treeHasProbe = () => treeRows().some((row) => (row.dataset.path ?? "").endsWith(probeName));
  check("the probe file is not in the tree to begin with", !treeHasProbe());
  await writeSession(panePlain, `echo probe>${probeName}\r`);
  await sleep(2000);
  check("a file made outside the app appears without a refresh", treeHasProbe());
  await writeSession(panePlain, `del ${probeName}\r`);
  await sleep(2000);
  check("and it leaves again when it is deleted", !treeHasProbe());

  /*
   * --- the Hangul IME must not deliver a syllable twice ---
   *
   * The measured failure: on a keydown with keyCode 229 xterm.js queues a
   * fallback that sends whatever appeared in its textarea a tick later, and the
   * IME's own keypress has already sent the same syllable. Reproduced here by
   * doing exactly that — announce an IME keystroke, then put a syllable in the
   * textarea the way the IME does — and asserting nothing is sent.
   */
  const imeEntry = getEntry(panePlain);
  const imeArea = imeEntry?.term.textarea;
  check("the terminal exposes the textarea the IME writes into", Boolean(imeArea));
  if (imeEntry && imeArea) {
    let sent = "";
    const tap = imeEntry.term.onData((data) => {
      sent += data;
    });
    const restore = imeArea.value;
    imeArea.value = "";

    // `keyCode` is not settable through the constructor, and it is the only part
    // of the event xterm.js looks at here.
    const imeKey = new KeyboardEvent("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(imeKey, "keyCode", { get: () => 229 });
    imeArea.dispatchEvent(imeKey);
    imeArea.value = "가";
    await sleep(120);

    tap.dispose();
    imeArea.value = restore;
    imeArea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true }));
    check("an IME keystroke queues no second send of the syllable", sent === "", JSON.stringify(sent));
  }

  /*
   * --- the cursor stops strobing while a CLI is working ---
   *
   * xterm.js restarts the blink animation on every cursor move, so a TUI that
   * repaints continuously makes the cursor flicker instead of blink.
   */
  if (imeEntry) {
    await writeSession(panePlain, `echo ${MARK}-blink\r`);
    await sleep(250);
    check(
      "the cursor is held still while output is arriving",
      imeEntry.term.options.cursorBlink === false,
    );
    await sleep(1100);
    check(
      "the cursor blinks again once the output stops",
      imeEntry.term.options.cursorBlink === true,
    );
  }

  /*
   * --- plan usage, read from the caches the CLIs keep ---
   *
   * Each number is only as fresh as the last run of that CLI, so the stamp is
   * checked as carefully as the value: an unstamped reading would be presented
   * as current when it might be days old.
   */
  const usage = await cliUsage(false).catch(() => null);
  check("cli_usage answers", usage !== null);
  if (usage) {
    const tools = [usage.claude, usage.codex].filter((tool): tool is ToolUsage => Boolean(tool));
    const windows = tools
      .flatMap((tool) => [tool.session, tool.weekly])
      .filter((window): window is UsageWindow => Boolean(window));
    check("at least one CLI reported a usage window", windows.length > 0, `windows=${windows.length}`);
    check(
      "every reported figure is a real percentage",
      windows.every((window) => window.percent >= 0 && window.percent <= 100),
      JSON.stringify(windows.map((window) => window.percent)),
    );
    const stamps = tools
      .map((tool) => tool.measuredAtMs)
      .filter((stamp): stamp is number => typeof stamp === "number");
    check("every reading carries when it was taken", stamps.length === tools.length);
    check(
      "no reading claims to come from the future",
      // 2023-11 is comfortably before either CLI existed.
      stamps.every((stamp) => stamp > 1.7e12 && stamp < Date.now() + 60_000),
      JSON.stringify(stamps),
    );
  }

  /*
   * The live reading is the answer to "the bar only moves after I type /usage".
   * It is allowed to be unavailable — no network, no token, a macOS keychain —
   * because it falls back to the cache. What it must never be is *older* than
   * the cache it was asked to improve on.
   */
  const liveUsage = await cliUsage(true).catch(() => null);
  check("cli_usage answers with 실시간 갱신 on", liveUsage !== null);
  if (liveUsage && usage) {
    const stampOf = (claude: ToolUsage | null | undefined) => claude?.measuredAtMs ?? 0;
    check(
      "the live reading is never staler than the cached one",
      stampOf(liveUsage.claude) >= stampOf(usage.claude),
      `live=${stampOf(liveUsage.claude)} cached=${stampOf(usage.claude)}`,
    );
  }

  /*
   * --- colour actually reaches the child ---
   *
   * "on that PC everything comes out black and white" is not a colour being
   * wrong, it is a CLI deciding to emit no colour at all, and what it decides on
   * is the environment it was handed. So the environment is read back from
   * inside the shell rather than trusted where it was set: the store holding
   * `forceColor` proves nothing about what the process got.
   */
  const colourEnvOf = async (paneId: string) => {
    await writeSession(paneId, `echo ${MARK}-col[%TERM%][%COLORTERM%][%FORCE_COLOR%]\r`);
    await sleep(700);
    return screen(paneId);
  };

  const plainColour = await colourEnvOf(panePlain);
  check(
    "a shell is told which terminal it is talking to",
    plainColour.includes(`${MARK}-col[xterm-256color][truecolor]`),
    plainColour.slice(-160),
  );
  check(
    "a plain shell is not forced by default",
    !plainColour.includes(`${MARK}-col[xterm-256color][truecolor][3]`),
  );

  {
    const restore = useWorkspace.getState().prefs.forceColor;
    useWorkspace.getState().setPrefs({ forceColor: true });
    const before = panesOf(idPlain);
    useWorkspace.getState().openCli(idPlain, "shell");
    await sleep(3000);
    const forced = panesOf(idPlain).find((id) => !before.includes(id)) ?? "";
    check("the switch opens a shell to test with", Boolean(forced));
    if (forced) {
      const forcedColour = await colourEnvOf(forced);
      check(
        "with the switch on, a new shell is handed FORCE_COLOR",
        forcedColour.includes(`${MARK}-col[xterm-256color][truecolor][3]`),
        forcedColour.slice(-160),
      );
      useWorkspace.getState().closePane(forced);
      await sleep(800);
    }
    useWorkspace.getState().setPrefs({ forceColor: restore });
  }

  /*
   * --- the pane's own copy/paste menu ---
   *
   * "붙여넣기" is never pressed here: it would push whatever the user has copied
   * into a live shell, and a trailing newline in it would run as a command.
   */
  if (host) {
    /*
     * xterm.js only fills whole rows, so a strip shorter than one row is left
     * over at the bottom and the library's own stylesheet paints it `#000` —
     * a black band under the terminal, in an app whose terminal is #1e1e1e.
     */
    const viewport = host.querySelector<HTMLElement>(".xterm-viewport");
    const viewportBg = viewport ? getComputedStyle(viewport).backgroundColor : "";
    check(
      "the strip under the last row is not the library's black",
      Boolean(viewport) && viewportBg !== "rgb(0, 0, 0)",
      viewportBg || "no viewport",
    );

    /*
     * The right button must not reach xterm.js at all. A TUI that asked for
     * mouse reporting gets button 2 forwarded to it, and one that pastes on
     * that press pastes *as well as* this app — one click, two pastes.
     */
    const inner = host.querySelector<HTMLElement>(".xterm-screen");
    check("the terminal's own element is there to shield", Boolean(inner));
    if (inner) {
      let reached = false;
      const spy = () => {
        reached = true;
      };
      inner.addEventListener("mousedown", spy);
      const rightDown = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 2,
      });
      inner.dispatchEvent(rightDown);
      inner.removeEventListener("mousedown", spy);
      check("a right-button press never reaches the terminal", !reached && rightDown.defaultPrevented);

      // The left button has to keep working, or selection and focus die with it.
      let leftReached = false;
      const leftSpy = () => {
        leftReached = true;
      };
      inner.addEventListener("mousedown", leftSpy);
      inner.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      inner.removeEventListener("mousedown", leftSpy);
      check("the left button still gets through", leftReached);
    }

    rightClick(host);
    await sleep(300);
    check(
      "a terminal with no selection offers everything but copy",
      menuLabels() === "붙여넣기|모두 선택|화면 지우기",
      menuLabels(),
    );
    await dismissMenu();

    getEntry(panePlain)?.term.selectAll();
    rightClick(host);
    await sleep(300);
    check(
      "a selection adds copy to the menu",
      menuLabels() === "복사|붙여넣기|모두 선택|화면 지우기",
      menuLabels(),
    );

    /*
     * The Clipboard API refuses to run while the document is unfocused, and
     * Windows will not bring a window forward on behalf of a background process,
     * which is how this run is started. So the round trip is checked only when
     * focus was actually obtained, and otherwise reported as skipped — never
     * quietly passed. Click the window and run again to cover it.
     */
    const focused = await getCurrentWindow()
      .setFocus()
      .then(() => sleep(700))
      .then(() => document.hasFocus())
      .catch(() => false);

    const copyItem = menuItem("복사");
    check("the menu has the copy item", Boolean(copyItem));

    const savedClipboard = focused ? await navigator.clipboard.readText().catch(() => null) : null;
    if (copyItem) {
      await pressItem(copyItem);
      await sleep(600);
      // True whether or not the clipboard is reachable: it says the press ran.
      check("the copy item runs and closes the menu", !document.querySelector(".context-menu"));

      if (focused) {
        const copied = await navigator.clipboard.readText().catch(() => "");
        check(
          "the copy item puts the selection on the clipboard",
          copied.includes(MARK),
          `${copied.length} chars`,
        );
        // The clipboard belongs to whoever is at the keyboard, so it goes back.
        if (savedClipboard !== null) {
          await navigator.clipboard.writeText(savedClipboard).catch(() => {});
        }
      } else {
        await logLine(
          "harness SKIP copy reaches the clipboard — the window could not take focus, " +
            "and the Clipboard API refuses to run unfocused",
        );
      }
    }
    getEntry(panePlain)?.term.clearSelection();
    await dismissMenu();

    /*
     * --- the other right-button setting: paste, with no menu at all ---
     *
     * This one *does* press paste, so the clipboard is loaded with a harmless
     * token first and put back afterwards. When the window has no focus the
     * Clipboard API refuses both, and then the only thing that can be asserted
     * is the part that matters most anyway: no menu appeared.
     */
    useWorkspace.getState().setPrefs({ rightClick: "paste" });
    await sleep(200);
    const token = `${MARK}-rmb`;
    /*
     * Guarded by the same `focused` as the copy check above, and not merely
     * because the call would fail: in WebView2 an unfocused `readText()` never
     * settles at all — it neither resolves nor rejects, and the run stops there.
     * Awaiting it unguarded hung this harness for ten minutes.
     */
    const heldClipboard = focused ? await navigator.clipboard.readText().catch(() => null) : null;
    const armed = focused
      ? await navigator.clipboard
          .writeText(token)
          .then(() => true)
          .catch(() => false)
      : false;

    rightClick(host);
    await sleep(800);
    check(
      "with 바로 붙여넣기 chosen, right-click puts up no menu",
      !document.querySelector(".context-menu"),
    );
    if (armed) {
      check(
        "and the clipboard really lands in the shell",
        screen(panePlain).includes(token),
        `token=${token}`,
      );
      // Never executed: the line the paste typed is cleared before moving on.
      await writeSession(panePlain, "\x1b");
      await sleep(400);
      if (heldClipboard !== null) {
        await navigator.clipboard.writeText(heldClipboard).catch(() => {});
      }
    } else {
      await logLine(
        "harness SKIP right-click paste reaches the shell — the window could not take " +
          "focus, and the Clipboard API refuses to run unfocused",
      );
    }
    useWorkspace.getState().setPrefs({ rightClick: "menu" });
    await sleep(200);
    rightClick(host);
    await sleep(300);
    check("with 메뉴 표시 chosen, the menu is back", Boolean(document.querySelector(".context-menu")));
    await dismissMenu();
  }

  /*
   * --- the browser's own menu must never surface ---
   *
   * Without this, right-clicking anywhere the app has no menu of its own brings up
   * Edge's ("장치에 탭 내보내기"), which belongs to a browser, not to this app.
   */
  const plainMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  document.body.dispatchEvent(plainMenu);
  check("right-click never reaches the WebView2 menu", plainMenu.defaultPrevented);

  const shiftMenu = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    shiftKey: true,
  });
  document.body.dispatchEvent(shiftMenu);
  check("Shift+right-click is still let through for DevTools", !shiftMenu.defaultPrevented);

  // --- the two new path commands refuse what they are not for ---
  const openFolderRejected = await openPath(PATH_PLAIN)
    .then(() => false)
    .catch(() => true);
  check("open_path refuses a folder", openFolderRejected);
  const revealMissingRejected = await revealPath(`${PATH_PLAIN}\\__no_such_file__`)
    .then(() => false)
    .catch(() => true);
  check("reveal_path refuses a missing path", revealMissingRejected);

  // --- cleanup, so the user's saved state stays clean ---
  useWorkspace.getState().removeProject(idPlain);
  useWorkspace.getState().removeProject(idSpaces);
  await sleep(1500);
  check("removeProject clears everything", useWorkspace.getState().projects.length === 0);
  const leftovers = await Promise.all(
    [panePlain, paneSpaces].map((id) => sessionAlive(id).catch(() => false)),
  );
  check("removed projects leave no live sessions", leftovers.every((alive) => !alive));

  /*
   * Left for last because it throws an Explorer window over everything. It is the
   * one case that matters: explorer.exe reads its own raw command line, so
   * `/select,` only works with the quotes around the path alone, and normal argv
   * quoting fails on exactly the paths that have a space in them.
   *
   * That the window highlights the file is the one thing here a person still has
   * to look at — this can only assert that the command was accepted.
   */
  const revealedWithSpaces = await revealPath(`${PATH_SPACES}\\README.md`)
    .then(() => true)
    .catch(() => false);
  check("reveal_path accepts a path with spaces", revealedWithSpaces);

  await logLine(
    `harness done passed=${passed} failed=${failed} verdict=${failed === 0 ? "PASS" : "FAIL"}`,
  );
}
