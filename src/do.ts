import { DurableObject } from 'cloudflare:workers';
import {
    AisgCredits,
    LOW_CREDITS_THRESHOLD,
    MIN_TASK_CREDITS,
    SESSION_EXPIRY_WARN_HOURS,
    aisgAuthHeaders,
    getAisgCredits,
} from './api/aisonggenerator';
import { normalizeDiffrhythmCookie, refreshDiffrhythmCookie } from './api/diffrhythm';

export interface AisgCreditsSnapshot extends AisgCredits {
    checked_at: string;
    session_expires_at: string | null;
}

const AISG_CREDITS_STORAGE_KEY = 'aisg_credits';

export class DO extends DurableObject<Env> {
    private diffrhythmRefresh?: Promise<string>;

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
    }

    async getDiffrhythmSession(refresh = false) {
        if (refresh) {
            this.diffrhythmRefresh ??= this.refreshDiffrhythmSession().finally(() => {
                this.diffrhythmRefresh = undefined;
            });
            return this.diffrhythmRefresh;
        }

        const stored = await this.ctx.storage.get<string>('session_token');
        return stored || normalizeDiffrhythmCookie(this.env.DIFFRHYTHM_SESSION_COOKIE);
    }

    private async refreshDiffrhythmSession() {
        const stored = await this.ctx.storage.get<string>('session_token');
        const fromEnv = normalizeDiffrhythmCookie(this.env.DIFFRHYTHM_SESSION_COOKIE);
        const candidates = [stored, fromEnv].filter((value): value is string => Boolean(value));
        if (candidates.length === 0) {
            throw new Error('DIFFRHYTHM_SESSION_COOKIE is missing');
        }

        // The stored cookie can belong to an older host.
        // Keep the cookie that can read the aisinging.ai account.
        const sessionToken = await refreshDiffrhythmCookie(candidates);
        await this.ctx.storage.put('session_token', sessionToken);
        return sessionToken;
    }

    async getLastAisgCredits(): Promise<AisgCreditsSnapshot | null> {
        return (await this.ctx.storage.get<AisgCreditsSnapshot>(AISG_CREDITS_STORAGE_KEY)) ?? null;
    }

    // The site session is a Better Auth cookie whose DB expiration slides forward when get-session is called.
    // This check confirms the session still signs in, tracks session expiry, and records the current credit balance.
    async checkAisgSession(): Promise<AisgCreditsSnapshot> {
        const response = await fetch('https://aisonggenerator.io/api/auth/get-session', {
            method: 'GET',
            headers: aisgAuthHeaders(this.env),
            signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
            throw new Error(`AISG session check failed: ${response.status}`);
        }

        const json = await response.json().catch(() => null) as {
            user?: { id?: string };
            session?: { expiresAt?: unknown };
        } | null;
        if (!json?.user?.id) {
            throw new Error('AISG session check returned no user');
        }

        const sessionExpiresAt =
            typeof json.session?.expiresAt === 'string' && Number.isFinite(Date.parse(json.session.expiresAt))
                ? json.session.expiresAt
                : null;

        if (sessionExpiresAt) {
            const hoursRemaining = (Date.parse(sessionExpiresAt) - Date.now()) / 36e5;
            if (hoursRemaining < SESSION_EXPIRY_WARN_HOURS) {
                console.warn(
                    `AISG session expiring soon: expires_at=${sessionExpiresAt} (${hoursRemaining.toFixed(1)}h remaining)`
                );
            }
        }

        const credits = await getAisgCredits(this.env);
        const snapshot: AisgCreditsSnapshot = {
            ...credits,
            checked_at: new Date().toISOString(),
            session_expires_at: sessionExpiresAt,
        };
        await this.ctx.storage.put(AISG_CREDITS_STORAGE_KEY, snapshot);

        if (credits.left_credits < MIN_TASK_CREDITS) {
            console.error(
                `AISG credits exhausted: left_credits=${credits.left_credits} (min=${MIN_TASK_CREDITS}), plan=${credits.plan_tier ?? 'none'}, active_sub=${credits.has_active_sub}`
            );
        } else if (credits.left_credits < LOW_CREDITS_THRESHOLD || !credits.has_active_sub) {
            console.warn(
                `AISG credits low or subscription inactive: left_credits=${credits.left_credits}, plan=${credits.plan_tier ?? 'none'}, active_sub=${credits.has_active_sub}`
            );
        }

        return snapshot;
    }
}
