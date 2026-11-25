import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness, experimental_readRawConfig } from "wrangler";

const project = new URL("../", import.meta.url);
const { rawConfig } = experimental_readRawConfig({
	config: fileURLToPath(new URL("wrangler.jsonc", project)),
});

async function scratchDirectory(t) {
	const directory = await mkdtemp(join(tmpdir(), "aisg-workerd-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

test("workerd loads every Worker route, Durable Object and cron", async (t) => {
	const outbound = t.mock.method(globalThis, "fetch", async (url) => {
		throw new Error(`Unexpected outbound request: ${url}`);
	});
	const server = createTestHarness({
		// Resolve local Wrangler variables only from this empty directory.
		root: await scratchDirectory(t),
		workers: [{
			config: {
				...rawConfig,
				main: fileURLToPath(new URL(rawConfig.main, project)),
				// The route canaries use validation paths and need no AI binding.
				ai: undefined,
				vars: { AISONGGENERATOR_SESSION_TOKEN: "" },
			},
		}],
	});

	try {
		await server.listen();
		const worker = server.getWorker();
		const initial = await worker.fetch("/health");
		assert.equal(initial.status, 200);
		assert.equal(initial.headers.get("cache-control"), "no-store");
		assert.equal((await initial.json()).status, "unknown");

		for (const [method, path, error] of [
			["POST", "/api/lyrics", "Invalid JSON request body"],
			["POST", "/api/tasks", "Invalid JSON request body"],
			["GET", "/api/tasks/smoke?page=0", "'page' query parameter must be a positive integer"],
			["POST", "/api/songs", "Invalid JSON request body"],
			["GET", "/api/songs", "'ids' query parameter is required"],
		]) {
			const request = method === "POST"
				? { method, headers: { "content-type": "application/json" }, body: "{" }
				: { method };
			const response = await worker.fetch(path, request);
			assert.equal(response.status, 400, `${method} ${path}`);
			assert.equal((await response.json()).error, error, `${method} ${path}`);
		}

		await worker.scheduled({ cron: rawConfig.triggers.crons[0] });
		const afterCron = await worker.fetch("/health");
		assert.equal(afterCron.status, 503);
		const health = await afterCron.json();
		assert.ok(health.checked_at);
		assert.equal(health.last_error, "AISG session token is missing");
		assert.equal(outbound.mock.callCount(), 0);
	} finally {
		await server.close();
	}
});
