import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const wranglerDir = fs.realpathSync(path.resolve("node_modules/wrangler"));
const esbuild = require(require.resolve("esbuild", {
	paths: [wranglerDir, path.dirname(wranglerDir)],
}));

const cloudflareWorkersStubPlugin = {
	name: "cloudflare-workers-stub",
	setup(build) {
		build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
			path: "cloudflare:workers",
			namespace: "cloudflare-workers-stub",
		}));
		build.onLoad({ filter: /.*/, namespace: "cloudflare-workers-stub" }, () => ({
			contents: `
				export class DurableObject {
					constructor(state, env) {
						this.ctx = state;
						this.env = env;
					}
				}
			`,
			loader: "js",
		}));
	},
};

export function createTestBundler(prefix) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return {
		async bundle(entry, outName) {
			const outfile = path.join(tmpDir, outName);
			await esbuild.build({
				entryPoints: [path.resolve(entry)],
				outfile,
				bundle: true,
				format: "esm",
				platform: "node",
				target: "node20",
				plugins: [cloudflareWorkersStubPlugin],
			});
			return import(pathToFileURL(outfile).href);
		},
		cleanup() {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		},
	};
}

export function createMockDoNamespace(DOClass, getEnv) {
	const instances = new Map();
	const stores = new Map();

	return {
		stores,
		idFromName(name) {
			return name;
		},
		get(id) {
			if (!stores.has(id)) {
				stores.set(id, new Map());
			}
			const map = stores.get(id);
			if (!instances.has(id)) {
				const state = {
					storage: {
						async get(key) {
							return map.get(key);
						},
						async put(key, value) {
							map.set(key, structuredClone(value));
						},
						async delete(key) {
							return map.delete(key);
						},
						async list(options = {}) {
							const prefix = options?.prefix ?? "";
							const out = new Map();
							for (const [k, v] of map.entries()) {
								if (!prefix || k.startsWith(prefix)) {
									out.set(k, structuredClone(v));
								}
							}
							return out;
						},
					},
				};
				instances.set(id, new DOClass(state, getEnv()));
			}
			return instances.get(id);
		},
	};
}
