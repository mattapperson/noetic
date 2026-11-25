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

# Publishing this checkout when its sources or dependency versions have moved on
# would put different code under an existing tag. Build the tag itself instead,
# in a checkout of its own, with the dependencies it was tagged with.
# Bun may rewrite lockfile metadata during install; compare its committed form.
publish_dir="./$dir"
provenance=--provenance
if ! git diff --quiet "$tag" -- "$dir" ':(glob)packages/*/package.json' ||
  ! git diff --quiet "$tag" HEAD -- bun.lock; then
  echo "This checkout has moved on from $tag: rebuilding $name@$version from the tag."
  src="$tmp/src"
  git worktree add --detach --quiet "$src" "$tag"
  trap 'git worktree remove --force "$src" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
  (
    cd "$src"
    bun install
    # The package's own build runs in `prepublishOnly`; its workspace
    # dependencies are built here first, dependencies before their consumers.
    dependencies=$(
      node - "$dir" <<'NODE'
const fs = require('fs');
const manifests = new Map(
  fs.readdirSync('packages').flatMap((entry) => {
    const file = `packages/${entry}/package.json`;
    if (!fs.existsSync(file)) return [];
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    return [[manifest.name, { dir: `packages/${entry}`, dependencies: Object.keys(manifest.dependencies ?? {}) }]];
  }),
);
const ordered = [];
const visit = (name) => {
  const found = manifests.get(name);
  if (!found || ordered.includes(found.dir)) return;
  found.dependencies.forEach(visit);
  ordered.push(found.dir);
};
const target = [...manifests.values()].find((manifest) => manifest.dir === process.argv[2]);
target.dependencies.forEach(visit);
console.log(ordered.join('\n'));
NODE
    )
    for dependency in $dependencies; do
      bun run --cwd "$dependency" build
    done
    # As the release jobs do: npm chokes on sibling packages' `workspace:*` deps.
    node -e "const fs=require('fs');const p=require('./package.json');delete p.workspaces;fs.writeFileSync('./package.json',JSON.stringify(p,null,2)+'\n')"
  )
  publish_dir="$src/$dir"
  # Provenance would name this run's commit as the source of a tarball built from
  # the tag, so it is left off rather than made to say something untrue.
  provenance=--provenance=false
fi

# Name the tag: npm refuses to tag a version `latest` on its own when a higher
# version is already published, as a withdrawn major can leave behind. A
# prerelease (`1.2.3-next.4`) goes to its channel (`next`), never `latest`.
dist_tag=latest
if [[ $version == *-* ]]; then
  prerelease=${version#*-}
  dist_tag=${prerelease%%.*}
fi
npm publish "$publish_dir" --access public "$provenance" --workspaces=false --tag "$dist_tag" "$@"
