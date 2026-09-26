import ReactDOM from "react-dom/client";
import App from "./App";
import { loadShellName } from "./shell";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

// 페인 이름표와 폴더 메뉴가 셸 이름을 적는다. 한 번 물어보는 데 드는 시간이
// 첫 그림보다 훨씬 짧으므로, 이름이 바뀌며 깜빡이게 두지 않고 받고 나서 그린다.
// 실패해도 기본값으로 그대로 그린다.
void loadShellName().finally(() => {
  // No React.StrictMode: its development double-mount would spawn a second PTY
  // for every pane and leave orphaned shells behind.
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
});
