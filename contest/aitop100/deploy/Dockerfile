# Contest-only gajae-way image: broker + gateway runtime, Kakao adapter, egress proxy.
# Built from the gajae-way checkout passed as the `gajaeway` build context.
FROM oven/bun:1.4.0 AS build
WORKDIR /src
COPY --from=gajaeway package.json bun.lock tsconfig.json biome.json bunfig.toml ./
COPY --from=gajaeway packages ./packages
COPY --from=gajaeway scripts ./scripts
RUN bun install --frozen-lockfile
RUN bun build --compile packages/gateway/src/main.ts --outfile dist/gajaeway-gateway \
 && bun build --compile packages/adapter-kakao/src/main.ts --outfile dist/gajaeway-kakao \
 && bun build --compile packages/cli/src/main.ts --outfile dist/gajaeway \
 && cp packages/gateway/package.json dist/package.json
# Install the gateway-pinned gjc into a seed home; the entrypoint links it into the volume.
RUN bun -e 'import { installPinnedGjc } from "./packages/cli/src/gjc-install.ts"; const { gjc } = await Bun.file("packages/gateway/package.json").json(); await installPinnedGjc({ home: "/opt/seed", version: gjc.version });'

FROM oven/bun:1.4.0
# python3 data stack: the persona's eval/python tool computes dates, money and tables instead of guessing.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git procps sqlite3 tinyproxy \
    python3 python3-numpy python3-pandas python3-openpyxl python3-dateutil python3-tz \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 1001 gajaeway \
 && mkdir -p /home/gajaeway/.gajaeway /home/gajaeway/kakao \
 && chown gajaeway:gajaeway /home/gajaeway/.gajaeway /home/gajaeway/kakao \
 && chmod 700 /home/gajaeway/.gajaeway /home/gajaeway/kakao
COPY --from=build /src/dist/ /usr/local/bin/
COPY --from=build /opt/seed /opt/seed
# Root-owned and read-only to UID 1001: the persona can run gjc but not replace it.
RUN chmod -R a+rX,go-w /opt/seed
COPY entrypoint.sh /usr/local/bin/contest-entrypoint
COPY tinyproxy.conf tinyproxy.filter /etc/tinyproxy/
ENV HOME=/home/gajaeway GAJAEWAY_HOME=/home/gajaeway/.gajaeway
WORKDIR /home/gajaeway
# Starts as root only to fix volume ownership and lay down read-only persona files, then drops to UID 1001.
ENTRYPOINT ["contest-entrypoint"]
