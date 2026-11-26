// Runtime secrets and optional vars not emitted by `wrangler types` without a local .dev.vars file.
interface Env {
	AISONGGENERATOR_SESSION_TOKEN: string;
	AISONGGENERATOR_WORKSPACE_ID?: string;
	CF_AI_GATEWAY_ID?: string;
	/** Optional override to promote a supported lyrics model to primary (e.g. "anthropic/claude-opus-5.5"). */
	LYRICS_PRIMARY_MODEL?: string;
}
