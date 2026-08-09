#!/usr/bin/env node
/**
 * 버전은 세 파일에 흩어져 있다. 손으로 고치면 반드시 하나를 빼먹으므로 여기서 한 번에 바꾼다.
 *
 *   node scripts/bump-version.mjs 0.2.0     세 파일을 0.2.0으로 맞춘다
 *   node scripts/bump-version.mjs --check v0.2.0
 *                                           태그와 세 파일이 일치하는지만 검사한다 (CI용)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
  {
    file: "package.json",
    read: (text) => JSON.parse(text).version,
    // 최상위 "version"만 바꾼다. 의존성 안의 버전 문자열은 건드리지 않는다.
    write: (text, next) => text.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`),
  },
  {
    file: "src-tauri/tauri.conf.json",
    read: (text) => JSON.parse(text).version,
    write: (text, next) => text.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`),
  },
  {
    file: "src-tauri/Cargo.toml",
    read: (text) => text.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
    // [package] 블록의 첫 version만. 의존성 줄은 `name = { version = ... }` 형태라 걸리지 않는다.
    write: (text, next) => text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${next}"`),
  },
];

const arg = process.argv[2];
if (!arg) {
  console.error("사용법: bump-version.mjs <새 버전> | --check <태그>");
  process.exit(2);
}

const checking = arg === "--check";
const requested = (checking ? process.argv[3] : arg) ?? "";
const version = requested.replace(/^v/, "");

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`버전 형식이 잘못됐다: ${requested} (예: 0.2.0)`);
  process.exit(2);
}

const found = targets.map((target) => {
  const path = join(root, target.file);
  const text = readFileSync(path, "utf8");
  return { ...target, path, text, current: target.read(text) };
});

if (checking) {
  const mismatched = found.filter((entry) => entry.current !== version);
  for (const entry of found) {
    console.log(`${entry.current === version ? "ok  " : "다름"} ${entry.file}: ${entry.current}`);
  }
  if (mismatched.length > 0) {
    console.error(`\n태그 ${requested} 와 어긋난다. scripts/bump-version.mjs ${version} 로 맞춰라.`);
    process.exit(1);
  }
  console.log(`\n태그 ${requested} 와 일치한다.`);
  process.exit(0);
}

for (const entry of found) {
  if (entry.current === version) {
    console.log(`그대로 ${entry.file}: ${version}`);
    continue;
  }
  writeFileSync(entry.path, entry.write(entry.text, version));
  console.log(`변경 ${entry.file}: ${entry.current} -> ${version}`);
}

console.log(`
다음 순서로 릴리스한다:
  git commit -am "chore: ${version}"
  git tag v${version}
  git push --follow-tags
태그가 올라가면 GitHub Actions가 설치 파일을 빌드해 릴리스에 붙인다.`);
