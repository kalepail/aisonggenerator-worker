import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createTestBundler } from "./helpers.mjs";

let bundler;
let languageMod;
let cfMod;
let lyricsMod;

before(async () => {
	bundler = createTestBundler("aisg-lyrics-test-");
	languageMod = await bundler.bundle("src/api/language.ts", "language.mjs");
	cfMod = await bundler.bundle("src/api/cf.ts", "cf.mjs");
	lyricsMod = await bundler.bundle("src/api/lyrics.ts", "lyrics.mjs");
});

after(() => {
	bundler?.cleanup();
});

test("promptAllowsHan allows Chinese/Japanese prompts and rejects English/Korean prompts", () => {
	assert.equal(languageMod.promptAllowsHan("hip hop style, everyday working person song"), false);
	assert.equal(languageMod.promptAllowsHan("K-pop dance song, half Korean and half English"), false);
	assert.equal(languageMod.promptAllowsHan("서울의 밤 K-pop dance track"), false);
	assert.equal(languageMod.promptAllowsHan("Mandarin pop ballad about autumn rain in Taipei"), true);
	assert.equal(languageMod.promptAllowsHan("Cantonese ballad about Hong Kong"), true);
	assert.equal(languageMod.promptAllowsHan("c-pop upbeat track"), true);
	assert.equal(languageMod.promptAllowsHan("一首关于雨夜的歌"), true);
	assert.equal(languageMod.promptAllowsHan("J-pop anime opening theme"), true);
	assert.equal(languageMod.promptAllowsHan("夜の街を歩く"), true);
});

test("hasUnexpectedChinese catches Han in title, lyrics, or style tags unless expected", () => {
	const enPrompt = "hip hop style, everyday working person song";
	assert.equal(
		languageMod.hasUnexpectedChinese(enPrompt, {
			title: "夜班诗人",
			lyrics: "[Verse 1]\nWorking hard",
			style: ["hip hop", "boom bap"],
		}),
		true
	);
	assert.equal(
		languageMod.hasUnexpectedChinese(enPrompt, {
			title: "Late Shift",
			lyrics: "[Verse 1]\n凌晨的办公室",
			style: ["hip hop", "boom bap"],
		}),
		true
	);
	assert.equal(
		languageMod.hasUnexpectedChinese(enPrompt, {
			title: "Late Shift",
			lyrics: "[Verse 1]\nWorking hard",
			style: ["hip hop", "节奏"],
		}),
		true
	);
	assert.equal(
		languageMod.hasUnexpectedChinese(enPrompt, {
			title: "Late Shift",
			lyrics: "[Verse 1]\nWorking hard",
			style: ["hip hop", "boom bap"],
		}),
		false
	);

	// Korean Hangul is allowed on K-pop prompt, Han is not
	const koPrompt = "K-pop track, half Korean and half English";
	assert.equal(
		languageMod.hasUnexpectedChinese(koPrompt, {
			title: "Bob (밥)",
			lyrics: "[Chorus]\n밥, 밥, 모두가 반해",
			style: ["K-pop", "dance pop"],
		}),
		false
	);
	assert.equal(
		languageMod.hasUnexpectedChinese(koPrompt, {
			title: "夜班诗人",
			lyrics: "[Chorus]\n밥, 밥",
			style: ["K-pop", "dance pop"],
		}),
		true
	);

	// Explicit Mandarin request allows Han
	assert.equal(
		languageMod.hasUnexpectedChinese("Mandarin pop ballad", {
			title: "秋雨台北",
			lyrics: "[Verse 1]\n秋雨落在台北街頭",
			style: ["Mandarin pop", "ballad"],
		}),
		false
	);
});

test("aisonggenerator.io retries on unexpected Chinese and succeeds when a retry returns English", async () => {
	const origFetch = globalThis.fetch;
	const seenPrompts = [];
	let calls = 0;

	globalThis.fetch = async (url, init) => {
		assert.equal(String(url), "https://aisonggenerator.io/api/music/lyrics/generate");
		calls++;
		const body = JSON.parse(init.body);
		seenPrompts.push(body.prompt);
		if (calls <= 2) {
			return new Response(
				JSON.stringify({
					title: "夜班诗人",
					lyrics: "[Verse 1]\n凌晨的办公室",
					tags: "静谧, 沉稳",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			);
		}
		return new Response(
			JSON.stringify({
				title: "Time Clock Hero",
				lyrics: "[Verse 1]\nSix AM coffee in a chipped mug",
				tags: "boom bap hip hop, dusty drums, warm bass",
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } }
		);
	};

	try {
		const env = {
			AISONGGENERATOR_SESSION_TOKEN: "test-token",
			AI: {
				run: async () => {
					throw new Error("should not hit CF AI");
				},
			},
		};
		const result = await lyricsMod.generateLyricsWithFallback("hip hop style, everyday working person song", env);
		assert.equal(calls, 3);
		assert.equal(result.service, "aisonggenerator.io");
		assert.equal(result.title, "Time Clock Hero");
		assert.doesNotMatch(seenPrompts[0], /IMPORTANT:/);
		assert.match(seenPrompts[1], /IMPORTANT:/);
		assert.match(seenPrompts[2], /IMPORTANT:/);
	} finally {
		globalThis.fetch = origFetch;
	}
});

test("aisonggenerator.io falls back directly to Cloudflare AI after 3 unexpected Chinese attempts or <2 style tags", async () => {
	const origFetch = globalThis.fetch;
	let aisgCalls = 0;
	const aiModelsCalled = [];

	globalThis.fetch = async (url) => {
		if (String(url).includes("aisonggenerator.io")) {
			aisgCalls++;
			return new Response(
				JSON.stringify({
					title: "像素之眼",
					lyrics: "[Verse 1]\n暗影浮动",
					tags: "合成器流行, 电子舞曲",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			);
		}
		throw new Error(`Unexpected fetch: ${url}`);
	};

	try {
		const env = {
			AISONGGENERATOR_SESSION_TOKEN: "test-token",
			AI: {
				run: async (model, input) => {
					aiModelsCalled.push({ model, input });
					return {
						choices: [
							{
								message: {
									content: JSON.stringify({
										title: "Clock In, Clock Out",
										lyrics: "[Verse 1]\nWoke up before the sun\n\n[Chorus]\nClock in, clock out",
										style: ["90s boom bap hip hop", "dusty snare", "warm Rhodes", "gritty male vocals"],
									}),
								},
								finish_reason: "stop",
							},
						],
					};
				},
			},
		};

		const result = await lyricsMod.generateLyricsWithFallback("hip hop style, everyday working person song", env);
		assert.equal(aisgCalls, 3);
		assert.equal(result.service, "cloudflare-ai");
		assert.equal(result.title, "Clock In, Clock Out");
		assert.equal(aiModelsCalled.length, 1);
		assert.equal(aiModelsCalled[0].model, cfMod.PRIMARY_LYRICS_MODEL);
		assert.equal(aiModelsCalled[0].input.reasoning_effort, "low");

		// Single style tag from AISG fails fast (1 attempt) and falls back to Cloudflare AI
		aisgCalls = 0;
		globalThis.fetch = async () => {
			aisgCalls++;
			return new Response(
				JSON.stringify({
					title: "One Tag Wonder",
					lyrics: "[Verse 1]\nOnly one tag here",
					tags: "synthwave",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			);
		};

		const singleTagFallback = await lyricsMod.generateLyricsWithFallback("synthwave night drive", env);
		assert.equal(aisgCalls, 1);
		assert.equal(singleTagFallback.service, "cloudflare-ai");
		assert.equal(singleTagFallback.style.length, 4);
	} finally {
		globalThis.fetch = origFetch;
	}
});

test("songWrite falls back GLM-5.3 -> DeepSeek V4.1 Flash -> Llama 3.3 70B on errors or unexpected Chinese", async () => {
	const modelsCalled = [];
	const env = {
		AI: {
			run: async (model) => {
				modelsCalled.push(model);
				if (model === cfMod.PRIMARY_LYRICS_MODEL) {
					return {
						choices: [
							{
								message: {
									content: JSON.stringify({
										title: "意外中文",
										lyrics: "[Verse 1]\n意外的中文歌词",
										style: ["indie folk", "acoustic guitar"],
									}),
								},
							},
						],
					};
				}
				if (model === cfMod.SECONDARY_LYRICS_MODEL) {
					throw new Error("rate limit 429");
				}
				return {
					response: {
						title: "Late Train Home",
						lyrics: "[Verse 1]\nRain on the window glass\n\n[Chorus]\nLate train home",
						style: ["indie folk", "fingerpicked acoustic guitar", "intimate male vocals", "melancholic"],
					},
				};
			},
		},
	};

	const result = await cfMod.songWrite(env, "rainy Tuesday train home, indie folk");
	assert.deepEqual(modelsCalled, [
		cfMod.PRIMARY_LYRICS_MODEL,
		cfMod.SECONDARY_LYRICS_MODEL,
		cfMod.FALLBACK_LYRICS_MODEL,
	]);
	assert.equal(result.title, "Late Train Home");
	assert.equal(result.style.length, 4);
});

test("songWrite gives all three models a share of one 25-second deadline", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const calls = [];
	const env = {
		CF_AI_GATEWAY_ID: "test-gateway",
		AI: {
			run(model, _input, options) {
				calls.push({ model, at: Date.now(), signal: options.signal });
				return new Promise(() => {});
			},
		},
	};

	let settled = false;
	const result = assert.rejects(cfMod.songWrite(env, "write a folk song"), /All Cloudflare AI lyrics models failed/)
		.then(() => { settled = true; });
	for (const duration of [8_333, 8_333, 8_333]) {
		t.mock.timers.tick(duration);
		await new Promise(setImmediate);
	}
	assert.deepEqual(calls.map(({ model, at }) => [model, at]), [
		[cfMod.PRIMARY_LYRICS_MODEL, 0],
		[cfMod.SECONDARY_LYRICS_MODEL, 8_333],
		[cfMod.FALLBACK_LYRICS_MODEL, 16_666],
	]);
	assert.equal(settled, false);
	t.mock.timers.tick(1);
	await result;
	assert.equal(Date.now(), 25_000);
	assert.ok(calls.every(({ signal }) => signal.aborted));
});

test("songWrite forwards the optional gateway on every fallback and omits options when unset", async () => {
	for (const gatewayId of [undefined, "test-gateway"]) {
		const calls = [];
		const env = {
			CF_AI_GATEWAY_ID: gatewayId,
			AI: {
				async run(...args) {
					calls.push(args);
					if (args[0] !== cfMod.FALLBACK_LYRICS_MODEL) {
						throw new Error("temporary model failure");
					}
					return { response: { title: "Song", lyrics: "Verse", style: ["folk", "acoustic"] } };
				},
			},
		};

		await cfMod.songWrite(env, "write a folk song");
		assert.equal(calls.length, 3);
		for (const args of calls) {
			if (gatewayId) {
				assert.deepEqual(args[2].gateway, { id: gatewayId });
				assert.equal(args[2].signal.aborted, false);
			} else {
				assert.equal(args.length, 2);
			}
		}
	}
});

test("songWrite stops fallback when AI Gateway reports an exhausted spend limit", async (t) => {
	const ai = {
		async run() {
			throw new Error("AiGatewayError: 2052: Insufficient unified billing balance for this request");
		},
	};
	const run = t.mock.method(ai, "run");
	await assert.rejects(
		cfMod.songWrite({ CF_AI_GATEWAY_ID: "test-gateway", AI: ai }, "write a folk song"),
		/All Cloudflare AI lyrics models failed/
	);
	assert.equal(run.mock.callCount(), 1);
});

test("AISG lyrics retries reserve enough time for the Workers AI fallback", async (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const timeout = t.mock.method(AbortSignal, "timeout", () => new AbortController().signal);
	t.mock.method(globalThis, "fetch", async () => {
		t.mock.timers.tick(9_500);
		return Response.json({ title: "意外中文", lyrics: "意外的中文歌词", tags: "folk, acoustic" });
	});
	const env = {
		AISONGGENERATOR_SESSION_TOKEN: "test-token",
		AI: {
			run: async () => ({ response: { title: "Song", lyrics: "Verse", style: ["folk", "acoustic"] } }),
		},
	};

	const lyrics = await lyricsMod.generateLyricsWithFallback("write a folk song", env);
	assert.equal(lyrics.service, "cloudflare-ai");
	assert.deepEqual(timeout.mock.calls.map(({ arguments: [ms] }) => ms), [10_000, 9_500]);
});
