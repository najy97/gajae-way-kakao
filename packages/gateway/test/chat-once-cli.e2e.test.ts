import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../../gateway/src/config";
import { startUnixServer } from "../../gateway/src/server/server";
import { Store } from "../../gateway/src/store";
import { attachTestBrokerOwnership, ScriptedSessionPort } from "../../gateway/test/session-port.fake";

async function eventually(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	expect(predicate(), message).toBe(true);
}

// The real gateway ends a [SILENT] turn with chat.progress final and no chat.message;
// `chat --once` must finish on it instead of waiting out the 30-minute turn timeout.
for (const [answer, expected] of [
	["[SILENT]", ""],
	["scenario answer", "scenario answer\n"],
] as const)
	test(`chat --once against the real gateway ends on ${answer === "[SILENT]" ? "a silent" : "an answered"} turn`, async () => {
		const home = await mkdtemp(join(tmpdir(), "gajaeway-cli-gateway-"));
		const config: GatewayConfig = {
			schemaVersion: 1,
			home,
			gjc: { agentDir: join(home, "agent") },
			configPath: join(home, "config.json"),
			socketPath: join(home, "gateway.sock"),
			dbPath: join(home, "gateway.db"),
			logVerbosity: "info",
			dmPolicy: "open",
		};
		const database = await Store.open(config.dbPath);
		const port = new ScriptedSessionPort();
		attachTestBrokerOwnership(database, port, join(home, "agent"));
		const server = await startUnixServer({
			config,
			database,
			sessionPort: port,
			progress: { firstAfterMs: 60_000, intervalMs: 60_000 },
			onStop: () => database.close(),
		});
		const child = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "../src/main.ts"),
				"--socket",
				config.socketPath,
				"chat",
				"--conversation",
				"scenario",
				"--once",
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, GAJAEWAY_HOME: home } },
		);
		const guard = setTimeout(() => child.kill(), 10_000);
		try {
			child.stdin.write("first line\nsecond line\n");
			child.stdin.end();
			await eventually(() => port.sends.length === 1, "turn was not sent");
			port.complete(port.sends[0]!.opRef, answer);
			const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
			expect(exit).toBe(0);
			expect(stdout).toBe(expected);
		} finally {
			clearTimeout(guard);
			child.kill();
			await server.stop();
			await rm(home, { recursive: true, force: true });
		}
	});
