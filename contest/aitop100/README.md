# AI_TOP_100 [2026] Kakao bot deployment

Build and run files of the Kakao Talk bot entered in AI_TOP_100 [2026]. The bot runs the
modified gajae-way in this repository; these files build it into a container image and
operate it. Exported by `deploy/export-public.sh` from the operator's deployment repository
at commit `64a9b8905848`, with the same relative layout.

Not included: the persona (`deploy/workspace`: SOUL.md, AGENTS.md, USER.md, knowledge/),
scenario test cases, interview tooling, and every secret.

## Layout

- `deploy/Dockerfile`: builds gajae-way (gateway, Kakao adapter, CLI) and the pinned gjc.
- `deploy/entrypoint.sh`: container roles (runtime, kakao, proxy, provision, sync).
- `deploy/compose.yaml`: runtime on an internal network, egress only through the proxy;
  the Kakao adapter holds the bot token in its own container.
- `deploy/tinyproxy.*`: egress allowlist (model providers and registry.npmjs.org).
- `deploy/contest/`: gateway, broker, gjc and adapter configuration.
- `deploy/apply.sh`: build, start, login, status, tests, watchdog.
- `deploy/watchdog.sh`: host watchdog with Telegram alerts.
- `deploy/tests/run.py`, `deploy/tests/latency.py`: scenario harness and reply latency report.

## Run

Host: Docker with Compose v2, bash, tmux, python3 with PyYAML, sqlite3, curl
(macOS, Linux, or Windows inside WSL2 with Docker Desktop).

1. `.env` in this directory: `BOT_TOKEN=<Kakao bot token>`
2. `deploy/.env`: `GAJAEWAY_SRC=<absolute path of this repository's root>`
3. Persona files in `deploy/workspace/`
4. Optional `deploy/secrets/model.env` (`ANTHROPIC_OAUTH_TOKEN=...` for the fallback model)
   and `deploy/secrets/alert.env` (see the header of `deploy/watchdog.sh`)
5. `deploy/apply.sh provision`: seeds the container's gjc agent directory from a host gjc
   profile (`~/.gjc/agent`, or `GJC_SOURCE_AGENT_DIR`), with its stored logins removed.
   Install gjc on the host and run it once first.
6. `deploy/apply.sh all`: builds and starts the services and ends with a smoke test, which
   fails until a model credential exists (the model.env of step 4, or step 7).
7. `deploy/apply.sh login` (ChatGPT device code), then `deploy/apply.sh test --smoke`, and
   optionally `deploy/apply.sh watch`.

## License

GNU Affero General Public License v3.0 only, like the rest of this repository (see
`LICENSE` at the repository root). Copyright (C) 2026 나준영 (najy97).
