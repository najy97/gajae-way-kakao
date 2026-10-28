import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { GatewayRequester } from "../src/delivery";
import { KakaoInbound } from "../src/inbound";
import { kakaoMessageOrigin } from "../src/origin";
import { KakaoAdapterState } from "../src/state";
import { FakeClock, quietLog } from "./helpers";

const homes: string[] = [];
afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function stateFixture() {
	const home = await mkdtemp(`${import.meta.dir}/.tmp-inbound-`);
	homes.push(home);
	return { home, state: await KakaoAdapterState.load(home) };
}
const data = {
	id: "1234567890123456789",
	content: "hello",
	timestamp: "2026-10-27T07:00:00.000Z",
	isChannelChatroom: true,
	botGroupKey: "bg2_group",
	botUserKey: "bu2_user",
	callbackToken: "callback-secret",
};

test("MESSAGE_CREATE persists the route before exact chat.send, keeping tokens in memory only", async () => {
	const { home, state } = await stateFixture();
	const calls: unknown[] = [];
	const origin = kakaoMessageOrigin(data);
	const gateway: GatewayRequester = {
		async request<T>(verb: string, params?: unknown): Promise<T> {
			const persisted = await KakaoAdapterState.load(home);
			expect(persisted.routeFor(origin)).toEqual({
				botGroupKey: data.botGroupKey,
				botUserKey: data.botUserKey,
				channelChatroom: true,
			});
			expect(state.tokenFor(origin)).toEqual({ token: data.callbackToken, receivedAt: 1234 });
			expect(await readFile(state.path, "utf8")).not.toContain(data.callbackToken);
			calls.push({ verb, params });
			return undefined as T;
		},
	};
	await new KakaoInbound(gateway, state, () => 1234).handleDispatch("MESSAGE_CREATE", data);
	expect(calls).toEqual([
		{
			verb: "chat.send",
			params: {
				origin,
				text: "hello",
				messageId: "bg2_group:1234567890123456789",
				receivedAt: data.timestamp,
				engagement: { mentioned: true, group: false, authorId: data.botUserKey },
			},
		},
	]);
	expect((await KakaoAdapterState.load(home)).tokenFor(origin)).toBeUndefined();
});

test("group messages are addressed to the bot, and non-message events log their type only", async () => {
	const { state } = await stateFixture();
	const calls: unknown[] = [];
	const logs: string[] = [];
	const gateway: GatewayRequester = {
		async request<T>(verb: string, params?: unknown): Promise<T> {
			calls.push({ verb, params });
			return undefined as T;
		},
	};
	const inbound = new KakaoInbound(gateway, state, () => 0, { info: (line) => logs.push(line) });
	await inbound.handleDispatch("MESSAGE_CREATE", { ...data, isChannelChatroom: false, callbackToken: undefined });
	expect(calls).toEqual([
		{
			verb: "chat.send",
			params: {
				origin: { platform: "kakao", kind: "channel", conversationId: "bg2_group" },
				text: data.content,
				messageId: `bg2_group:${data.id}`,
				receivedAt: data.timestamp,
				engagement: { mentioned: true, group: true, authorId: data.botUserKey },
			},
		},
	]);
	for (const type of ["ENTRANCE", "CHAT_JOIN", "LEAVE", "AD_REWARD"])
		await inbound.handleDispatch(type, { callbackToken: "secret", content: "private" });
	expect(calls).toHaveLength(1);
	expect(logs).toEqual(["ENTRANCE", "CHAT_JOIN", "LEAVE", "AD_REWARD"].map((type) => `kakao_event type=${type}`));
});

test("empty or incomplete MESSAGE_CREATE opens no turn", async () => {
	const { state } = await stateFixture();
	let sent = 0;
	const gateway: GatewayRequester = {
		async request<T>(): Promise<T> {
			sent++;
			return undefined as T;
		},
	};
	const inbound = new KakaoInbound(gateway, state);
	for (const patch of [
		{ content: " " },
		{ botGroupKey: "" },
		{ botUserKey: undefined },
		{ id: Number.MAX_SAFE_INTEGER + 2 },
		{ isChannelChatroom: undefined },
	])
		await inbound.handleDispatch("MESSAGE_CREATE", { ...data, ...patch });
	expect(sent).toBe(0);
});

test("a failed route persistence queues the event and retries before chat.send", async () => {
	const { state } = await stateFixture();
	// Atomic rename cannot replace a directory with a file.
	await mkdir(state.path);
	let sent = 0;
	const gateway: GatewayRequester = {
		async request<T>(): Promise<T> {
			sent++;
			return undefined as T;
		},
	};
	const clock = new FakeClock();
	const inbound = new KakaoInbound(gateway, state, clock.now, quietLog, clock);
	await inbound.handleDispatch("MESSAGE_CREATE", data);
	expect(sent).toBe(0);
	await rm(state.path, { recursive: true });
	clock.advance(1_000);
	await waitFor(() => sent === 1);
	inbound.stop();
});

async function waitFor(predicate: () => boolean) {
	for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(2);
	expect(predicate()).toBe(true);
}

test("gateway rejects twice then accepts original params once, preserving per-origin message order", async () => {
	const { state } = await stateFixture();
	const clock = new FakeClock();
	const attempts: Record<string, unknown>[] = [];
	const accepted: Record<string, unknown>[] = [];
	const gateway: GatewayRequester = {
		async request<T>(_verb: string, params?: unknown): Promise<T> {
			attempts.push(params as Record<string, unknown>);
			if (attempts.length <= 2) throw new Error("gateway unavailable");
			accepted.push(params as Record<string, unknown>);
			return { turnId: "turn" } as T;
		},
	};
	const inbound = new KakaoInbound(gateway, state, clock.now, quietLog, clock);
	await inbound.handleDispatch("MESSAGE_CREATE", data, 123);
	const origin = kakaoMessageOrigin(data);
	expect(state.takeToken(origin)?.receivedAt).toBe(123);
	await inbound.handleDispatch(
		"MESSAGE_CREATE",
		{ ...data, id: "second", content: "second", callbackToken: "newer" },
		124,
	);
	clock.advance(1_000);
	await waitFor(() => attempts.length === 2);
	expect(state.tokenFor(origin)).toEqual({ token: "newer", receivedAt: 124 });
	state.takeToken(origin);
	clock.advance(2_000);
	await waitFor(() => accepted.length === 2);
	expect(attempts.slice(0, 3)).toEqual([attempts[0], attempts[0], attempts[0]]);
	expect(accepted.map((params) => params.messageId)).toEqual([`bg2_group:${data.id}`, "bg2_group:second"]);
	expect(accepted[0]).toEqual(attempts[0]);
	expect(state.tokenFor(origin)).toBeUndefined();
	inbound.stop();
});

test("receipt time precedes delayed dispatch and oversized origins are rejected without sending", async () => {
	const { state } = await stateFixture();
	let sent = 0;
	const logs: string[] = [];
	const gateway: GatewayRequester = {
		async request<T>(): Promise<T> {
			sent++;
			return undefined as T;
		},
	};
	const inbound = new KakaoInbound(gateway, state, () => 250_000, { info: (line) => logs.push(line) });
	await inbound.handleDispatch("MESSAGE_CREATE", data, 100);
	expect(state.tokenFor(kakaoMessageOrigin(data))?.receivedAt).toBe(100);
	await inbound.handleDispatch("MESSAGE_CREATE", { ...data, botGroupKey: "a".repeat(257) });
	expect(sent).toBe(1);
	expect(logs).toEqual(["kakao_inbound result=invalid_origin"]);
});

test("retry queue drops the oldest event when bounded capacity is exceeded", async () => {
	const { state } = await stateFixture();
	const clock = new FakeClock();
	const logs: string[] = [];
	const accepted: string[] = [];
	let available = false;
	const gateway: GatewayRequester = {
		async request<T>(_verb: string, params?: unknown): Promise<T> {
			if (!available) throw new Error("offline");
			accepted.push((params as { messageId: string }).messageId);
			return undefined as T;
		},
	};
	const inbound = new KakaoInbound(gateway, state, clock.now, { info: (line) => logs.push(line) }, clock);
	for (let i = 0; i < 501; i++) await inbound.handleDispatch("MESSAGE_CREATE", { ...data, id: String(i) });
	expect(logs.filter((line) => line.includes("queue_full"))).toHaveLength(1);
	available = true;
	clock.advance(1_000);
	await waitFor(() => accepted.length > 0);
	expect(accepted[0]).toBe("bg2_group:1");
	await waitFor(() => accepted.length === 500);
	inbound.stop();
});

test("newer callback token replaces older, and concurrent route saves survive reload", async () => {
	const { home, state } = await stateFixture();
	const first = kakaoMessageOrigin(data);
	const second = kakaoMessageOrigin({ ...data, botGroupKey: "bg2_other" });
	state.rememberToken(first, "new", 10);
	state.rememberToken(first, "older", 9);
	expect(state.tokenFor(first)).toEqual({ token: "new", receivedAt: 10 });
	state.rememberToken(first, "latest", 11);
	expect(state.takeToken(first)?.token).toBe("latest");
	expect(state.takeToken(first)).toBeUndefined();
	const route = { botGroupKey: data.botGroupKey, botUserKey: data.botUserKey, channelChatroom: true };
	await Promise.all([
		state.rememberRoute(first, route),
		state.rememberRoute(second, { ...route, botGroupKey: "bg2_other" }),
	]);
	const reloaded = await KakaoAdapterState.load(home);
	expect(reloaded.routeFor(first)).toEqual(route);
	expect(reloaded.routeFor(second)?.botGroupKey).toBe("bg2_other");
});

test("state ignores partial route rows and rejects corrupt state", async () => {
	const { home, state } = await stateFixture();
	await writeFile(state.path, JSON.stringify({ routes: { incomplete: { botGroupKey: "group" } } }));
	expect((await KakaoAdapterState.load(home)).routeFor(kakaoMessageOrigin(data))).toBeUndefined();
	await writeFile(state.path, "bad json");
	await expect(KakaoAdapterState.load(home)).rejects.toThrow("Unable to read Kakao adapter state");
});

test("a RESUME replay of a handled MESSAGE_CREATE neither resends nor reinstalls its consumed token", async () => {
	const { state } = await stateFixture();
	const sent: unknown[] = [];
	const gateway: GatewayRequester = {
		async request<T>(_verb: string, params?: unknown): Promise<T> {
			sent.push(params);
			return { turnId: "turn" } as T;
		},
	};
	const inbound = new KakaoInbound(gateway, state, () => 1234, quietLog);
	const origin = kakaoMessageOrigin(data);
	await inbound.handleDispatch("MESSAGE_CREATE", data);
	expect(state.takeToken(origin)?.token).toBe(data.callbackToken);
	await inbound.handleDispatch("MESSAGE_CREATE", data);
	expect(sent).toHaveLength(1);
	expect(state.tokenFor(origin)).toBeUndefined();
	await inbound.handleDispatch("MESSAGE_CREATE", { ...data, id: "next", callbackToken: "fresh" });
	expect(sent).toHaveLength(2);
	expect(state.tokenFor(origin)?.token).toBe("fresh");
});
