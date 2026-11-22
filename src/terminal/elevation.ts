/**
 * 관리자 페인(아래 줄의 cmd·PowerShell 버튼).
 *
 * 윈도우는 이미 열린 터미널 칸 안에서 프로그램을 관리자로 올리지 못한다. UAC 가
 * 띄우는 건 보통 새 창이다. 윈도우 11 의 내장 sudo 를 "인라인"으로 켠 PC 에서만
 * 관리자 셸이 이 칸에 붙는다(`src-tauri/src/pty/elevation.rs`). 그 밖의 PC 에서는
 * 같은 셸을 일반 권한으로 열고, 셸이 첫 줄에 그 사실과 켜는 법을 말한다
 * (`spawn.rs` 의 NOT_ELEVATED — 앱이 화면에 직접 쓰면 ConPTY 재도색에 지워진다).
 */
import type { SessionKind } from "../types";

export const isAdminKind = (kind: SessionKind): boolean =>
  kind === "adminCmd" || kind === "adminPs";

/** 이름표 꼬리. 실제로 올라가 있는 동안에만 붙는다. */
export const ELEVATED_SUFFIX = " · 관리자";
