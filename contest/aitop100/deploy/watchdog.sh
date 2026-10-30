#!/usr/bin/env bash
# Host watchdog for the contest bot. Sends Telegram alerts to the operator on:
#   Docker down, a service not running / unhealthy / restarted, public IP drifting away
#   from the Kakao allowed IP, Kakao gateway socket errors, model/auth failures,
#   failed or stuck deliveries, and unanswered inbound messages.
# Config: deploy/secrets/alert.env
#   ALERT_TELEGRAM_TOKEN_FILE=/path/to/telegram-bot-token   (file, never printed)
#   ALERT_TELEGRAM_CHAT_ID=1234567
#   KAKAO_ALLOWED_IP=203.0.113.10                            (comma-separated)
# Usage: watchdog.sh [--once] [--test]   (env WATCH_NOTIFY=log|fail for dry runs)
# Runs under `apply.sh watch` (tmux session aitop100-watch, with caffeinate on macOS).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[ -f secrets/alert.env ] || { echo "watchdog: deploy/secrets/alert.env missing" >&2; exit 1; }
# shellcheck disable=SC1091
. secrets/alert.env
: "${ALERT_TELEGRAM_TOKEN_FILE:?}" "${ALERT_TELEGRAM_CHAT_ID:?}" "${KAKAO_ALLOWED_IP:?}"
INTERVAL="${WATCH_INTERVAL:-60}"
REALERT="${WATCH_REALERT:-1800}"
EVENT_COOLDOWN="${WATCH_EVENT_COOLDOWN:-300}"
STUCK_SECONDS="${WATCH_STUCK_SECONDS:-360}"
state=../logs/watch
mkdir -p "$state"
DB="${WATCH_DB:-/home/gajaeway/.gajaeway/gateway.db}"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

notify() {
	local token code
	# WATCH_NOTIFY=fail|log: test the failure path or run without sending.
	case "${WATCH_NOTIFY:-send}" in
	fail) log "notify(test fail): $1"; return 1 ;;
	log) log "notify(log only): $1"; return 0 ;;
	esac
	token="$(cat "$ALERT_TELEGRAM_TOKEN_FILE")" || { log "notify: token file unreadable"; return 1; }
	# The token goes through curl's stdin config, never argv.
	code="$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
		curl -sS --max-time 15 -K - --data-urlencode "chat_id=$ALERT_TELEGRAM_CHAT_ID" \
			--data-urlencode "text=[AITOP100 봇] $1" -o /dev/null -w '%{http_code}')"
	log "notify http=$code: $1"
	[ "$code" = 200 ]
}

# Level check: alert on ok->fail, re-alert every REALERT while failing, alert on recovery.
level() {
	local name="$1" status="$2" detail="${3:-}" file="$state/level.$1" prev since now
	now="$(date +%s)"
	read -r prev since 2>/dev/null <"$file" || { prev=ok; since=0; }
	if [ "$status" = fail ]; then
		if [ "$prev" != fail ]; then
			notify "장애: $detail" && echo "fail $now" >"$file"
		elif [ $((now - since)) -ge "$REALERT" ]; then
			notify "계속 장애 중: $detail" && echo "fail $now" >"$file"
		fi
	elif [ "$prev" = fail ]; then
		notify "복구됨: $name" && echo "ok $now" >"$file"
	fi
}

# Event check: at most one alert per EVENT_COOLDOWN per name. Returns non-zero when the
# alert was not sent (cooldown or Telegram failure) so the caller keeps its read cursor
# and the same events are reported, aggregated, on a later poll instead of being lost.
event() {
	local name="$1" detail="$2" file="$state/event.$1" last now
	now="$(date +%s)"
	last="$(cat "$file" 2>/dev/null || echo 0)"
	[ $((now - last)) -ge "$EVENT_COOLDOWN" ] || return 1
	notify "$detail" && echo "$now" >"$file"
}

container_id() { docker compose ps -q "$1" 2>/dev/null; }

check_services() {
	local s id info status health started prev_started
	for s in runtime proxy kakao; do
		id="$(container_id "$s")"
		if [ -z "$id" ]; then
			level "svc-$s" fail "$s 컨테이너가 없습니다"
			continue
		fi
		info="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.StartedAt}}' "$id" 2>/dev/null)"
		read -r status health started <<<"$info"
		if [ "$status" != running ]; then
			level "svc-$s" fail "$s 상태 $status"
		elif [ "$health" = unhealthy ]; then
			level "svc-$s" fail "$s unhealthy"
		else
			level "svc-$s" ok
		fi
		prev_started="$(cat "$state/started.$s" 2>/dev/null || true)"
		if [ -n "$started" ] && [ "$started" != "$prev_started" ]; then
			[ -n "$prev_started" ] && event "restart-$s" "$s 컨테이너가 재시작됐습니다 ($started)"
			echo "$started" >"$state/started.$s"
		fi
	done
}

check_ip() {
	local ip
	ip="$(curl -s --max-time 8 https://api.ipify.org || curl -s --max-time 8 https://ifconfig.me || true)"
	if ! [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
		level ip fail "인터넷 연결 또는 공인 IP 확인 실패"
	elif [[ ",${KAKAO_ALLOWED_IP// /}," != *",$ip,"* ]]; then
		level ip fail "공인 IP가 $ip 로 바뀌었습니다. 카카오 허용 IP($KAKAO_ALLOWED_IP)에 추가해야 응답이 나갑니다"
	else
		level ip ok
	fi
}

iso_now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

# Each source keeps its own cursor. A missing cursor is created before the first read, so a
# failed first read or alert still has a fixed lower bound. The cursor moves only after a
# successful read whose matches, if any, were alerted (Compose --since has second
# resolution; the overlap only repeats a line).
check_log_source() {
	local service="$1" name="$2" label="$3" pattern="$4" cursor="$state/cursor.log.$1" since now out hits
	[ -s "$cursor" ] || iso_now >"$cursor"
	since="$(cat "$cursor")"
	now="$(iso_now)"
	out="$(docker compose logs --no-log-prefix --since "$since" "$service" 2>&1)" || {
		level "logs-$service" fail "$service 로그 조회 실패: $(tail -1 <<<"$out" | cut -c1-200)"
		return
	}
	level "logs-$service" ok
	hits="$(grep -E "$pattern" <<<"$out" || true)"
	if [ -n "$hits" ]; then
		event "$name" "$label $(wc -l <<<"$hits" | tr -d ' ')건: $(tail -1 <<<"$hits" | cut -c1-300)" || return
	fi
	echo "$now" >"$cursor"
}

check_logs() {
	check_log_source kakao kakao-log "카카오 어댑터 오류" \
		'result=(socket_error|close_timeout|invalid_frame|invalid_origin|failed[a-z_]*|settlement_failed|settlement_retry|fail_unacknowledged|queue_full|retry)|fatal code|lease_failed'
	check_log_source runtime model-log "모델/세션 오류" \
		'persona_(model|bind|send|terminal_delivery)_(failed|refused)|broker_watchdog_failed|invalid_grant|No API key|model_not_selected|rate limit|quota|usage_limit|HTTP 40[123]'
}

# Failed deliveries are read in an inclusive window that overlaps the previous one by
# DB_OVERLAP seconds (a row stamped before its transaction commits can appear late) and
# deduplicated by delivery id. Runs as UID 1001: root must not open paths inside the
# persona-writable home.
DB_OVERLAP="${WATCH_DB_OVERLAP:-30}"
check_db() {
	local cursor="$state/cursor.db" seen="$state/reported.deliveries" since out now stuck inbound ids new
	[ -s "$cursor" ] || iso_now >"$cursor"
	touch "$seen"
	since="$(cat "$cursor")"
	out="$(docker compose exec -T runtime setpriv --reuid=1001 --regid=1001 --init-groups sqlite3 -readonly "$DB" "
		select strftime('%Y-%m-%dT%H:%M:%fZ','now');
		select count(*) from deliveries where state in ('pending','inflight') and created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-$STUCK_SECONDS seconds');
		select count(*) from inbound_messages where state = 'pending' and received_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-$STUCK_SECONDS seconds');
		select delivery_id from deliveries where state in ('expired','failed_ambiguous')
			and updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ','$since','-$DB_OVERLAP seconds');
	" </dev/null 2>&1)" || { level db fail "gateway.db 조회 실패: $(tail -1 <<<"$out" | cut -c1-200)"; return; }
	{ read -r now; read -r stuck; read -r inbound; } <<<"$out"
	if ! [[ "$now" =~ ^[0-9]{4}- && "$stuck$inbound" =~ ^[0-9]+$ ]]; then
		level db fail "gateway.db 응답 형식 이상: $(tr '\n' ' ' <<<"$out" | cut -c1-200)"
		return
	fi
	level db ok
	if [ "$stuck" -gt 0 ]; then level delivery-stuck fail "${STUCK_SECONDS}초 넘게 안 나간 답장 ${stuck}건"; else level delivery-stuck ok; fi
	if [ "$inbound" -gt 0 ]; then level inbound-stuck fail "${STUCK_SECONDS}초 넘게 처리 안 된 메시지 ${inbound}건"; else level inbound-stuck ok; fi
	ids="$(tail -n +4 <<<"$out" | grep -v '^$' || true)"
	new="$(grep -vxF -f "$seen" <<<"$ids" | grep -v '^$' || true)"
	if [ -n "$new" ]; then
		event delivery-failed "답장 전송 실패 $(wc -l <<<"$new" | tr -d ' ')건 (deliveries expired/failed_ambiguous)" || return
		cat <<<"$new" >>"$seen"
		tail -n 2000 "$seen" >"$seen.tmp" && mv "$seen.tmp" "$seen"
	fi
	echo "$now" >"$cursor"
}

run_once() {
	if ! docker info >/dev/null 2>&1; then
		level docker fail "Docker 데몬이 응답하지 않습니다 (Docker Desktop 확인)"
		check_ip
		return
	fi
	level docker ok
	check_services
	check_ip
	check_logs
	if [ -n "$(container_id runtime)" ]; then check_db; fi
}

# Sourcing with WATCHDOG_SOURCE_ONLY=1 loads the functions without running (tests).
[ "${WATCHDOG_SOURCE_ONLY:-0}" = 1 ] && return 0

case "${1:-}" in
--test)
	notify "알림 테스트입니다 ($(hostname -s))"
	exit
	;;
--once)
	run_once
	exit
	;;
esac
notify "감시 시작 (${INTERVAL}초 간격, $(hostname -s))" || true
while true; do
	run_once
	sleep "$INTERVAL"
done
