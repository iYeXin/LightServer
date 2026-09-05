import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

/**
 * Machine-friendly config parsing (global lightserver.jsonc).
 * Comments and trailing commas allowed; anything else is a hard error
 * naming the file, so bad configs fail fast instead of half-loading.
 */
export function parseJsonc(text: string, file = "<config>"): unknown {
  const errors: ParseError[] = [];
  const result = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `Invalid JSONC in ${file}: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }
  return result;
}
