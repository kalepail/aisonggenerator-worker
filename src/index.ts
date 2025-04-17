import { lyrics } from './api/lyrics';
import { getSongs, postSongs } from './api/songs';
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'

export { DO } from "./do";

export const app = new Hono<{Bindings: Env}>()

app
    .all('*', cors())
    .post('/api/lyrics', lyrics)
    .post('/api/songs', postSongs)
    .get('/api/songs', getSongs)
    // .get('/api/token', async (ctx) => {
    //     const { env } = ctx 
    //     const doid = env.DURABLE_OBJECT.idFromName('v0.0.0');
    //     const stub = env.DURABLE_OBJECT.get(doid);

    //     const { error } = await stub.getTokens();

    //     if (error) {
    //         throw new HTTPException(400, { res: ctx.json(error, 400) });
    //     }

    //     return ctx.body(null, 204);
    // })
    .onError((err, ctx) => {
        console.error(err)

        if (err instanceof HTTPException) {
            return err.getResponse()
        } else {
            return ctx.text(err.message, 500)
        }
    })
    .notFound((ctx) => ctx.body(null, 404))

export default {
    fetch: app.fetch,
    async scheduled(ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
        const doid = env.DURABLE_OBJECT.idFromName('v0.0.0');
        const stub = env.DURABLE_OBJECT.get(doid);

        const { error } = await stub.getTokens();

        if (error) {
            console.error(error)
        }
    },
}