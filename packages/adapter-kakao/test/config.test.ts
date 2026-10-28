import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { adapterHome, loadKakaoAdapterConfig } from "../src/config";
import { runKakaoAdapterWithLease } from "../src/main";

const homes: string[] = [];
afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function homeFixture() {
	const home = await mkdtemp(`${import.meta.dir}/.tmp-config-`);
	homes.push(home);
	return home;
}

test("config resolves relative tokenFile and defaults adapterHome like Telegram", async () => {
	const home = await homeFixture();
	await writeFile(join(home, "token"), " bot-secret\n");
	await writeFile(
		join(home, "adapter-kakao.json"),
		JSON.stringify({ tokenFile: "token", gatewaySocket: "/gateway.sock" }),
	);
	expect(await loadKakaoAdapterConfig({ GAJAEWAY_HOME: home })).toEqual({
		tokenFile: join(home, "token"),
		token: "bot-secret",
		configPath: join(home, "adapter-kakao.json"),
		gatewaySocket: "/gateway.sock",
	});
	expect(adapterHome({})).toBe(join(homedir(), ".gajaeway"));
	expect(adapterHome({ GAJAEWAY_HOME: "" })).toBe(join(homedir(), ".gajaeway"));
});

test("invalid/missing config and credentials produce actionable startup errors without contents", async () => {
	const home = await homeFixture();
	await expect(loadKakaoAdapterConfig({ GAJAEWAY_HOME: home })).rejects.toThrow("Unable to read Kakao adapter config");
	for (const config of [{}, { tokenFile: " " }, { tokenFile: "token", gatewaySocket: 1 }]) {
		await writeFile(join(home, "adapter-kakao.json"), JSON.stringify(config));
		await expect(loadKakaoAdapterConfig({ GAJAEWAY_HOME: home })).rejects.toThrow(/Kakao adapter/);
	}
	await writeFile(join(home, "adapter-kakao.json"), JSON.stringify({ tokenFile: "token" }));
	await expect(loadKakaoAdapterConfig({ GAJAEWAY_HOME: home })).rejects.toThrow(
		"Unable to read Kakao token credential file",
	);
	await writeFile(join(home, "token"), " \n");
	await expect(loadKakaoAdapterConfig({ GAJAEWAY_HOME: home })).rejects.toThrow("is empty");
});

test("adapter-kakao lease releases on startup failure and can be acquired again", async () => {
	const home = await homeFixture();
	await expect(
		runKakaoAdapterWithLease(home, async () => {
			throw new Error("startup failed");
		}),
	).rejects.toThrow("startup failed");
	expect(await runKakaoAdapterWithLease(home, async () => "reacquired")).toBe("reacquired");
});
