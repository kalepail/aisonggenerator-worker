import { json } from "itty-router";
import { Baker } from "../baker";
import { Clerk } from "../clerk";
import { getClient } from "../client";
import { Suno } from "../suno";

export async function lyrics(req: Request, env: Env, ctx: ExecutionContext) {
    // TODO Support lyrics model
    
    const body = await req.json<{ 
        prompt: string
    }>();

    const baker = new Baker(env);
    const client = await getClient(env, baker);
    const clerk = await Clerk.create(env, client, baker);
    const suno = new Suno(env, client, clerk);

    const get_res = await suno.lyrics(body.prompt);

    return json(get_res.data);
}