import { describe, expect, test } from "bun:test";
import { parseJsonc } from "../src/jsonc.ts";

describe("parseJsonc", () => {
  test("comments plus trailing commas", () => {
    expect(
      parseJsonc(`{
        // global config
        "port": 5600, /* inline */
        "sites": {
          "default": {
            "root": "/srv/websites/example.com", // trailing
          },
        },
      }`),
    ).toEqual({
      port: 5600,
      sites: { default: { root: "/srv/websites/example.com" } },
    });
  });

  test("comment markers inside strings survive", () => {
    expect(
      parseJsonc('{ "url": "http://x/y", "glob": "/a/*", "close": "a,}" }'),
    ).toEqual({ url: "http://x/y", glob: "/a/*", close: "a,}" });
  });

  test("arrays with trailing commas", () => {
    expect(parseJsonc('{ "deny": ["/a/**", "/b",] }')).toEqual({ deny: ["/a/**", "/b"] });
  });

  test("invalid JSON throws with filename", () => {
    expect(() => parseJsonc("{ nope", "conf.jsonc")).toThrow(/conf\.jsonc/);
    expect(() => parseJsonc("[1, 2")).toThrow();
  });
});
