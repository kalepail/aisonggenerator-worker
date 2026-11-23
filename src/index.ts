import { Hono, Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
	LOW_CREDITS_THRESHOLD,
	MIN_TASK_CREDITS,
	MUSIC_MODEL,
	SESSION_EXPIRY_WARN_HOURS,
} from './api/aisonggenerator';
import { ProviderError, classifyUnexpectedErrorCategory } from './api/errors';
import { lyrics } from './api/lyrics';
import { getSongs, getTask, postSongs, postTask } from './api/songs';
import {
	getProviderStateStub,
	sanitizeHealthErrorMessage,
	type AisgHealthSnapshot,
} from './do';

export { DO, getProviderStateStub } from './do';

const HEALTH_STALE_MS = 60 * 60 * 1000; // 4 missed 15-minute cron intervals

function buildHealthBody(snapshot: AisgHealthSnapshot | null) {
	if (!snapshot) {
		return {
			httpStatus: 200 as ContentfulStatusCode,
			body: {
				status: 'unknown' as const,
				provider: 'aisonggenerator' as const,
				model: MUSIC_MODEL,
				checked_at: null,
				stale: false,
				session: {
					ok: null,
					expires_at: null,
					expiring_soon: false,
				},
				credits: {
					ok: null,
					left_credits: null,
					paid_credits: null,
					used_credits: null,
					free_credits: null,
					plan_tier: null,
					has_active_sub: null,
					min_task_credits: MIN_TASK_CREDITS,
					low_credits_threshold: LOW_CREDITS_THRESHOLD,
					low: false,
				},
				last_error: null,
			},
		};
	}

	const now = Date.now();
	const expiresAtMs = snapshot.session_expires_at ? Date.parse(snapshot.session_expires_at) : NaN;
	const sessionExpired = Number.isFinite(expiresAtMs) && expiresAtMs <= now;
	const sessionOk = snapshot.session_ok && !sessionExpired;
	const sessionExpiringSoon =
		Number.isFinite(expiresAtMs) && !sessionExpired && (expiresAtMs - now) / 36e5 < SESSION_EXPIRY_WARN_HOURS;

	const creditsOk =
		snapshot.credits_ok && (snapshot.left_credits === null || snapshot.left_credits >= MIN_TASK_CREDITS);
	const creditsLow = snapshot.left_credits !== null && snapshot.left_credits < LOW_CREDITS_THRESHOLD;

	const checkedAtMs = Date.parse(snapshot.checked_at);
	const stale = Number.isFinite(checkedAtMs) && now - checkedAtMs > HEALTH_STALE_MS;

	const healthy = snapshot.ok && sessionOk && creditsOk;
	const status = !healthy
		? ('unhealthy' as const)
		: sessionExpiringSoon || creditsLow || snapshot.has_active_sub === false || stale
			? ('degraded' as const)
			: ('ok' as const);

	return {
		httpStatus: (status === 'unhealthy' ? 503 : 200) as ContentfulStatusCode,
		body: {
			status,
			provider: 'aisonggenerator' as const,
			model: MUSIC_MODEL,
			checked_at: snapshot.checked_at,
			stale,
			session: {
				ok: sessionOk,
				expires_at: snapshot.session_expires_at,
				expiring_soon: sessionExpiringSoon,
			},
			credits: {
				ok: creditsOk,
				left_credits: snapshot.left_credits,
				paid_credits: snapshot.paid_credits,
				used_credits: snapshot.used_credits,
				free_credits: snapshot.free_credits,
				plan_tier: snapshot.plan_tier,
				has_active_sub: snapshot.has_active_sub,
				min_task_credits: MIN_TASK_CREDITS,
				low_credits_threshold: LOW_CREDITS_THRESHOLD,
				low: creditsLow,
			},
			last_error: sessionExpired
				? 'AISG session expired'
				: sanitizeHealthErrorMessage(snapshot.last_error),
		},
	};
}

async function health(ctx: Context<{ Bindings: Env }>) {
	const stub = getProviderStateStub(ctx.env);
	const snapshot = await stub.getAisgHealth();
	const { httpStatus, body } = buildHealthBody(snapshot);
	ctx.header('Cache-Control', 'no-store');
	return ctx.json(body, httpStatus);
}

export const app = new Hono<{ Bindings: Env }>();

app
	.get('/health', health)
	.post('/api/lyrics', lyrics)
	.post('/api/tasks', postTask)
	.get('/api/tasks/:id', getTask)
	.post('/api/songs', postSongs)
	.get('/api/songs', getSongs)
	.onError((err, ctx) => {
		if (err instanceof ProviderError) {
			console.error(
				JSON.stringify({
					event: 'provider_error',
					provider: err.provider,
					code: err.code,
					status: err.status,
					retryable: err.retryable,
					outcome: err.outcome,
					upstream_status: err.upstreamStatus,
					task_id: err.taskId,
				})
			);
			return err.toResponse();
		}

		if (err instanceof HTTPException) {
			const status = err.status as ContentfulStatusCode;
			console.error(
				JSON.stringify({
					event: 'http_exception',
					status,
				})
			);
			return ctx.json(
				{
					error: status >= 500 ? 'Internal server error' : 'Invalid request',
					provider: 'worker',
					code: status >= 500 ? 'internal_error' : 'invalid_request',
					retryable: status >= 500,
					outcome: status >= 500 ? 'unknown' : 'rejected',
				},
				status
			);
		}

		console.error(
			JSON.stringify({
				event: 'unexpected_error',
				category: classifyUnexpectedErrorCategory(err),
			})
		);

		return ctx.json(
			{
				error: 'Internal server error',
				provider: 'worker',
				code: 'internal_error',
				retryable: true,
				outcome: 'unknown',
			},
			500
		);
	})
	.notFound((ctx) => ctx.body(null, 404));

async function checkSession<T>(
	name: string,
	check: () => Promise<T>,
	formatSuccess?: (result: T) => Record<string, unknown> | null
) {
	try {
		const result = await check();
		const fields = formatSuccess ? formatSuccess(result) : {};
		if (fields !== null) {
			console.log(JSON.stringify({ event: 'session_check_ok', name, ...fields }));
		}
	} catch (error) {
		if (error instanceof ProviderError) {
			console.error(
				JSON.stringify({
					event: 'session_check_failed',
					name,
					code: error.code,
					status: error.status,
					upstream_status: error.upstreamStatus,
				})
			);
		} else {
			console.error(
				JSON.stringify({
					event: 'session_check_failed',
					name,
					code: 'unexpected_error',
					category: classifyUnexpectedErrorCategory(error),
				})
			);
		}
	}
}

export default {
	fetch: app.fetch,
	async scheduled(ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
		const stub = getProviderStateStub(env);

		await checkSession(
			'AISG',
			() => stub.checkAisgSession(),
			(credits) => ({
				left_credits: credits.left_credits,
				plan_tier: credits.plan_tier,
				has_active_sub: credits.has_active_sub,
				session_expires_at: credits.session_expires_at,
			})
		);
	},
};
