// Runtime secrets and optional vars not emitted by `wrangler types` without a local .dev.vars file.
interface Env {
	AISONGGENERATOR_SESSION_TOKEN: string;
	AISONGGENERATOR_WORKSPACE_ID?: string;
	// Legacy Step-2 bridge secret kept while live smol-workflow drains and rollback window remains open.
	DIFFRHYTHM_SESSION_COOKIE?: string;
}
