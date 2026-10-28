import type { KakaoReplyRoute } from "./state";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export const KAKAO_REQUEST_TIMEOUT_MS = 15_000;

/** Mention placeholders used in bubble text, mapped to the botUserKey each one names. */
/** Kakao renders at most 15 mentions in one response. */
export const KAKAO_MAX_MENTIONS = 15;

export type KakaoMentions = Readonly<Record<string, string>>;

export class KakaoApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "KakaoApiError";
	}
}

export class KakaoBotApi {
	constructor(
		private readonly token: string,
		private readonly fetcher: FetchLike = fetch,
		private readonly timeoutMs: number = KAKAO_REQUEST_TIMEOUT_MS,
	) {}

	callback(callbackToken: string, bubbles: readonly string[], mentions?: KakaoMentions): Promise<void> {
		return this.#post("callback", {}, bubbles, callbackToken, mentions);
	}

	sendMessage(route: KakaoReplyRoute, bubbles: readonly string[], mentions?: KakaoMentions): Promise<void> {
		return this.#post(
			"send_message",
			route.channelChatroom ? { botUserKey: route.botUserKey } : { botGroupKey: route.botGroupKey },
			bubbles,
			undefined,
			mentions,
		);
	}

	async #post(
		method: string,
		target: Record<string, unknown>,
		bubbles: readonly string[],
		callbackToken?: string,
		mentions?: KakaoMentions,
	): Promise<void> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let refusalStatus: number | undefined;
		try {
			await Promise.race([
				(async () => {
					const response = await this.fetcher(`https://kapi.kakao.com/v1/bot/${method}`, {
						method: "POST",
						headers: {
							Authorization: `KakaoAK ${this.token}`,
							"Content-Type": "application/json",
							...(callbackToken ? { "X-Bot-Callback-Token": callbackToken } : {}),
						},
						body: JSON.stringify({
							...target,
							skillResponse: {
								version: "2.0",
								template: { outputs: bubbles.map((text) => ({ simpleText: { text } })) },
								...(mentions && Object.keys(mentions).length > 0
									? {
											extra: {
												mentions: Object.fromEntries(
													Object.entries(mentions).map(([key, id]) => [key, { type: "botUserKey", id }]),
												),
											},
										}
									: {}),
							},
						}),
						signal: controller.signal,
					});
					if (response.status >= 400 && response.status < 500) refusalStatus = response.status;
					if (response.status >= 500) throw new Error(`Kakao ${method} HTTP ${response.status}`);
					let body: unknown;
					try {
						body = await response.json();
					} catch {
						if (response.status >= 400 && response.status < 500)
							throw new KakaoApiError(response.status, `Kakao ${method} HTTP ${response.status}`);
						throw new Error(`Kakao ${method} returned an unreadable response`);
					}
					const result = isObject(body) ? body : {};
					const sent = result.sendCount;
					const errors = result.errorCount;
					// Any positive send count means something may be on screen, whatever the status
					// or code says: that is never a definitive refusal a caller could resend after.
					if (
						typeof sent === "number" &&
						sent > 0 &&
						(!response.ok ||
							(typeof result.code === "number" && result.code !== 0) ||
							(typeof errors === "number" && errors > 0) ||
							sent < bubbles.length)
					) {
						refusalStatus = undefined;
						throw new Error(`Kakao ${method} partial delivery`);
					}
					if (
						(response.status >= 400 && response.status < 500) ||
						(typeof result.code === "number" && result.code !== 0) ||
						(sent === 0 && typeof errors === "number" && errors > 0)
					) {
						const detail =
							typeof result.msg === "string"
								? result.msg
								: typeof result.message === "string"
									? result.message
									: "message refused";
						throw new KakaoApiError(response.status, `Kakao ${method} HTTP ${response.status}: ${detail}`);
					}
					if (!response.ok || sent !== bubbles.length || errors !== 0 || result.totalCount !== bubbles.length)
						throw new Error(`Kakao ${method} returned an unrecognized response`);
				})(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						reject(new Error(`Kakao ${method} request timed out`));
						controller.abort();
					}, this.timeoutMs);
				}),
			]);
		} catch (error) {
			let message = error instanceof Error ? error.message : String(error);
			for (const secret of [this.token, callbackToken]) {
				if (!secret) continue;
				for (const spelling of [secret, encodeURIComponent(secret)])
					message = message.split(spelling).join("[REDACTED]");
			}
			if (error instanceof KakaoApiError) throw new KakaoApiError(error.status, message);
			if (refusalStatus !== undefined) throw new KakaoApiError(refusalStatus, message);
			throw new Error(message);
		} finally {
			clearTimeout(timer);
		}
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
