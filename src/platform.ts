/**
 * 지금 돌고 있는 운영체제.
 *
 * 러스트 쪽은 `#[cfg]`로 컴파일 때 갈리지만 프론트는 한 벌로 빌드되어 두 곳에서
 * 다 돌므로, 실행 중에 물어봐야 하는 것이 몇 가지 있다 — 설치 파일 자산 고르기,
 * 터미널의 줄바꿈 처리 같은 것들.
 *
 * `@tauri-apps/plugin-os`를 넣으면 정확하게 알 수 있지만, 이 한 줄을 위해 플러그인과
 * 권한 설정을 늘리지 않는다. WebView2는 UA에 "Windows NT"를, WKWebView는
 * "Macintosh"를 반드시 넣으므로 이것으로 충분하다. `navigator.userAgentData`는
 * 크로미움에만 있어 WKWebView에서 undefined다.
 */
const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;

export const isMac = /Mac(intosh| OS X)/i.test(ua);
export const isWindows = /Windows/i.test(ua);

/**
 * 경로 구분자. 폴더 트리는 부모 경로에 이름을 이어 붙여 자식 경로를 만드는데,
 * 여기에 `\` 를 박아 두면 맥에서는 있지도 않은 경로가 되어 **트리가 한 칸도
 * 펼쳐지지 않는다.** 백엔드는 이름만 돌려주므로 잇는 일은 이쪽 몫이다.
 */
export const pathSep = isWindows ? "\\" : "/";

/**
 * 앱 단축키의 수정자.
 *
 * 맥에서 Ctrl 은 **셸의 것이다** — Ctrl+C 는 인터럽트고, Ctrl+A·Ctrl+E 는 줄 편집이다.
 * 그래서 앱이 가로채는 것은 ⌘ 이고, 윈도우에서는 그대로 Ctrl 이다.
 */
export const hasMod = (event: KeyboardEvent): boolean =>
  isMac ? event.metaKey : event.ctrlKey;

/** 반대쪽 수정자. 눌려 있으면 우리 단축키가 아니다(⌘+Ctrl+C 같은 조합). */
export const hasOtherMod = (event: KeyboardEvent): boolean =>
  isMac ? event.ctrlKey : event.metaKey;

/** 화면에 적는 그 수정자의 이름. */
export const modLabel = isMac ? "⌘" : "Ctrl";

/** 복사·붙여넣기만 규칙이 다르다: 맥은 ⌘C/⌘V, 윈도우는 Ctrl+C 가 셸의 것이라 Shift 를 낀다. */
export const copyPasteLabel = isMac ? "⌘C / ⌘V" : "Ctrl+Shift+C / V";

/** OS 가 폴더를 보여주는 프로그램의 이름 — 메뉴에 그대로 적힌다. */
export const fileManagerName = isMac ? "Finder" : "탐색기";
