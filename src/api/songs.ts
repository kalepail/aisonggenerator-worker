import { Context } from 'hono';
import {
	AiSongGeneratorGenerateParams,
	AiSongGeneratorSong,
	aisgAuthHeaders,
	buildSubmitBody,
	discoverAiSongGeneratorTaskMusicIds,
	findMusicIds,
	getAiSongGeneratorSongResults,
	submitAiSongGeneratorTask,
} from './aisonggenerator';
import { ProviderError } from './errors';
import { getProviderStateStub } from '../do';

interface SongRequestBody {
	attempt_id?: unknown;
	title?: unknown;
	style?: unknown;
	instrumental?: unknown;
	lyrics?: unknown;
	prompt?: unknown;
	description?: unknown;
	public?: unknown;
	vocalGender?: unknown;
	negativeTags?: unknown;
	is_original?: unknown;
	lyrics_compatibility_level?: unknown;
	imageUrls?: unknown;
	workspace_id?: unknown;
}

interface ParsedSongRequest {
	params: AiSongGeneratorGenerateParams;
	attemptId?: string;
	rawPrompt: string;
}

const ATTEMPT_ID_RE = /^[A-Za-z0-9._:-]{16,128}$/;

function invalidRequest(message: string): ProviderError {
	return new ProviderError(message, {
		status: 400,
		provider: 'aisonggenerator',
		code: 'invalid_request',
		retryable: false,
		outcome: 'rejected',
	});
}

function assertAisgOnlySource(source: string | undefined): void {
	const resolved = source || 'aisonggenerator';
	if (resolved !== 'aisonggenerator') {
		throw invalidRequest("Invalid 'source'. Only 'aisonggenerator' is supported.");
	}
}

function parseOptionalPositivePage(raw: string | undefined): number | undefined {
	if (raw === undefined || raw === '') {
		return undefined;
	}
	if (!/^[1-9]\d*$/.test(raw.trim())) {
		throw invalidRequest("'page' query parameter must be a positive integer");
	}
	const parsed = Number(raw.trim());
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw invalidRequest("'page' query parameter must be a positive integer");
	}
	return parsed;
}

function parseAttemptId(headerValue: string | undefined, bodyValue: unknown): string | undefined {
	let fromHeader: string | undefined;
	if (headerValue !== undefined) {
		const trimmed = headerValue.trim();
		if (!trimmed || !ATTEMPT_ID_RE.test(trimmed)) {
			throw invalidRequest("'Idempotency-Key' header must be 16-128 characters of [A-Za-z0-9._:-]");
		}
		fromHeader = trimmed;
	}

	let fromBody: string | undefined;
	if (bodyValue !== undefined) {
		if (typeof bodyValue !== 'string' || !bodyValue.trim() || !ATTEMPT_ID_RE.test(bodyValue.trim())) {
			throw invalidRequest("'attempt_id' must be 16-128 characters of [A-Za-z0-9._:-]");
		}
		fromBody = bodyValue.trim();
	}

	if (fromHeader && fromBody && fromHeader !== fromBody) {
		throw invalidRequest("Conflicting 'Idempotency-Key' header and 'attempt_id' field");
	}
	return fromHeader ?? fromBody;
}

async function parseSongRequest(ctx: Context<{ Bindings: Env }>): Promise<ParsedSongRequest> {
	let raw: unknown;
	try {
		raw = await ctx.req.json();
	} catch {
		throw invalidRequest('Invalid JSON request body');
	}

	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw invalidRequest('Request body must be a JSON object');
	}

	const data = raw as SongRequestBody;
	const attemptId = parseAttemptId(ctx.req.header('idempotency-key'), data.attempt_id);

	if (data.instrumental !== undefined && typeof data.instrumental !== 'boolean') {
		throw invalidRequest("'instrumental' must be a boolean");
	}
	const instrumental = Boolean(data.instrumental);

	if (data.public !== undefined && typeof data.public !== 'boolean') {
		throw invalidRequest("'public' must be a boolean");
	}

	if (data.title !== undefined && typeof data.title !== 'string') {
		throw invalidRequest("'title' must be a string");
	}
	if (data.lyrics !== undefined && typeof data.lyrics !== 'string') {
		throw invalidRequest("'lyrics' must be a string");
	}
	if (data.prompt !== undefined && typeof data.prompt !== 'string') {
		throw invalidRequest("'prompt' must be a string");
	}
	if (data.description !== undefined && typeof data.description !== 'string') {
		throw invalidRequest("'description' must be a string");
	}

	let styles: string[] = [];
	if (!instrumental) {
		if (!Array.isArray(data.style) || !data.style.every((item) => typeof item === 'string')) {
			throw invalidRequest("'style' must be an array of strings");
		}
		styles = data.style;
	} else if (data.style !== undefined) {
		if (!Array.isArray(data.style) || !data.style.every((item) => typeof item === 'string')) {
			throw invalidRequest("'style' must be an array of strings");
		}
		styles = data.style;
	}

	let instrumentalDesc = data.prompt ?? '';
	if (instrumental && data.description) {
		instrumentalDesc += (instrumentalDesc ? '\n' : '') + data.description;
	}

	const compatibilityLevel = data.lyrics_compatibility_level;
	const params: AiSongGeneratorGenerateParams = {
		title: data.title ?? '',
		styles,
		instrumental,
		lyrics: data.lyrics,
		description: instrumental ? instrumentalDesc : data.lyrics,
		isPublic: Boolean(data.public),
		vocalGender: data.vocalGender === 'm' || data.vocalGender === 'f' ? data.vocalGender : undefined,
		negativeTags: typeof data.negativeTags === 'string' ? data.negativeTags : undefined,
		isOriginal: typeof data.is_original === 'boolean' ? data.is_original : undefined,
		lyricsCompatibilityLevel:
			compatibilityLevel === 0 ||
			compatibilityLevel === 1 ||
			compatibilityLevel === 2 ||
			compatibilityLevel === 3
				? compatibilityLevel
				: undefined,
		imageUrls: Array.isArray(data.imageUrls)
			? data.imageUrls.filter((item): item is string => typeof item === 'string')
			: undefined,
		workspaceId: typeof data.workspace_id === 'string' ? data.workspace_id : undefined,
	};

	return {
		params,
		attemptId,
		rawPrompt: data.prompt ?? '',
	};
}

async function computeAttemptPayloadHash(
	submitBody: Record<string, unknown>,
	rawPrompt: string
): Promise<string> {
	const canonicalBody = JSON.stringify(submitBody, Object.keys(submitBody).sort());
	const canonical = JSON.stringify({ body: canonicalBody, prompt: rawPrompt });
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function conflictError(): ProviderError {
	return new ProviderError('Attempt id was already used with a different request payload', {
		status: 409,
		provider: 'aisonggenerator',
		code: 'idempotency_conflict',
		retryable: false,
		outcome: 'rejected',
	});
}

function unresolvedAttemptError(): ProviderError {
	return new ProviderError('AISG song submission outcome unknown; refusing duplicate submission', {
		status: 504,
		provider: 'aisonggenerator',
		code: 'aisg_dispatch_unknown',
		retryable: false,
		outcome: 'unknown',
	});
}

export async function postTask(ctx: Context<{ Bindings: Env }>) {
	assertAisgOnlySource(ctx.req.query('source'));
	const { params, attemptId, rawPrompt } = await parseSongRequest(ctx);

	if (!attemptId) {
		const receipt = await submitAiSongGeneratorTask(params, ctx.env);
		return ctx.json(receipt);
	}

	const submitBody = buildSubmitBody(params, ctx.env);
	aisgAuthHeaders(ctx.env, true);
	const payloadHash = await computeAttemptPayloadHash(submitBody, rawPrompt);
	const stub = getProviderStateStub(ctx.env);
	const claim = await stub.claimAttempt(attemptId, payloadHash);

	if (claim.action === 'conflict') {
		throw conflictError();
	}
	if (claim.action === 'existing') {
		const existing = claim.receipt;
		if ((existing.status === 'accepted' || existing.status === 'completed') && existing.task_id) {
			return ctx.json(
				existing.workspace_id
					? { task_id: existing.task_id, workspace_id: existing.workspace_id }
					: { task_id: existing.task_id }
			);
		}
		throw unresolvedAttemptError();
	}

	let receipt: { task_id: string; workspace_id?: string };
	try {
		receipt = await submitAiSongGeneratorTask(params, ctx.env);
	} catch (error) {
		if (error instanceof ProviderError && error.outcome === 'rejected') {
			await stub.clearAttempt(attemptId);
		} else {
			await stub.recordAttemptAmbiguous(attemptId, payloadHash);
		}
		throw error;
	}

	await stub.recordAttemptAccepted(attemptId, payloadHash, receipt.task_id, receipt.workspace_id);
	return ctx.json(receipt);
}

export async function getTask(ctx: Context<{ Bindings: Env }>) {
	assertAisgOnlySource(ctx.req.query('source'));
	const taskId = ctx.req.param('id')?.trim();
	if (!taskId) {
		throw invalidRequest("Task 'id' path parameter is required");
	}
	const workspaceId = ctx.req.query('workspace_id')?.trim() || undefined;
	const startPage = parseOptionalPositivePage(ctx.req.query('page'));
	const discovery = await discoverAiSongGeneratorTaskMusicIds(taskId, ctx.env, workspaceId, { startPage });
	return ctx.json(discovery);
}

export async function getSongs(ctx: Context<{ Bindings: Env }>) {
	const { req, env } = ctx;
	assertAisgOnlySource(req.query('source'));

	const idsQuery = req.query('ids');
	if (!idsQuery) {
		throw invalidRequest("'ids' query parameter is required");
	}

	const ids = idsQuery.split(',').map((id) => id.trim());
	if (ids.length === 0 || ids.some((id) => id.length === 0)) {
		throw invalidRequest("'ids' query parameter must not contain empty elements");
	}

	const results: AiSongGeneratorSong[] = await getAiSongGeneratorSongResults(ids, env);
	return ctx.json(results);
}

export async function postSongs(ctx: Context<{ Bindings: Env }>) {
	assertAisgOnlySource(ctx.req.query('source'));
	const { params, attemptId, rawPrompt } = await parseSongRequest(ctx);

	// Unkeyed legacy caller (without Idempotency-Key / attempt_id):
	// never share DO state across independent requests, and preserve 6af87b5 non-retrying behavior
	// when a single song is visible at loop exhaustion so unkeyed callers do not re-pay AISG.
	if (!attemptId) {
		const receipt = await submitAiSongGeneratorTask(params, ctx.env);
		const musicIds = await findMusicIds(ctx.env, receipt.task_id, receipt.workspace_id, {
			allowSingletonOnExhaustion: true,
		});
		return ctx.json(musicIds);
	}

	// Keyed caller with explicit Idempotency-Key / attempt_id:
	// retain completed receipts across response loss & replay, never expire unresolved attempts,
	// and require full 2-track discovery before completing.
	const submitBody = buildSubmitBody(params, ctx.env);
	aisgAuthHeaders(ctx.env, true);
	const payloadHash = await computeAttemptPayloadHash(submitBody, rawPrompt);
	const stub = getProviderStateStub(ctx.env);
	const claim = await stub.claimAttempt(attemptId, payloadHash);

	if (claim.action === 'conflict') {
		throw conflictError();
	}

	if (claim.action === 'existing') {
		const existing = claim.receipt;
		if (existing.status === 'completed' && existing.music_ids) {
			return ctx.json(existing.music_ids);
		}
		if (existing.status === 'accepted' && existing.task_id) {
			const musicIds = await findMusicIds(ctx.env, existing.task_id, existing.workspace_id);
			await stub.recordAttemptCompleted(attemptId, payloadHash, existing.task_id, musicIds, existing.workspace_id);
			return ctx.json(musicIds);
		}
		throw unresolvedAttemptError();
	}

	let receipt: { task_id: string; workspace_id?: string };
	try {
		receipt = await submitAiSongGeneratorTask(params, ctx.env);
	} catch (error) {
		if (error instanceof ProviderError && error.outcome === 'rejected') {
			await stub.clearAttempt(attemptId);
		} else {
			await stub.recordAttemptAmbiguous(attemptId, payloadHash);
		}
		throw error;
	}

	await stub.recordAttemptAccepted(attemptId, payloadHash, receipt.task_id, receipt.workspace_id);

	const musicIds = await findMusicIds(ctx.env, receipt.task_id, receipt.workspace_id);
	await stub.recordAttemptCompleted(attemptId, payloadHash, receipt.task_id, musicIds, receipt.workspace_id);
	return ctx.json(musicIds);
}
