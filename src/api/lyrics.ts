import { Context } from "hono";
import { HTTPException } from "hono/http-exception";

// TODO use this if the below fails https://aisonggenerator.io/api/lyrics-generate
// Consider using the suno lyrics generator

export async function lyrics(ctx: Context) {
    const { req } = ctx
    const lyrics: LyricsResponse = await fetch('https://lyrics-generator.tommy-ni1997.workers.dev', {
        method: 'POST',
        body: await req.text(),
    })
        .then(async (res: any) => {
            if (res.ok) {
                return res.json();
            }

            throw new HTTPException(400, { res: ctx.json(await res.text(), 400) });
        })
        .then((res: any) => {
            return {
                ...res,
                style: res.style.split(', ')
            }
        })

    return ctx.json(lyrics)
}