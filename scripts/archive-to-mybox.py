#!/usr/bin/env python3
"""
릴리스 산출물과 소스를 MYBOX 로 넘긴다 — NAS 백업으로 흘러 들어가는 유일한 입구.

    python scripts/archive-to-mybox.py            # 최신 릴리스
    python scripts/archive-to-mybox.py v0.6.1     # 특정 태그
    python scripts/archive-to-mybox.py --dry-run

왜 이 파일이 있나 (2026-08-14, 일감 #11):
  0.6.0·0.6.1 두 판이 **NAS 백업에 없었다.** 배포는 나갔는데(사이트 다운로드 카드는 0.6.1)
  산출물도 소스도 백업에 안 남았다. 원인은 동기화가 아니었다 —

    ★설치 파일은 **GitHub Actions 안에서** 만들어진다(`.github/workflows/release.yml`).
     이 기계에는 애초에 존재한 적이 없다. `src-tauri/target/.../nsis` 에는 손으로 빌드한
     0.1.0~0.5.0 만 있다. 그러니 MYBOX 로 옮길 것 자체가 없었다.
     그리고 소스는 `D:\\dev\\IceCmd` 에 있고, 백업 엔진이 보는 곳은 `D:\\Naver MYBOX` 다.
     릴리스 절차 어디에도 이 둘을 잇는 단계가 없었다.

  즉 (a) **MYBOX 원본에 애초에 안 올라갔다.** 동기화는 없는 파일을 가져올 수 없다.
  이 스크립트가 그 빠진 한 단계다. README「릴리스 내보내기」의 마지막 걸음으로 넣었다.

  ★MYBOX 로만 넣는다. NAS(`_source\\`)는 동기화 엔진 소유 구역이라 직접 쓰지 않는다.
   여기 넣어 두면 다음 동기화가 가져간다(규칙: `2. Works/Personal/IceCmd`).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import urllib.request

REPO = "icenovel-rgb/IceCmd"
MYBOX = r"D:\Naver MYBOX\2. Works\Personal\IceCmd"

# 소스 사본에서 뺄 것. 빌드 산출물·의존성은 백업할 이유가 없고, 넣으면 동기화가 수만 개를 끈다.
SKIP_DIRS = {"node_modules", "target", "dist", "dist-ssr", ".git", "__pycache__", ".venv"}

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def fetch_release(tag: str | None) -> dict:
    url = (f"https://api.github.com/repos/{REPO}/releases/latest" if not tag
           else f"https://api.github.com/repos/{REPO}/releases/tags/{tag}")
    req = urllib.request.Request(
        url, headers={"Accept": "application/vnd.github+json", "User-Agent": "IceCmd"}
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def pull_installers(release: dict, dest: str, dry: bool) -> list[str]:
    """버전이 붙은 설치 파일만 받는다.

    별칭(`IceCmd-Setup-x64.exe`)은 받지 않는다 — 판마다 같은 이름이라 백업에서
    **덮어써 버려** 어느 판인지 알 수 없게 된다. 사이트 카드가 별칭을 쓰는 것과는 목적이 다르다.
    """
    got = []
    for a in release.get("assets", []):
        name = a["name"]
        if not name.lower().endswith(".exe") or "_x64-setup" not in name.lower():
            continue
        out = os.path.join(dest, name)
        if os.path.isfile(out) and os.path.getsize(out) == a.get("size"):
            print(f"  = {name} (이미 있음)")
            got.append(out)
            continue
        print(f"  {'· (dry)' if dry else '↓'} {name}  {a.get('size', 0):,}B")
        if not dry:
            req = urllib.request.Request(
                a["browser_download_url"], headers={"User-Agent": "IceCmd"}
            )
            with urllib.request.urlopen(req, timeout=300) as r, open(out, "wb") as f:
                shutil.copyfileobj(r, f)
        got.append(out)
    return got


def mirror_source(repo_root: str, dest: str, dry: bool) -> int:
    """소스를 통째로 덮어쓴다. 지우지는 않는다 — 백업에서 사라지는 쪽이 더 위험하다."""
    n = 0
    for dp, dn, fn in os.walk(repo_root):
        dn[:] = [d for d in dn if d not in SKIP_DIRS]
        rel = os.path.relpath(dp, repo_root)
        outdir = dest if rel == "." else os.path.join(dest, rel)
        for f in fn:
            src, dst = os.path.join(dp, f), os.path.join(outdir, f)
            if (os.path.isfile(dst)
                    and os.path.getsize(dst) == os.path.getsize(src)
                    and abs(os.path.getmtime(dst) - os.path.getmtime(src)) < 2):
                continue
            n += 1
            if not dry:
                os.makedirs(outdir, exist_ok=True)
                shutil.copy2(src, dst)   # ★mtime 을 지킨다. 동기화가 mtime 으로 변경을 본다
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("tag", nargs="?", help="예: v0.6.1 (없으면 최신 릴리스)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if not os.path.isdir(MYBOX):
        sys.exit(f"MYBOX 폴더가 없습니다: {MYBOX} — 드라이브가 연결돼 있습니까?")

    rel = fetch_release(a.tag)
    tag = rel.get("tag_name") or "?"
    print(f"릴리스 {tag} ({REPO})")

    dest_rel = os.path.join(MYBOX, "release")
    dest_src = os.path.join(MYBOX, "source")
    if not a.dry_run:
        os.makedirs(dest_rel, exist_ok=True)
        os.makedirs(dest_src, exist_ok=True)

    print(f"설치 파일 → {dest_rel}")
    got = pull_installers(rel, dest_rel, a.dry_run)
    if not got:
        print("  ⚠️ .exe 자산이 없습니다 — CI 가 아직 빌드 중일 수 있습니다.")

    print(f"소스 → {dest_src}")
    n = mirror_source(repo_root, dest_src, a.dry_run)
    print(f"  {n}개 파일 {'복사 예정' if a.dry_run else '복사'}")

    print("\n다음 동기화가 MYBOX → NAS 로 옮긴다(규칙: 2. Works/Personal/IceCmd).")
    print("바로 확인하려면:")
    print('  powershell -ExecutionPolicy Bypass -File '
          '"%LOCALAPPDATA%\\nas-sync\\Sync-MyboxToNas.ps1" -FullScan -OnlyRule IceCmd')
    return 0


if __name__ == "__main__":
    sys.exit(main())
