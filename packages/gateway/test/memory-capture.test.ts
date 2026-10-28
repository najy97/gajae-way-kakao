import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, parseConfigFile, RESTART_REQUIRED_FIELDS } from "../src/config";
import { DeliveryService } from "../src/delivery/delivery";
import { MemoryClosureQueue } from "../src/memory/closure";
import { memoryRoot } from "../src/memory/doctrine";
import { seedDefaultMonitors } from "../src/monitors/defaults";
import { MonitorPropagator } from "../src/monitors/propagate";
import { MonitorRegistry } from "../src/monitors/registry";
import { Store } from "../src/store";
import { sessionPortFromScript } from "./session-port.fake";

let home = "";
let database: Store | undefined;
let queue: MemoryClosureQueue | undefined;
let propagator: MonitorPropagator | undefined;

afterEach(async () => {
	await propagator?.drain();
	await queue?.drain();
	database?.close();
	propagator = undefined;
	queue = undefined;
	database = undefined;
	if (home) await rm(home, { recursive: true, force: true });
	home = "";
});

async function setup(capture?: boolean) {
	home = await mkdtemp(join(tmpdir(), "gajaeway-memory-capture-"));
	database = await Store.open(join(home, "gateway.db"));
	queue = new MemoryClosureQueue(database, home, { capture });
	return { database, queue };
}

test("memory.capture accepts booleans, preserves the byte threshold, and requires restart", () => {
	for (const capture of [true, false])
		expect(parseConfigFile({ schemaVersion: 1, memory: { capture, debloatByteThreshold: 1234 } }).memory).toEqual({
			capture,
			debloatByteThreshold: 1234,
		});
	expect(parseConfigFile({ schemaVersion: 1, memory: {} }).memory).toEqual({});
	expect(RESTART_REQUIRED_FIELDS).toContain("memory");
});

test("memory.capture rejects non-booleans and memory still rejects unknown fields", () => {
	for (const capture of [null, "false", 0, 1, [], {}]) {
		try {
			parseConfigFile({ schemaVersion: 1, memory: { capture } });
			throw new Error("accepted invalid capture");
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigError);
			expect(error).toMatchObject({ code: "config_invalid" });
			expect((error as Error).message).toContain("memory.capture must be a boolean");
		}
	}
	expect(() => parseConfigFile({ schemaVersion: 1, memory: { capture: false, typo: true } })).toThrow(/unknown field/);
});

test("disabled capture creates no intent, daily file, or scheduled work for either mutation kind", async () => {
	const { database, queue } = await setup(false);
	for (const kind of ["daily_capture", "monitor-event"] as const)
		expect(queue.enqueue({ kind, originRefJson: "{}", userText: "private user", replyText: "private reply" })).toBe("");
	expect(queue.queueDepth).toBe(0);
	await queue.drain();
	expect(database.memory.rows()).toEqual([]);
	expect(await Bun.file(join(memoryRoot(home), "MEMORY.md")).exists()).toBe(false);
	await expect(readdir(join(memoryRoot(home), "daily"))).rejects.toMatchObject({ code: "ENOENT" });
});

for (const capture of [true, undefined])
	test(`capture ${String(capture)} writes and receipts both mutation kinds`, async () => {
		const { database, queue } = await setup(capture);
		for (const kind of ["daily_capture", "monitor-event"] as const) {
			const id = queue.enqueue({ kind, originRefJson: "{}", userText: kind, replyText: "captured reply" });
			expect(id).not.toBe("");
		}
		await queue.drain();
		expect(database.memory.rows().map((row) => row.state)).toEqual(["receipted", "receipted"]);
		const daily = join(memoryRoot(home), "daily");
		const files = (await readdir(daily)).filter((name) => name.endsWith(".md"));
		const text = (await Promise.all(files.map((name) => readFile(join(daily, name), "utf8")))).join("\n");
		expect(text).toContain("daily_capture");
		expect(text).toContain("monitor-event");
	}, 20_000);

test("disabled capture still recovers a durable intent left by a failed writer", async () => {
	const { database } = await setup(true);
	queue = new MemoryClosureQueue(database, home, {
		afterWrite: async () => {
			throw new Error("writer interrupted");
		},
	});
	await queue.initialize();
	const id = queue.enqueue({
		kind: "daily_capture",
		originRefJson: "{}",
		userText: "durable",
		replyText: "recover me",
	});
	await queue.drain();
	expect(database.memory.get(id)?.state).toBe("written");
	queue = new MemoryClosureQueue(database, home, { capture: false });
	await queue.initialize();
	expect(database.memory.get(id)?.state).toBe("receipted");
	expect(queue.enqueue({ kind: "daily_capture", originRefJson: "{}", userText: "new", replyText: "skip" })).toBe("");
	expect(database.memory.rows()).toHaveLength(1);
}, 20_000);

test("disabled seeding writes no flags, preserves existing monitors, and enabling later seeds defaults", async () => {
	const { database } = await setup(false);
	const registry = new MonitorRegistry(database);
	const existing = registry.add({
		name: "memory-audit",
		trigger: { kind: "cron", schedule: "0 6 * * *" },
		eventTypes: ["memory.audit"],
	});
	expect(seedDefaultMonitors(registry, database, false)).toBe(0);
	expect(registry.list().map((monitor) => monitor.monitorId)).toEqual([existing.monitorId]);
	for (const name of ["memory-canonicalize", "memory-audit", "memory-debloat"])
		expect(database.core.metaGet(`default_monitor_seeded:${name}`)).toBeUndefined();
	expect(seedDefaultMonitors(registry, database, true)).toBe(2);
	expect(registry.list()).toHaveLength(3);
	expect(seedDefaultMonitors(registry, database, false)).toBe(0);
	expect(registry.list()).toHaveLength(3);
});

test("disabled capture skips atomic monitor intents on live authoring and authored-note reconciliation", async () => {
	const { database, queue } = await setup(false);
	const registry = new MonitorRegistry(database);
	const monitor = registry.add({
		name: "capture-test",
		trigger: { kind: "cron", schedule: "0 6 * * *" },
		eventTypes: ["memory.audit"],
	});
	propagator = new MonitorPropagator({
		database,
		registry,
		memory: queue,
		delivery: new DeliveryService(database),
		emit: () => {},
		ownerTarget: { origin: { platform: "loopback", kind: "loopback", conversationId: "loopback" } },
		sessionPort: sessionPortFromScript({
			bind: async () => ({ sessionId: "capture-test-session" }),
			respond: async (_id, text) => {
				const events = JSON.parse(text.match(/\[.*\]$/s)?.[0] ?? "[]") as Array<{ eventId: string }>;
				return JSON.stringify(events.map(({ eventId }) => ({ eventId, note: "Validated the corpus successfully." })));
			},
		}),
	});
	const eventId = propagator.submit(monitor.monitorId, "memory.audit", { at: "now" });
	for (let attempt = 0; attempt < 100 && database.monitors.eventGet(eventId)?.stage !== "authored"; attempt++)
		await Bun.sleep(10);
	expect(database.monitors.authoredOutput(eventId)).toBe("Validated the corpus successfully.");
	expect(database.memory.rows()).toEqual([]);
	const author = spyOn(database.monitors, "authorFenced");
	try {
		await propagator.reconcile();
		expect(author).toHaveBeenCalled();
	} finally {
		author.mockRestore();
	}
	await queue.drain();
	expect(database.monitors.authoredOutput(eventId)).toBe("Validated the corpus successfully.");
	expect(database.memory.rows()).toEqual([]);
	expect(await Bun.file(join(memoryRoot(home), "daily", `${new Date().toISOString().slice(0, 10)}.md`)).exists()).toBe(
		false,
	);
});
