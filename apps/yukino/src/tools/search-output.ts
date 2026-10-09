import { utf8ByteLength } from "./shell-output.js";

export const MAX_SEARCH_OUTPUT_BYTES = 50 * 1024;

export class SearchOutput {
  readonly lines: string[] = [];
  private bytes = 0;
  limit: "matches" | "bytes" | undefined;

  constructor(private readonly maxMatches: number) {}

  append(line: string): boolean {
    if (this.lines.length >= this.maxMatches) {
      this.limit = "matches";
      return false;
    }
    const bytes = utf8ByteLength(line) + Number(this.lines.length > 0);
    if (this.bytes + bytes > MAX_SEARCH_OUTPUT_BYTES) {
      this.limit = "bytes";
      return false;
    }
    this.lines.push(line);
    this.bytes += bytes;
    return true;
  }
}
