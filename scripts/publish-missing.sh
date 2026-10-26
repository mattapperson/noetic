#!/usr/bin/env bash
set -euo pipefail

dir=${1:?Usage: publish-missing.sh package-dir [npm-publish-options]}
shift
name=$(node -p 'require("./" + process.argv[1] + "/package.json").name' "$dir")
version=$(node -p 'require("./" + process.argv[1] + "/package.json").version' "$dir")
tag="${dir##*/}-v$version"

# semantic-release writes its tag before npm accepts the package. A retry
# must finish that publish before a dependent can pin the new version.
if ! git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if npm view "$name@$version" version --json >"$tmp/result" 2>"$tmp/error"; then
  echo "$name@$version is already on npm."
  exit 0
fi

if ! node -e 'const fs = require("fs"); const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(result.error?.code === "E404" ? 0 : 1)' "$tmp/result"; then
  cat "$tmp/result" "$tmp/error" >&2
  exit 1
fi

# Rebuilding with changed sources or dependency versions would publish
# different code under an existing tag.
# Bun may rewrite lockfile metadata during install; compare its committed form.
if ! git diff --quiet "$tag" -- "$dir" ':(glob)packages/*/package.json' ||
  ! git diff --quiet "$tag" HEAD -- bun.lock; then
  echo "Cannot publish $name@$version: check out $tag to rebuild its sources and dependencies." >&2
  exit 1
fi

# Name the tag: npm refuses to tag a version `latest` on its own when a higher
# version is already published, as a withdrawn major can leave behind.
npm publish "./$dir" --access public --provenance --workspaces=false --tag latest "$@"
