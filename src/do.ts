import { DurableObject } from 'cloudflare:workers';
import {
	AisgCredits,
	LOW_CREDITS_THRESHOLD,
	MIN_TASK_CREDITS,
	SESSION_EXPIRY_WARN_HOURS,
	aisgAuthHeaders,
	getAisgCredits,
} from './api/aisonggenerator';
import { ProviderError } from './api/errors';

export interface AisgCreditsSnapshot extends AisgCredits {
	checked_at: string;
	session_expires_at: string | null;
}

export interface AisgHealthSnapshot {
	ok: boolean;
	session_ok: boolean;
	credits_ok: boolean;
	checked_at: string;
	session_expires_at: string | null;
	left_credits: number | null;
	paid_credits: number | null;
	used_credits: number | null;
	free_credits: number | null;
	plan_tier: string | null;
	has_active_sub: boolean | null;
	last_error: string | null;
}

export interface AttemptReceipt {
	attempt_id: string;
	status: 'in_flight' | 'accepted' | 'completed' | 'ambiguous';
	payload_hash: string;
	task_id?: string;
	workspace_id?: string;
	music_ids?: string[];
	created_at: string;
	updated_at: string;
}

export type AttemptClaimResult =
	| { action: 'proceed' }
	| { action: 'conflict' }
	| { action: 'existing'; receipt: AttemptReceipt };

const PROVIDER_STATE_DO_NAME = 'v0.0.0';
const AISG_CREDITS_STORAGE_KEY = 'aisg_credits';
const AISG_HEALTH_STORAGE_KEY = 'aisg_health';
const LEGACY_DIFFRHYTHM_SESSION_STORAGE_KEY = 'session_token';
const ATTEMPT_STORAGE_PREFIX = 'attempt:';

const ALLOWED_HEALTH_ERRORS = new Set([
	'AISG session token is missing',
	'AISG session check failed: network or timeout',
	'AISG session check returned no user',
	'AISG session expired',
	'AISG credits check unauthorized',
	'AISG credits check failed: network or timeout',
	'AISG credits check returned invalid payload',
	'AISG credits check failed',
	'AISG credits exhausted',
	'AISG health check failed',
]);
const SAFE_HTTP_HEALTH_ERROR_RE = /^AISG (session|credits) check failed \(HTTP [1-5]\d{2}\)$/;

export function getProviderStateStub(env: Env) {
	const doid = env.DURABLE_OBJECT.idFromName(PROVIDER_STATE_DO_NAME);
	return env.DURABLE_OBJECT.get(doid);
}

export function sanitizeHealthErrorMessage(value: string | null | undefined): string | null {
	if (typeof value !== 'string' || !value.trim()) {
		return null;
	}
	const trimmed = value.trim();
	if (ALLOWED_HEALTH_ERRORS.has(trimmed) || SAFE_HTTP_HEALTH_ERROR_RE.test(trimmed)) {
		return trimmed;
	}
	return 'AISG health check failed';
}

function classifyCreditsHealthError(error: unknown): string {
	if (error instanceof ProviderError) {
		if (error.code === 'aisg_auth_error' || error.code === 'aisg_forbidden') {
			return 'AISG credits check unauthorized';
		}
		if (error.upstreamStatus !== undefined) {
			if (error.upstreamStatus >= 200 && error.upstreamStatus < 300) {
				return 'AISG credits check returned invalid payload';
			}
			return `AISG credits check failed (HTTP ${error.upstreamStatus})`;
		}
		if (error.status === 504 || error.status === 502) {
			return 'AISG credits check failed: network or timeout';
		}
	}
	return 'AISG credits check failed';
}

function healthFromCreditsSnapshot(snapshot: AisgCreditsSnapshot): AisgHealthSnapshot {
	const creditsOk = snapshot.left_credits >= MIN_TASK_CREDITS;
	const sessionExpired =
		snapshot.session_expires_at !== null &&
		Number.isFinite(Date.parse(snapshot.session_expires_at)) &&
		Date.parse(snapshot.session_expires_at) <= Date.now();
	const sessionOk = !sessionExpired;
	return {
		ok: sessionOk && creditsOk,
		session_ok: sessionOk,
		credits_ok: creditsOk,
		checked_at: snapshot.checked_at,
		session_expires_at: snapshot.session_expires_at,
		left_credits: snapshot.left_credits,
		paid_credits: snapshot.paid_credits,
		used_credits: snapshot.used_credits,
		free_credits: snapshot.free_credits,
		plan_tier: snapshot.plan_tier,
		has_active_sub: snapshot.has_active_sub,
		last_error: !sessionOk
			? 'AISG session expired'
			: !creditsOk
				? 'AISG credits exhausted'
				: null,
	};
}

export class DO extends DurableObject<Env> {
	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
	}

	/**
	 * Caller-supplied attempt receipt ledger (keyed by explicit Idempotency-Key / attempt_id).
	 * Completed receipts are retained across lost responses and replays.
	 * Unresolved (`in_flight` / `ambiguous`) attempts NEVER expire back into a fresh paid submit
	 * and remain inspectable via getAttempt() for deliberate reconciliation.
	 */
	async claimAttempt(attemptId: string, payloadHash: string): Promise<AttemptClaimResult> {
		const storageKey = `${ATTEMPT_STORAGE_PREFIX}${attemptId}`;
		const existing = await this.ctx.storage.get<AttemptReceipt>(storageKey);
		if (existing) {
			if (existing.payload_hash !== payloadHash) {
				return { action: 'conflict' };
			}
			return { action: 'existing', receipt: existing };
		}

		const now = new Date().toISOString();
		const created: AttemptReceipt = {
			attempt_id: attemptId,
			status: 'in_flight',
			payload_hash: payloadHash,
			created_at: now,
			updated_at: now,
		};
		await this.ctx.storage.put(storageKey, created);
		return { action: 'proceed' };
	}

	async recordAttemptAccepted(
		attemptId: string,
		payloadHash: string,
		taskId: string,
		workspaceId?: string
	): Promise<AttemptReceipt> {
		const storageKey = `${ATTEMPT_STORAGE_PREFIX}${attemptId}`;
		const existing = await this.ctx.storage.get<AttemptReceipt>(storageKey);
		const now = new Date().toISOString();
		const updated: AttemptReceipt = {
			attempt_id: attemptId,
			status: 'accepted',
			payload_hash: existing?.payload_hash ?? payloadHash,
			task_id: taskId,
			...(workspaceId ? { workspace_id: workspaceId } : {}),
			created_at: existing?.created_at ?? now,
			updated_at: now,
		};
		await this.ctx.storage.put(storageKey, updated);
		return updated;
	}

	async recordAttemptCompleted(
		attemptId: string,
		payloadHash: string,
		taskId: string,
		musicIds: string[],
		workspaceId?: string
	): Promise<AttemptReceipt> {
		const storageKey = `${ATTEMPT_STORAGE_PREFIX}${attemptId}`;
		const existing = await this.ctx.storage.get<AttemptReceipt>(storageKey);
		const now = new Date().toISOString();
		const updated: AttemptReceipt = {
			attempt_id: attemptId,
			status: 'completed',
			payload_hash: existing?.payload_hash ?? payloadHash,
			task_id: taskId,
			...(workspaceId ? { workspace_id: workspaceId } : {}),
			music_ids: [...musicIds],
			created_at: existing?.created_at ?? now,
			updated_at: now,
		};
		await this.ctx.storage.put(storageKey, updated);
		return updated;
	}

	async recordAttemptAmbiguous(attemptId: string, payloadHash: string): Promise<AttemptReceipt> {
		const storageKey = `${ATTEMPT_STORAGE_PREFIX}${attemptId}`;
		const existing = await this.ctx.storage.get<AttemptReceipt>(storageKey);
		const now = new Date().toISOString();
		const updated: AttemptReceipt = {
			attempt_id: attemptId,
			status: 'ambiguous',
			payload_hash: existing?.payload_hash ?? payloadHash,
			created_at: existing?.created_at ?? now,
			updated_at: now,
		};
		await this.ctx.storage.put(storageKey, updated);
		return updated;
	}

	async clearAttempt(attemptId: string): Promise<void> {
		await this.ctx.storage.delete(`${ATTEMPT_STORAGE_PREFIX}${attemptId}`);
	}

	async getAttempt(attemptId: string): Promise<AttemptReceipt | null> {
		return (await this.ctx.storage.get<AttemptReceipt>(`${ATTEMPT_STORAGE_PREFIX}${attemptId}`)) ?? null;
	}

	async getLastAisgCredits(): Promise<AisgCreditsSnapshot | null> {
		return (await this.ctx.storage.get<AisgCreditsSnapshot>(AISG_CREDITS_STORAGE_KEY)) ?? null;
	}

	async getAisgHealth(): Promise<AisgHealthSnapshot | null> {
		const storedHealth = await this.ctx.storage.get<AisgHealthSnapshot>(AISG_HEALTH_STORAGE_KEY);
		if (storedHealth) {
			return {
				...storedHealth,
				last_error: sanitizeHealthErrorMessage(storedHealth.last_error),
			};
		}
		const storedCredits = await this.getLastAisgCredits();
		if (storedCredits) {
			return healthFromCreditsSnapshot(storedCredits);
		}
		return null;
	}

	private async recordHealthFailure(
		checkedAt: string,
		sessionOk: boolean,
		sessionExpiresAt: string | null,
		prevCredits: AisgCreditsSnapshot | null,
		reason: string
	): Promise<void> {
		const health: AisgHealthSnapshot = {
			ok: false,
			session_ok: sessionOk,
			credits_ok: false,
			checked_at: checkedAt,
			session_expires_at: sessionExpiresAt ?? prevCredits?.session_expires_at ?? null,
			left_credits: prevCredits?.left_credits ?? null,
			paid_credits: prevCredits?.paid_credits ?? null,
			used_credits: prevCredits?.used_credits ?? null,
			free_credits: prevCredits?.free_credits ?? null,
			plan_tier: prevCredits?.plan_tier ?? null,
			has_active_sub: prevCredits?.has_active_sub ?? null,
			last_error: sanitizeHealthErrorMessage(reason),
		};
		await this.ctx.storage.put(AISG_HEALTH_STORAGE_KEY, health);
	}

	// The site session is a Better Auth cookie whose DB expiration slides forward when get-session is called.
	// This check confirms the session still signs in, tracks session expiry, and records the current credit balance.
	async checkAisgSession(): Promise<AisgCreditsSnapshot> {
		const checkedAt = new Date().toISOString();
		const prevCredits = await this.getLastAisgCredits();

		let headers: HeadersInit;
		try {
			headers = aisgAuthHeaders(this.env);
		} catch (error) {
			await this.recordHealthFailure(checkedAt, false, null, prevCredits, 'AISG session token is missing');
			throw error;
		}

		let response: Response;
		try {
			response = await fetch('https://aisonggenerator.io/api/auth/get-session', {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(10000),
			});
		} catch {
			const reason = 'AISG session check failed: network or timeout';
			await this.recordHealthFailure(checkedAt, false, null, prevCredits, reason);
			throw new ProviderError(reason, {
				status: 502,
				provider: 'aisonggenerator',
				code: 'aisg_upstream_error',
				retryable: true,
				outcome: 'rejected',
			});
		}

		if (!response.ok) {
			const reason = `AISG session check failed (HTTP ${response.status})`;
			await this.recordHealthFailure(checkedAt, false, null, prevCredits, reason);
			throw new ProviderError(reason, {
				status: response.status === 401 ? 401 : response.status === 403 ? 403 : 502,
				provider: 'aisonggenerator',
				code:
					response.status === 401
						? 'aisg_auth_error'
						: response.status === 403
							? 'aisg_forbidden'
							: 'aisg_upstream_error',
				retryable: response.status >= 500,
				outcome: 'rejected',
				upstreamStatus: response.status,
			});
		}

		const json = (await response.json().catch(() => null)) as {
			user?: { id?: string };
			session?: { expiresAt?: unknown };
		} | null;
		if (!json?.user?.id) {
			const reason = 'AISG session check returned no user';
			await this.recordHealthFailure(checkedAt, false, null, prevCredits, reason);
			throw new ProviderError(reason, {
				status: 401,
				provider: 'aisonggenerator',
				code: 'aisg_auth_error',
				retryable: false,
				outcome: 'rejected',
			});
		}

		const sessionExpiresAt =
			typeof json.session?.expiresAt === 'string' && Number.isFinite(Date.parse(json.session.expiresAt))
				? json.session.expiresAt
				: null;

		if (sessionExpiresAt) {
			const hoursRemaining = (Date.parse(sessionExpiresAt) - Date.now()) / 36e5;
			if (hoursRemaining < SESSION_EXPIRY_WARN_HOURS) {
				console.warn(
					JSON.stringify({
						event: 'aisg_session_expiring_soon',
						expires_at: sessionExpiresAt,
						hours_remaining: Number(hoursRemaining.toFixed(1)),
					})
				);
			}
		}

		let credits: AisgCredits;
		try {
			credits = await getAisgCredits(this.env);
		} catch (error) {
			const reason = classifyCreditsHealthError(error);
			await this.recordHealthFailure(checkedAt, true, sessionExpiresAt, prevCredits, reason);
			throw new ProviderError(reason, {
				status: error instanceof ProviderError ? error.status : 502,
				provider: 'aisonggenerator',
				code: error instanceof ProviderError ? error.code : 'aisg_upstream_error',
				retryable: error instanceof ProviderError ? error.retryable : true,
				outcome: 'rejected',
				upstreamStatus: error instanceof ProviderError ? error.upstreamStatus : undefined,
			});
		}

		const snapshot: AisgCreditsSnapshot = {
			...credits,
			checked_at: checkedAt,
			session_expires_at: sessionExpiresAt,
		};
		const creditsOk = credits.left_credits >= MIN_TASK_CREDITS;
		const health: AisgHealthSnapshot = {
			ok: creditsOk,
			session_ok: true,
			credits_ok: creditsOk,
			checked_at: checkedAt,
			session_expires_at: sessionExpiresAt,
			left_credits: credits.left_credits,
			paid_credits: credits.paid_credits,
			used_credits: credits.used_credits,
			free_credits: credits.free_credits,
			plan_tier: credits.plan_tier,
			has_active_sub: credits.has_active_sub,
			last_error: creditsOk ? null : 'AISG credits exhausted',
		};

		await this.ctx.storage.put(AISG_CREDITS_STORAGE_KEY, snapshot);
		await this.ctx.storage.put(AISG_HEALTH_STORAGE_KEY, health);
		// Step-6 contraction: safely retire only the obsolete DiffRhythm cookie key while preserving DO state.
		await this.ctx.storage.delete(LEGACY_DIFFRHYTHM_SESSION_STORAGE_KEY);

		if (credits.left_credits < MIN_TASK_CREDITS) {
			console.error(
				JSON.stringify({
					event: 'aisg_credits_exhausted',
					left_credits: credits.left_credits,
					min_task_credits: MIN_TASK_CREDITS,
					plan_tier: credits.plan_tier,
					has_active_sub: credits.has_active_sub,
				})
			);
		} else if (credits.left_credits < LOW_CREDITS_THRESHOLD || !credits.has_active_sub) {
			console.warn(
				JSON.stringify({
					event: 'aisg_credits_low',
					left_credits: credits.left_credits,
					plan_tier: credits.plan_tier,
					has_active_sub: credits.has_active_sub,
				})
			);
		}

		return snapshot;
	}
}
