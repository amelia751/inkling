#!/usr/bin/env bash
# Move signed plugin artifacts between installations through an OCI registry (todo10 Phase 8).
# The kernel exports and imports OCI image layouts (GET /api/v1/plugins/<id>/export,
# POST /api/v1/plugins/import, both `plugins.approve`); ORAS moves them. `-r` copies the
# signature and attestation referrers too, so signatures travel with the artifacts.
#
#   tools/oras-plugins.sh export <id>@<version> <registry>/<repo>     kernel → registry (<repo>/<id>:<version>)
#   tools/oras-plugins.sh import <registry>/<repo>/<id>:<version> [tier]   registry → kernel (tier: generated|organisation|curated)
#   tools/oras-plugins.sh mirror <src-ref> <dst-ref>                  registry → registry, e.g. into a hospital's Harbor
#   tools/oras-plugins.sh save <src-ref> <dir>                        registry → OCI layout dir (carry it into the air gap)
#   tools/oras-plugins.sh load <dir> <tag> <dst-ref>                  OCI layout dir → registry inside the air gap
#   tools/oras-plugins.sh zot [port]                                  a local zot registry for development (docker)
#
# Kernel access: <prefix>API_URL (default http://127.0.0.1:8000), <prefix>API_TOKEN (a person's
# session token; in dev, header identities work without one), <prefix>WORKSPACE (X-Workspace-Id).
# <prefix> is schemas/naming.json's envPrefix. ORAS=/path/to/oras overrides the binary;
# ZOT_IMAGE the dev registry image (pin a digest in anything shared).
# Registry credentials are oras's own (`oras login`); nothing here stores them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["envPrefix"])' "$ROOT/schemas/naming.json")"
var() { local n="${PREFIX}$1"; printf '%s' "${!n:-${2:-}}"; }
API="$(var API_URL http://127.0.0.1:8000)"
TOKEN="$(var API_TOKEN)"
WORKSPACE="$(var WORKSPACE default)"
ORAS="${ORAS:-oras}"

die() { echo "oras-plugins: $*" >&2; exit 1; }
need_oras() { command -v "$ORAS" >/dev/null 2>&1 || die "oras not found (https://oras.land/docs/installation, or set ORAS=)"; }
curl_api() {
  local auth=()
  [ -n "$TOKEN" ] && auth=(-H "Authorization: Bearer $TOKEN")
  curl -sS --fail-with-body ${auth[@]+"${auth[@]}"} -H "X-Workspace-Id: $WORKSPACE" "$@"
}
tmpdir() { mktemp -d "${TMPDIR:-/tmp}/oras-plugins.XXXXXX"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  export)
    [ $# -eq 2 ] || die "usage: export <id>@<version> <registry>/<repo>"
    id="${1%@*}"; ver="${1##*@}"; repo="$2"
    [ "$id" != "$1" ] || die "name the version: <id>@<version>"
    need_oras
    d="$(tmpdir)"; trap 'rm -rf "$d"' EXIT
    curl_api -o "$d/layout.tar" "$API/api/v1/plugins/$id/export?version=$ver"
    mkdir "$d/layout" && tar -xf "$d/layout.tar" -C "$d/layout"
    "$ORAS" copy -r --from-oci-layout "$d/layout:$ver" "$repo/$id:$ver"
    echo "pushed $id@$ver → $repo/$id:$ver (with signature and attestation referrers)"
    ;;
  import)
    [ $# -ge 1 ] || die "usage: import <registry>/<repo>/<id>:<version> [tier]"
    ref="$1"; tier="${2:-generated}"; tag="${ref##*:}"
    need_oras
    d="$(tmpdir)"; trap 'rm -rf "$d"' EXIT
    "$ORAS" copy -r --to-oci-layout "$ref" "$d/layout:$tag"
    # COPYFILE_DISABLE: macOS tar would add AppleDouble (._*) entries, which aren't part of a layout.
    (cd "$d/layout" && COPYFILE_DISABLE=1 tar -cf "$d/layout.tar" oci-layout index.json blobs)
    curl_api -X POST -H "Content-Type: application/x-tar" --data-binary "@$d/layout.tar" "$API/api/v1/plugins/import?tier=$tier"
    echo
    ;;
  mirror)
    [ $# -eq 2 ] || die "usage: mirror <src-ref> <dst-ref>"
    need_oras
    "$ORAS" copy -r "$1" "$2"
    ;;
  save)
    [ $# -eq 2 ] || die "usage: save <src-ref> <dir>"
    need_oras
    "$ORAS" copy -r --to-oci-layout "$1" "$2:${1##*:}"
    ;;
  load)
    [ $# -eq 3 ] || die "usage: load <dir> <tag> <dst-ref>"
    need_oras
    "$ORAS" copy -r --from-oci-layout "$1:$2" "$3"
    ;;
  zot)
    port="${1:-5000}"
    exec docker run --rm -p "127.0.0.1:$port:5000" --name studio-zot "${ZOT_IMAGE:-ghcr.io/project-zot/zot:latest}"
    ;;
  *)
    sed -n '2,20p' "$0" >&2
    exit 2
    ;;
esac
