import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface KakaoAdapterConfig {
	readonly tokenFile: string;
	readonly gatewaySocket?: string;
}

export interface LoadedKakaoAdapterConfig extends KakaoAdapterConfig {
	readonly token: string;
	readonly configPath: string;
}

export class KakaoAdapterStartupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KakaoAdapterStartupError";
	}
}

export function adapterHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.GAJAEWAY_HOME || join(homedir(), ".gajaeway");
}

export async function loadKakaoAdapterConfig(env: NodeJS.ProcessEnv = process.env): Promise<LoadedKakaoAdapterConfig> {
	const configPath = join(adapterHome(env), "adapter-kakao.json");
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(configPath, "utf8"));
	} catch {
		throw new KakaoAdapterStartupError(
			`Unable to read Kakao adapter config at ${configPath}. Create it with a tokenFile credential-file path.`,
		);
	}
	if (!isObject(raw) || typeof raw.tokenFile !== "string" || raw.tokenFile.trim() === "") {
		throw new KakaoAdapterStartupError(
			`Kakao adapter config at ${configPath} requires a non-empty tokenFile credential-file path.`,
		);
	}
	if (raw.gatewaySocket !== undefined && typeof raw.gatewaySocket !== "string") {
		throw new KakaoAdapterStartupError("Kakao adapter gatewaySocket must be a string when set.");
	}
	const tokenFile = isAbsolute(raw.tokenFile) ? raw.tokenFile : resolve(dirname(configPath), raw.tokenFile);
	let token: string;
	try {
		token = (await readFile(tokenFile, "utf8")).trim();
	} catch {
		throw new KakaoAdapterStartupError(
			`Unable to read Kakao token credential file ${tokenFile}. Check tokenFile and file permissions.`,
		);
	}
	if (!token) throw new KakaoAdapterStartupError(`Kakao token credential file ${tokenFile} is empty.`);
	return {
		tokenFile,
		token,
		configPath,
		...(typeof raw.gatewaySocket === "string" ? { gatewaySocket: raw.gatewaySocket } : {}),
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
