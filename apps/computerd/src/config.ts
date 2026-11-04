export type ComputerdConfig = {
  linkUrl: string;
  token: string;
};

type Env = Record<string, string | undefined>;

export function parseConfig(env: Env): ComputerdConfig {
  const { COMPUTER_LINK_URL: linkUrl, COMPUTER_TOKEN: token } = env;
  if (linkUrl === undefined || !/^wss?:\/\//.test(linkUrl) || !URL.canParse(linkUrl)) {
    throw new Error("COMPUTER_LINK_URL must be a ws:// or wss:// URL");
  }
  if (token === undefined || token === "") {
    throw new Error("COMPUTER_TOKEN is required");
  }
  return { linkUrl, token };
}
