#!/usr/bin/env bash
# Rolls one commit out to the Cloud Run stage (.github/workflows/deploy.yml).
#
# Every app whose image exists at sha-<commit> moves to it; the others keep their revision. Order:
# migrate jobs (api, versioning, pipeline), backends, agent, web, then a smoke test through the
# Studio host. Cloud Run only sends traffic to a revision whose startup probe passes; if a
# rollout or the smoke test fails, every service moved here goes back to its previous revision.
# Migrations are not undone, so they must work with the previous revision too.
#
# Env: SHA, PHI_REGISTRY, AI_REGISTRY (us-central1-docker.pkg.dev/<project>/images),
# PHI_CREDENTIALS, AI_CREDENTIALS (credential files from google-github-actions/auth),
# STUDIO_URL (https://<studio host>; empty skips the checks through the load balancer),
# AGENT_URL (the agent's run.app URL).
set -euo pipefail

short="${SHA::7}"
tag="sha-$short"
region="${PHI_REGISTRY%%-docker.pkg.dev*}"
project_of() { cut -d/ -f2 <<<"$1"; }

phi() { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="$PHI_CREDENTIALS" gcloud --quiet --project "$(project_of "$PHI_REGISTRY")" "$@"; }
ai() { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="$AI_CREDENTIALS" gcloud --quiet --project "$(project_of "$AI_REGISTRY")" "$@"; }
built() { "$1" artifacts docker images describe "$2:$tag" --format='value(image_summary.digest)' >/dev/null 2>&1; }

declare -A image cli prev
order=()
for app in versioning pipeline api worker web; do
  if built phi "$PHI_REGISTRY/studio-$app"; then image[$app]="$PHI_REGISTRY/studio-$app:$tag" cli[$app]=phi order+=("$app"); fi
done
if built ai "$AI_REGISTRY/studio-agent"; then image[agent]="$AI_REGISTRY/studio-agent:$tag" cli[agent]=ai; fi
# The agent goes after the backends it calls and before web, which proxies to it.
if [ -n "${image[agent]:-}" ]; then
  if [ -n "${image[web]:-}" ]; then order=("${order[@]:0:${#order[@]}-1}" agent web); else order+=(agent); fi
fi
echo "Commit $short: ${order[*]:-nothing new}"

moved=()
rollback() {
  for svc in "${moved[@]}"; do
    echo "::warning::rolling $svc back to ${prev[$svc]}"
    "${cli[$svc]}" run services update-traffic "$svc" --region "$region" --to-revisions="${prev[$svc]}=100" || true
  done
}

for app in api versioning pipeline; do
  [ -n "${image[$app]:-}" ] || continue
  echo "::group::$app-migrate"
  phi run jobs update "$app-migrate" --region "$region" --image "${image[$app]}"
  phi run jobs execute "$app-migrate" --region "$region" --wait
  echo "::endgroup::"
done

for svc in "${order[@]}"; do
  echo "::group::$svc"
  prev[$svc]="$("${cli[$svc]}" run services describe "$svc" --region "$region" --format='value(status.latestReadyRevisionName)')"
  moved+=("$svc")
  if ! "${cli[$svc]}" run services update "$svc" --region "$region" --image "${image[$svc]}" ||
    ! "${cli[$svc]}" run services update-traffic "$svc" --region "$region" --to-latest; then
    echo "::error::$svc: the new revision didn't become ready"
    rollback
    exit 1
  fi
  echo "::endgroup::"
done

retry() {
  for _ in $(seq 1 18); do
    if "$@"; then return 0; fi
    sleep 10
  done
  return 1
}
sha_is() { curl -fsS --max-time 10 "$1/version" | jq -e --arg s "$short" '.gitSha == $s' >/dev/null; }
config_ok() { curl -fsS --max-time 10 "$STUDIO_URL/config.json" | jq -e '.auth.mode == "workos"' >/dev/null; }
login_redirects() {
  code="$(curl -s -o /dev/null --max-time 10 -w '%{http_code}' "$STUDIO_URL/api/auth/login")"
  [[ "$code" =~ ^30[1278]$ ]]
}

failed=()
if [ -n "$STUDIO_URL" ]; then
  retry curl -fsS --max-time 10 -o /dev/null "$STUDIO_URL/healthz" || failed+=("web /healthz")
  retry config_ok || failed+=("web /config.json")
  [ -z "${image[web]:-}" ] || retry sha_is "$STUDIO_URL" || failed+=("web /version is not $short")
  retry login_redirects || failed+=("api /api/auth/login")
else
  echo "::warning::STUDIO_URL is unset: skipping the checks through the load balancer"
fi
if [ -n "${image[agent]:-}" ]; then
  retry sha_is "$AGENT_URL" || failed+=("agent /version is not $short")
else
  retry curl -fsS --max-time 10 -o /dev/null "$AGENT_URL/version" || failed+=("agent /version")
fi

if [ "${#failed[@]}" -gt 0 ]; then
  printf '::error::smoke test failed: %s\n' "${failed[@]}"
  rollback
  exit 1
fi
echo "Deployed $short: ${order[*]:-nothing new}; smoke test passed."
