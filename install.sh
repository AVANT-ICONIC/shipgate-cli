#!/usr/bin/env sh
set -eu

repo="${SHIPGATE_REPO:-AVANT-ICONIC/shipgate-cli}"
version="${SHIPGATE_VERSION:-latest}"
scope="${SHIPGATE_SCOPE:-global}"

if [ "$version" = "latest" ]; then
  version="$(
    curl -fsSL "https://api.github.com/repos/${repo}/releases" |
      node -e "const fs=require('node:fs'); const releases=JSON.parse(fs.readFileSync(0,'utf8')); const release=releases.find((item)=>!item.draft); if (!release) process.exit(1); process.stdout.write(release.tag_name);"
  )"
fi

case "$version" in
  v*) tag="$version" ;;
  *) tag="v$version" ;;
esac

package_version="${tag#v}"
url="https://github.com/${repo}/releases/download/${tag}/shipgate-cli-${package_version}.tgz"

case "$scope" in
  global)
    set -- npm install -g "$url"
    ;;
  local)
    set -- npm install -D "$url"
    ;;
  *)
    echo "SHIPGATE_SCOPE must be global or local." >&2
    exit 2
    ;;
esac

echo "+ $*"
exec "$@"
