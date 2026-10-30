#!/usr/bin/env bash
# One entry point for operating the contest bot (macOS, or Windows via WSL2 + Docker Desktop).
#
#   apply.sh [all]        build image, (re)start services, apply config and persona files,
#                         drop memory maintenance monitors, smoke test     (default)
#   apply.sh knowledge    apply deploy/workspace (SOUL.md, knowledge/) only, then smoke test
#   apply.sh test [args]  scenario tests (tests/run.py; e.g. -k immigration -j 4)
#   apply.sh latency [--minutes N]  reply time of real Kakao messages (tests/latency.py)
#   apply.sh status       services, model accounts, public IP, recent Kakao lines
#   apply.sh login        log the container into ChatGPT (openai-codex device code)
#   apply.sh provision    seed a fresh home volume (stops the bot; re-run login afterwards)
#   apply.sh watch        start watchdog (+ caffeinate on macOS) in tmux session aitop100-watch
#   apply.sh logs [svc]   follow logs (runtime | kakao | proxy)
#
# Host needs: Docker (Compose v2), bash, tmux, python3 + PyYAML, sqlite3, curl, and deploy/.env with
# GAJAEWAY_SRC=<gajae-way-kakao checkout>. On Windows run everything inside a WSL2 distro with
# Docker Desktop's WSL integration on, and clone both repos into the WSL filesystem.
set -euo pipefail
cd "$(dirname "$0")"
export COMPOSE_FILE="$PWD/compose.yaml"
AGENT_DIR=/home/gajaeway/.gajaeway/broker/agent
# The image's pinned gjc (packages/gateway/package.json in the gajae-way source).
GJC=/opt/seed/gjc/current/bin/gjc

as_bot() { docker compose exec -T runtime setpriv --reuid=1001 --regid=1001 --init-groups "$@" </dev/null; }
say() { printf '\n== %s\n' "$*"; }

wait_healthy() {
	local i health
	for i in $(seq 1 60); do
		health="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q runtime)" 2>/dev/null || true)"
		if [ "$health" = healthy ] && [ "$(docker compose ps --status running -q kakao)" != "" ]; then
			echo "runtime healthy, kakao running"
			return 0
		fi
		sleep 3
	done
	docker compose ps
	echo "services did not become healthy in 180s" >&2
	return 1
}

drop_memory_monitors() {
	# memory.capture is off (rooms must not share memory); the maintenance monitors have nothing to do.
	local ids id
	ids="$(as_bot gajaeway monitors list --json | python3 -c '
import json, sys
print(" ".join(m["monitorId"] for m in json.load(sys.stdin)["monitors"] if m["name"].startswith("memory-")))')"
	for id in $ids; do as_bot gajaeway monitors remove "$id" >/dev/null && echo "removed monitor $id"; done
}

smoke() {
	say "smoke test"
	python3 tests/run.py --smoke
}

cmd="${1:-all}"
[ $# -gt 0 ] && shift
case "$cmd" in
all)
	say "build + up"
	# Config and persona files are bind mounts applied by the entrypoint at start, so the
	# containers are recreated even when the image did not change.
	docker compose up -d --build --force-recreate
	wait_healthy
	drop_memory_monitors
	smoke
	;;
knowledge)
	say "sync workspace"
	docker compose exec -T -u 0 runtime contest-entrypoint sync
	echo "persona files applied; changed SOUL.md is resent to every session on its next turn"
	smoke
	;;
test) exec python3 tests/run.py "$@" ;;
latency) exec python3 tests/latency.py "$@" ;;
status)
	docker compose ps
	say "model accounts"
	as_bot env GJC_CODING_AGENT_DIR="$AGENT_DIR" "$GJC" accounts list || true
	say "public IP"
	curl -s --max-time 8 https://api.ipify.org && echo
	grep -E '^KAKAO_ALLOWED_IP=' secrets/alert.env 2>/dev/null || true
	say "kakao (last 10)"
	docker compose logs --no-log-prefix --tail 10 kakao
	;;
login)
	# Device-code login: open the printed URL in a browser, enter the code, then leave gjc
	# (Ctrl+D or Ctrl+C) once "Successfully logged in" shows. The credential stays in the
	# container's agent.db (never the host's). Success is judged by the stored account, not
	# by how gjc exited.
	docker compose exec -it -e GJC_CODING_AGENT_DIR="$AGENT_DIR" -w /home/gajaeway/.gajaeway/workspace/tmp runtime \
		setpriv --reuid=1001 --regid=1001 --init-groups "$GJC" login openai-codex-device || true
	as_bot env GJC_CODING_AGENT_DIR="$AGENT_DIR" "$GJC" accounts list | grep -q '^openai-codex' ||
		{ echo "no openai-codex account stored; login did not complete" >&2; exit 1; }
	# The model catalog is cached per credential; drop it so the new login's models are listed.
	as_bot sqlite3 "$AGENT_DIR/models.db" "delete from model_cache where provider_id='openai-codex';"
	docker compose restart runtime kakao
	wait_healthy
	;;
provision)
	# agent.db is a snapshot of the host profile with every stored login removed: OAuth refresh
	# tokens rotate, so a copy shared with the host breaks whichever side refreshes second.
	src="${GJC_SOURCE_AGENT_DIR:-$HOME/.gjc/agent}"
	umask 077
	stage="$(mktemp -d)"
	trap 'rm -rf "$stage"' EXIT
	sqlite3 -readonly "$src/agent.db" ".backup '$stage/agent.db'"
	sqlite3 "$stage/agent.db" "DELETE FROM auth_credentials; DELETE FROM oauth_refresh_leases; VACUUM;"
	cp contest/gjc-config.yml "$stage/config.yml"
	docker compose stop runtime kakao >/dev/null 2>&1 || true
	docker compose run --rm --no-deps -v "$stage:/seed/agent:ro" runtime provision
	echo "provisioned; next: apply.sh all, then apply.sh login"
	;;
watch)
	tmux has-session -t aitop100-watch 2>/dev/null && { echo "already running (tmux attach -t aitop100-watch)"; exit 0; }
	mkdir -p ../logs
	# macOS: caffeinate keeps the Mac awake (no idle/system sleep) for as long as the watchdog runs.
	# WSL cannot hold Windows awake; the Windows power plan must never sleep instead.
	keep_awake=
	if command -v caffeinate >/dev/null; then
		keep_awake="caffeinate -ims "
	else
		echo "no caffeinate: keep the host from sleeping yourself (Windows: powercfg.exe /change standby-timeout-ac 0)" >&2
	fi
	# Relative paths under -c: the checkout path may contain spaces.
	tmux new-session -d -s aitop100-watch -c "$PWD" "${keep_awake}./watchdog.sh 2>&1 | tee -a ../logs/watchdog.log"
	echo "watchdog started: tmux attach -t aitop100-watch"
	;;
logs) docker compose logs -f --tail 50 "$@" ;;
*)
	# Already in deploy/: "$0" may be a path relative to the caller's directory.
	sed -n 2,17p apply.sh
	exit 2
	;;
esac
