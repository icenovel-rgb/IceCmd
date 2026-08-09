import ReactDOM from "react-dom/client";
import App from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

// No React.StrictMode: its development double-mount would spawn a second PTY
// for every pane and leave orphaned shells behind.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
