#!/usr/bin/env bash
# Roles: runtime | kakao | proxy | provision | sync
# Runs as root only for setup, then drops to UID 1001 for every gajae-way process.
set -euo pipefail
home="$GAJAEWAY_HOME"
as_user() { setpriv --reuid=1001 --regid=1001 --init-groups --inh-caps=-all -- "$@"; }

die() {
	echo "contest-entrypoint: $*" >&2
	exit 1
}

# Everything below runs as root over directories UID 1001 can write. Root never
# follows a path the persona could have replaced: mount roots and root-owned
# directories are the only parents it traverses, persona-owned entries are only
# touched with -h, and new files come from mktemp (O_EXCL), never a fixed name.

# Persona files are root-owned and read-only to the persona: a prompt-injected turn
# cannot rewrite SOUL.md or knowledge for the next user. The workspace is its own
# mount, so UID 1001 cannot rename it away (EBUSY) even though it owns $home.
# Only tmp/, gjc's .gjc/state and the gateway's self-ops skill directory are writable.
sync_workspace() {
	local ws="$home/workspace" stage dir
	mountpoint -q "$ws" || die "$ws must be a dedicated mount"
	chown root:root "$ws"
	chmod 755 "$ws"
	find "$ws" -mindepth 1 -maxdepth 1 ! -name memory ! -name tmp ! -name .gjc -exec rm -rf {} +
	stage="$(mktemp -d)"
	cp -R /contest-workspace/. "$stage/"
	chown -R root:root "$stage"
	find "$stage" -type d -exec chmod 755 {} +
	find "$stage" -type f -exec chmod 644 {} +
	cp -a "$stage/." "$ws/"
	rm -rf "$stage"
	[ -L "$ws/memory" ] || ln -s ../memory "$ws/memory"
	for dir in .gjc .gjc/skills; do
		mkdir -p "$ws/$dir"
		chown -h root:root "$ws/$dir"
		chmod 755 "$ws/$dir"
	done
	# .gjc/state is gjc's per-workspace session state root (lifecycle markers, transcripts).
	for dir in tmp .gjc/state .gjc/skills/self-ops; do
		mkdir -p "$ws/$dir"
		chown -h 1001:1001 "$ws/$dir"
		chmod 700 "$ws/$dir"
	done
}

prepare_home() {
	local file tmp
	mountpoint -q "$home" || die "$home must be a volume mount"
	chown 1001:1001 "$home"
	chmod 700 "$home"
	# $home/memory is persona-writable: refuse a planted symlink or non-directory.
	if [ -L "$home/memory" ] || { [ -e "$home/memory" ] && [ ! -d "$home/memory" ]; }; then
		die "$home/memory is not a plain directory; refusing to start"
	fi
	mkdir -p "$home/memory"
	chown -h 1001:1001 "$home/memory"
	rm -rf "$home/gjc"
	ln -s /opt/seed/gjc "$home/gjc"
	for file in config.json broker.env; do
		tmp="$(mktemp -p "$home" .contest.XXXXXX)"
		cat "/contest/$file" >"$tmp"
		# The container's own model credential (never the host's OAuth login).
		if [ "$file" = broker.env ] && [ -f /contest-secrets/model.env ]; then
			grep -E '^(ANTHROPIC_API_KEY|ANTHROPIC_OAUTH_TOKEN|OPENAI_API_KEY)=' /contest-secrets/model.env >>"$tmp" || true
		fi
		chmod 600 "$tmp"
		chown -h 1001:1001 "$tmp"
		mv -f "$tmp" "$home/$file"
	done
	sync_workspace
}

# The broker's gjc settings (model chain, tools) follow deploy/contest/gjc-config.yml on
# every start. Written as UID 1001: the agent dir is persona-writable, so root must not
# resolve paths inside it.
install_gjc_config() {
	as_user bash -c '
		set -euo pipefail
		agent="$GAJAEWAY_HOME/broker/agent"
		[ -d "$agent" ] || exit 0
		tmp="$(mktemp -p "$agent" .config.XXXXXX)"
		trap "rm -f \"\$tmp\"" EXIT
		cat /contest/gjc-config.yml >"$tmp"
		chmod 600 "$tmp"
		# -T: a directory planted at config.yml fails the start instead of swallowing the file.
		mv -fT "$tmp" "$agent/config.yml"
	' || die "could not install gjc config.yml"
}

case "${1:-}" in
runtime)
	prepare_home
	install_gjc_config
	# broker and gateway share one network and PID namespace (broker discovery is loopback + pid).
	exec setpriv --reuid=1001 --regid=1001 --init-groups --inh-caps=-all -- bash -c '
		# A container start is a fresh PID namespace: no broker from a previous start can
		# be alive, but its lock names a PID that a new process may now hold. Drop only
		# the lock and discovery file; the lifecycle ledger is kept.
		rm -rf "$GAJAEWAY_HOME/broker/agent/sdk/broker.lock" "$GAJAEWAY_HOME/broker/agent/sdk/broker.json"
		gajaeway-gateway broker & broker=$!
		gajaeway-gateway daemon & gateway=$!
		trap "kill -TERM $broker $gateway 2>/dev/null" TERM INT
		wait -n
		status=$?
		kill -TERM $broker $gateway 2>/dev/null || true
		wait
		exit $status
	'
	;;
kakao)
	: "${BOT_TOKEN:?BOT_TOKEN is required for the kakao role}"
	kakao_home=/home/gajaeway/kakao
	mkdir -p "$kakao_home/secrets"
	umask 077
	printf '%s\n' "$BOT_TOKEN" >"$kakao_home/secrets/kakao-bot-token"
	install -m 600 /contest/adapter-kakao.json "$kakao_home/adapter-kakao.json"
	chown -R 1001:1001 "$kakao_home"
	chmod 700 "$kakao_home" "$kakao_home/secrets"
	unset BOT_TOKEN
	GAJAEWAY_HOME="$kakao_home" exec setpriv --reuid=1001 --regid=1001 --init-groups --inh-caps=-all -- gajaeway-kakao
	;;
proxy) exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf ;;
provision)
	# /seed/agent is the host's private staging dir; copy it into a UID 1001-only dir first.
	prepare_home
	seed="$(mktemp -d)"
	cp -R /seed/agent/. "$seed/"
	chown -R 1001:1001 "$seed"
	chmod -R go-rwx "$seed"
	as_user gajaeway setup --broker-agent --from "$seed"
	rm -rf "$seed"
	;;
sync) sync_workspace ;;
*) exec "$@" ;;
esac
