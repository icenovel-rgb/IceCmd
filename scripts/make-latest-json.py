#!/usr/bin/env python3
"""
icenovel.com 서비스 페이지의 다운로드 카드용 latest.json 생성 — GitHub 릴리스에서 뽑는다.

사이트는 이 파일 하나만 보고 버전·크기·날짜·설명을 표시한다. 릴리스를 낸 뒤 이걸 돌려
사이트 소스를 갱신하고 배포하면 다운로드 카드가 최신이 된다.

    python scripts/make-latest-json.py                 # 표준출력으로 확인
    python scripts/make-latest-json.py --write         # 기본 위치에 저장
    python scripts/make-latest-json.py --write <경로>   # 다른 경로에 저장

저장 후:
    cd "D:/Naver MYBOX/11. Business/icenovel.com/web/.deploy"
    python deploy.py plan
    python deploy.py push --approved-by "<실제 지시>"

다운로드 URL은 버전이 붙지 않은 별칭(IceCmd-Setup-x64.exe, IceCmd-universal.dmg)을 우선한다.
그래야 사용자가 페이지를 캐시해 두었더라도 항상 최신 설치 파일을 받는다. 별칭이 없으면 버전이
붙은 자산으로 떨어진다.

윈도와 맥 두 칸을 모두 채운다. 릴리스 워크플로의 두 잡이 따로 끝나므로, 한쪽 자산이 아직
없으면 만들지 않고 죽는다 — 반쪽짜리 latest.json 을 배포하는 것보다 낫다.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request

API = "https://api.github.com/repos/icenovel-rgb/IceCmd/releases/latest"
DEFAULT_WRITE = (
    "D:/Naver MYBOX/11. Business/icenovel.com/web/public/download/icecmd/latest.json"
)
# 플랫폼마다 어떤 자산이 그 플랫폼의 설치 파일인지와, 버전이 붙지 않은 별칭 이름.
PLATFORMS = {
    "win": (".exe", "icecmd-setup-x64.exe"),
    "mac": (".dmg", "icecmd-universal.dmg"),
}


def fetch_release() -> dict:
    request = urllib.request.Request(
        API, headers={"Accept": "application/vnd.github+json", "User-Agent": "IceCmd"}
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def first_line(body: str) -> str:
    """
    릴리스 노트에서 사람이 읽을 한 줄만 — 마크다운 표시는 걷어낸다.

    --generate-notes 로 만든 릴리스는 본문이 "Full Changelog: <링크>" 뿐이라
    그대로 카드에 띄우면 사용자에게 아무 뜻이 없다. 그런 줄은 건너뛴다.
    """
    for raw in (body or "").splitlines():
        line = raw.lstrip("#>*- ").replace("**", "").strip()
        if len(line) <= 1 or line.startswith(("|", "---")):
            continue
        if line.lower().startswith(("full changelog", "what's changed", "http")):
            continue
        return line[:200]
    return ""


def build(release: dict) -> dict:
    version = (release.get("tag_name") or "").lstrip("v")
    if not version:
        raise SystemExit("release tag not found")
    date = (release.get("published_at") or "")[:10]
    notes = first_line(release.get("body") or "")

    assets = release.get("assets", [])
    result = {}
    for key, (suffix, alias) in PLATFORMS.items():
        matches = [a for a in assets if a["name"].lower().endswith(suffix)]
        if not matches:
            # 두 잡이 따로 끝나므로 한쪽만 올라온 순간이 실제로 있다. 그때
            # 만든 파일을 배포하면 한 플랫폼의 다운로드가 조용히 사라진다.
            raise SystemExit(f"v{version}: no {suffix} asset yet (CI may still be building)")
        # 버전 없는 별칭이 있으면 그것을 쓴다.
        chosen = next((a for a in matches if a["name"].lower() == alias), matches[0])
        result[key] = {
            "version": version,
            "url": chosen["browser_download_url"],
            "size_bytes": chosen["size"],
            "date": date,
            "notes": notes,
        }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--write",
        nargs="?",
        const=DEFAULT_WRITE,
        metavar="PATH",
        help=f"저장 경로 (생략 시 {DEFAULT_WRITE})",
    )
    args = parser.parse_args()

    data = build(fetch_release())
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"

    if not args.write:
        # 윈도 기본 stdout은 cp949다. 그대로 내보내면 파이프로 파일에 담을 때
        # 한글이 깨진 채 저장된다.
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass
        sys.stdout.write(text)
        return

    with open(args.write, "w", encoding="utf-8") as handle:
        handle.write(text)
    # 윈도 콘솔은 cp949라 한글을 찍으면 깨진다. 알림은 ASCII로만.
    sizes = ", ".join(f"{key} {data[key]['size_bytes']} bytes" for key in data)
    print(f"saved: {args.write} (v{data['win']['version']}, {sizes})")


if __name__ == "__main__":
    main()
