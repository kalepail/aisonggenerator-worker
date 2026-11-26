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
	const koPrompt = "서울의 밤 K-pop track, half Korean and half English";
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

test("Cloudflare AI (Anthropic Fable 5.2 low + json_schema) is primary and never hits aisonggenerator.io on success", async () => {
	const origFetch = globalThis.fetch;
	let aisgCalls = 0;
	const aiCalls = [];

	globalThis.fetch = async (url) => {
		aisgCalls++;
		throw new Error(`Unexpected outbound fetch to ${url}`);
	};

	try {
		const env = {
			AISONGGENERATOR_SESSION_TOKEN: "test-token",
			AI: {
				run: async (model, input) => {
					aiCalls.push({ model, input });
					// Anthropic Messages response shape with thinking + text blocks
					return {
						id: "msg_test_1",
						type: "message",
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "plan" },
							{
								type: "text",
								text: JSON.stringify({
									title: "Passenger Side",
									lyrics: "[Verse 1 - intimate, sparse]\nYour jacket still smells like cedar\n\n[Chorus]\nStay on the passenger side",
									style: [
										"warm indie soft rock",
										"smoky female alto, intimate phrasing",
										"clean chiming electric guitar, brushed snare",
										"slow 74 BPM sway",
										"dry close-mic warmth, wide chorus lift",
									],
								}),
							},
						],
					};
				},
			},
		};

		const result = await lyricsMod.generateLyricsWithFallback(
			"# Prompt\nsoft romantic rock song with female voice",
			env,
			"soft romantic rock song with female voice",
			"smol-primary-1"
		);
		assert.equal(aisgCalls, 0);
		assert.equal(aiCalls.length, 1);
		assert.equal(aiCalls[0].model, cfMod.PRIMARY_LYRICS_MODEL);
		assert.equal(aiCalls[0].input.max_tokens, 5000);
		assert.equal(aiCalls[0].input.thinking.type, "adaptive");
		assert.equal(aiCalls[0].input.output_config.effort, "low");
		assert.equal(aiCalls[0].input.output_config.format.type, "json_schema");
		assert.equal(aiCalls[0].input.system, cfMod.SONGWRITER_SYSTEM_PROMPT);
		assert.equal(result.service, "cloudflare-ai");
		assert.equal(result.model, cfMod.PRIMARY_LYRICS_MODEL);
		assert.equal(result.meta.aisg_attempts, 0);
		assert.equal(result.meta.cf_attempts, 1);
		assert.equal(result.meta.fallbacks, undefined);
		assert.equal(result.title, "Passenger Side");
		assert.equal(result.style.length, 5);
	} finally {
		globalThis.fetch = origFetch;
	}
});

test("parseAndValidateSong trims malformed key whitespace and accepts style/styles", () => {
	const raw = '{"title":"Spare Key","lyrics":"[Verse 1]\\nLeft it under the mat"," style":["soft rock","female vocals","clean guitar"]}';
	const parsed = cfMod.parseAndValidateSong(raw, "soft romantic rock");
	assert.equal(parsed.title, "Spare Key");
	assert.deepEqual(parsed.style, ["soft rock", "female vocals", "clean guitar"]);

	const plural = '{"title":"Spare Key","lyrics":"[Verse 1]\\nLeft it under the mat","styles":"soft rock, female vocals"}';
	const parsedPlural = cfMod.parseAndValidateSong(plural, "soft romantic rock");
	assert.deepEqual(parsedPlural.style, ["soft rock", "female vocals"]);
});

test("songWrite falls back Fable 5.2 -> Opus 5.5 -> DeepSeek V4.1 (no-think) -> GLM-5.3 on errors or unexpected Chinese", async () => {
	const modelsCalled = [];
	const inputsByModel = {};
	const env = {
		AI: {
			run: async (model, input) => {
				modelsCalled.push(model);
				inputsByModel[model] = input;
				if (model === cfMod.PRIMARY_LYRICS_MODEL) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									title: "意外中文",
									lyrics: "[Verse 1]\n意外的中文歌词",
									style: ["indie folk", "acoustic guitar"],
								}),
							},
						],
					};
				}
				if (model === cfMod.SECONDARY_LYRICS_MODEL) {
					throw new Error("Anthropic 529 overloaded");
				}
				if (model === cfMod.TERTIARY_LYRICS_MODEL) {
					throw new Error("rate limit 429");
				}
				return {
					choices: [
						{
							message: {
								content: JSON.stringify({
									title: "Late Train Home",
									lyrics: "[Verse 1]\nRain on the window glass\n\n[Chorus]\nLate train home",
									style: ["indie folk", "fingerpicked acoustic guitar", "intimate vocals", "slow 72 BPM"],
								}),
							},
						},
					],
				};
			},
		},
	};

	const result = await cfMod.songWrite(env, "rainy Tuesday train home, indie folk");
	assert.deepEqual(modelsCalled, [
		cfMod.PRIMARY_LYRICS_MODEL,
		cfMod.SECONDARY_LYRICS_MODEL,
		cfMod.TERTIARY_LYRICS_MODEL,
		cfMod.FALLBACK_LYRICS_MODEL,
	]);
	assert.equal(inputsByModel[cfMod.TERTIARY_LYRICS_MODEL].reasoning_effort, "none");
	assert.equal(inputsByModel[cfMod.TERTIARY_LYRICS_MODEL].chat_template_kwargs.enable_thinking, false);
	assert.equal(inputsByModel[cfMod.FALLBACK_LYRICS_MODEL].reasoning_effort, "low");
	assert.equal(result.title, "Late Train Home");
	assert.equal(result.model, cfMod.FALLBACK_LYRICS_MODEL);
	assert.equal(result.attempts, 4);
	assert.equal(result.failures.length, 3);
});

test("LYRICS_PRIMARY_MODEL promotes a supported model to primary without breaking fallback order", async () => {
	const modelsCalled = [];
	const env = {
		LYRICS_PRIMARY_MODEL: cfMod.SECONDARY_LYRICS_MODEL,
		AI: {
			run: async (model) => {
				modelsCalled.push(model);
				if (model === cfMod.SECONDARY_LYRICS_MODEL) {
					throw new Error("opus hiccup");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								title: "Promoted Fallback",
								lyrics: "[Verse 1]\nLines that sing cleanly",
								style: ["indie folk", "acoustic guitar"],
							}),
						},
					],
				};
			},
		},
	};
	const result = await cfMod.songWrite(env, "indie folk song");
	assert.deepEqual(modelsCalled, [cfMod.SECONDARY_LYRICS_MODEL, cfMod.PRIMARY_LYRICS_MODEL]);
	assert.equal(result.model, cfMod.PRIMARY_LYRICS_MODEL);
});

test("Unified Billing spend_limit skips remaining third-party models and falls through to native @cf/ Workers AI", async () => {
	const modelsCalled = [];
	const env = {
		AI: {
			run: async (model) => {
				modelsCalled.push(model);
				if (model === cfMod.PRIMARY_LYRICS_MODEL) {
					throw new Error("AiGatewayError: 2052: Insufficient unified billing balance for this request");
				}
				return {
					choices: [
						{
							message: {
								content: JSON.stringify({
									title: "Native Safety Net",
									lyrics: "[Verse 1]\nStill singing when credits run dry",
									style: ["indie rock", "clean guitar", "brushed snare"],
								}),
							},
						},
					],
				};
			},
		},
	};

	const result = await cfMod.songWrite(env, "indie rock song");
	// Skips SECONDARY (anthropic/claude-opus-5.5) and lands directly on TERTIARY (@cf/deepseek-ai/deepseek-v4.1-flash-1017)
	assert.deepEqual(modelsCalled, [cfMod.PRIMARY_LYRICS_MODEL, cfMod.TERTIARY_LYRICS_MODEL]);
	assert.equal(result.model, cfMod.TERTIARY_LYRICS_MODEL);
	assert.deepEqual(result.failures, [{ model: cfMod.PRIMARY_LYRICS_MODEL, reason: "spend_limit" }]);
});

test("Native @cf/ spend_limit stops immediately without trying further native models", async () => {
	const modelsCalled = [];
	const env = {
		LYRICS_PRIMARY_MODEL: cfMod.TERTIARY_LYRICS_MODEL,
		AI: {
			run: async (model) => {
				modelsCalled.push(model);
				throw new Error("AiError: 3036: Daily neuron quota exceeded");
			},
		},
	};
	await assert.rejects(cfMod.songWrite(env, "write a folk song"), /All Cloudflare AI lyrics models failed/);
	assert.deepEqual(modelsCalled, [cfMod.TERTIARY_LYRICS_MODEL]);
});

test("songWrite reserves fallback time for native @cf/ models and aborts stalled calls cleanly", async (t) => {
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
	const result = assert
		.rejects(cfMod.songWrite(env, "write a folk song"), /All Cloudflare AI lyrics models failed/)
		.then(() => {
			settled = true;
		});
	// Fable gets min(32000, 48000-12000)=32000 -> leaves 16000; Opus gets max(4000, min(24000, 16000-12000))=4000 -> leaves 12000;
	// DeepSeek gets min(14000, 12000)=12000 -> deadline 48000 reached!
	for (const duration of [32_000, 4_000, 11_999]) {
		t.mock.timers.tick(duration);
		await new Promise(setImmediate);
	}
	assert.equal(settled, false);
	t.mock.timers.tick(1);
	await result;
	assert.equal(Date.now(), cfMod.CF_LYRICS_BUDGET_MS);
	assert.deepEqual(
		calls.map(({ model, at }) => [model, at]),
		[
			[cfMod.PRIMARY_LYRICS_MODEL, 0],
			[cfMod.SECONDARY_LYRICS_MODEL, 32_000],
			[cfMod.TERTIARY_LYRICS_MODEL, 36_000],
		]
	);
	assert.ok(calls.every(({ signal }) => signal.aborted));
});

test("Emergency aisonggenerator.io fallback activates only if all Cloudflare AI models fail, and logs correlate X-Smol-Id", async (t) => {
	const logs = [];
	t.mock.method(console, "log", (line) => logs.push(String(line)));
	t.mock.method(console, "warn", (line) => logs.push(String(line)));
	let aisgCalls = 0;
	t.mock.method(globalThis, "fetch", async (url) => {
		assert.equal(String(url), "https://aisonggenerator.io/api/music/lyrics/generate");
		aisgCalls++;
		return Response.json({
			title: "Emergency Song",
			lyrics: "[Verse 1]\nBackup signal still alive",
			tags: "indie folk, acoustic guitar",
		});
	});

	const env = {
		AISONGGENERATOR_SESSION_TOKEN: "test-token",
		AI: {
			run: async () => {
				throw new Error("CF AI outage");
			},
		},
	};

	const result = await lyricsMod.generateLyricsWithFallback(
		"harbor night",
		env,
		"harbor night",
		"229ef31696aadf4881dd27529d9e3b02984a75ccec257fbb4c107f6ea9157931"
	);
	assert.equal(aisgCalls, 1);
	assert.equal(result.service, "aisonggenerator.io");
	assert.equal(result.model, lyricsMod.AISG_LYRICS_MODEL);
	assert.equal(result.meta.cf_attempts, 4);
	assert.equal(result.meta.aisg_attempts, 1);
	assert.equal(result.meta.fallbacks.length, 4);

	const parsed = logs.map((line) => JSON.parse(line));
	const okLog = parsed.find((e) => e.event === "lyrics_generated");
	assert.ok(okLog);
	assert.equal(okLog.smol_id, "229ef31696aadf4881dd27529d9e3b02984a75ccec257fbb4c107f6ea9157931");
	assert.equal(okLog.service, "aisonggenerator.io");
	assert.equal(okLog.cf_attempts, 4);
	assert.equal(okLog.aisg_attempts, 1);
	assert.equal(okLog.fallback_count, 4);
	assert.equal(lyricsMod.extractSmolId("bad id with spaces"), undefined);
	assert.equal(
		lyricsMod.extractSmolId("229ef31696aadf4881dd27529d9e3b02984a75ccec257fbb4c107f6ea9157931"),
		"229ef31696aadf4881dd27529d9e3b02984a75ccec257fbb4c107f6ea9157931"
	);
});

test("Emergency aisonggenerator.io fallback still rejects unexpected Chinese and <2 style tags", async (t) => {
	t.mock.method(globalThis, "fetch", async () =>
		Response.json({
			title: "夜班诗人",
			lyrics: "[Verse 1]\n凌晨的办公室",
			tags: "hip hop, boom bap",
		})
	);
	const env = {
		AISONGGENERATOR_SESSION_TOKEN: "test-token",
		AI: {
			run: async () => {
				throw new Error("CF AI outage");
			},
		},
	};
	await assert.rejects(
		lyricsMod.generateLyricsWithFallback("working person hip hop", env, "working person hip hop"),
		/All lyric generation services failed/
	);
});
