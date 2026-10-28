import { expect, test } from "bun:test";
import { KakaoApiError, KakaoBotApi } from "../src/api";

const route = { botGroupKey: "bg2_group", botUserKey: "bu2_user", channelChatroom: false };
const success = () => Response.json({ totalCount: 1, sendCount: 1, errorCount: 0 });

test("callback sends SkillResponse and the credential headers", async () => {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	const bot = new KakaoBotApi("bot-secret", async (url, init) => {
		calls.push({ url: String(url), init });
		return Response.json({ totalCount: 2, sendCount: 2, errorCount: 0 });
	});
	await bot.callback("callback-secret", ["first", "second"]);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.url).toBe("https://kapi.kakao.com/v1/bot/callback");
	expect(calls[0]?.init?.method).toBe("POST");
	expect(calls[0]?.init?.headers).toEqual({
		Authorization: "KakaoAK bot-secret",
		"Content-Type": "application/json",
		"X-Bot-Callback-Token": "callback-secret",
	});
	expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
		skillResponse: {
			version: "2.0",
			template: { outputs: [{ simpleText: { text: "first" } }, { simpleText: { text: "second" } }] },
		},
	});
});

test("send_message selects botUserKey only for channel chatrooms, otherwise botGroupKey", async () => {
	const bodies: Record<string, unknown>[] = [];
	const bot = new KakaoBotApi("secret", async (_url, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		expect(new Headers(init?.headers).has("X-Bot-Callback-Token")).toBe(false);
		return success();
	});
	await bot.sendMessage({ ...route, channelChatroom: true }, ["dm"]);
	await bot.sendMessage(route, ["group"]);
	expect(bodies[0]?.botUserKey).toBe(route.botUserKey);
	expect(bodies[0]?.botGroupKey).toBeUndefined();
	expect(bodies[1]?.botGroupKey).toBe(route.botGroupKey);
	expect(bodies[1]?.botUserKey).toBeUndefined();
});

test("4xx, parsed Kakao refusals and zero sends with errors are definitive", async () => {
	for (const [status, body] of [
		[403, { msg: "refused" }],
		[429, "not json"],
		[200, { code: -1, msg: "denied" }],
		[200, { totalCount: 1, sendCount: 0, errorCount: 1 }],
	] as const) {
		const bot = new KakaoBotApi(
			"secret",
			async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
		);
		try {
			await bot.callback("callback", ["text"]);
			throw new Error("expected refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(KakaoApiError);
			expect((error as KakaoApiError).status).toBe(status);
		}
	}
});

test("5xx, network errors and unreadable/unrecognized 2xx remain ambiguous", async () => {
	for (const fetcher of [
		async () => new Response(JSON.stringify({ code: -1, msg: "down" }), { status: 503 }),
		async () => {
			throw new Error("network unavailable");
		},
		async () => new Response("invalid json"),
		async () => Response.json({ unknown: true }),
		async () => Response.json({ totalCount: 1, sendCount: 0, errorCount: 0 }),
		async () => Response.json({ totalCount: 2, sendCount: 2, errorCount: 0 }),
		async () => Response.json({ totalCount: 2, sendCount: 1, errorCount: 0 }),
		async () => Response.json({ totalCount: 1, sendCount: 1.5, errorCount: 0 }),
	]) {
		try {
			await new KakaoBotApi("secret", fetcher).sendMessage(route, ["text"]);
			throw new KakaoApiError(0, "expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(KakaoApiError);
		}
	}
});

test("positive partial sends are ambiguous, including a short send count without errors", async () => {
	for (const errorCount of [0, 1]) {
		const bot = new KakaoBotApi("secret", async () => Response.json({ totalCount: 2, sendCount: 1, errorCount }));
		try {
			await bot.callback("callback", ["first", "second"]);
			throw new KakaoApiError(0, "expected partial failure");
		} catch (error) {
			expect(error).not.toBeInstanceOf(KakaoApiError);
			expect((error as Error).message).toContain("partial");
		}
	}
});

test("positive sends are ambiguous even under a 4xx or a nonzero code", async () => {
	for (const response of [
		() => Response.json({ totalCount: 1, sendCount: 1, errorCount: 0 }, { status: 400 }),
		() => Response.json({ totalCount: 1, sendCount: 1, errorCount: 0, code: -1 }),
	]) {
		const bot = new KakaoBotApi("secret", async () => response());
		try {
			await bot.callback("callback", ["only"]);
			throw new KakaoApiError(0, "expected failure");
		} catch (error) {
			expect(error).not.toBeInstanceOf(KakaoApiError);
			expect((error as Error).message).toContain("partial");
		}
	}
});

test("request timeout covers stalled fetch and stalled response body", async () => {
	for (const fetcher of [
		async () => new Promise<Response>(() => {}),
		async () => new Response(new ReadableStream({ start() {} })),
	]) {
		const bot = new KakaoBotApi("secret", fetcher, 5);
		await expect(bot.callback("callback", ["text"])).rejects.toThrow("timed out");
	}
});

test("a 4xx remains definitive even when reading its error body times out", async () => {
	const bot = new KakaoBotApi(
		"secret",
		async () => new Response(new ReadableStream({ start() {} }), { status: 429 }),
		5,
	);
	try {
		await bot.callback("callback", ["text"]);
		throw new Error("expected refusal");
	} catch (error) {
		expect(error).toBeInstanceOf(KakaoApiError);
		expect((error as KakaoApiError).status).toBe(429);
	}
});

test("every failure redacts bot and callback credentials, including thrown network errors", async () => {
	const token = "bot/secret+value";
	const callback = "callback/secret+value";
	for (const fetcher of [
		async () => Response.json({ code: -1, msg: `refused ${token} ${callback} ${encodeURIComponent(token)}` }),
		async () => {
			throw new Error(`network ${token} ${callback} ${encodeURIComponent(callback)}`);
		},
	]) {
		try {
			await new KakaoBotApi(token, fetcher).callback(callback, ["text"]);
			throw new Error("missing failure");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("[REDACTED]");
			for (const secret of [token, callback, encodeURIComponent(token), encodeURIComponent(callback)])
				expect(message).not.toContain(secret);
		}
	}
});

test("mentions become SkillResponse extra.mentions keyed by placeholder with botUserKey ids", async () => {
	const bodies: Record<string, unknown>[] = [];
	const bot = new KakaoBotApi("secret", async (_url, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		return success();
	});
	await bot.callback("callback", ["{{#mentions.asker}} hi"], { asker: "bu2_asker" });
	await bot.callback("callback", ["plain"], {});
	expect(bodies[0]).toEqual({
		skillResponse: {
			version: "2.0",
			template: { outputs: [{ simpleText: { text: "{{#mentions.asker}} hi" } }] },
			extra: { mentions: { asker: { type: "botUserKey", id: "bu2_asker" } } },
		},
	});
	expect((bodies[1]?.skillResponse as Record<string, unknown>).extra).toBeUndefined();
});
