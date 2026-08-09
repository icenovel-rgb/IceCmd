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
import { paneIds } from "./layout/tree";
import { useWorkspace } from "./store/workspace";
import {
  loadState,
  logLine,
  openExternal,
  openInFileManager,
  sessionAlive,
  writeSession,
} from "./terminal/ipc";
import { getEntry } from "./terminal/termRegistry";
import { clearAttention } from "./terminal/status";
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
  check("auto shell cwd (plain path)", screen(panePlain).includes("D:\\dev\\IceCmd"));
  check("auto shell cwd (path with spaces)", screen(paneSpaces).includes("Naver MYBOX"));

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
  const shell = document.querySelector(".app-shell") as HTMLElement | null;
  check(
    "ui scale reaches the stylesheet",
    shell?.style.getPropertyValue("--ui-scale") === String(scaleNow),
    `var=${shell?.style.getPropertyValue("--ui-scale")} store=${scaleNow}`,
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

  // --- cleanup, so the user's saved state stays clean ---
  useWorkspace.getState().removeProject(idPlain);
  useWorkspace.getState().removeProject(idSpaces);
  await sleep(1500);
  check("removeProject clears everything", useWorkspace.getState().projects.length === 0);
  const leftovers = await Promise.all(
    [panePlain, paneSpaces].map((id) => sessionAlive(id).catch(() => false)),
  );
  check("removed projects leave no live sessions", leftovers.every((alive) => !alive));

  await logLine(
    `harness done passed=${passed} failed=${failed} verdict=${failed === 0 ? "PASS" : "FAIL"}`,
  );
}
