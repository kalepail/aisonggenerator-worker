export async function songWrite(env: Env, prompt: string) {
    const messages = [
        {
            role: "system", content: `You are a creative and comedic song writer.

Your task is to write a song based on a prompt and a description of an image which the prompt generated.

Your output should be formatted with musical tags such as [Intro], [Verse], [Chorus], [Bridge], [Outro], etc. The key being each tag is a section of the song and denoted with brackets [].

Feel free to include instrumental, gender and genre clues in the tags should the song need it.

Songs should be relatively short, just 2-3 verses long.`
        },
        {
            role: "user",
            content: prompt,
        },
    ];

    return env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages,
        max_tokens: 1024,
        temperature: 0.8,
        frequency_penalty: 0.3,
        presence_penalty: 0.2,
        response_format: {
            type: "json_schema",
            json_schema: {
                type: "object",
                properties: {
                    title: { type: "string" },
                    lyrics: { type: "string" },
                    style: {
                        type: "array",
                        items: { type: "string" },
                    },
                },
                required: ["title", "lyrics", "style"],
            },
        },
    });
}