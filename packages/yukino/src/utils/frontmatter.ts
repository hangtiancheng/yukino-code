import yaml from "js-yaml";
import { z } from "zod";

import {
  FRONTMATTER_CLOSE_RE,
  FRONTMATTER_OPEN_RE,
} from "@/utils/constants.js";

const FrontmatterDataSchema = z.record(z.string(), z.unknown());

export function parseYamlFrontmatter(content: string): {
  data: Record<string, unknown>;
  body: string;
} | null {
  const normalized = content.replace(/^\uFEFF/u, "");
  const opening = FRONTMATTER_OPEN_RE.exec(normalized);
  if (!opening) {
    return null;
  }

  const rest = normalized.slice(opening[0].length);
  const closing = FRONTMATTER_CLOSE_RE.exec(rest);
  if (!closing) {
    throw new TypeError("Missing closing YAML frontmatter delimiter");
  }

  const metadata = rest.slice(0, closing.index);
  const data = FrontmatterDataSchema.parse(
    metadata.trim() ? yaml.load(metadata) : {},
  );
  return { data, body: rest.slice(closing.index + closing[0].length).trim() };
}
