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
import { clearAttention } from "./terminal/status";
import { dropTextFor } from "./terminal/dropText";
import { PATH_MIME } from "./terminal/pathDrag";
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

function screen(paneId: string): string {
  const term = getEntry(paneId)?.term;
  if (!term) return "";
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
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
  check(
    "apply button reports it is already applied",
    Boolean(document.querySelector(".mysize-apply:disabled")),
  );
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

  const installedStateAfter = await askShell(panePlain, sizeProbe("state.json"));
  check(
    "installed app's state.json untouched by this run",
    /^\d+$/.test(installedStateAfter) && installedStateAfter === installedStateBefore,
    `before=${installedStateBefore}B after=${installedStateAfter}B`,
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
   * A drag that starts inside the app is an ordinary HTML5 one, so unlike the
   * Explorer drops above it can be dispatched end to end here: the tree row
   * really is the source and the pane's own handler really is the target.
   */
  const treeRow = document.querySelector<HTMLElement>(".tree-row[data-path]");
  check("the folder tree has rows on screen", Boolean(treeRow));
  if (treeRow) {
    check("a tree row can be picked up", treeRow.draggable);
    const carried = new DataTransfer();
    treeRow.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: carried }),
    );
    check(
      "dragging a row carries that row's own path",
      carried.getData(PATH_MIME) === treeRow.dataset.path,
      `carried=${carried.getData(PATH_MIME)} row=${treeRow.dataset.path}`,
    );
  }

  if (host) {
    // A different path from the Explorer drop above, so a leftover line on the
    // screen cannot pass this check for it.
    const draggedPath = `${PATH_SPACES}\\release`;
    const transfer = new DataTransfer();
    transfer.setData(PATH_MIME, draggedPath);

    host.dispatchEvent(
      new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
    check("a path dragged over a pane marks it as the target", host.classList.contains("drop-active"));

    host.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
    await sleep(900);
    check(
      "dropping it on the pane types the path, quoted",
      screen(panePlain).includes(`"${draggedPath}"`),
      `want="${draggedPath}"`,
    );
    check("the target mark is cleared after the drop", !host.classList.contains("drop-active"));
    await writeSession(panePlain, "\x1b");
    await sleep(500);
  }

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
  const usage = await cliUsage().catch(() => null);
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
   * --- the pane's own copy/paste menu ---
   *
   * "붙여넣기" is never pressed here: it would push whatever the user has copied
   * into a live shell, and a trailing newline in it would run as a command.
   */
  if (host) {
    rightClick(host);
    await sleep(300);
    check("a terminal with no selection offers paste only", menuLabels() === "붙여넣기", menuLabels());
    await dismissMenu();

    getEntry(panePlain)?.term.selectAll();
    rightClick(host);
    await sleep(300);
    check("a selection adds copy to the menu", menuLabels() === "복사|붙여넣기", menuLabels());

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
