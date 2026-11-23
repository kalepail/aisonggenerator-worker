import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createMockDoNamespace, createTestBundler } from "./helpers.mjs";

let bundler;
let workerMod;

before(async () => {
	bundler = createTestBundler("aisg-e2e-test-");
	workerMod = await bundler.bundle("src/index.ts", "index.mjs");
});

after(() => {
	bundler?.cleanup();
});

function createEnv(overrides = {}) {
	const env = {
		AISONGGENERATOR_SESSION_TOKEN: "test-session-token",
		AISONGGENERATOR_WORKSPACE_ID: "ws_default",
		AI: {
			run: async () => {
				throw new Error("AI.run not stubbed for this test");
			},
		},
		...overrides,
	};
	env.DURABLE_OBJECT = createMockDoNamespace(workerMod.DO, () => env);
	return env;
}

async function captureConsole(fn) {
	const origWarn = console.warn;
	const origError = console.error;
	const origLog = console.log;
	const lines = [];
	const record = (...args) => lines.push(args.map(String).join(" "));
	console.warn = record;
	console.error = record;
	console.log = record;
	try {
		const result = await fn();
		return { result, logs: lines.join("\n") };
	} finally {
		console.warn = origWarn;
		console.error = origError;
		console.log = origLog;
	}
}

test("E2E split AISG submit (POST /api/tasks), multi-page discovery (GET /api/tasks/:id), excess-match guard, and song poll", async () => {
	const origFetch = globalThis.fetch;
	const env = createEnv();
	const seenRequests = [];

	globalThis.fetch = async (url, init = {}) => {
		const urlStr = String(url);
		seenRequests.push({ method: init.method ?? "GET", url: urlStr, body: init.body });

		if (urlStr === "https://aisonggenerator.io/api/music/submit") {
			return Response.json({ success: true, data: { task_id: "task_split_1" } });
		}
		if (urlStr.startsWith("https://aisonggenerator.io/api/music/list?")) {
			const parsed = new URL(urlStr);
			const page = Number(parsed.searchParams.get("page"));
			const ws = parsed.searchParams.get("workspace_id");

			if (ws === "ws_page3") {
				const items =
					page === 3
						? [
								{ task_id: "task_split_1", music_id: "m_beta" },
								{ task_id: "task_split_1", music_id: "m_alpha" },
							]
						: [];
				return Response.json({ success: true, data: { items, pagination: { page, totalPages: 3 } } });
			}

			if (ws === "ws_page7") {
				const items =
					page === 7
						? [
								{ task_id: "task_split_1", music_id: "m_2" },
								{ task_id: "task_split_1", music_id: "m_1" },
							]
						: [];
				return Response.json({ success: true, data: { items, pagination: { page, totalPages: 7 } } });
			}

			if (ws === "ws_excess") {
				return Response.json({
					success: true,
					data: {
						items: [
							{ task_id: "task_split_1", music_id: "m_1" },
							{ task_id: "task_split_1", music_id: "m_2" },
							{ task_id: "task_split_1", music_id: "m_3" },
						],
						pagination: { page: 1, totalPages: 1 },
					},
				});
			}
		}
		if (urlStr === "https://aisonggenerator.io/api/music/m_alpha") {
			return Response.json({
				success: true,
				data: {
					music_id: "m_alpha",
					task_id: "task_split_1",
					status: "completed",
					audio_url: "https://cdn.example/m_alpha.mp3",
					duration: 142,
					provider: "sun",
					credits_cost: 4,
				},
			});
		}
		if (urlStr === "https://aisonggenerator.io/api/music/m_beta") {
			return Response.json({
				success: true,
				data: {
					music_id: "m_beta",
					task_id: "task_split_1",
					status: "processing",
					audio_url: null,
				},
			});
		}
		if (urlStr === "https://aisonggenerator.io/api/music/m_empty_200") {
			return new Response("", { status: 200 });
		}
		if (urlStr === "https://aisonggenerator.io/api/music/m_omitted_data") {
			return Response.json({ success: true }, { status: 200 });
		}
		if (urlStr === "https://aisonggenerator.io/api/music/m_app_false") {
			return Response.json({ success: false, message: "db error" }, { status: 200 });
		}
		if (urlStr === "https://aisonggenerator.io/api/music/m_outage") {
			return new Response("Bad Gateway", { status: 502 });
		}
		throw new Error(`Unexpected upstream fetch: ${urlStr}`);
	};

	try {
		// 1) POST /api/tasks with Idempotency-Key submits once and retains receipt across replay
		const taskBody = JSON.stringify({
			title: "Midnight Tram",
			style: ["indie pop", "jangly guitars"],
			instrumental: false,
			lyrics: "[Verse 1]\nSparks on the wire",
			public: true,
			workspace_id: "ws_page3",
		});
		const submitRes = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json", "Idempotency-Key": "task-attempt-key-0001" },
				body: taskBody,
			}),
			env
		);
		assert.equal(submitRes.status, 200);
		assert.deepEqual(await submitRes.json(), { task_id: "task_split_1", workspace_id: "ws_page3" });
		assert.equal(seenRequests.length, 1);

		// Lost response replay returns identical task receipt with 0 extra submits
		const replayRes = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json", "Idempotency-Key": "task-attempt-key-0001" },
				body: taskBody,
			}),
			env
		);
		assert.equal(replayRes.status, 200);
		assert.deepEqual(await replayRes.json(), { task_id: "task_split_1", workspace_id: "ws_page3" });
		assert.equal(seenRequests.length, 1);

		// 2) Both matches on page 3 -> discovered in a single bounded lookup
		const page3Res = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/tasks/task_split_1?workspace_id=ws_page3"),
			env
		);
		assert.equal(page3Res.status, 200);
		assert.deepEqual(await page3Res.json(), {
			task_id: "task_split_1",
			music_ids: ["m_alpha", "m_beta"],
		});

		// 3) Matches on page 7 -> first call returns next_page: 6; follow-up with ?page=6 finds both
		const page7Slice1 = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/tasks/task_split_1?workspace_id=ws_page7"),
			env
		);
		assert.equal(page7Slice1.status, 200);
		assert.deepEqual(await page7Slice1.json(), {
			task_id: "task_split_1",
			music_ids: [],
			next_page: 6,
		});

		const page7Slice2 = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/tasks/task_split_1?workspace_id=ws_page7&page=6"),
			env
		);
		assert.equal(page7Slice2.status, 200);
		assert.deepEqual(await page7Slice2.json(), {
			task_id: "task_split_1",
			music_ids: ["m_1", "m_2"],
		});

		// 4) Excess matches (>2 distinct IDs) rejected explicitly with 502 + outcome: 'unknown'
		const excessRes = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/tasks/task_split_1?workspace_id=ws_excess"),
			env
		);
		assert.equal(excessRes.status, 502);
		const excessBody = await excessRes.json();
		assert.equal(excessBody.code, "aisg_upstream_error");
		assert.equal(excessBody.retryable, false);
		assert.equal(excessBody.outcome, "unknown");
		assert.equal(excessBody.task_id, "task_split_1");

		// 5) Invalid ?page=0 rejected before upstream calls
		const badPageRes = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/tasks/task_split_1?page=0"),
			env
		);
		assert.equal(badPageRes.status, 400);

		// 6) GET /api/songs?ids=... returns ordered snapshots, and surfaces 502, empty 200, and 200 success:false as 502 errors
		const pollRes = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/songs?ids=m_alpha,m_beta"),
			env
		);
		assert.equal(pollRes.status, 200);
		const songs = await pollRes.json();
		assert.equal(songs[0].status, 4);
		assert.equal(songs[1].status, 2);

		for (const badId of ["m_outage", "m_empty_200", "m_omitted_data", "m_app_false"]) {
			const errRes = await workerMod.default.fetch(
				new Request(`http://aisonggenerator-worker/api/songs?ids=${badId}`),
				env
			);
			assert.equal(errRes.status, 502, `expected 502 for ${badId}`);
			const errBody = await errRes.json();
			assert.equal(errBody.code, "aisg_upstream_error");
			assert.equal(errBody.retryable, true);
		}
	} finally {
		globalThis.fetch = origFetch;
	}
});

test("E2E paid replay invariants: keyed lost-success replay, non-expiring ambiguous claim, isolated independent requests, and 100-page page-1 recheck", async () => {
	const origFetch = globalThis.fetch;
	const origSetTimeout = globalThis.setTimeout;
	const origDateNow = Date.now;
	const env = createEnv();

	globalThis.setTimeout = (fn, _ms, ...args) => origSetTimeout(fn, 0, ...args);

	try {
		// 1) Keyed POST /api/songs:
		//    - Attempt 1 submits ONCE, discovery exhausts at 1 song -> 504 (retained as accepted)
		//    - Attempt 2 resumes SAME task_id -> discovers both -> retained as completed -> 200 ["id_1", "id_2"]
		//    - Attempt 3 (simulating LOST 200 response replay!) returns identical ["id_1", "id_2"] with 0 upstream calls!
		let keyedSubmits = 0;
		let keyedListCalls = 0;
		globalThis.fetch = async (url) => {
			const urlStr = String(url);
			if (urlStr.endsWith("/api/music/submit")) {
				keyedSubmits++;
				return Response.json({ success: true, data: { task_id: "task_keyed_1" } });
			}
			if (urlStr.includes("/api/music/list")) {
				keyedListCalls++;
				const items =
					keyedListCalls <= 6
						? [{ task_id: "task_keyed_1", music_id: "id_2" }]
						: [
								{ task_id: "task_keyed_1", music_id: "id_2" },
								{ task_id: "task_keyed_1", music_id: "id_1" },
							];
				return Response.json({ success: true, data: { items, pagination: { page: 1, totalPages: 1 } } });
			}
			throw new Error(`Unexpected URL: ${urlStr}`);
		};

		const keyedPayload = JSON.stringify({
			title: "Rainy Keys",
			style: ["lofi"],
			instrumental: true,
			prompt: "Cozy midnight piano",
			public: false,
		});

		const keyed1 = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/songs", {
				method: "POST",
				headers: { "Content-Type": "application/json", "Idempotency-Key": "gen-keyed-attempt-0001" },
				body: keyedPayload,
			}),
			env
		);
		assert.equal(keyed1.status, 504);
		assert.equal((await keyed1.json()).task_id, "task_keyed_1");
		assert.equal(keyedSubmits, 1);

		const keyed2 = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/songs", {
				method: "POST",
				headers: { "Content-Type": "application/json", "Idempotency-Key": "gen-keyed-attempt-0001" },
				body: keyedPayload,
			}),
			env
		);
		assert.equal(keyed2.status, 200);
		assert.deepEqual(await keyed2.json(), ["id_1", "id_2"]);
		assert.equal(keyedSubmits, 1);

		// Discard keyed2's response and replay — MUST return same pair with ZERO upstream calls!
		const listCountBeforeReplay = keyedListCalls;
		const keyed3LostSuccessReplay = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/songs", {
				method: "POST",
				headers: { "Content-Type": "application/json", "Idempotency-Key": "gen-keyed-attempt-0001" },
				body: keyedPayload,
			}),
			env
		);
		assert.equal(keyed3LostSuccessReplay.status, 200);
		assert.deepEqual(await keyed3LostSuccessReplay.json(), ["id_1", "id_2"]);
		assert.equal(keyedSubmits, 1);
		assert.equal(keyedListCalls, listCountBeforeReplay);

		// Public GET /api/attempts/:id MUST NOT be exposed over HTTP (404), while internal DO.getAttempt() retains receipt
		const publicAttemptRes = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/attempts/gen-keyed-attempt-0001"),
			env
		);
		assert.equal(publicAttemptRes.status, 404);
		const internalStub = env.DURABLE_OBJECT.get(env.DURABLE_OBJECT.idFromName("v0.0.0"));
		const internalReceipt = await internalStub.getAttempt("gen-keyed-attempt-0001");
		assert.equal(internalReceipt.status, "completed");
		assert.equal(internalReceipt.task_id, "task_keyed_1");
		assert.deepEqual(internalReceipt.music_ids, ["id_1", "id_2"]);

		// Reusing same Idempotency-Key with a DIFFERENT payload returns 409 idempotency_conflict (no receipt disclosure)
		const conflictRes = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/songs", {
				method: "POST",
				headers: { "Content-Type": "application/json", "Idempotency-Key": "gen-keyed-attempt-0001" },
				body: JSON.stringify({
					title: "Different Song",
					style: ["jazz"],
					instrumental: true,
					prompt: "Different prompt",
					public: false,
				}),
			}),
			env
		);
		assert.equal(conflictRes.status, 409);
		assert.equal((await conflictRes.json()).code, "idempotency_conflict");

		// Short guessable keys (<16 chars) rejected with 400 before dispatch
		const shortKeyRes = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/songs", {
				method: "POST",
				headers: { "Content-Type": "application/json", "Idempotency-Key": "a" },
				body: keyedPayload,
			}),
			env
		);
		assert.equal(shortKeyRes.status, 400);
		assert.equal((await shortKeyRes.json()).code, "invalid_request");

		// 2) Unresolved/ambiguous keyed attempt NEVER expires back into a fresh submit — even after 24 hours!
		let ambigSubmits = 0;
		globalThis.fetch = async (url) => {
			if (String(url).endsWith("/api/music/submit")) {
				ambigSubmits++;
				return new Response("Bad Gateway", { status: 502 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const ambigPayload = JSON.stringify({
			attempt_id: "gen-ambig-attempt-0001",
			title: "Ambiguous Track",
			style: ["ambient"],
			instrumental: true,
			prompt: "Distant thunder",
			public: false,
		});
		const ambig1 = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/songs", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: ambigPayload,
			}),
			env
		);
		assert.equal(ambig1.status, 502);
		assert.equal((await ambig1.json()).outcome, "unknown");
		assert.equal(ambigSubmits, 1);

		// Simulate +15 minutes and +24 hours clock advance — unresolved attempt must STILL refuse duplicate submit!
		const baseNow = origDateNow();
		for (const deltaMs of [15 * 60 * 1000, 24 * 60 * 60 * 1000]) {
			Date.now = () => baseNow + deltaMs;
			const delayedRetry = await workerMod.default.fetch(
				new Request("http://aisonggenerator-worker/api/songs", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: ambigPayload,
				}),
				env
			);
			assert.equal(delayedRetry.status, 504);
			const delayedBody = await delayedRetry.json();
			assert.equal(delayedBody.code, "aisg_dispatch_unknown");
			assert.equal(delayedBody.outcome, "unknown");
			assert.equal(ambigSubmits, 1);
		}
		Date.now = origDateNow;

		assert.equal((await internalStub.getAttempt("gen-ambig-attempt-0001")).status, "ambiguous");

		// 3) Independent unkeyed vocal requests with DIFFERENT original prompts and IDENTICAL title/lyrics/style/visibility
		//    MUST NOT share a receipt or return generation A's tracks to generation B!
		let nextTaskSeq = 0;
		const readyByTask = new Map();
		globalThis.fetch = async (url) => {
			const urlStr = String(url);
			if (urlStr.endsWith("/api/music/submit")) {
				nextTaskSeq++;
				const taskId = `task_indep_${nextTaskSeq}`;
				readyByTask.set(taskId, [`${taskId}_a`, `${taskId}_b`]);
				return Response.json({ success: true, data: { task_id: taskId } });
			}
			if (urlStr.includes("/api/music/list")) {
				const items = [];
				for (const [taskId, pair] of readyByTask.entries()) {
					for (const musicId of pair) {
						items.push({ task_id: taskId, music_id: musicId });
					}
				}
				return Response.json({ success: true, data: { items, pagination: { page: 1, totalPages: 1 } } });
			}
			throw new Error(`Unexpected URL: ${urlStr}`);
		};

		const makeVocalReq = (prompt) =>
			workerMod.default.fetch(
				new Request("http://aisonggenerator-worker/api/songs?source=aisonggenerator", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						title: "Same Title",
						style: ["synthpop", "bright"],
						instrumental: false,
						lyrics: "[Verse 1]\nSame lyrics line",
						prompt,
						public: true,
					}),
				}),
				env
			);

		const [indepResA, indepResB] = await Promise.all([
			makeVocalReq("Original user prompt A"),
			makeVocalReq("Completely different prompt B"),
		]);
		assert.equal(indepResA.status, 200);
		assert.equal(indepResB.status, 200);
		const pairA = await indepResA.json();
		const pairB = await indepResB.json();
		assert.equal(nextTaskSeq, 2);
		assert.notDeepEqual(pairA, pairB);
		assert.equal(pairA.length, 2);
		assert.equal(pairB.length, 2);

		// 4) Unkeyed legacy POST /api/songs on 100-page library where page 2 transiently returns 503
		//    and page 1 exposes both IDs on its 2nd read: MUST succeed with 1 paid submit (no 503 abort!)
		let deepPage1Reads = 0;
		let deepSubmits = 0;
		globalThis.fetch = async (url) => {
			const urlStr = String(url);
			if (urlStr.endsWith("/api/music/submit")) {
				deepSubmits++;
				return Response.json({ success: true, data: { task_id: "task_100p" } });
			}
			if (urlStr.includes("/api/music/list")) {
				const page = Number(new URL(urlStr).searchParams.get("page"));
				if (page === 1) {
					deepPage1Reads++;
					const items =
						deepPage1Reads >= 2
							? [
									{ task_id: "task_100p", music_id: "p1_b" },
									{ task_id: "task_100p", music_id: "p1_a" },
								]
							: [];
					return Response.json({ success: true, data: { items, pagination: { page: 1, totalPages: 100 } } });
				}
				return new Response("Service Unavailable", { status: 503 });
			}
			throw new Error(`Unexpected URL: ${urlStr}`);
		};

		const page100Res = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/songs?source=aisonggenerator", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: keyedPayload,
			}),
			env
		);
		assert.equal(page100Res.status, 200);
		assert.deepEqual(await page100Res.json(), ["p1_a", "p1_b"]);
		assert.equal(deepSubmits, 1);
		assert.equal(deepPage1Reads, 2);

		// 5) Step-6 contraction: DiffRhythm, Suno, malformed inputs, and wildcard CORS are all rejected/absent
		let unexpectedCalls = 0;
		globalThis.fetch = async () => {
			unexpectedCalls++;
			throw new Error("Should not call upstream on invalid inputs");
		};
		for (const req of [
			new Request("http://aisonggenerator-worker/api/songs?source=diffrhythm", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: keyedPayload,
			}),
			new Request("http://aisonggenerator-worker/api/songs?source=diffrhythm&ids=diff_task_1,diff_task_2"),
			new Request("http://aisonggenerator-worker/api/tasks?source=diffrhythm", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: keyedPayload,
			}),
			new Request("http://aisonggenerator-worker/api/tasks/task_1?source=diffrhythm"),
			new Request("http://aisonggenerator-worker/api/songs?source=suno&ids=a,b"),
			new Request("http://aisonggenerator-worker/api/songs?ids=a,,"),
			new Request("http://aisonggenerator-worker/api/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{not valid json",
			}),
		]) {
			const res = await workerMod.default.fetch(req, env);
			assert.equal(res.status, 400, `expected 400 for ${req.method} ${req.url}`);
			assert.equal((await res.json()).code, "invalid_request");
		}
		assert.equal(unexpectedCalls, 0);

		// Internal Service-Binding-only: wildcard CORS middleware removed
		const corsProbeRes = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/health", {
				headers: { Origin: "https://evil.example" },
			}),
			env
		);
		assert.equal(corsProbeRes.status, 200);
		assert.equal(corsProbeRes.headers.get("access-control-allow-origin"), null);

		const preflightRes = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/tasks", {
				method: "OPTIONS",
				headers: {
					Origin: "https://evil.example",
					"Access-Control-Request-Method": "POST",
				},
			}),
			env
		);
		assert.equal(preflightRes.status, 404);
		assert.equal(preflightRes.headers.get("access-control-allow-origin"), null);
	} finally {
		globalThis.fetch = origFetch;
		globalThis.setTimeout = origSetTimeout;
		Date.now = origDateNow;
	}
});

test("E2E ProviderError classification requires positive rejection BEFORE matching reason keywords (504 moderation/credits -> unknown)", async () => {
	const origFetch = globalThis.fetch;
	const validPayload = JSON.stringify({
		title: "Test",
		style: ["lofi"],
		instrumental: true,
		prompt: "Cozy rain",
		public: false,
	});

	const submit = (env) =>
		workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: validPayload,
			}),
			env
		);

	try {
		// 1) Missing token -> 401 aisg_auth_error
		const missingTokRes = await submit(createEnv({ AISONGGENERATOR_SESSION_TOKEN: "" }));
		assert.equal(missingTokRes.status, 401);
		assert.deepEqual(await missingTokRes.json(), {
			error: "AISONGGENERATOR_SESSION_TOKEN is missing",
			provider: "aisonggenerator",
			code: "aisg_auth_error",
			retryable: false,
			outcome: "rejected",
		});

		const env = createEnv();

		// 2) Confirmed 401, 402, 403-credits, 403-forbidden, 400-policy, 429, and JSON 503 { success: false }
		globalThis.fetch = async () => Response.json({ success: false, message: "Unauthorized" }, { status: 401 });
		assert.equal((await submit(env)).status, 401);

		globalThis.fetch = async () =>
			Response.json({ success: false, message: "Insufficient credits for user@private.example" }, { status: 403 });
		const res403Credits = await submit(env);
		assert.equal(res403Credits.status, 402);
		const body403Credits = await res403Credits.json();
		assert.equal(body403Credits.code, "aisg_insufficient_credits");
		assert.equal(body403Credits.outcome, "rejected");
		assert.doesNotMatch(body403Credits.error, /private\.example/);

		globalThis.fetch = async () => Response.json({ success: false }, { status: 402 });
		assert.equal((await submit(env)).status, 402);

		globalThis.fetch = async () =>
			Response.json({ success: false, message: "Forbidden for sensitive-user@example.com" }, { status: 403 });
		const res403 = await submit(env);
		assert.equal(res403.status, 403);
		const body403 = await res403.json();
		assert.equal(body403.code, "aisg_forbidden");
		assert.doesNotMatch(body403.error, /sensitive-user/);

		globalThis.fetch = async () =>
			Response.json({ success: false, message: "Prompt flagged for copyright policy violation" }, { status: 400 });
		const resPolicy = await submit(env);
		assert.equal(resPolicy.status, 422);
		assert.equal((await resPolicy.json()).code, "aisg_policy_rejected");

		globalThis.fetch = async () => Response.json({ success: false }, { status: 429 });
		const res429 = await submit(env);
		assert.equal(res429.status, 429);
		assert.equal((await res429.json()).retryable, true);

		globalThis.fetch = async () => Response.json({ success: false, message: "Queue busy" }, { status: 503 });
		const res503Json = await submit(env);
		assert.equal(res503Json.status, 503);
		const body503Json = await res503Json.json();
		assert.equal(body503Json.code, "aisg_upstream_error");
		assert.equal(body503Json.retryable, true);
		assert.equal(body503Json.outcome, "rejected");

		// 3) CRITICAL REGRESSION: 504 with moderation/policy or credit keywords (without positive rejection)
		//    MUST map to 504 aisg_dispatch_unknown (outcome: 'unknown', retryable: false) — NEVER 422 or 402!
		globalThis.fetch = async () =>
			Response.json({ message: "moderation service timed out waiting for policy backend" }, { status: 504 });
		const res504Mod = await submit(env);
		assert.equal(res504Mod.status, 504);
		const body504Mod = await res504Mod.json();
		assert.equal(body504Mod.code, "aisg_dispatch_unknown");
		assert.equal(body504Mod.retryable, false);
		assert.equal(body504Mod.outcome, "unknown");

		globalThis.fetch = async () =>
			Response.json({ message: "insufficient credit ledger service gateway timeout" }, { status: 504 });
		const res504Cred = await submit(env);
		assert.equal(res504Cred.status, 504);
		const body504Cred = await res504Cred.json();
		assert.equal(body504Cred.code, "aisg_dispatch_unknown");
		assert.equal(body504Cred.retryable, false);
		assert.equal(body504Cred.outcome, "unknown");

		// 502 with credits/policy text or bare 500/502/503/504 -> ALL outcome: 'unknown', retryable: false
		globalThis.fetch = async () =>
			Response.json({ success: false, message: "Insufficient credits" }, { status: 502 });
		const res502Cred = await submit(env);
		assert.equal(res502Cred.status, 502);
		assert.equal((await res502Cred.json()).outcome, "unknown");

		for (const status of [500, 502, 503, 504]) {
			globalThis.fetch = async () => new Response("Gateway Error", { status });
			const res = await submit(env);
			const body = await res.json();
			assert.equal(body.code, "aisg_dispatch_unknown");
			assert.equal(body.retryable, false);
			assert.equal(body.outcome, "unknown");
		}

		// Timeout & truncated 200 -> outcome: 'unknown'
		globalThis.fetch = async () => {
			const err = new Error("The operation was aborted due to timeout");
			err.name = "TimeoutError";
			throw err;
		};
		const resTimeout = await submit(env);
		assert.equal(resTimeout.status, 504);
		assert.equal((await resTimeout.json()).outcome, "unknown");

		globalThis.fetch = async () => new Response("{truncated", { status: 200 });
		const resTruncated = await submit(env);
		assert.equal(resTruncated.status, 502);
		assert.equal((await resTruncated.json()).outcome, "unknown");
	} finally {
		globalThis.fetch = origFetch;
	}
});

test("E2E POST /api/lyrics rejects malformed declared JSON, preserves raw text, enforces 2+ tags, and strips raw provider diagnostics", async () => {
	const origFetch = globalThis.fetch;

	try {
		const env = createEnv({
			AI: {
				run: async () => ({
					choices: [
						{
							message: {
								content: JSON.stringify({
									title: "Harbor Mist",
									lyrics: "[Verse 1]\nFog on the dock\n\n[Chorus]\nHarbor mist rolls in",
									style: ["dream pop", "reverb guitar", "ethereal vocals"],
								}),
							},
						},
					],
				}),
			},
		});

		let fetchCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls++;
			throw new Error("should not call upstream");
		};

		const emptyRes = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/lyrics", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "   " }),
			}),
			env
		);
		assert.equal(emptyRes.status, 400);

		const malformedJsonRes = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/lyrics", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{broken json",
			}),
			env
		);
		assert.equal(malformedJsonRes.status, 400);
		assert.equal(fetchCalls, 0);

		globalThis.fetch = async () =>
			Response.json({
				title: "Plain Text Ballad",
				lyrics: "[Verse 1]\nSimple words",
				tags: "indie folk, acoustic guitar",
			});
		const plainTextRes = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/lyrics", {
				method: "POST",
				headers: { "Content-Type": "text/plain" },
				body: "acoustic folk song about morning coffee",
			}),
			env
		);
		assert.equal(plainTextRes.status, 200);
		assert.equal((await plainTextRes.json()).title, "Plain Text Ballad");

		globalThis.fetch = async () =>
			Response.json({
				title: "Too Few Tags",
				lyrics: "[Verse 1]\nShort line",
				tags: "ambient",
			});
		const fallbackRes = await workerMod.default.fetch(
			new Request("http://aisonggenerator-worker/api/lyrics", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "foggy harbor dream pop" }),
			}),
			env
		);
		assert.equal(fallbackRes.status, 200);
		assert.equal((await fallbackRes.json()).service, "cloudflare-ai");

		const canary = "SYNTHETIC_AI_BINDING_SECRET_999";
		const failingEnv = createEnv({
			AI: {
				run: async () => {
					throw new Error(`Internal binding crash: ${canary}`);
				},
			},
		});
		globalThis.fetch = async () => new Response("error", { status: 502 });

		const { result: failRes, logs } = await captureConsole(() =>
			workerMod.default.fetch(
				new Request("http://aisonggenerator-worker/api/lyrics", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ prompt: "midnight synthwave" }),
				}),
				failingEnv
			)
		);
		assert.equal(failRes.status, 503);
		const failText = await failRes.text();
		assert.doesNotMatch(failText, new RegExp(canary));
		assert.doesNotMatch(logs, new RegExp(canary));
		assert.equal(JSON.parse(failText).error, "All lyric generation services failed");
	} finally {
		globalThis.fetch = origFetch;
	}
});

test("E2E scheduled() cron retires legacy session_token safely, preserves aisg_credits, 0-credit GET /health, and closed-set error categories (no custom error.name leaks)", async () => {
	const origFetch = globalThis.fetch;
	const env = createEnv();

	try {
		let fetchCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls++;
			throw new Error("GET /health must never make upstream calls");
		};
		const initialRes = await workerMod.default.fetch(new Request("http://aisonggenerator-worker/health"), env);
		assert.equal(initialRes.status, 200);
		assert.equal(initialRes.headers.get("cache-control"), "no-store");
		assert.equal((await initialRes.json()).status, "unknown");
		assert.equal(fetchCalls, 0);

		const doStore = env.DURABLE_OBJECT.stores.get("v0.0.0");
		const futureExpiry = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
		doStore.set("aisg_credits", {
			left_credits: 900,
			paid_credits: 1000,
			used_credits: 100,
			free_credits: 0,
			plan_tier: "Pro-yearly-1",
			has_active_sub: true,
			checked_at: new Date().toISOString(),
			session_expires_at: futureExpiry,
		});
		const legacySnapRes = await workerMod.default.fetch(new Request("http://aisonggenerator-worker/health"), env);
		assert.equal(legacySnapRes.status, 200);
		assert.equal((await legacySnapRes.json()).credits.left_credits, 900);
		assert.equal(fetchCalls, 0);

		doStore.set("session_token", "__Secure-next-auth.session-token=stored-diff-tok");
		globalThis.fetch = async (url) => {
			const urlStr = String(url);
			if (urlStr === "https://aisonggenerator.io/api/auth/get-session") {
				return Response.json({
					user: { id: "usr_hidden", email: "hidden@example.com" },
					session: { expiresAt: futureExpiry },
				});
			}
			if (urlStr === "https://aisonggenerator.io/api/user") {
				return Response.json({
					success: true,
					data: {
						left_credits: 1200,
						paid_credits: 2000,
						used_credits: 800,
						free_credits: 0,
						plan_tier: "Pro-yearly-1",
						has_active_sub: true,
						email: "hidden@example.com",
					},
				});
			}
			throw new Error(`Unexpected cron URL: ${urlStr}`);
		};

		await workerMod.default.scheduled({}, env, {});
		// Step-6 contraction: obsolete DiffRhythm key is safely retired while aisg_credits & aisg_health stay intact
		assert.equal(doStore.has("session_token"), false);
		assert.ok(doStore.has("aisg_credits"));
		assert.ok(doStore.has("aisg_health"));

		globalThis.fetch = async () => {
			throw new Error("GET /health must never make upstream calls");
		};
		const okRes = await workerMod.default.fetch(new Request("http://aisonggenerator-worker/health"), env);
		assert.equal(okRes.status, 200);
		const okHealth = await okRes.json();
		assert.equal(okHealth.status, "ok");
		assert.doesNotMatch(JSON.stringify(okHealth), /hidden@example\.com|usr_hidden/);

		// Synthetic credit-response stream exception NEVER leaks into cron logs or public GET /health
		const streamCanary = "SYNTHETIC_STREAM_ERR_888";
		globalThis.fetch = async (url) => {
			const urlStr = String(url);
			if (urlStr === "https://aisonggenerator.io/api/auth/get-session") {
				return Response.json({ user: { id: "u" }, session: { expiresAt: futureExpiry } });
			}
			if (urlStr === "https://aisonggenerator.io/api/user") {
				return {
					ok: true,
					status: 200,
					async text() {
						throw new Error(`Stream exploded: ${streamCanary}`);
					},
				};
			}
			throw new Error(`Unexpected URL: ${urlStr}`);
		};

		const { logs: cronLogs } = await captureConsole(() => workerMod.default.scheduled({}, env, {}));
		assert.doesNotMatch(cronLogs, new RegExp(streamCanary));

		globalThis.fetch = async () => {
			throw new Error("GET /health must never make upstream calls");
		};
		const streamFailHealthRes = await workerMod.default.fetch(new Request("http://aisonggenerator-worker/health"), env);
		assert.equal(streamFailHealthRes.status, 503);
		const streamFailHealthText = await streamFailHealthRes.text();
		assert.doesNotMatch(streamFailHealthText, new RegExp(streamCanary));
		assert.equal(JSON.parse(streamFailHealthText).last_error, "AISG credits check returned invalid payload");

		// CRITICAL REGRESSION: Custom exception `.name` canary NEVER leaks in generic HTTP OR cron logs!
		const nameCanary = "CUSTOM_BINDING_ERR_NAME_CANARY_444";
		const msgCanary = "CUSTOM_BINDING_ERR_MSG_CANARY_444";
		const makeCanaryError = () => {
			const err = new Error(msgCanary);
			err.name = nameCanary;
			return err;
		};
		const brokenEnv = createEnv();
		brokenEnv.DURABLE_OBJECT = {
			idFromName: () => "v0.0.0",
			get: () => ({
				getAisgHealth: async () => {
					throw makeCanaryError();
				},
				checkAisgSession: async () => {
					throw makeCanaryError();
				},
			}),
		};

		const { result: err500Res, logs: httpErrLogs } = await captureConsole(() =>
			workerMod.default.fetch(new Request("http://aisonggenerator-worker/health"), brokenEnv)
		);
		assert.equal(err500Res.status, 500);
		const err500Text = await err500Res.text();
		assert.doesNotMatch(err500Text, new RegExp(`${nameCanary}|${msgCanary}`));
		assert.doesNotMatch(httpErrLogs, new RegExp(`${nameCanary}|${msgCanary}`));
		assert.match(httpErrLogs, /"category":"runtime_error"/);
		assert.equal(JSON.parse(err500Text).error, "Internal server error");

		const { logs: cronCustomErrLogs } = await captureConsole(() => workerMod.default.scheduled({}, brokenEnv, {}));
		assert.doesNotMatch(cronCustomErrLogs, new RegExp(`${nameCanary}|${msgCanary}`));
		assert.match(cronCustomErrLogs, /"category":"runtime_error"/);
	} finally {
		globalThis.fetch = origFetch;
	}
});
