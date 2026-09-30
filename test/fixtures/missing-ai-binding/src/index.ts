export default {
  async fetch(request: Request, env: Env) {
    const answer = await env.AI.run(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      {
        prompt: await request.text()
      }
    );
    return Response.json(answer);
  }
};
