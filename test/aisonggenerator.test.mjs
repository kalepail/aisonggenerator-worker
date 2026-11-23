import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const wranglerDir = fs.realpathSync(path.resolve("node_modules/wrangler"));
const esbuild = require(require.resolve("esbuild", {
	paths: [wranglerDir, path.dirname(wranglerDir)],
}));

let tmpDir;
let aisgMod;

before(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aisg-api-test-"));
	const outfile = path.join(tmpDir, "aisonggenerator.mjs");
	await esbuild.build({
		entryPoints: [path.resolve("src/api/aisonggenerator.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node20",
	});
	aisgMod = await import(pathToFileURL(outfile).href);
});

after(() => {
	if (tmpDir) {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("buildSubmitBody keeps model v6, clamps limits, and passes free optional params", () => {
	const customBody = aisgMod.buildSubmitBody(
		{
			title: "T".repeat(120),
			styles: ["synthwave", "dreamy", "S".repeat(1200)],
			instrumental: false,
			lyrics: "L".repeat(6000),
			isPublic: false,
			vocalGender: "f",
			negativeTags: "N".repeat(260),
			isOriginal: true,
			lyricsCompatibilityLevel: 2,
		},
		{ AISONGGENERATOR_WORKSPACE_ID: "ws_env_123" }
	);

	assert.equal(customBody.model, "v6");
	assert.equal(customBody.customMode, true);
	assert.equal(customBody.instrumental, false);
	assert.equal(customBody.is_private, true);
	assert.equal(customBody.title.length, aisgMod.TITLE_LIMIT);
	assert.equal(customBody.prompt.length, aisgMod.CUSTOM_LYRICS_LIMIT);
	assert.equal(customBody.style.length, aisgMod.STYLE_LIMIT);
	assert.equal(customBody.vocalGender, "f");
	assert.equal(customBody.negativeTags.length, aisgMod.NEGATIVE_TAGS_LIMIT);
	assert.equal(customBody.is_original, true);
	assert.equal(customBody.lyrics_compatibility_level, 2);
	assert.equal(customBody.workspace_id, "ws_env_123");

	const easyBody = aisgMod.buildSubmitBody(
		{
			title: "I".repeat(100),
			styles: ["lofi"],
			instrumental: true,
			description: "D".repeat(3500),
			isPublic: true,
			lyricsCompatibilityLevel: 3, // Ignored in instrumental/easy mode
			imageUrls: [
				"https://cdn.example/1.png",
				"http://insecure.example/skip.png",
				"https://cdn.example/2.png",
				"https://cdn.example/3.png",
				"https://cdn.example/4.png",
				"https://cdn.example/5.png",
				"https://cdn.example/6.png",
			],
			workspaceId: "ws_param_999",
		},
		{ AISONGGENERATOR_WORKSPACE_ID: "ws_env_123" }
	);

	assert.equal(easyBody.model, "v6");
	assert.equal(easyBody.customMode, false);
	assert.equal(easyBody.instrumental, true);
	assert.equal(easyBody.is_private, false);
	assert.equal(easyBody.title.length, aisgMod.TITLE_LIMIT);
	assert.equal(easyBody.prompt.length, aisgMod.EASY_PROMPT_LIMIT);
	assert.equal(easyBody.workspace_id, "ws_param_999");
	assert.deepEqual(easyBody.imageUrls, [
		"https://cdn.example/1.png",
		"https://cdn.example/2.png",
		"https://cdn.example/3.png",
		"https://cdn.example/4.png",
		"https://cdn.example/5.png",
	]);
	assert.equal("style" in easyBody, false);
	assert.equal("vocalGender" in easyBody, false);
	assert.equal("lyrics_compatibility_level" in easyBody, false);
});

test("generateAiSongGeneratorSong distinguishes insufficient credits from generic 403 and forwards workspace_id", async () => {
	const origFetch = globalThis.fetch;
	const env = {
		AISONGGENERATOR_SESSION_TOKEN: "secret-session-token",
		AISONGGENERATOR_WORKSPACE_ID: "ws_smol",
	};

	try {
		// 1) Insufficient credits on HTTP 403
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ success: false, message: "Insufficient credits", email: "private@example.com" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});

		await assert.rejects(
			() =>
				aisgMod.generateAiSongGeneratorSong(
					{
						title: "Test",
						styles: ["lofi"],
						instrumental: true,
						description: "Cozy rain",
						isPublic: false,
					},
					env
				),
			/AISG song submission failed: insufficient credits \(HTTP 403\)/
		);

		// 2) Generic 403 does not claim insufficient credits or leak body text
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ success: false, message: "Forbidden for sensitive-user@example.com" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});

		await assert.rejects(
			() =>
				aisgMod.generateAiSongGeneratorSong(
					{
						title: "Test",
						styles: ["lofi"],
						instrumental: true,
						description: "Cozy rain",
						isPublic: false,
					},
					env
				),
			(err) => {
				assert.equal(err.message, "AISG song submission failed (HTTP 403)");
				assert.doesNotMatch(err.message, /sensitive-user/);
				return true;
			}
		);

		// 3) Success forwards workspace_id to both submit and library list
		const seenUrls = [];
		let submitBody = null;
		globalThis.fetch = async (url, init) => {
			const urlStr = String(url);
			seenUrls.push(urlStr);
			if (urlStr.endsWith("/api/music/submit")) {
				submitBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ success: true, data: { task_id: "task_42" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({
					success: true,
					data: {
						items: [
							{ task_id: "task_42", music_id: "m_2" },
							{ task_id: "task_42", music_id: "m_1" },
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			);
		};

		const ids = await aisgMod.generateAiSongGeneratorSong(
			{
				title: "Test",
				styles: ["lofi"],
				instrumental: true,
				description: "Cozy rain",
				isPublic: true,
			},
			env
		);
		assert.deepEqual(ids, ["m_1", "m_2"]);
		assert.equal(submitBody.workspace_id, "ws_smol");
		assert.equal(seenUrls[1], "https://aisonggenerator.io/api/music/list?scope=library&page=1&workspace_id=ws_smol");
	} finally {
		globalThis.fetch = origFetch;
	}
});

test("getAisgCredits sends bodyless POST /api/user and strips PII", async () => {
	const origFetch = globalThis.fetch;
	let captured;

	globalThis.fetch = async (url, init) => {
		captured = { url: String(url), method: init.method, body: init.body };
		return new Response(
			JSON.stringify({
				success: true,
				data: {
					left_credits: 17980,
					paid_credits: 18000,
					used_credits: 20,
					free_credits: 5,
					plan_tier: "Pro-yearly-1",
					has_active_sub: true,
					email: "secret@example.com",
					name: "Secret User",
					user_id: "usr_secret",
				},
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } }
		);
	};

	try {
		const credits = await aisgMod.getAisgCredits({ AISONGGENERATOR_SESSION_TOKEN: "tok" });
		assert.equal(captured.url, "https://aisonggenerator.io/api/user");
		assert.equal(captured.method, "POST");
		assert.equal(captured.body, undefined);
		assert.deepEqual(credits, {
			left_credits: 17980,
			paid_credits: 18000,
			used_credits: 20,
			free_credits: 5,
			plan_tier: "Pro-yearly-1",
			has_active_sub: true,
		});
		assert.equal("email" in credits, false);
		assert.equal("name" in credits, false);
		assert.equal("user_id" in credits, false);

		// Rejects missing left_credits payload
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ success: true, data: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		await assert.rejects(
			() => aisgMod.getAisgCredits({ AISONGGENERATOR_SESSION_TOKEN: "tok" }),
			/invalid credit payload/
		);
	} finally {
		globalThis.fetch = origFetch;
	}
});

test("optimizeAisgStyle and recoverAisgAudio call free utility endpoints cleanly", async () => {
	const origFetch = globalThis.fetch;
	const calls = [];

	globalThis.fetch = async (url, init) => {
		const urlStr = String(url);
		calls.push({ url: urlStr, method: init.method, body: init.body });
		if (urlStr.endsWith("/api/music/style/optimize")) {
			return new Response(JSON.stringify({ result: "warm analog synthwave, 110 bpm, crisp snare" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (urlStr.endsWith("/api/music/song_123/audio/recovery")) {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		throw new Error(`Unexpected URL: ${urlStr}`);
	};

	try {
		const env = { AISONGGENERATOR_SESSION_TOKEN: "tok" };
		const optimized = await aisgMod.optimizeAisgStyle("synthwave", env);
		assert.equal(optimized, "warm analog synthwave, 110 bpm, crisp snare");
		assert.equal(JSON.parse(calls[0].body).content, "synthwave");

		const recovered = await aisgMod.recoverAisgAudio("song_123", env);
		assert.equal(recovered, true);
		assert.equal(calls[1].method, "POST");
	} finally {
		globalThis.fetch = origFetch;
	}
});

test("getAiSongGeneratorSongResults preserves fields, falls back to audio_source, and surfaces diagnostics", async () => {
	const origFetch = globalThis.fetch;

	globalThis.fetch = async (url) => {
		const urlStr = String(url);
		if (urlStr.endsWith("/api/music/m_ok")) {
			return new Response(
				JSON.stringify({
					success: true,
					data: {
						music_id: "m_ok",
						task_id: "t_1",
						status: "completed",
						audio_url: null,
						processing_results: {
							audio_source: { url: "https://cdn.example/m_ok.mp3", format: "mp3" },
						},
						duration: 193.6,
						provider: "sun",
						credits_cost: 4,
						credits_refunded: false,
						error_message: "ignored on completed song",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			);
		}
		return new Response(
			JSON.stringify({
				success: true,
				data: {
					music_id: "m_fail",
					task_id: "t_1",
					status: "failed",
					audio_url: null,
					provider: "kie",
					credits_cost: 0,
					credits_refunded: true,
					error_message: "Upstream timeout\n   " + "x".repeat(250),
				},
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } }
		);
	};

	try {
		const rows = await aisgMod.getAiSongGeneratorSongResults(["m_ok", "m_fail"], {
			AISONGGENERATOR_SESSION_TOKEN: "tok",
		});

		assert.deepEqual(rows[0], {
			music_id: "m_ok",
			status: 4,
			audio: "https://cdn.example/m_ok.mp3",
			identify_id: "t_1",
			service: "aisonggenerator",
			duration: 193.6,
			provider: "sun",
			credits_cost: 4,
			credits_refunded: false,
		});

		assert.equal(rows[1].music_id, "m_fail");
		assert.equal(rows[1].status, -4);
		assert.equal(rows[1].audio, null);
		assert.equal(rows[1].provider, "kie");
		assert.equal(rows[1].credits_cost, 0);
		assert.equal(rows[1].credits_refunded, true);
		assert.equal(rows[1].error_message.length, 200);
		assert.match(rows[1].error_message, /^Upstream timeout x+/);
	} finally {
		globalThis.fetch = origFetch;
	}
});
