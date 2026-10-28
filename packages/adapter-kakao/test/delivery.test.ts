import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { ChatMessagePayload, OriginRef } from "@gajae-gateway/protocol";
import { KakaoApiError } from "../src/api";
import { type GatewayRequester, KakaoDelivery } from "../src/delivery";
import { KakaoAdapterState, type KakaoReplyRoute } from "../src/state";
import { FakeClock } from "./helpers";

const origin: OriginRef = { platform: "kakao", kind: "channel", conversationId: "bg2_group" };
const route: KakaoReplyRoute = { botGroupKey: "bg2_group", botUserKey: "bu2_user", channelChatroom: false };
const homes: string[] = [];
afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(options: { token?: boolean; route?: boolean; origin?: OriginRef; running?: boolean } = {}) {
	const home = await mkdtemp(`${import.meta.dir}/.tmp-delivery-`);
	homes.push(home);
	const state = await KakaoAdapterState.load(home);
	const target = options.origin ?? origin;
	if (options.route !== false) await state.rememberRoute(target, { ...route, channelChatroom: target.kind === "dm" });
	const clock = new FakeClock();
	if (options.token !== false) state.rememberToken(target, "callback-secret", clock.now());
	const requests: { verb: string; params: Record<string, unknown> }[] = [];
	let requestError: Error | undefined;
	const gateway: GatewayRequester = {
		async request<T>(verb: string, params?: unknown): Promise<T> {
			if (requestError) throw requestError;
			requests.push({ verb, params: params as Record<string, unknown> });
			return undefined as T;
		},
	};
	const posted: { path: string; bubbles: readonly string[]; route?: KakaoReplyRoute }[] = [];
	const logs: string[] = [];
	let callbackAction: (() => Promise<void>) | undefined;
	let sendAction: (() => Promise<void>) | undefined;
	const bot = {
		async callback(_token: string, bubbles: readonly string[]) {
			expect(state.tokenFor(target)).toBeUndefined();
			posted.push({ path: "callback", bubbles });
			await callbackAction?.();
		},
		async sendMessage(replyRoute: KakaoReplyRoute, bubbles: readonly string[]) {
			posted.push({ path: "send_message", bubbles, route: replyRoute });
			await sendAction?.();
		},
	};
	const delivery = new KakaoDelivery(gateway, bot, state, clock, {
		info: (message) => logs.push(message),
		error: (message) => logs.push(message),
	});
	if (options.running !== false) delivery.onTurnStarted(target, "inbound-turn");
	return {
		state,
		delivery,
		clock,
		requests,
		posted,
		logs,
		target,
		callbackAction: (action: () => Promise<void>) => {
			callbackAction = action;
		},
		sendAction: (action: () => Promise<void>) => {
			sendAction = action;
		},
		requestError: (error?: Error) => {
			requestError = error;
		},
	};
}

function message(fields: Partial<ChatMessagePayload> = {}): ChatMessagePayload {
	// Like the gateway, every chat.message carries its own id, never the inbound turn id.
	return {
		origin,
		turnId: crypto.randomUUID(),
		role: "assistant",
		text: "answer",
		final: true,
		deliveryId: "d1",
		...fields,
	};
}

test("final delivery uses callback once, removes the token before posting and confirms", async () => {
	const f = await fixture();
	await f.delivery.onChatMessage(message());
	expect(f.posted).toEqual([{ path: "callback", bubbles: ["answer"] }]);
	expect(f.state.tokenFor(origin)).toBeUndefined();
	expect(f.requests).toEqual([{ verb: "delivery.confirm", params: { deliveryId: "d1" } }]);
	expect(f.logs).toEqual(["kakao_flush origin=kakao/channel/bg2_group bubbles=1 path=callback result=confirmed"]);
});

test("mid-turn messages buffer and join until progress.final, ignoring intermediate progress", async () => {
	const f = await fixture();
	await f.delivery.onChatMessage(message({ final: false, text: "first" }));
	await f.delivery.onChatMessage(message({ final: false, deliveryId: "d2", text: "second" }));
	await f.delivery.onChatProgress({ origin, turnId: "inbound-turn", elapsedMs: 1, toolCalls: 0, outputTokens: 0 });
	expect(f.posted).toHaveLength(0);
	await f.delivery.onChatProgress({
		origin,
		turnId: "inbound-turn",
		elapsedMs: 2,
		toolCalls: 0,
		outputTokens: 0,
		final: true,
	});
	expect(f.posted).toEqual([{ path: "callback", bubbles: ["first\n\nsecond"] }]);
	expect(f.requests.map((request) => request.params.deliveryId)).toEqual(["d1", "d2"]);
	f.clock.advance(270_000);
	await f.delivery.flush(origin);
	expect(f.posted).toHaveLength(1);
});

test("deadline flushes at token receipt plus 255 seconds, reserving the request budget", async () => {
	const f = await fixture();
	f.clock.advance(60_000);
	await f.delivery.onChatMessage(message({ final: false }));
	f.clock.advance(194_999);
	expect(f.posted).toHaveLength(0);
	f.clock.advance(1);
	await f.delivery.flush(origin);
	expect(f.posted[0]?.path).toBe("send_message");
	expect(f.requests[0]?.verb).toBe("delivery.confirm");
});

test("final near expiry falls back to send_message without attempting callback", async () => {
	for (const age of [254_999, 255_000, 289_000]) {
		const f = await fixture();
		f.clock.advance(age);
		await f.delivery.onChatMessage(message());
		expect(f.posted.map((post) => post.path)).toEqual([age < 255_000 ? "callback" : "send_message"]);
	}
});

test("stop cancels failed settlement retries and ignores late events", async () => {
	const f = await fixture();
	f.requestError(new Error("disconnected"));
	await f.delivery.onChatMessage(message());
	f.delivery.stop();
	f.requestError();
	f.clock.advance(30_000);
	await f.delivery.onChatMessage(message({ deliveryId: "late" }));
	expect(f.posted).toHaveLength(1);
	expect(f.requests).toHaveLength(0);
});

test("standalone non-final notices flush immediately with an unused token when no turn runs in the room", async () => {
	const f = await fixture({ running: false });
	await f.delivery.onChatMessage(message({ final: false, text: "restart notice" }));
	expect(f.posted.map((post) => post.path)).toEqual(["callback"]);
});

test("progress learns a running turn by origin and final progress forgets it", async () => {
	const f = await fixture({ running: false });
	await f.delivery.onChatProgress({ origin, turnId: "learned", elapsedMs: 1, toolCalls: 0, outputTokens: 0 });
	// The interim's own id differs from the progress turn id, exactly as the gateway emits it.
	await f.delivery.onChatMessage(message({ final: false, text: "interim" }));
	expect(f.posted).toHaveLength(0);
	await f.delivery.onChatProgress({
		origin,
		turnId: "learned",
		elapsedMs: 2,
		toolCalls: 0,
		outputTokens: 0,
		final: true,
	});
	expect(f.posted.map((post) => post.bubbles)).toEqual([["interim"]]);
	f.state.rememberToken(origin, "new-token", f.clock.now());
	await f.delivery.onChatMessage(message({ final: false, deliveryId: "d2" }));
	expect(f.posted).toHaveLength(2);
});

test("a final message ends the room's running turn so later standalone notices are not held", async () => {
	const f = await fixture();
	await f.delivery.onChatMessage(message());
	f.state.rememberToken(origin, "new-token", f.clock.now());
	await f.delivery.onChatMessage(message({ final: false, deliveryId: "d2", text: "notice" }));
	expect(f.posted.map((post) => post.bubbles)).toEqual([["answer"], ["notice"]]);
});

test("missing or expired token flushes immediately through send_message", async () => {
	for (const token of [false, true]) {
		const f = await fixture({ token });
		if (token) f.clock.advance(290_001);
		await f.delivery.onChatMessage(message({ final: false }));
		expect(f.posted).toEqual([{ path: "send_message", bubbles: ["answer"], route }]);
	}
});

test("channel-chatroom no-token sends keep botUserKey and the channel-chatroom route flag", async () => {
	const dm: OriginRef = { platform: "kakao", kind: "dm", conversationId: route.botGroupKey, peerId: route.botUserKey };
	const f = await fixture({ token: false, origin: dm });
	await f.delivery.onChatMessage(message({ origin: dm }));
	expect(f.posted[0]?.route).toEqual({ ...route, channelChatroom: true });
});

test("a second batch uses send_message after the first three callback bubbles", async () => {
	const f = await fixture();
	await f.delivery.onChatMessage(message({ text: "x".repeat(3_500) }));
	expect(f.posted.map((post) => [post.path, post.bubbles.map((bubble) => bubble.length)])).toEqual([
		["callback", [1_000, 1_000, 1_000]],
		["send_message", [500]],
	]);
	expect(f.requests).toEqual([{ verb: "delivery.confirm", params: { deliveryId: "d1" } }]);
});

test("a definitive callback refusal fails non-ambiguously and retry uses send_message", async () => {
	const f = await fixture();
	f.callbackAction(async () => {
		throw new KakaoApiError(403, "refused");
	});
	await f.delivery.onChatMessage(message());
	expect(f.requests).toEqual([
		{ verb: "delivery.fail", params: { deliveryId: "d1", reason: "refused", ambiguous: false } },
	]);
	await f.delivery.onChatMessage(message({ redelivered: true }));
	expect(f.posted.map((post) => post.path)).toEqual(["callback", "send_message"]);
	expect(f.requests[1]?.verb).toBe("delivery.confirm");
});

test("network failures are ambiguous even before any successful batch", async () => {
	const f = await fixture();
	f.callbackAction(async () => {
		throw new Error("network reset");
	});
	await f.delivery.onChatMessage(message());
	expect(f.requests).toEqual([
		{ verb: "delivery.fail", params: { deliveryId: "d1", reason: "network reset", ambiguous: true } },
	]);
});

test("a later definitive batch refusal is ambiguous for every buffered delivery", async () => {
	const f = await fixture();
	f.sendAction(async () => {
		throw new KakaoApiError(429, "quota");
	});
	await f.delivery.onChatMessage(message({ text: "x".repeat(2_000), final: false }));
	await f.delivery.onChatMessage(message({ text: "y".repeat(1_500), deliveryId: "d2" }));
	expect(f.posted.map((post) => post.path)).toEqual(["callback", "send_message"]);
	expect(f.requests).toEqual(
		["d1", "d2"].map((deliveryId) => ({
			verb: "delivery.fail",
			params: { deliveryId, reason: "quota", ambiguous: true },
		})),
	);
});

test("duplicateWarning is visible, and logs contain no message text or credentials", async () => {
	const f = await fixture();
	await f.delivery.onChatMessage(message({ text: "private answer", duplicateWarning: true }));
	expect(f.posted[0]?.bubbles).toEqual(["[복구됨, 중복일 수 있음] private answer"]);
	for (const log of f.logs) {
		expect(log).not.toContain("private answer");
		expect(log).not.toContain("callback-secret");
	}
});

test("reaction and file deliveries fail non-ambiguously without posting", async () => {
	const f = await fixture();
	await f.delivery.onChatMessage(message({ reaction: { targetMessageId: "m1", emoji: "👀", emojiName: "eyes" } }));
	await f.delivery.onChatMessage(message({ deliveryId: "d2", file: { path: "/file", name: "file", size: 1 } }));
	expect(f.posted).toHaveLength(0);
	expect(f.requests.map((request) => [request.verb, request.params.ambiguous, request.params.reason])).toEqual([
		["delivery.fail", false, "Kakao does not support reaction deliveries"],
		["delivery.fail", false, "Kakao does not support file deliveries"],
	]);
});

test("empty deliveries confirm without spending a callback; missing routes fail definitively", async () => {
	const f = await fixture({ route: false });
	await f.delivery.onChatMessage(message({ text: "" }));
	expect(f.requests[0]?.verb).toBe("delivery.confirm");
	expect(f.state.tokenFor(origin)?.token).toBe("callback-secret");
	await f.delivery.onChatMessage(message({ deliveryId: "d2" }));
	expect(f.posted).toHaveLength(0);
	expect(f.requests[1]?.params).toEqual({
		deliveryId: "d2",
		reason: "Kakao origin has no reply route",
		ambiguous: false,
	});
});

test("non-Kakao and untracked deliveries are ignored", async () => {
	const f = await fixture();
	await f.delivery.onChatMessage(message({ origin: { platform: "slack", kind: "channel", conversationId: "C1" } }));
	await f.delivery.onChatMessage(message({ deliveryId: undefined }));
	expect(f.posted).toHaveLength(0);
	expect(f.requests).toHaveLength(0);
});

test("per-origin flushes serialize and a failed settlement never blocks the next flush", async () => {
	const f = await fixture();
	let release!: () => void;
	f.callbackAction(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const first = f.delivery.onChatMessage(message());
	await Promise.resolve();
	const second = f.delivery.onChatMessage(message({ deliveryId: "d2", text: "later" }));
	await Promise.resolve();
	expect(f.posted.map((post) => post.path)).toEqual(["callback"]);
	f.requestError(new Error("gateway disconnected"));
	release();
	await first;
	f.requestError();
	await second;
	expect(f.posted.map((post) => post.path)).toEqual(["callback", "send_message"]);
	expect(f.requests.at(-1)).toEqual({ verb: "delivery.confirm", params: { deliveryId: "d2" } });
});

test("a replay received while still buffered or posting does not duplicate delivery text", async () => {
	const f = await fixture();
	await f.delivery.onChatMessage(message({ final: false }));
	await f.delivery.onChatMessage(message({ final: false, redelivered: true }));
	await f.delivery.flush(origin);
	expect(f.posted[0]?.bubbles).toEqual(["answer"]);
	expect(f.requests).toHaveLength(1);
});
