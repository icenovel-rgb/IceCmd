#!/usr/bin/env bash
#
# 맥 배포본을 서명하고 공증해서 dmg 하나로 뽑는다.
#
#   scripts/mac-release.sh              유니버설(인텔+애플실리콘) 서명+공증
#   scripts/mac-release.sh --no-notarize  서명만 (공증 자격증명 없이 확인용)
#   scripts/mac-release.sh --host         호스트 아키텍처만 (빌드가 절반으로 짧다)
#
# 자격증명은 저장소에 두지 않는다. scripts/../.env.mac 이 있으면 읽고, 없으면
# 이미 환경에 있는 값을 쓴다. .env.mac.example 을 복사해서 채우면 된다.
#
# 서명만 하고 공증을 건너뛰면 이 맥에서는 열리지만 남에게 준 dmg 는 열리지
# 않는다. 다운로드에 붙는 quarantine 을 떼 주는 것이 공증이기 때문이다.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

notarize=1
target=universal-apple-darwin
for arg in "$@"; do
  case "$arg" in
    --no-notarize) notarize=0 ;;
    --host) target="" ;;
    *) echo "모르는 인자: $arg" >&2; exit 2 ;;
  esac
done

# shellcheck disable=SC1091
[[ -f .env.mac ]] && set -a && source .env.mac && set +a

# 서명 자격증명. APPLE_SIGNING_IDENTITY 는 tauri 가 직접 읽어 간다.
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "APPLE_SIGNING_IDENTITY 가 없다. .env.mac 을 만들거나 환경에 넣어라." >&2
  echo "쓸 수 있는 인증서:" >&2
  security find-identity -v -p codesigning >&2
  exit 1
fi

# 그 이름의 인증서가 실제로 키체인에 있는지 먼저 본다. 없으면 tauri 는 90초를
# 컴파일한 뒤 마지막 서명 단계에서 죽는다.
if ! security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY"; then
  echo "키체인에 '$APPLE_SIGNING_IDENTITY' 인증서가 없다." >&2
  security find-identity -v -p codesigning >&2
  exit 1
fi

# 공증 자격증명은 두 가지 중 하나면 된다. App Store Connect API 키 쪽이
# 만료가 없어 CI 에 맞고, Apple ID + 앱 암호 쪽이 손으로 쓰기 쉽다.
if (( notarize )); then
  if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
    :
  elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    :
  else
    echo "공증 자격증명이 없다. 둘 중 한 벌을 채워라:" >&2
    echo "  APPLE_API_KEY / APPLE_API_ISSUER / APPLE_API_KEY_PATH" >&2
    echo "  APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID" >&2
    echo "서명만 확인하려면 --no-notarize 를 붙여라." >&2
    exit 1
  fi
else
  # 있는 값을 지워야 tauri 가 공증을 건너뛴다.
  unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
fi

args=()
[[ -n "$target" ]] && args+=(--target "$target")

echo "서명: $APPLE_SIGNING_IDENTITY"
echo "공증: $(( notarize )) / 타깃: ${target:-호스트}"
# 맥 기본 bash 는 3.2 라 빈 배열을 "${args[@]}" 로 펴면 set -u 가 문다.
npm run tauri build -- ${args[@]+"${args[@]}"}

# 번들 경로는 --target 을 줬는지에 따라 한 단계 달라진다.
bundle="src-tauri/target/${target:+$target/}release/bundle"
app=$(ls -d "$bundle"/macos/*.app | head -1)
dmg=$(ls "$bundle"/dmg/*.dmg | head -1)

# tauri 는 .app 만 공증하고 dmg 는 서명만 하고 끝낸다. 그런데 사람이 실제로
# 내려받아 여는 것은 dmg 이고, 티켓 없는 dmg 는 열리는 순간 Gatekeeper 가
# 막는다 — 안에 든 앱이 공증돼 있어도 소용없다. dmg 는 제 몫의 cdhash 로
# 따로 심사받아야 하므로 여기서 한 번 더 올린다.
if (( notarize )); then
  echo
  echo "=== dmg 공증 ==="
  if [[ -n "${APPLE_API_KEY:-}" ]]; then
    xcrun notarytool submit "$dmg" \
      --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
  else
    xcrun notarytool submit "$dmg" \
      --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  fi
  xcrun stapler staple "$dmg"
fi

echo
echo "=== 서명 확인 ==="
codesign --verify --deep --strict --verbose=2 "$app"
echo "=== Gatekeeper 판정 (앱) ==="
# 공증까지 끝났으면 "accepted ... source=Notarized Developer ID" 가 나온다.
spctl -a -vvv -t install "$app" || true
if (( notarize )); then
  echo "=== staple 확인 ==="
  xcrun stapler validate "$app"
  xcrun stapler validate "$dmg"
  # 받는 사람이 dmg 를 더블클릭했을 때 그대로의 판정. 여기가 accepted 여야
  # 경고 없이 열린다.
  echo "=== Gatekeeper 판정 (dmg) ==="
  spctl -a -vvv -t open --context context:primary-signature "$dmg"
fi

echo
echo "완성:"
echo "  $app"
echo "  $dmg"
