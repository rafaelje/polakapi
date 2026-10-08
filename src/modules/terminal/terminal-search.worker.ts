import { searchTerminalLines, type SearchRequest } from "./terminal-search-engine";

self.onmessage = (event: MessageEvent<SearchRequest>): void => {
  const result = searchTerminalLines(event.data);
  self.postMessage(result, { transfer: [result.matches.buffer] });
};
