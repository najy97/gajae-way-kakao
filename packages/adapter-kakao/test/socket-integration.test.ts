import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILE_VERSION } from "@gajae-gateway/protocol";
import { KakaoBotApi } from "../src/api";
import { KakaoInbound } from "../src/inbound";
import { ReconnectingGateway } from "../src/main";
import { kakaoMessageOrigin } from "../src/origin";
import { KakaoAdapterState } from "../src/state";
import { quietLog } from "./helpers";

// Same newline-framed Bun.listen fake-server pattern as SDK client-lifecycle.test.ts.
// Its withSocket helper is private to that test module, so it cannot be imported.
test("Unix SDK reconnect retains inbound order, running-turn buffers and every terminal ledger settlement", async () => {
	const home = await mkdtemp(join(tmpdir(), "kakao-sdk-"));
	const socketPath = join(home, "gateway.sock");
	type Peer = { write(data: string): unknown; end(): void };
	let peer: Peer | undefined;
	let connections = 0;
	let sends = 0;
	let refuseSettlement = true;
	const attempted: unknown[] = [];
	const accepted: { messageId: string }[] = [];
	const ledger = new Map(["first", "second"].map((id) => [id, { settlements: 0, terminal: "" }]));
	const frame = (socket: Peer, value: Record<string, unknown>) =>
		socket.write(`${JSON.stringify({ v: PROFILE_VERSION, ...value })}\n`);
	const listener = Bun.listen<{ buffer: string }>({
		unix: socketPath,
		socket: {
			open(socket) {
				socket.data = { buffer: "" };
				peer = socket;
				connections++;
			},
			data(socket, bytes) {
				socket.data.buffer += Buffer.from(bytes).toString("utf8");
				for (;;) {
					const newline = socket.data.buffer.indexOf("\n");
					if (newline < 0) break;
					const request = JSON.parse(socket.data.buffer.slice(0, newline));
					socket.data.buffer = socket.data.buffer.slice(newline + 1);
					if (request.type === "hello") {
						frame(socket, { type: "negotiated", payload: { profileVersion: PROFILE_VERSION, capabilities: [] } });
					} else if (request.type === "request") {
						if (request.verb === "chat.send") {
							attempted.push(request.params);
							if (++sends <= 2) {
								socket.end();
								continue;
							}
							accepted.push(request.params);
							frame(socket, { type: "response", id: request.id, result: { turnId: "running" } });
						} else if (request.verb === "delivery.confirm" || request.verb === "delivery.fail") {
							if (refuseSettlement) {
								refuseSettlement = false;
								socket.end();
								continue;
							}
							const row = ledger.get(request.params.deliveryId)!;
							if (!row.terminal) {
								row.terminal = request.verb;
								row.settlements++;
							}
							frame(socket, { type: "response", id: request.id, result: {} });
						} else frame(socket, { type: "response", id: request.id, result: {} });
					}
				}
			},
		},
	});
	const posts: { path: string; texts: string[] }[] = [];
	const api = new KakaoBotApi("bot-secret", async (url, init) => {
		const body = JSON.parse(String(init?.body));
		const texts = body.skillResponse.template.outputs.map(
			(value: { simpleText: { text: string } }) => value.simpleText.text,
		);
		posts.push({ path: String(url).split("/").at(-1)!, texts });
		return Response.json({ totalCount: texts.length, sendCount: texts.length, errorCount: 0 });
	});
	const state = await KakaoAdapterState.load(home);
	const gateway = new ReconnectingGateway(socketPath, api, state);
	const inbound = new KakaoInbound(gateway, state, Date.now, quietLog);
	const data = {
		id: "one",
		content: "question",
		timestamp: "2026-10-27T07:00:00.000Z",
		botGroupKey: "room",
		botUserKey: "user",
		isChannelChatroom: false,
		callbackToken: "callback-secret",
	};
	const origin = kakaoMessageOrigin(data);
	const event = (name: string, payload: unknown) => frame(peer!, { type: "event", event: name, payload });
	try {
		await gateway.connectInitial();
		await inbound.handleDispatch("MESSAGE_CREATE", data);
		await inbound.handleDispatch("MESSAGE_CREATE", { ...data, id: "two", content: "second question" });
		await until(() => accepted.length === 2);
		expect(attempted.slice(0, 3)).toEqual([attempted[0], attempted[0], attempted[0]]);
		expect(accepted.map((params) => params.messageId)).toEqual(["room:one", "room:two"]);
		const message = (deliveryId: string, extra: Record<string, unknown> = {}) => ({
			origin,
			// The gateway stamps each chat.message with a fresh id, never the inbound turn id.
			turnId: crypto.randomUUID(),
			role: "assistant",
			text: deliveryId,
			deliveryId,
			final: false,
			...extra,
		});
		event("chat.message", message("first"));
		await Bun.sleep(10);
		expect(posts).toHaveLength(0); // Learned from real chat.send result, not a manually written turn map.
		const priorConnections = connections;
		peer!.end();
		await until(() => connections > priorConnections);
		await Bun.sleep(10);
		event("chat.message", message("first", { redelivered: true }));
		event("chat.message", message("second"));
		event("chat.progress", { origin, turnId: "running", elapsedMs: 1, toolCalls: 0, outputTokens: 0, final: true });
		await until(() => [...ledger.values()].every((row) => !!row.terminal));
		for (const row of ledger.values()) expect(row).toEqual({ terminal: "delivery.confirm", settlements: 1 });
		expect(posts).toEqual([{ path: "callback", texts: ["first\n\nsecond"] }]);
	} finally {
		inbound.stop();
		await gateway.close();
		listener.stop(true);
		await rm(home, { recursive: true, force: true });
	}
}, 15_000);

async function until(predicate: () => boolean) {
	for (let i = 0; i < 2_000 && !predicate(); i++) await Bun.sleep(5);
	expect(predicate()).toBe(true);
}
