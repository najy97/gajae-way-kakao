#!/usr/bin/env bash
# Export the build and run files of this deployment, without secrets or the persona, as the
# AGPL Corresponding Source companion of the modified gajae-way (najy97/gajae-way-kakao).
# Usage: deploy/export-public.sh [dest]   (default: $GAJAEWAY_SRC/contest/aitop100)
# The files are copied from the current commit (they must be committed), keeping this repo's
# layout so every relative path in them still holds. Persona (deploy/workspace), scenario
# cases, interview tooling and secrets are never copied. The export is built in a staging
# directory and installed only if no value from .env, deploy/.env or deploy/secrets (nor the
# Telegram token file, the allowed IPs, or a host home path) appears in it. Local files in
# dest that the export does not manage (.env, deploy/secrets/, logs/) are left alone.
# Commit the result in the gajae-way-kakao checkout yourself.
set -euo pipefail
cd "$(dirname "$0")/.."

files=(
	.gitattributes
	deploy/Dockerfile
	deploy/entrypoint.sh
	deploy/compose.yaml
	deploy/action/Dockerfile
	deploy/action/proxy.py
	deploy/tinyproxy.conf
	deploy/tinyproxy.filter
	deploy/apply.sh
	deploy/watchdog.sh
	deploy/export-public.sh
	deploy/contest/config.json
	deploy/contest/gjc-config.yml
	deploy/contest/broker.env
	deploy/contest/adapter-kakao.json
	deploy/tests/run.py
	deploy/tests/latency.py
)
marker=.export-source

die() {
	echo "export aborted: $*" >&2
	exit 1
}

# --- env file parsing (never prints values) ---------------------------------------------
trim() {
	local v="$1"
	v="${v#"${v%%[![:space:]]*}"}"
	printf '%s' "${v%"${v##*[![:space:]]}"}"
}

# Value of one NAME=VALUE line as bash would assign it for the forms used here:
# optional `export `, surrounding single or double quotes, or an unquoted value with an
# optional ` # comment`.
env_value() {
	local v
	v="$(trim "$1")"
	if [ "${#v}" -ge 2 ] && { [[ "$v" == \"*\" ]] || [[ "$v" == \'*\' ]]; }; then
		v="${v:1:${#v}-2}"
	else
		v="$(trim "${v%%[[:space:]]#*}")"
	fi
	printf '%s' "$v"
}

needles=()
add_needle() {
	local value="$1" label="$2"
	if [ "${#value}" -ge 6 ]; then
		needles+=("$value")
	elif [ -n "$value" ]; then
		echo "warning: $label is shorter than 6 characters and is not leak-checked" >&2
	fi
}

# Reads NAME=VALUE files. Blank lines and comments are skipped; any other line form is an
# error, so a format this parser does not understand cannot slip past the check.
token_file=
read_env_file() {
	local file="$1" n=0 line name value ip
	while IFS= read -r line || [ -n "$line" ]; do
		n=$((n + 1))
		line="${line%$'\r'}"
		[[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
		[[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] ||
			die "unsupported line $file:$n (expected NAME=VALUE)"
		name="${BASH_REMATCH[2]}"
		value="$(env_value "${BASH_REMATCH[3]}")"
		case "$name" in
		ALERT_TELEGRAM_TOKEN_FILE) token_file="$value" ;;
		KAKAO_ALLOWED_IP)
			add_needle "$value" "$file:$name"
			IFS=, read -ra ips <<<"$value"
			for ip in "${ips[@]}"; do add_needle "$(trim "$ip")" "$file:$name"; done
			;;
		*) add_needle "$value" "$file:$name" ;;
		esac
	done <"$file"
}

read_raw_file() {
	local file="$1" line
	[ -r "$file" ] && [ -s "$file" ] || die "$file is unreadable or empty"
	while IFS= read -r line || [ -n "$line" ]; do
		add_needle "$(trim "${line%$'\r'}")" "$file"
	done <"$file"
}

# --- destination -------------------------------------------------------------------------
if [ $# -ge 1 ]; then
	dest="$1"
else
	src=
	[ -f deploy/.env ] && src="$(grep -E '^[[:space:]]*(export[[:space:]]+)?GAJAEWAY_SRC=' deploy/.env | tail -1 || true)"
	src="$(env_value "${src#*=}")"
	[ -n "$src" ] || { echo "no dest given and no GAJAEWAY_SRC in deploy/.env" >&2; exit 2; }
	dest="$src/contest/aitop100"
fi
if [ -e "$dest" ] && [ ! -f "$dest/$marker" ]; then
	die "$dest exists and is not a previous export; refusing to write into it"
fi

# --- the export must equal a commit ------------------------------------------------------
for f in "${files[@]}"; do
	git ls-files --error-unmatch -- "$f" >/dev/null 2>&1 || die "not committed: $f"
done
if [ -n "$(git status --porcelain -- "${files[@]}")" ]; then
	git status --short -- "${files[@]}" >&2
	die "commit these changes first"
fi
commit="$(git rev-parse --short=12 HEAD)"

# --- build in staging --------------------------------------------------------------------
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

for f in "${files[@]}"; do
	mkdir -p "$stage/$(dirname "$f")"
	git show "HEAD:$f" >"$stage/$f"
	mode="$(git ls-files -s -- "$f" | cut -c1-6)"
	chmod "$([ "$mode" = 100755 ] && echo 755 || echo 644)" "$stage/$f"
done

mkdir -p "$stage/deploy/workspace" "$stage/deploy/tests/cases"
cat >"$stage/deploy/workspace/README.md" <<'EOF'
The persona of the contest bot (SOUL.md, AGENTS.md, USER.md, knowledge/) is not published.
Put your own persona files here; the entrypoint installs this directory read-only as the
persona workspace on every start.
EOF
cat >"$stage/deploy/tests/cases/README.md" <<'EOF'
Scenario cases of the contest bot are not published. Add your own *.yaml cases here; the
format is documented at the top of ../run.py. `apply.sh` only needs `run.py --smoke`.
EOF
cat >"$stage/.gitignore" <<'EOF'
.env
deploy/secrets/
logs/
EOF
cat >"$stage/README.md" <<EOF
# AI_TOP_100 [2026] Kakao bot deployment

Build and run files of the Kakao Talk bot entered in AI_TOP_100 [2026]. The bot runs the
modified gajae-way in this repository; these files build it into a container image and
operate it. Exported by \`deploy/export-public.sh\` from the operator's deployment repository
at commit \`$commit\`, with the same relative layout.

Not included: the persona (\`deploy/workspace\`: SOUL.md, AGENTS.md, USER.md, knowledge/),
scenario test cases, interview tooling, and every secret.

## Layout

- \`deploy/Dockerfile\`: builds gajae-way (gateway, Kakao adapter, CLI) and the pinned gjc.
- \`deploy/entrypoint.sh\`: container roles (runtime, kakao, proxy, provision, sync).
- \`deploy/compose.yaml\`: runtime on an internal network, egress only through the proxy;
  the Kakao adapter holds the bot token in its own container.
- \`deploy/action/\`: action API sidecar. It alone holds the contest action token
  (\`deploy/secrets/action.env\`: \`ACTION_TOKEN=...\`), forwards \`/api/*\` with one 30s budget
  (non-GET calls are never retried after a timeout), blocks the data reset path, and serves
  kakaocdn media and local Korean speech-to-text (faster-whisper) to the persona.
- \`deploy/tinyproxy.*\`: egress allowlist (model providers and registry.npmjs.org).
- \`deploy/contest/\`: gateway, broker, gjc and adapter configuration.
- \`deploy/apply.sh\`: build, start, login, status, tests, watchdog.
- \`deploy/watchdog.sh\`: host watchdog with Telegram alerts.
- \`deploy/tests/run.py\`, \`deploy/tests/latency.py\`: scenario harness and reply latency report.

## Run

Host: Docker with Compose v2, bash, tmux, python3 with PyYAML, sqlite3, curl
(macOS, Linux, or Windows inside WSL2 with Docker Desktop).

1. \`.env\` in this directory: \`BOT_TOKEN=<Kakao bot token>\`
2. \`deploy/.env\`: \`GAJAEWAY_SRC=<absolute path of this repository's root>\`
3. Persona files in \`deploy/workspace/\`
4. Optional \`deploy/secrets/model.env\` (\`ANTHROPIC_OAUTH_TOKEN=...\` for the fallback model)
   and \`deploy/secrets/alert.env\` (see the header of \`deploy/watchdog.sh\`); required
   \`deploy/secrets/action.env\` with \`ACTION_TOKEN=...\` for the action sidecar
5. \`deploy/apply.sh provision\`: seeds the container's gjc agent directory from a host gjc
   profile (\`~/.gjc/agent\`, or \`GJC_SOURCE_AGENT_DIR\`), with its stored logins removed.
   Install gjc on the host and run it once first.
6. \`deploy/apply.sh all\`: builds and starts the services and ends with a smoke test, which
   fails until a model credential exists (the model.env of step 4, or step 7).
7. \`deploy/apply.sh login\` (ChatGPT device code), then \`deploy/apply.sh test --smoke\`, and
   optionally \`deploy/apply.sh watch\`.

## License

GNU Affero General Public License v3.0 only, like the rest of this repository (see
\`LICENSE\` at the repository root). Copyright (C) 2026 나준영 (najy97).
EOF
{
	echo "$commit"
	(cd "$stage" && find . -type f ! -name "$marker" | sed 's|^\./||' | sort)
} >"$stage/$marker"

# --- leak check --------------------------------------------------------------------------
[ -f .env ] && read_env_file .env
[ -f deploy/.env ] && read_env_file deploy/.env
for f in deploy/secrets/*; do
	[ -f "$f" ] || continue
	case "$f" in
	*.env) read_env_file "$f" ;;
	*) read_raw_file "$f" ;;
	esac
done
if [ -n "$token_file" ]; then
	case "$token_file" in
	"~/"*) token_file="$HOME/${token_file#"~/"}" ;;
	/*) ;;
	*) token_file="deploy/$token_file" ;; # watchdog.sh resolves it from deploy/
	esac
	read_raw_file "$token_file"
fi
needles+=("$HOME" "/home/$(id -un)")

for n in "${needles[@]}"; do
	set +e
	hits="$(grep -rlF -- "$n" "$stage")"
	rc=$?
	set -e
	case "$rc" in
	0) die "a secret or host path appears in the export (in: $(sed "s|^$stage/||" <<<"$hits" | tr '\n' ' '))" ;;
	1) ;;
	*) die "leak check could not read the export (grep exit $rc)" ;;
	esac
done

# --- install -----------------------------------------------------------------------------
mkdir -p "$dest"
# Files a previous export wrote that this one no longer has.
if [ -f "$dest/$marker" ]; then
	while IFS= read -r rel; do
		case "$rel" in "" | /* | *..*) continue ;; esac
		if [ ! -e "$stage/$rel" ]; then rm -f "$dest/$rel"; fi
	done < <(tail -n +2 "$dest/$marker")
fi
tar -C "$stage" -cf - . | tar -C "$dest" -xf -

echo "exported ${#files[@]} files from $commit to $dest (leak check: ${#needles[@]} values, none found)"
