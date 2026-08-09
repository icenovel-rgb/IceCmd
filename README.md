# IceCmd

가벼운 터미널 프로젝트 매니저. 폴더를 끌어다 놓으면 프로젝트가 되고, 그 폴더에서 cmd·claude·codex를
바로 띄워 화면을 자유롭게 분할해 쓴다. Windows 우선, macOS는 이후.

**다운로드**: [최신 Windows 설치 파일](https://github.com/icenovel-rgb/IceCmd/releases/latest/download/IceCmd-Setup-x64.exe)
· [모든 릴리스](https://github.com/icenovel-rgb/IceCmd/releases)

실측 (릴리스 빌드, 셸 5개 열어둔 유휴 상태): 상주 메모리 private working set 약 **125MB**,
CPU **0.0%**, 설치 파일 **1.7MB**.

## 왜 이 구조인가

| 항목 | 선택 | 이유 |
|---|---|---|
| 앱 셸 | Tauri 2 | 시스템 WebView2를 쓰므로 상주 메모리가 Electron의 1/3 이하 |
| 터미널 | @xterm/xterm + WebGL 렌더러 | 글리프 그리기를 GPU로 넘겨 CPU 사용을 최소화 |
| PTY | portable-pty (ConPTY / openpty) | Windows와 macOS를 한 API로 |
| 출력 전송 | Tauri IPC Channel(raw) + 배칭 | Channel 메시지마다 `eval` 비용이 있어 개수를 줄이는 게 관건 |
| 분할 레이아웃 | 자체 이진 트리 | 네이티브 파일 드롭이 HTML5 DnD를 가려서, DnD 기반 레이아웃 라이브러리는 쓸 수 없다 |
| 상태 표시 | xterm 파서 재활용 | BEL·출력시각을 이미 파싱하는 경로에서 얻으므로 감시 비용이 사실상 없다 |

## 개발

```bash
npm install
npm run tauri dev          # 개발 실행
npm run tauri build        # 배포 빌드 (NSIS 설치 파일)
npx tsc --noEmit           # 프론트엔드 타입 검사
cd src-tauri && cargo check # 백엔드 검사
```

### 릴리스 내보내기

버전은 `package.json`·`src-tauri/tauri.conf.json`·`src-tauri/Cargo.toml` 세 곳에 있다.
손으로 고치면 하나를 빼먹으므로 스크립트로 한 번에 바꾼다.

```bash
node scripts/bump-version.mjs 0.2.0
git commit -am "chore: 0.2.0"
git tag v0.2.0
git push --follow-tags
```

태그가 올라가면 `.github/workflows/release.yml`이 Windows 설치 파일을 빌드해 그 태그의 릴리스에
붙인다. 워크플로는 빌드 전에 `bump-version.mjs --check <태그>`로 **태그와 소스 버전이 일치하는지
확인**하고, 어긋나면 릴리스를 만들지 않는다.

이어서 배포 페이지(icenovel.com)의 다운로드 카드를 갱신한다.

```bash
python scripts/make-latest-json.py --write     # GitHub 릴리스에서 뽑아 사이트 소스에 기록
cd "D:/Naver MYBOX/11. Business/icenovel.com/web/.deploy"
python deploy.py plan
python deploy.py push --approved-by "<실제 지시>"
```

카드가 가리키는 주소는 **태그 고정 URL**이다(`releases/download/v0.1.0/...`).
`releases/latest/...` 를 쓰면 카드에 적힌 버전·크기와 실제로 내려가는 파일이 어긋날 수 있다 —
카드가 0.1.0이라고 적어두고 0.3.0을 내려주는 상황을 막기 위해 고정 URL을 쓴다.
그래서 릴리스를 낼 때마다 위 두 단계를 같이 밟는다.

버전 무관 사본(`IceCmd-Setup-x64.exe`)도 함께 올라가므로, 버전 표기가 필요 없는 곳
(README 배지, 블로그 링크 등)에서는 아래 주소를 쓸 수 있다.

```
https://github.com/icenovel-rgb/IceCmd/releases/latest/download/IceCmd-Setup-x64.exe
```

### 창을 보지 않고 검증하기

```bash
VITE_ICECMD_HARNESS=1 npm run tauri dev
```

`src/devHarness.ts`가 실제 저장소·PTY·xterm 버퍼를 조작해 35개 항목을 확인하고 결과를 콘솔에
`harness PASS/FAIL ...`로 출력한다. 끝나면 자신이 만든 프로젝트를 지우므로 저장된 상태는 그대로다.

모드는 환경변수 값으로 고른다:

| 값 | 하는 일 |
|---|---|
| `1` | 전체 스위트 |
| `persist1` → 재시작 → `persist2` | 저장/복원을 두 번의 실행으로 확인 |
| `demo`, `demo-support` | 스크린샷용 상태를 만들고 요소 좌표를 찍는다 |

**레이아웃 검사는 화면 내용이 아니라 셸 프로세스를 본다.** ConPTY는 리사이즈마다 화면을
재도색하고 그 과정에서 한 줄쯤 잃기도 해서, 글자가 사라진 게 재시작 탓인지 재도색 탓인지
구분되지 않는다. 그래서 셸에 `set ICEVAR=<토큰>`을 심어두고 나중에 `echo %ICEVAR%`로 되묻는다 —
같은 프로세스만 답할 수 있다.

## 조작

| 조작 | 동작 |
|---|---|
| 폴더를 사이드바로 끌어다 놓기 | 프로젝트 추가 + 그 폴더에서 cmd 자동 실행 |
| 파일·폴더를 터미널로 끌어다 놓기 | 그 경로를 커서 자리에 입력 (공백이 있으면 따옴표로 감싼다) |
| 프로젝트 우클릭 | 탐색기에서 열기 · 프로젝트 제거 (셸도 함께 종료) |
| 폴더 트리에서 파일 우클릭 | 열기 · 폴더에서 보기 |
| 폴더 트리에서 폴더 우클릭 | 탐색기에서 열기 · 여기서 cmd 열기 |
| 터미널 우클릭 | 복사(선택이 있을 때) · 붙여넣기 |
| 페인 툴바의 `⠿`를 끌어 다른 페인 가장자리에 놓기 | 페인 재배치 — 좌우 분할을 상하로 바꾸는 방법 |
| 디바이더 드래그 / 더블클릭 | 비율 조정 / 좌우↔상하 방향 전환 |
| 좌·우 패널 경계 드래그 / 더블클릭 | 패널 너비 조정 / 기본값 복귀 |
| Ctrl + `+` / `-` / `0`, Ctrl+휠 | 터미널 글자 확대 / 축소 / 기본값 (9–24px) |
| 오른쪽 패널 하단 슬라이더 | 화면 배율(80–160%)과 터미널 글자 크기를 각각 조정 |
| Ctrl+Shift+D / E | 활성 페인을 좌우 / 위아래로 분할 |
| Ctrl+Shift+W | 활성 페인 닫기 |
| Ctrl+Shift+C / V | 복사 / 붙여넣기 |

페인 배치·패널 너비·화면 배율·글자 크기는 모두 저장되어 다음 실행에 복원된다.

**화면 배율과 터미널 글자 크기는 별개다.** 터미널 글자는 출력이 몇 줄 들어가는지를 정하고,
화면 배율은 사이드바·버튼·트리가 얼마나 읽히는지를 정한다. 둘을 곱해 버리면 예측이 안 되므로
배율(`zoom`)은 크롬에만 적용하고 터미널에는 걸지 않는다.

오른쪽 패널 하단의 **☕ 후원하기**는 다른 ICE 앱과 같은 Buy Me a Coffee 링크를 연다
(QR + 버튼). 링크 열기는 Rust의 `open_external`이 처리하며 **http(s)만 허용**한다.

## 디자인

ICE 계열 공통 다크 톤(ICEPDF 계승)을 그대로 쓴다. `styles.css`의 `:root` 토큰이 ICECrawler·
ICEFiction과 같은 회색 계단을 공유하고, 액센트만 이 앱 아이콘의 크리스탈 청록(`#24a6a9` /
`#92d6dd`)으로 바꿨다. 두 가지는 의도적으로 ICE 관례를 따랐다:

- **섹션 제목을 11px 대문자 라벨로 두지 않는다.** 목록 줄과 굵기가 비슷해져 계층이 뭉개진다.
- **목록 행에 라운드를 주지 않는다.** 라운드 모서리에 왼쪽 강조선을 넣으면 모서리를 따라 휘어
  괄호처럼 보인다. 각진 행 + 곧은 세로 바로 둔다.

한 가지는 의도적으로 벗어났다: 터미널 폰트에 **D2Coding**을 앞세운다. 취향이 아니라 기능이다 —
한글 글자폭이 라틴 문자의 정확히 2배라서 xterm의 셀 계산과 어긋나지 않는다.

## 구조

```
src/
  layout/      분할 트리(순수 함수) · 좌표 계산 · 평면 렌더러 · 디바이더 · 페인 프레임
  terminal/    IPC 래퍼 · xterm 레지스트리 · 페인 · 상태 판정
  sidebar/     프로젝트 목록 · 네이티브 폴더 드롭 · 상태 표시
  rightpanel/  폴더 트리 · CLI 버튼 · 크기 조절 · 후원 모달
  chrome/      패널 너비 조정 핸들
  store/       workspace(단일 진실) · 영속화
src-tauri/src/
  pty/         세션 스폰 · 리더/배처 스레드 · 역압
  commands.rs  webview ↔ 세션 레지스트리 어댑터
  fs_tree.rs   한 단계 디렉터리 읽기 (감시 없음)
  persist.rs   state.json 읽기/쓰기
```

## 알아둘 것

- **ConPTY 핸드셰이크**: 세션이 열리면 ConPTY가 커서 위치를 물어보고(`ESC[6n`) 답이 올 때까지
  아무 출력도 내지 않는다. 그래서 `TerminalPane`은 세션을 만들기 **전에** 입력 경로를 연결한다.
- **한글**: ConPTY가 UTF-16↔UTF-8을 변환하므로 코드페이지가 949여도 한글은 정상 왕복한다.
  그래도 UTF-8 바이트를 직접 쓰는 도구를 위해 `chcp 65001`로 시작한다.
  터미널 폰트는 한글 폭이 정확히 2칸인 D2Coding을 우선한다.
- **프로세스 정리**: 세션 종료는 자식 kill과 함께 pseudoconsole을 닫는다. ConPTY를 닫는 쪽이
  같은 콘솔에 붙은 손자 프로세스까지 확실히 정리한다.
- **PTY 수명**: 세션은 `TerminalPane`의 마운트/언마운트에 묶여 있다. 트리에서 페인을 빼거나
  프로젝트를 지우면 그것만으로 셸이 종료된다.
- **페인을 DOM에 중첩하지 마라 (가장 중요한 제약)**: 분할 트리를 그대로 재귀 렌더링하면
  트리 모양이 바뀔 때 React가 살아남은 형제까지 언마운트·재마운트한다. 위의 PTY 수명 규칙과
  맞물려 **옆 페인의 셸이 조용히 죽고 재시작된다** — Claude Code를 띄운 페인이라면 그게 죽는다.
  그래서 `layout/geometry.ts`가 트리에서 좌표만 계산하고, 페인은 절대위치 형제로 평평하게
  렌더링한다. 배치 변경은 style만 바꾼다. `key`로는 막을 수 없다(부모 체인이 달라지므로).
- **리소스 실측** (릴리스 빌드, 셸 5개, 유휴): private working set 합계 약 125MB
  (백엔드 5.8MB + WebView2 101MB + 셸 18MB), CPU 0.0%. 설치 파일 1.6MB, 실행 파일 5.9MB.
  Working Set으로 보면 550MB가 넘게 나오지만 그건 WebView2 런타임의 공유 페이지를
  프로세스마다 중복 계산한 값이다.
- **우클릭 메뉴는 한 컴포넌트만 쓴다** (`chrome/ContextMenu.tsx`): 메뉴를 닫는 리스너가
  자기 자신 위에서 시작된 press를 걸러내지 않으면, 누르는 순간 버튼이 언마운트되어
  `click`이 영원히 발생하지 않는다. 0.1.0~0.3.0 사이 사이드바 메뉴 항목이 전부 이 이유로
  죽어 있었다. 새 메뉴를 손으로 만들면 그 버그가 그대로 복제된다.

## 라이선스

MIT. [LICENSE](LICENSE) 참조.
