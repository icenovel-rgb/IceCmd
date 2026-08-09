/**
 * Dev-only guided tour, enabled with VITE_ICECMD_TOUR=1.
 *
 * The app performs its own demo so a screen recording captures a coherent take.
 * Pointer gestures are dispatched as real PointerEvents rather than calling store
 * actions, so the drag preview and hover states appear exactly as a user would see
 * them — a recording of store mutations would jump without showing the interaction.
 *
 * Recording (window must be visible and unobscured):
 *   VITE_ICECMD_TOUR=1 npm run tauri dev
 *   ffmpeg -f gdigrab -framerate 30 -draw_mouse 0 -i title=IceCmd ...
 */
import { useWorkspace } from "./store/workspace";
import { logLine, writeSession } from "./terminal/ipc";
import { getEntry } from "./terminal/termRegistry";
import { paneIds } from "./layout/tree";

const PROJECT_A = { path: "D:\\dev\\IceCmd", name: "IceCmd" };
const PROJECT_B = {
  path: "D:\\Naver MYBOX\\2. Works\\Personal\\ICEFiction",
  name: "IceFiction",
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const panesOf = (projectId: string) =>
  paneIds(useWorkspace.getState().layouts[projectId] ?? null);

/** Types a command a character at a time so the recording shows real typing. */
async function typeCommand(paneId: string, command: string, perChar = 45): Promise<void> {
  for (const character of command) {
    await writeSession(paneId, character);
    await wait(perChar);
  }
  await wait(220);
  await writeSession(paneId, "\r");
}

function centerOf(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    clientX: x,
    clientY: y,
    buttons: type === "pointerup" ? 0 : 1,
  });
}

/**
 * Drags a pane by its grip onto a target point. Moves in steps because the drop
 * preview is recomputed on pointermove — a single jump would never show it.
 */
async function dragPane(
  gripElement: Element,
  destination: { x: number; y: number },
  steps = 18,
): Promise<void> {
  const from = centerOf(gripElement);
  gripElement.dispatchEvent(pointer("pointerdown", from.x, from.y));
  await wait(160);

  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps;
    window.dispatchEvent(
      pointer(
        "pointermove",
        from.x + (destination.x - from.x) * ratio,
        from.y + (destination.y - from.y) * ratio,
      ),
    );
    await wait(28);
  }
  await wait(520); // hold so the drop target is readable
  window.dispatchEvent(pointer("pointerup", destination.x, destination.y));
}

/** The divider is addressed by its rendered position, like a user would. */
async function doubleClickDivider(): Promise<void> {
  const divider = document.querySelector(".pane-stage .divider");
  if (!divider) return;
  const at = centerOf(divider);
  divider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: at.x, clientY: at.y }));
}

function clickButton(selector: string): void {
  (document.querySelector(selector) as HTMLButtonElement | null)?.click();
}

export async function runTour(): Promise<void> {
  const store = useWorkspace.getState();
  await logLine("tour start");
  await wait(1500);

  // 1. 폴더를 프로젝트로 등록 — 터미널이 그 폴더에서 열린다
  const projectA = store.addProject(PROJECT_A.path, PROJECT_A.name);
  if (!projectA) return;
  await wait(2600);

  const firstPane = panesOf(projectA)[0];
  await typeCommand(firstPane, "dir /b");
  await wait(1600);

  // 2. claude 버튼 — 가장 넓은 칸이 절반으로 나뉜다
  clickButton(".cli-claude");
  await wait(3600);

  // 신뢰 확인은 Enter만 보내 이미 선택된 항목을 고른다. "1"을 타이핑하면 확인이
  // 닫힌 뒤 그 글자가 프롬프트로도 들어가 예측할 수 없는 답변이 화면에 남는다.
  const claudePane = panesOf(projectA).find((id) => id !== firstPane);
  if (claudePane) {
    await writeSession(claudePane, "\r");
    await wait(4200);
  }

  // 3. 칸을 끌어 배치를 바꾼다 (좌우 -> 상하)
  const grips = Array.from(document.querySelectorAll(".pane-grip"));
  const slots = Array.from(document.querySelectorAll(".pane-slot"));
  if (grips.length >= 2 && slots.length >= 2) {
    const target = slots[0].getBoundingClientRect();
    await dragPane(grips[1], {
      // 첫 칸의 아래쪽 가장자리 — 위아래 배치가 된다
      x: target.left + target.width / 2,
      y: target.bottom - target.height * 0.12,
    });
  }
  await wait(2200);

  // 4. 경계 더블클릭으로 방향 뒤집기
  await doubleClickDivider();
  await wait(1800);
  await doubleClickDivider();
  await wait(1600);

  // 5. 터미널 글자 크기 — 출력이 몇 줄 들어가는지를 정한다
  for (let i = 0; i < 5; i += 1) {
    store.nudgeFontSize(1);
    await wait(300);
  }
  await wait(1100);
  for (let i = 0; i < 5; i += 1) {
    store.nudgeFontSize(-1);
    await wait(240);
  }
  await wait(1000);

  // 6. 화면 배율 — 크롬만 커진다. 터미널 글자와 따로 조정하는 것이 요점이다
  for (let i = 0; i < 6; i += 1) {
    store.nudgeUiScale(0.05);
    await wait(300);
  }
  await wait(1400);
  for (let i = 0; i < 6; i += 1) {
    store.nudgeUiScale(-0.05);
    await wait(240);
  }
  await wait(1100);

  // 7. 두 번째 프로젝트를 더하고 오가 본다
  const projectB = store.addProject(PROJECT_B.path, PROJECT_B.name);
  await wait(2600);
  if (projectB) {
    store.setActiveProject(projectA);
    await wait(1700);
    store.setActiveProject(projectB);
    await wait(1700);
    store.setActiveProject(projectA);
    await wait(1500);

    // 8. 다른 프로젝트가 답을 기다리면 사이드바에 종이 뜬다
    const otherPane = panesOf(projectB)[0];
    getEntry(otherPane)?.term.write("\x07");
    await wait(3600);
  }

  await logLine("tour done");
}
