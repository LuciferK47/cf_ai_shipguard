// Deliberately bad: a credential literal in source. The value is filled in by
// the test loader at run time so no token-shaped string is stored on disk.
const awsKey = "{{AWS_KEY}}";

export default {
  async fetch() {
    return new Response(awsKey.length > 0 ? "configured" : "missing");
  }
};
