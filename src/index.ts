import { lyrics } from './api/lyrics';
import { getSongs, postSongs } from './api/songs';
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { getClerkToken } from './api/suno';

export { DO } from "./do";

export const app = new Hono<{Bindings: Env}>()

app
    .all('*', cors())
    .post('/api/lyrics', lyrics)
    .post('/api/songs', postSongs)
    .get('/api/songs', getSongs)
    .onError((err, ctx) => {
        console.error(err)

        if (err instanceof HTTPException) {
            return err.getResponse()
        } else {
            return ctx.text(err.message, 500)
        }
    })
    .notFound((ctx) => ctx.body(null, 404))

async function checkSession<T>(
    name: string,
    check: () => Promise<T>,
    formatSuccess?: (result: T) => string
) {
    try {
        const result = await check();
        const summary = formatSuccess ? ` (${formatSuccess(result)})` : "";
        console.log(`${name} session check succeeded${summary}`);
    } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown error";
        console.error(`${name} session check failed:`, detail);
    }
}

export default {
    fetch: app.fetch,
    async scheduled(ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
        const doid = env.DURABLE_OBJECT.idFromName('v0.0.0');
        const stub = env.DURABLE_OBJECT.get(doid);

        await Promise.all([
            checkSession("Suno", () => getClerkToken(env)),
            checkSession(
                "AISG",
                () => stub.checkAisgSession(),
                (credits) => {
                    const expiry = credits.session_expires_at
                        ? `, session_expires_at=${credits.session_expires_at}`
                        : "";
                    return `left_credits=${credits.left_credits}, plan=${credits.plan_tier ?? "none"}, active_sub=${credits.has_active_sub}${expiry}`;
                }
            ),
            checkSession("DiffRhythm", () => stub.getDiffrhythmSession(true)),
        ]);
    },
}
