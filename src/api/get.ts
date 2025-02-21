import { json } from "itty-router";
import { Baker } from "../baker";
import { Clerk } from "../clerk";
import { getClient } from "../client";
import { Suno } from "../suno";
import { processClips } from "../utils";

export async function get(req: Request, env: Env, ctx: ExecutionContext) {
    const baker = new Baker(env);
    const client = await getClient(env, baker);
    const clerk = await Clerk.create(env, client, baker);
    const suno = new Suno(env, client, clerk);

    const get_res = await suno.get(req);

    const res = processClips(get_res.data.clips);

    return json(res);
}