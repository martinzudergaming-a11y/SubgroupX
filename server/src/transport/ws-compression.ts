export const BROWSER_WS_PER_MESSAGE_DEFLATE = {
  zlibDeflateOptions: {
    chunkSize: 16 * 1024,
    level: 3,
    memLevel: 7,
  },
  zlibInflateOptions: {
    chunkSize: 16 * 1024,
  },
  clientNoContextTakeover: true,
  serverNoContextTakeover: true,
  concurrencyLimit: 4,
  threshold: 8 * 1024,
} as const;

export function browserWsPerMessageDeflate(): false | typeof BROWSER_WS_PER_MESSAGE_DEFLATE {
  return process.env.AGENT_WEB_WS_COMPRESSION === "0" ? false : BROWSER_WS_PER_MESSAGE_DEFLATE;
}
