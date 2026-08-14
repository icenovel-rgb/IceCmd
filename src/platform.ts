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
