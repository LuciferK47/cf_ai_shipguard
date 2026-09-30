import { createHash } from "node:crypto";

export default {
  async fetch(request: Request) {
    const digest = createHash("sha256")
      .update(await request.text())
      .digest("hex");
    return new Response(digest);
  }
};
