import { Context } from "hono";
import { HTTPException } from "hono/http-exception";

export async function getSongs(ctx: Context<{ Bindings: Env }>) {
    const { req, env } = ctx
    const ids = req.query('ids')?.split(',');

    let filters = ""

    for (let id of ids || []) {
        filters += `identify_id.eq."${id}",`
    }

    filters = filters.slice(0, -1)

    const res = await fetch(`https://hjgeamyjogwwmvjydbfm.supabase.co/rest/v1/music?select=music_id,status,audio&user_id=eq.${env.AISONGGENERATOR_USER_ID}&or=(${filters})`, {
        method: 'GET',
        headers: {
            'apikey': env.AISONGGENERATOR_API_KEY
        }
    })
        .then(async (res: any) => {
            if (res.ok) {
                return res.json();
            }

            throw new HTTPException(400, { res: ctx.json(await res.text(), 400) });
        })

    return ctx.json(res);
}

export async function postSongs(ctx: Context<{ Bindings: Env }>) {
    const { req, env } = ctx
    const data: LyricsResponse = await req.json()
    const body = {
        lyrics_mode: true,
        instrumental: false,
        lyrics: data.lyrics,
        title: data.title,
        styles: data.style.join(', '),
        type: "lyrics",
        user_id: env.AISONGGENERATOR_USER_ID,
        is_private: false
    }

    const doid = env.DURABLE_OBJECT.idFromName('v0.0.0');
    const stub = env.DURABLE_OBJECT.get(doid);
    const { access_token, refresh_token } = await stub.getTokens();

    const res = await fetch(`https://aisonggenerator.io/api/song`, {
        method: 'POST',
        headers: {
            Cookie: `sb-hjgeamyjogwwmvjydbfm-auth-token=${encodeURIComponent(`'["${access_token}","${refresh_token}",null,null,null]'`)}`
        },
        body: JSON.stringify(body)
    })
        .then(async (res: any) => {
            if (res.ok) {
                return res.json();
            }

            throw new HTTPException(400, { res: ctx.json(await res.text(), 400) });
        })
        .then((res) => {
            if (res?.task_id) {
                return [res.task_id]
            } else if (res?.data?.taskId) {
                return [res.data.taskId]
            } else if (res?.data?.length > 0) {
                return res.data
            } else if (res?.jobs?.length) {
                return res.jobs.map((job: { id: string }) => job.id)
            } else {
                throw res
            }
        })

    return ctx.json(res)
}