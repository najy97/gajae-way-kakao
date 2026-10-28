import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type OriginRef, originKey } from "@gajae-gateway/protocol";

export interface KakaoReplyRoute {
	readonly botGroupKey: string;
	readonly botUserKey: string;
	readonly channelChatroom: boolean;
}

export interface KakaoCallbackToken {
	readonly token: string;
	readonly receivedAt: number;
}

export class KakaoAdapterState {
	readonly #routes = new Map<string, KakaoReplyRoute>();
	readonly #tokens = new Map<string, KakaoCallbackToken>();
	#saving: Promise<void> = Promise.resolve();

	private constructor(readonly path: string) {}

	static async load(home: string): Promise<KakaoAdapterState> {
		const state = new KakaoAdapterState(join(home, "adapter-kakao-state.json"));
		try {
			const parsed = JSON.parse(await readFile(state.path, "utf8")) as { routes?: Record<string, unknown> };
			for (const [key, value] of Object.entries(parsed.routes ?? {})) {
				if (typeof value !== "object" || value === null) continue;
				const route = value as Partial<KakaoReplyRoute>;
				if (
					typeof route.botGroupKey === "string" &&
					route.botGroupKey &&
					typeof route.botUserKey === "string" &&
					route.botUserKey &&
					typeof route.channelChatroom === "boolean"
				)
					state.#routes.set(key, {
						botGroupKey: route.botGroupKey,
						botUserKey: route.botUserKey,
						channelChatroom: route.channelChatroom,
					});
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error(`Unable to read Kakao adapter state at ${state.path}`);
		}
		return state;
	}

	async rememberRoute(origin: OriginRef, route: KakaoReplyRoute): Promise<void> {
		this.#routes.set(originKey(origin), { ...route });
		await this.save();
	}

	routeFor(origin: OriginRef): KakaoReplyRoute | undefined {
		return this.#routes.get(originKey(origin));
	}

	rememberToken(origin: OriginRef, token: string, receivedAt: number): void {
		const key = originKey(origin);
		const previous = this.#tokens.get(key);
		if (!previous || receivedAt >= previous.receivedAt) this.#tokens.set(key, { token, receivedAt });
	}

	tokenFor(origin: OriginRef): KakaoCallbackToken | undefined {
		return this.#tokens.get(originKey(origin));
	}

	takeToken(origin: OriginRef): KakaoCallbackToken | undefined {
		const key = originKey(origin);
		const token = this.#tokens.get(key);
		this.#tokens.delete(key);
		return token;
	}

	save(): Promise<void> {
		const payload = `${JSON.stringify({ routes: Object.fromEntries(this.#routes) })}\n`;
		const next = this.#saving
			.catch(() => {})
			.then(async () => {
				await mkdir(dirname(this.path), { recursive: true });
				const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
				await writeFile(temporary, payload, { mode: 0o600 });
				await rename(temporary, this.path);
			});
		this.#saving = next;
		return next;
	}
}
