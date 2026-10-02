import { DurableObject } from 'cloudflare:workers';
import { aisgAuthHeaders } from './api/aisonggenerator';

export class DO extends DurableObject<Env> {
    private refreshingDiffrhythmToken = false;

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
    }

    async getDiffrhythmSession(refresh = false) {
        if (refresh) {
            // Prevent concurrent refresh attempts if called rapidly
            if (this.refreshingDiffrhythmToken) {
                // Optional: wait for the ongoing refresh or return stale/error
                // For simplicity, just return current token, refresh will eventually complete
            } else {
                try {
                    this.refreshingDiffrhythmToken = true;
                    await this.refreshDiffrhythmSession();
                } catch (err: any) {
                    return { error: err };
                } finally {
                    this.refreshingDiffrhythmToken = false;
                }
            }
        }

        return this.ctx.storage.get<string>('session_token');
    }

    private async refreshDiffrhythmSession() {
        const existingSessionToken = await this.ctx.storage.get<string>('session_token') || this.env.DIFFRHYTHM_SESSION_COOKIE;
        const headers: HeadersInit = {};

        if (existingSessionToken) {
            headers['Cookie'] = existingSessionToken;
        }

        const response = await fetch("https://diffrhythm.ai/api/auth/session", {
            method: "GET",
            headers: headers,
            redirect: "manual", // Important to handle cookies manually
        });

        if (!response.ok && response.status !== 302) { // 302 is expected on redirect, but we care about cookies
            const errorText = await response.text();
            throw new Error(`Failed to fetch Diffrhythm session: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const setCookieHeader = response.headers.get("Set-Cookie");

        if (!setCookieHeader) {
            throw new Error("No Set-Cookie header found from Diffrhythm.");
        }

        // Example: __Secure-next-auth.session-token=...; Path=/; Expires=...; HttpOnly; SameSite=Lax
        const match = setCookieHeader?.match(/(__Secure-next-auth\.session-token=([^;]+))/);
        
        if (match && match[1]) {
            const sessionToken = match[1]; // match[1] is the full cookie string "name=value"
            await this.ctx.storage.put('session_token', sessionToken);
        } else if (setCookieHeader) {
            throw new Error("__Secure-next-auth.session-token not found in Set-Cookie header.");
        } else {
            throw new Error("Set-Cookie header found but __Secure-next-auth.session-token was not present or in unexpected format.");
        }
    }

    // The site session is a Better Auth cookie. It has no refresh token.
    // This check confirms the stored session still signs in.
    async checkAisgSession() {
        const token = this.env.AISONGGENERATOR_SESSION_TOKEN?.trim();
        if (!token) {
            throw new Error('AISONGGENERATOR_SESSION_TOKEN is missing');
        }

        const response = await fetch('https://aisonggenerator.io/api/auth/get-session', {
            method: 'GET',
            headers: aisgAuthHeaders(this.env),
        });

        if (!response.ok) {
            throw new Error(`AISG session check failed: ${response.status}`);
        }

        const json = await response.json() as { user?: { id?: string } };
        if (!json?.user) {
            throw new Error('AISG session check returned no user');
        }
    }
}