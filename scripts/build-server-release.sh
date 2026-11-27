#!/usr/bin/env bash
# Build release assets from a verified Git commit, never from working-tree files.
# Usage: bash scripts/build-server-release.sh hub-vX.Y.Z <commit-sha> <out-dir>
set -euo pipefail
export LC_ALL=C TZ=UTC

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
[[ $# == 3 ]] || fail 'usage: build-server-release.sh hub-vX.Y.Z <commit-sha> <out-dir>'
tag=$1
commit=$2
out_dir=$3
[[ $tag =~ ^hub-v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$ ]] || fail 'expected a stable hub-vX.Y.Z tag'
[[ $commit =~ ^[0-9a-f]{40}$ ]] || fail 'expected a full lowercase commit SHA'
[[ $(git cat-file -t "$commit") == commit ]] || fail 'SHA must identify a Git commit'

mkdir -p -- "$out_dir"
out_dir=$(cd -- "$out_dir" && pwd -P)
tmp=$(mktemp -d "${out_dir%/}/.dsh-hub-build.XXXXXXXX")
[[ $tmp == "${out_dir%/}"/.dsh-hub-build.* && -d $tmp ]] || fail 'unexpected staging directory'
trap 'rm -rf -- "$tmp"' EXIT
stage=$tmp/stage
mkdir -p -- "$stage/apps/server/src"

# Match the updater's limits and allowlist. Git tree modes distinguish regular
# blobs from symlinks/submodules before anything is copied into the tar stage.
copy_blob() {
  local entry=$1 path=$2 oid size
  case "$entry" in
    '100644 blob '*|'100755 blob '*) oid=${entry##* } ;;
    *) fail "$path is not a regular file at $commit" ;;
  esac
  size=$(git cat-file -s "$oid")
  (( size > 0 && size <= 4 * 1024 * 1024 )) || fail "$path must be nonempty and at most 4 MiB"
  git cat-file blob "$oid" > "$stage/$path"
  chmod 0644 "$stage/$path"
}

package=apps/server/package.json
copy_blob "$(git ls-tree "$commit" -- "$package" | cut -f1)" "$package"
printf '{"version":1,"tag":"%s","commit":"%s"}\n' "$tag" "$commit" > "$stage/manifest.json"
chmod 0644 "$stage/manifest.json"
members=(manifest.json "$package")
git ls-tree -z "$commit:apps/server/src" > "$tmp/tree"
while IFS= read -r -d '' entry; do
  name=${entry#*$'\t'}
  [[ $name == *.js ]] || continue
  [[ $name =~ ^[A-Za-z0-9._-]+\.js$ ]] || fail 'invalid server source filename'
  path=apps/server/src/$name
  copy_blob "${entry%%$'\t'*}" "$path"
  members+=("$path")
done < "$tmp/tree"
[[ -f $stage/apps/server/src/index.js ]] || fail 'missing apps/server/src/index.js'
(( ${#members[@]} <= 256 )) || fail 'archive exceeds 256 members'

# Explicit paths keep even directory headers out of the archive. USTAR avoids
# PAX/GNU metadata records; COPYFILE_DISABLE disables macOS AppleDouble entries.
archive=dsh-hub-$tag.tar.gz
checksum=dsh-hub-$tag.sha256
COPYFILE_DISABLE=1 tar --format=ustar -cf "$tmp/release.tar" -C "$stage" -- "${members[@]}"
(( $(wc -c < "$tmp/release.tar") <= 32 * 1024 * 1024 )) || fail 'tar exceeds 32 MiB'
gzip -n -c "$tmp/release.tar" > "$tmp/$archive"
(( $(wc -c < "$tmp/$archive") <= 8 * 1024 * 1024 )) || fail 'gzip exceeds 8 MiB'
(
  cd -- "$tmp"
  if command -v sha256sum >/dev/null; then
    sha256sum "$archive"
  else
    shasum -a 256 "$archive"
  fi > "$checksum"
)

# Assets are only placed in the output directory after both are complete.
mv -- "$tmp/$archive" "$out_dir/$archive"
mv -- "$tmp/$checksum" "$out_dir/$checksum"
printf '%s\n' "$out_dir/$archive" "$out_dir/$checksum"
