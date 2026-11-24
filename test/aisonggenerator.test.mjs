import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createTestBundler } from "./helpers.mjs";

let bundler;
let aisgMod;

before(async () => {
	bundler = createTestBundler("aisg-api-test-");
	aisgMod = await bundler.bundle("src/api/aisonggenerator.ts", "aisonggenerator.mjs");
});

after(() => {
	bundler?.cleanup();
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

test("findMusicIds waits past attempt 2, rechecks page 1 on 100-page library, and handles strict vs legacy exhaustion", async () => {
	const origFetch = globalThis.fetch;
	const env = { AISONGGENERATOR_SESSION_TOKEN: "tok", AISONGGENERATOR_WORKSPACE_ID: "ws_1" };

	try {
		// 1) Returns 1 song on attempts 1..3 and both songs on attempt 4 (previously early-broke on attempt 3)
		let listCalls = 0;
		globalThis.fetch = async (url) => {
			assert.equal(String(url), "https://aisonggenerator.io/api/music/list?scope=library&page=1&workspace_id=ws_1");
			listCalls++;
			const items =
				listCalls < 4
					? [{ task_id: "task_99", music_id: "m_b" }]
					: [
							{ task_id: "task_99", music_id: "m_b" },
							{ task_id: "task_99", music_id: "m_a" },
						];
			return new Response(JSON.stringify({ success: true, data: { items, pagination: { page: 1, totalPages: 1 } } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const ids = await aisgMod.findMusicIds(env, "task_99", "ws_1", { maxAttempts: 6, delayMs: 0 });
		assert.equal(listCalls, 4);
		assert.deepEqual(ids, ["m_a", "m_b"]);

		// 2) 100-page library where pair becomes visible on page 1 AFTER the first page-1 read:
		//    must recheck page 1 on attempt 2 rather than advancing to pages 6..30 and returning 504!
		let page1Reads = 0;
		const seenPages = [];
		globalThis.fetch = async (url) => {
			const page = Number(new URL(String(url)).searchParams.get("page"));
			seenPages.push(page);
			if (page === 1) {
				page1Reads++;
				const items =
					page1Reads >= 2
						? [
								{ task_id: "task_deep_head", music_id: "m_2" },
								{ task_id: "task_deep_head", music_id: "m_1" },
							]
						: [];
				return Response.json({ success: true, data: { items, pagination: { page: 1, totalPages: 100 } } });
			}
			return Response.json({ success: true, data: { items: [], pagination: { page, totalPages: 100 } } });
		};

		const deepHeadIds = await aisgMod.findMusicIds(env, "task_deep_head", "ws_1", { maxAttempts: 6, delayMs: 0 });
		assert.deepEqual(deepHeadIds, ["m_1", "m_2"]);
		assert.equal(page1Reads, 2);
		assert.deepEqual(seenPages, [1, 2, 3, 4, 5, 1]);

		// 2b) Transient 503 on optional deeper page (page 2) MUST NOT abort discovery before page 1's second read!
		let page1ReadsAfter503 = 0;
		globalThis.fetch = async (url) => {
			const page = Number(new URL(String(url)).searchParams.get("page"));
			if (page === 1) {
				page1ReadsAfter503++;
				const items =
					page1ReadsAfter503 >= 2
						? [
								{ task_id: "task_p2_503", music_id: "r_2" },
								{ task_id: "task_p2_503", music_id: "r_1" },
							]
						: [];
				return Response.json({ success: true, data: { items, pagination: { page: 1, totalPages: 100 } } });
			}
			return new Response("Service Unavailable", { status: 503 });
		};
		const recoveredIds = await aisgMod.findMusicIds(env, "task_p2_503", "ws_1", { maxAttempts: 6, delayMs: 0 });
		assert.deepEqual(recoveredIds, ["r_1", "r_2"]);
		assert.equal(page1ReadsAfter503, 2);

		// 3) Strict mode (default): loop exhaustion with 1 song throws ProviderError(504, outcome: 'unknown', taskId)
		let exhaustedCalls = 0;
		globalThis.fetch = async () => {
			exhaustedCalls++;
			return new Response(
				JSON.stringify({
					success: true,
					data: { items: [{ task_id: "task_partial", music_id: "m_only" }], pagination: { page: 1, totalPages: 1 } },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			);
		};

		await assert.rejects(
			() => aisgMod.findMusicIds(env, "task_partial", "ws_1", { maxAttempts: 3, delayMs: 0 }),
			(err) => {
				assert.equal(err.status, 504);
				assert.equal(err.code, "aisg_task_not_found");
				assert.equal(err.retryable, false);
				assert.equal(err.outcome, "unknown");
				assert.equal(err.taskId, "task_partial");
				return true;
			}
		);
		assert.equal(exhaustedCalls, 3);

		// 4) Unkeyed legacy compatibility mode (allowSingletonOnExhaustion: true) preserves non-retrying 1-ID return
		const legacySingle = await aisgMod.findMusicIds(env, "task_partial", "ws_1", {
			maxAttempts: 3,
			delayMs: 0,
			allowSingletonOnExhaustion: true,
		});
		assert.deepEqual(legacySingle, ["m_only"]);
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

test("recoverAisgAudio calls the free recovery endpoint cleanly", async () => {
	const origFetch = globalThis.fetch;
	const calls = [];

	globalThis.fetch = async (url, init) => {
		const urlStr = String(url);
		calls.push({ url: urlStr, method: init.method, body: init.body });
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
		const recovered = await aisgMod.recoverAisgAudio("song_123", env);
		assert.equal(recovered, true);
		assert.deepEqual(calls, [{
			url: "https://aisonggenerator.io/api/music/song_123/audio/recovery",
			method: "POST",
			body: undefined,
		}]);
	} finally {
		globalThis.fetch = origFetch;
	}
});

test("getAiSongGeneratorSongResults reserves pending for explicit missing and surfaces 5xx, empty 200, and success:false as read errors", async () => {
	const origFetch = globalThis.fetch;

	globalThis.fetch = async (url) => {
		const urlStr = String(url);
		if (urlStr.endsWith("/api/music/m_ok")) {
			return Response.json({
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
			});
		}
		if (urlStr.endsWith("/api/music/m_timeout")) {
			return Response.json({
				success: true,
				data: {
					music_id: "m_timeout",
					task_id: "t_1",
					status: "failed",
					audio_url: null,
					provider: "kie",
					credits_cost: 0,
					credits_refunded: true,
					error_message: "Upstream timeout for CANARY_LEAK_TOKEN_99",
				},
			});
		}
		if (urlStr.endsWith("/api/music/m_policy")) {
			return Response.json({
				success: true,
				data: {
					music_id: "m_policy",
					task_id: "t_1",
					status: "failed",
					audio_url: null,
					error_message: "Copyright policy violation on CANARY_PRIVATE_EMAIL@example.com",
				},
			});
		}
		if (urlStr.endsWith("/api/music/m_404")) {
			return new Response("not found", { status: 404 });
		}
		if (urlStr.endsWith("/api/music/m_explicit_null")) {
			return Response.json({ success: true, data: null });
		}
		if (urlStr.endsWith("/api/music/m_omitted_data")) {
			return Response.json({ success: true });
		}
		if (urlStr.endsWith("/api/music/m_empty_200")) {
			return new Response("", { status: 200 });
		}
		if (urlStr.endsWith("/api/music/m_app_false")) {
			return Response.json({ success: false, message: "database unavailable" }, { status: 200 });
		}
		if (urlStr.endsWith("/api/music/m_weird_envelope")) {
			return Response.json({ unexpected: true }, { status: 200 });
		}
		return new Response("Bad Gateway", { status: 502 });
	};

	try {
		const rows = await aisgMod.getAiSongGeneratorSongResults(
			["m_ok", "m_timeout", "m_policy", "m_404", "m_explicit_null"],
			{ AISONGGENERATOR_SESSION_TOKEN: "tok" }
		);

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

		assert.equal(rows[1].status, -4);
		assert.equal(rows[1].error_message, "Song generation timed out upstream");
		assert.doesNotMatch(rows[1].error_message, /CANARY_LEAK_TOKEN_99/);

		assert.equal(rows[2].status, -4);
		assert.equal(rows[2].error_message, "Song generation rejected by content policy");
		assert.doesNotMatch(rows[2].error_message, /CANARY_PRIVATE_EMAIL/);

		// 404 and explicit { success: true, data: null } preserve legacy pending rows without bogus identify_id
		assert.deepEqual(rows[3], { music_id: "m_404", status: 0, audio: null, service: "aisonggenerator" });
		assert.equal("identify_id" in rows[3], false);
		assert.deepEqual(rows[4], { music_id: "m_explicit_null", status: 0, audio: null, service: "aisonggenerator" });

		// 502 outage, empty HTTP 200 body, omitted data ({ success: true }), 200 { success: false }, and unrecognized envelopes all surface as 502 read errors
		for (const id of ["m_outage", "m_empty_200", "m_omitted_data", "m_app_false", "m_weird_envelope"]) {
			await assert.rejects(
				() => aisgMod.getAiSongGeneratorSongResults([id], { AISONGGENERATOR_SESSION_TOKEN: "tok" }),
				(err) => {
					assert.equal(err.status, 502, `expected 502 for ${id}`);
					assert.equal(err.code, "aisg_upstream_error", `expected aisg_upstream_error for ${id}`);
					assert.equal(err.retryable, true);
					assert.equal(err.outcome, "rejected");
					return true;
				}
			);
		}
	} finally {
		globalThis.fetch = origFetch;
	}
});
