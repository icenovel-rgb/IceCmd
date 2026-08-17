/**
 * 새 버전 확인.
 *
 * 정본은 사이트의 `download/icecmd/latest.json`이다 — 릴리스를 낼 때
 * `scripts/make-latest-json.py`가 GitHub 릴리스에서 뽑아 갱신하는 그 파일이고,
 * 다운로드 카드도 같은 것을 읽는다. 사이트가 최신이면 카드에 적힌 버전과 앱이
 * 알려주는 버전이 어긋날 수 없다.
 *
 * 그 파일을 못 읽어도, **읽히지만 뒤처져 있어도** GitHub 릴리스 API로 떨어진다.
 * 0.6.3 이 그래서 아무에게도 뜨지 않았다 — 릴리스는 나갔는데 사이트 갱신을 잊었고,
 * 읽히는 `0.6.2` 를 최종 답으로 삼은 코드가 GitHub 을 아예 보지 않았다. 사이트를
 * 잊는 것은 사람의 실수이고, 그 실수로 업데이트가 조용히 멈추는 것보다
 * 사실(릴리스)을 한 번 더 확인하는 쪽이 낫다.
 *
 * 대가는 둘이다. 최신일 때는 두 곳을 다 보므로 앱을 켤 때 요청이 하나 늘고,
 * 사이트를 잊은 동안에는 앱이 카드보다 새 버전을 안내한다. 다만 그때 받는 링크는
 * GitHub 자산이라 사용자는 제대로 된 설치 파일을 받는다.
 *
 * 확인은 앱을 켤 때 한 번만 한다. 실패하면 조용히 넘어간다 — 오프라인인 사람에게
 * 경고를 띄울 이유가 없다.
 */
const SITE_URL = "https://icenovel.com/download/icecmd/latest.json";
const GITHUB_URL = "https://api.github.com/repos/icenovel-rgb/IceCmd/releases/latest";
export const RELEASES_PAGE = "https://github.com/icenovel-rgb/IceCmd/releases/latest";
const TIMEOUT_MS = 6000;

export const currentVersion = __APP_VERSION__;

export interface UpdateInfo {
  version: string;
  /** Where the installer actually is. */
  downloadUrl: string;
  notes: string;
}

/**
 * Compares dotted numeric versions. A string compare would rank "0.10.0" below
 * "0.9.0", which is the classic way an update quietly never appears.
 */
export function isNewer(candidate: string, base: string): boolean {
  const parse = (value: string) =>
    value
      .trim()
      .replace(/^v/, "")
      .split(/[.\-+]/)
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part));

  const a = parse(candidate);
  const b = parse(base);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`http ${response.status}`);
    return await response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

function fromSite(payload: unknown): UpdateInfo | null {
  const win = (payload as { win?: Record<string, unknown> } | null)?.win;
  if (!win || typeof win.version !== "string") return null;
  return {
    version: win.version,
    downloadUrl: typeof win.url === "string" ? win.url : RELEASES_PAGE,
    notes: typeof win.notes === "string" ? win.notes : "",
  };
}

function fromGithub(payload: unknown): UpdateInfo | null {
  const release = payload as
    | { tag_name?: string; body?: string; assets?: { name?: string; browser_download_url?: string }[] }
    | null;
  const tag = release?.tag_name;
  if (typeof tag !== "string") return null;

  const exe = release?.assets?.find((asset) => asset.name?.toLowerCase().endsWith(".exe"));
  const firstLine = (release?.body ?? "")
    .split("\n")
    .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
    .find((line) => line.length > 1 && !/^(full changelog|what's changed|http)/i.test(line));

  return {
    version: tag.replace(/^v/, ""),
    downloadUrl: exe?.browser_download_url ?? RELEASES_PAGE,
    notes: firstLine ?? "",
  };
}

/** Returns the newer release, or null when up to date or unreachable. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const sources: [string, (payload: unknown) => UpdateInfo | null][] = [
    [SITE_URL, fromSite],
    [GITHUB_URL, fromGithub],
  ];

  for (const [url, parse] of sources) {
    try {
      const info = parse(await getJson(url));
      if (info && isNewer(info.version, currentVersion)) return info;
      // 읽혔다는 것만으로 끝내지 않는다 — 뒤처진 사이트가 GitHub 을 가리면
      // 업데이트가 조용히 멈춘다. 그것이 0.6.3 에서 일어난 일이다.
    } catch {
      // Try the next source; being offline is not an error worth surfacing.
    }
  }
  return null;
}
