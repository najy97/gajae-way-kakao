import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOPBACK_ORIGIN } from "@gajae-gateway/protocol";
import { GajaewayClient } from "@gajae-gateway/sdk";
import { CLI_USAGE, main, parseChatArgs, USAGE_EXIT_CODE } from "../src/main";

test("chat keeps the default origin or validates an isolated loopback conversation", () => {
	expect(parseChatArgs([])).toEqual({ origin: LOOPBACK_ORIGIN, once: false });
	expect(parseChatArgs(["--conversation", "scenario-42"])).toEqual({
		origin: { platform: "loopback", kind: "loopback", conversationId: "scenario-42" },
		once: false,
	});
	expect(parseChatArgs(["--once"])).toEqual({ origin: LOOPBACK_ORIGIN, once: true });
	for (const args of [
		["--once", "--conversation", "scenario-42"],
		["--conversation", "scenario-42", "--once"],
	])
		expect(parseChatArgs(args)).toEqual({
			origin: { platform: "loopback", kind: "loopback", conversationId: "scenario-42" },
			once: true,
		});
	expect(CLI_USAGE).toContain("chat [--conversation <id>] [--once]");
});

test("chat rejects missing, empty, malformed, duplicate and unknown arguments", () => {
	for (const args of [
		["--conversation"],
		["--conversation", ""],
		["--conversation", " "],
		["--conversation", "room/id"],
		["--conversation", "x".repeat(257)],
		["--conversation", "--unknown"],
		["--conversation", "a", "--conversation", "b"],
		["--once", "--once"],
		["--once", "--conversation"],
		["--unknown"],
		["room"],
	])
		expect(() => parseChatArgs(args), JSON.stringify(args)).toThrow(/usage: gajaeway chat/);
});

test("invalid chat conversation exits with a usage error before any connection", async () => {
	const child = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "../src/main.ts"),
			"--socket",
			"/nonexistent-chat-test.sock",
			"chat",
			"--conversation",
			"",
		],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	expect(exit).toBe(USAGE_EXIT_CODE);
	expect(stderr).toContain("usage: gajaeway chat");
	expect(stderr).not.toContain("Unable to connect");
});

async function runChat(
	args: string[],
	input: string,
	reply: "normal" | "early" | "declined" | "silent" | "silent-early" = "normal",
) {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-cli-chat-"));
	const socketPath = join(home, "gateway.sock");
	const requests: Array<{ verb: string; params: unknown }> = [];
	const listener = Bun.listen<{ buffer: string }>({
		unix: socketPath,
		socket: {
			open(socket) {
				socket.data = { buffer: "" };
			},
			data(socket, data) {
				socket.data.buffer += Buffer.from(data).toString("utf8");
				let newline = socket.data.buffer.indexOf("\n");
				while (newline >= 0) {
					const frame = JSON.parse(socket.data.buffer.slice(0, newline));
					socket.data.buffer = socket.data.buffer.slice(newline + 1);
					if (frame.type === "hello")
						socket.write(`${JSON.stringify({ v: "0.1", type: "negotiated", payload: { profileVersion: "v0.1" } })}\n`);
					else if (frame.type === "request") {
						requests.push({ verb: frame.verb, params: frame.params });
						const progressFinal = (turnId: string) =>
							socket.write(
								`${JSON.stringify({ v: "0.1", type: "event", event: "chat.progress", payload: { turnId, origin: frame.params.origin, elapsedMs: 5, toolCalls: 0, outputTokens: 0, final: true } })}\n`,
							);
						const deliver = () => {
							if (reply.startsWith("silent")) {
								progressFinal("other-turn");
								progressFinal("turn-1");
								return;
							}
							const send = (turnId: string, text: string, final: boolean) =>
								socket.write(
									`${JSON.stringify({ v: "0.1", type: "event", event: "chat.message", payload: { turnId, origin: frame.params.origin, role: "assistant", text, final } })}\n`,
								);
							if (args.includes("--once")) send("other-turn", "unrelated output", true);
							send("turn-1", "progress", false);
							send("turn-1", "scenario reply", true);
						};
						if (reply === "early" || reply === "silent-early") deliver();
						socket.write(
							`${JSON.stringify({ v: "0.1", type: "response", id: frame.id, result: { turnId: reply === "declined" ? null : "turn-1", engaged: reply !== "declined" } })}\n`,
						);
						if (reply === "normal" || reply === "silent") setTimeout(deliver, 10);
					}
					newline = socket.data.buffer.indexOf("\n");
				}
			},
		},
	});
	const child = Bun.spawn(
		[process.execPath, join(import.meta.dir, "../src/main.ts"), "--socket", socketPath, "chat", ...args],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, GAJAEWAY_HOME: home } },
	);
	const guard = setTimeout(() => child.kill(), 3_000);
	try {
		child.stdin.write(input);
		child.stdin.end();
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exit, requests };
	} finally {
		clearTimeout(guard);
		child.kill();
		listener.stop(true);
		await rm(home, { recursive: true, force: true });
	}
}

for (const conversationId of [undefined, "scenario-one"])
	test(`chat REPL sends the ${conversationId ?? "default"} origin over the socket`, async () => {
		const args = conversationId === undefined ? [] : ["--conversation", conversationId];
		const result = await runChat(args, "scenario input\n/quit\n");
		expect(result.exit).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("scenario reply");
		expect(result.stdout).toContain("> ");
		expect(result.requests).toHaveLength(1);
		expect(result.requests[0]?.verb).toBe("chat.send");
		expect(result.requests[0]?.params).toMatchObject({
			origin: { platform: "loopback", kind: "loopback", conversationId: conversationId ?? "loopback" },
			text: "scenario input",
		});
	});

for (const conversationId of [undefined, "scenario-multiline"])
	test(`chat --once sends all stdin to the ${conversationId ?? "default"} conversation and prints only its turn`, async () => {
		const args = conversationId === undefined ? ["--once"] : ["--once", "--conversation", conversationId];
		const result = await runChat(args, " first line\nsecond line\n/quit  \n");
		expect(result.exit).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe("progress\nscenario reply\n");
		expect(result.requests).toHaveLength(1);
		expect(result.requests[0]?.params).toMatchObject({
			origin: { platform: "loopback", kind: "loopback", conversationId: conversationId ?? "loopback" },
			text: " first line\nsecond line\n/quit  ",
		});
	});

test("chat --once handles a final event preceding its response and removes only the final newline", async () => {
	const result = await runChat(["--conversation", "fast-case", "--once"], "line\n\n", "early");
	expect(result.exit).toBe(0);
	expect(result.stderr).toBe("");
	expect(result.stdout).toBe("progress\nscenario reply\n");
	expect(result.requests[0]?.params).toMatchObject({ text: "line\n" });
});

for (const reply of ["silent", "silent-early"] as const)
	test(`chat --once ends a [SILENT] turn on its final progress event (${reply})`, async () => {
		const result = await runChat(["--once", "--conversation", "silent-case"], "stay quiet\n", reply);
		expect(result.exit).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe("");
	});

test("chat --once exits 1 with a diagnostic when the message is not engaged", async () => {
	const result = await runChat(["--once"], "not engaged\n", "declined");
	expect(result.exit).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("message was not engaged");
});

test("chat --once exits 1 and closes the client when its final message times out", async () => {
	const client: GajaewayClient = Object.create(GajaewayClient.prototype);
	client.onChatMessage = () => () => {};
	client.onChatProgress = () => () => {};
	client.chatSend = async () => ({ turnId: "missing-final", engaged: true });
	let closed = false;
	client.close = async () => {
		closed = true;
	};
	const connect = spyOn(GajaewayClient, "connectSocketWithBackoff").mockResolvedValue(client);
	const stdin = spyOn(Bun.stdin, "text").mockResolvedValue("timeout input\n");
	const errors: string[] = [];
	const error = spyOn(console, "error").mockImplementation((line) => {
		errors.push(String(line));
	});
	const originalSetTimeout = globalThis.setTimeout;
	const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) =>
		originalSetTimeout(callback, ms === 30 * 60_000 ? 0 : ms)) as typeof setTimeout);
	const previousExit = process.exitCode;
	try {
		process.exitCode = 0;
		await main(["chat", "--once"]);
		expect(process.exitCode).toBe(1);
		expect(errors.join("\n")).toContain("turn timed out");
		expect(closed).toBe(true);
	} finally {
		connect.mockRestore();
		stdin.mockRestore();
		error.mockRestore();
		timer.mockRestore();
		process.exitCode = previousExit ?? 0;
	}
});
