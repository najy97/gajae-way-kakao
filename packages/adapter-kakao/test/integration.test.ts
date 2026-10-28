import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type ChatMessagePayload, type OriginRef, originKey } from "@gajae-gateway/protocol";
import { KakaoBotApi } from "../src/api";
import { type GatewayRequester, KakaoDelivery } from "../src/delivery";
import { KakaoInbound } from "../src/inbound";
import { kakaoMessageOrigin } from "../src/origin";
import { KakaoAdapterState } from "../src/state";
import { FakeClock, quietLog } from "./helpers";

const homes: string[] = [];
const deliveries: KakaoDelivery[] = [];
afterEach(async () => {
	for (const delivery of deliveries.splice(0)) delivery.stop();
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const incoming = {
	id: "1234567890123456789",
	content: "question",
	timestamp: "2026-10-27T07:00:00.000Z",
	isChannelChatroom: false,
	botGroupKey: "group",
	botUserKey: "user",
	callbackToken: "callback-secret",
};
const origin = kakaoMessageOrigin(incoming);

async function until(predicate: () => boolean) {
	for (let i = 0; i < 500 && !predicate(); i++) await Bun.sleep(2);
	expect(predicate()).toBe(true);
}

async function fixture() {
	const home = await mkdtemp(`${import.meta.dir}/.tmp-integration-`);
	homes.push(home);
	let state = await KakaoAdapterState.load(home);
	const clock = new FakeClock();
	const posts: { path: string; texts: string[]; target?: string; extra?: unknown }[] = [];
	let response: { totalCount: number; sendCount: number; errorCount: number } | undefined;
	const refusals: Response[] = [];
	const api = new KakaoBotApi("bot-secret", async (url, init) => {
		const body = JSON.parse(String(init?.body));
		const texts = body.skillResponse.template.outputs.map(
			(bubble: { simpleText: { text: string } }) => bubble.simpleText.text,
		);
		posts.push({
			path: String(url).split("/").at(-1)!,
			texts,
			target: body.botGroupKey ?? body.botUserKey,
			...(body.skillResponse.extra ? { extra: body.skillResponse.extra } : {}),
		});
		const refusal = refusals.shift();
		if (refusal) return refusal;
		return Response.json(response ?? { totalCount: texts.length, sendCount: texts.length, errorCount: 0 });
	});
	const ledger = new Map<string, { terminal?: string; settlements: number; ambiguous?: boolean }>();
	let connected = true;
	let rejectSettlements = 0;
	let delivery: KakaoDelivery;
	const accepted: unknown[] = [];
	const gateway: GatewayRequester = {
		async request<T>(verb: string, params?: unknown): Promise<T> {
			if (!connected) throw new Error("gateway disconnected");
			if (verb === "chat.send") {
				accepted.push(params);
				delivery.onTurnStarted((params as { origin: OriginRef }).origin, "turn");
				return { turnId: "turn" } as T;
			}
			if (rejectSettlements-- > 0) throw new Error("settlement transport failed");
			const { deliveryId, ambiguous } = params as { deliveryId: string; ambiguous?: boolean };
			const row = ledger.get(deliveryId);
			if (!row) throw new Error("unregistered delivery");
			// The fake ledger has the gateway's idempotent terminal settlement semantics.
			if (!row.terminal) {
				row.terminal = verb;
				row.settlements++;
				row.ambiguous = ambiguous;
			}
			return undefined as T;
		},
	};
	const createDelivery = () => {
		delivery = new KakaoDelivery(gateway, api, state, clock, quietLog);
		deliveries.push(delivery);
	};
	createDelivery();
	const inbound = new KakaoInbound(gateway, state, clock.now, quietLog, clock);
	await inbound.handleDispatch("MESSAGE_CREATE", incoming, clock.now());
	const emit = async (id: string, fields: Partial<ChatMessagePayload> = {}) => {
		if (!ledger.has(id)) ledger.set(id, { settlements: 0 });
		await delivery.onChatMessage({
			origin,
			// The gateway stamps each chat.message with a fresh id, never the inbound turn id.
			turnId: crypto.randomUUID(),
			role: "assistant",
			text: id,
			final: true,
			deliveryId: id,
			...fields,
		});
	};
	return {
		clock,
		posts,
		ledger,
		accepted,
		emit,
		get delivery() {
			return delivery;
		},
		setConnected: (value: boolean) => {
			connected = value;
		},
		failSettlements: (count: number) => {
			rejectSettlements = count;
		},
		respond: (value: typeof response) => {
			response = value;
		},
		refuseNext: (value: Response) => {
			refusals.push(value);
		},
		recreate: async () => {
			delivery.stop();
			state = await KakaoAdapterState.load(home);
			createDelivery();
		},
		assertSettled(ids: string[], verb = "delivery.confirm") {
			expect([...ledger.keys()].sort()).toEqual([...ids].sort());
			for (const id of ids) expect(ledger.get(id)).toMatchObject({ terminal: verb, settlements: 1 });
		},
	};
}

async function finalProgress(delivery: KakaoDelivery) {
	await delivery.onChatProgress({ origin, turnId: "turn", elapsedMs: 1, toolCalls: 0, outputTokens: 0, final: true });
}

test("ledger integration: callback success settles every delivery exactly once", async () => {
	const f = await fixture();
	await f.emit("first", { final: false });
	await f.emit("second", { askerIds: ["user"] });
	f.assertSettled(["first", "second"]);
	// The gateway attributed the turn to its asker, so the group-room callback mentions them.
	expect(f.posts).toEqual([
		{
			path: "callback",
			texts: ["{{#mentions.asker1}} first\n\nsecond"],
			target: undefined,
			extra: { mentions: { asker1: { type: "botUserKey", id: "user" } } },
		},
	]);
});

test("ledger integration: a refused mention reaches the room plain via send_message, not the spent token", async () => {
	const f = await fixture();
	f.refuseNext(Response.json({ code: -401, msg: "invalid mention" }, { status: 400 }));
	await f.emit("answer", { askerIds: ["gone"] });
	f.assertSettled(["answer"]);
	expect(f.posts).toEqual([
		{
			path: "callback",
			texts: ["{{#mentions.asker1}} answer"],
			target: undefined,
			extra: { mentions: { asker1: { type: "botUserKey", id: "gone" } } },
		},
		{ path: "send_message", texts: ["answer"], target: "group" },
	]);
});

test("ledger integration: a refused mention whose plain resend is also refused fails definitively", async () => {
	const f = await fixture();
	f.refuseNext(Response.json({ code: -401, msg: "invalid mention" }, { status: 400 }));
	f.refuseNext(Response.json({ code: -403, msg: "quota" }, { status: 403 }));
	await f.emit("answer", { askerIds: ["gone"] });
	f.assertSettled(["answer"], "delivery.fail");
	expect(f.ledger.get("answer")?.ambiguous).toBe(false);
	expect(f.posts).toHaveLength(2);
});

test("ledger integration: a 4xx that reports positive sends is never resent", async () => {
	const f = await fixture();
	f.refuseNext(Response.json({ totalCount: 1, sendCount: 1, errorCount: 0, code: -1 }, { status: 400 }));
	await f.emit("answer", { askerIds: ["user"] });
	f.assertSettled(["answer"], "delivery.fail");
	expect(f.ledger.get("answer")?.ambiguous).toBe(true);
	expect(f.posts).toHaveLength(1);
});

test("ledger integration: first settlement request failure retries without losing any delivery or reposting", async () => {
	const f = await fixture();
	f.failSettlements(1);
	await f.emit("first", { final: false });
	await f.emit("second");
	expect(f.ledger.get("first")?.terminal).toBeUndefined();
	expect(f.ledger.get("second")?.terminal).toBe("delivery.confirm");
	await f.emit("first", { redelivered: true, duplicateWarning: true });
	f.clock.advance(1_000);
	await until(() => !!f.ledger.get("first")?.terminal);
	f.assertSettled(["first", "second"]);
	expect(f.posts).toHaveLength(1);
});

test("ledger integration: gateway reconnect while buffering keeps text and settles all replayed IDs", async () => {
	const f = await fixture();
	await f.emit("first", { final: false });
	f.setConnected(false);
	await f.emit("first", { final: false, redelivered: true });
	await f.emit("second", { final: false });
	await finalProgress(f.delivery);
	expect(f.posts).toHaveLength(1);
	f.setConnected(true);
	f.clock.advance(1_000);
	await until(() => [...f.ledger.values()].every((row) => !!row.terminal));
	f.assertSettled(["first", "second"]);
	expect(f.posts[0]?.texts).toEqual(["first\n\nsecond"]);
});

test("ledger integration: adapter recreation loses callback token but persisted route sends every replay", async () => {
	const f = await fixture();
	await f.emit("first", { final: false });
	await f.recreate();
	await f.emit("first", { redelivered: true });
	await f.emit("second");
	f.assertSettled(["first", "second"]);
	expect(f.posts).toEqual([
		{ path: "send_message", texts: ["first"], target: "group" },
		{ path: "send_message", texts: ["second"], target: "group" },
	]);
});

test("ledger integration: duplicateWarning replay after recreation is visibly marked and settles once", async () => {
	const f = await fixture();
	await f.emit("first", { final: false });
	await f.recreate();
	await f.emit("first", { redelivered: true, duplicateWarning: true });
	f.assertSettled(["first"]);
	expect(f.posts).toEqual([{ path: "send_message", texts: ["[복구됨, 중복일 수 있음] first"], target: "group" }]);
});

test("ledger integration: silent final progress flushes interim deliveries and an empty turn posts nothing", async () => {
	const f = await fixture();
	await f.emit("first", { final: false });
	await f.emit("second", { final: false });
	await finalProgress(f.delivery);
	f.assertSettled(["first", "second"]);
	expect(f.posts).toHaveLength(1);
	const silent = await fixture();
	await finalProgress(silent.delivery);
	silent.assertSettled([]);
	expect(silent.posts).toHaveLength(0);
});

test("real KakaoBotApi partial first batch fails every buffered delivery ambiguously", async () => {
	const f = await fixture();
	f.respond({ totalCount: 3, sendCount: 2, errorCount: 1 });
	await f.emit("first", { final: false, text: "a".repeat(1500) });
	await f.emit("second", { text: "b".repeat(1500) });
	f.assertSettled(["first", "second"], "delivery.fail");
	for (const row of f.ledger.values()) expect(row.ambiguous).toBe(true);
	expect(f.posts).toHaveLength(1);
	expect(f.posts[0]?.path).toBe("callback");
});

test("real KakaoBotApi complete refusal is definitive for every buffered delivery", async () => {
	const f = await fixture();
	f.respond({ totalCount: 1, sendCount: 0, errorCount: 1 });
	await f.emit("first", { final: false });
	await f.emit("second");
	f.assertSettled(["first", "second"], "delivery.fail");
	for (const row of f.ledger.values()) expect(row.ambiguous).toBe(false);
});

test("collision-pair ingress preserves distinct routes through the real inbound handler", async () => {
	const home = await mkdtemp(`${import.meta.dir}/.tmp-integration-`);
	homes.push(home);
	const state = await KakaoAdapterState.load(home);
	const origins: OriginRef[] = [];
	const gateway: GatewayRequester = {
		async request<T>(_verb: string, params?: unknown): Promise<T> {
			origins.push((params as { origin: OriginRef }).origin);
			return undefined as T;
		},
	};
	const inbound = new KakaoInbound(gateway, state, () => 0, quietLog);
	for (const botGroupKey of ["/", "b64.Lw"])
		await inbound.handleDispatch("MESSAGE_CREATE", { ...incoming, botGroupKey });
	expect(originKey(origins[0]!)).not.toBe(originKey(origins[1]!));
	expect(origins.map((value) => state.routeFor(value)?.botGroupKey)).toEqual(["/", "b64.Lw"]);
});
