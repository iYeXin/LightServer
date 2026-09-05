import { describe, expect, test } from "bun:test";
import {
  compileDenyPatterns,
  compileHostPattern,
  compileRedirects,
  compileRoutePattern,
  decodeHeaderJson,
  decodePathname,
  encodeHeaderJson,
  findRedirect,
  globToRegExp,
  isWithin,
  matchDeny,
  matchDenyPattern,
  matchHost,
  matchRoutePattern,
  normalizeHost,
} from "../src/utils.ts";

describe("normalizeHost", () => {
  test("strips port and lowercases", () => {
    expect(normalizeHost("Example.COM:5600")).toBe("example.com");
    expect(normalizeHost("127.0.0.1:5600")).toBe("127.0.0.1");
    expect(normalizeHost(null)).toBe("");
    expect(normalizeHost("  API.Example.com ")).toBe("api.example.com");
  });
});

describe("matchHost", () => {
  test("exact", () => {
    expect(matchHost("example.com", "example.com")).toBe(true);
    expect(matchHost("Example.com", "example.com")).toBe(true);
    expect(matchHost("example.com", "api.example.com")).toBe(false);
  });
  test("wildcard does not match apex", () => {
    expect(matchHost("*.example.com", "api.example.com")).toBe(true);
    expect(matchHost("*.example.com", "a.b.example.com")).toBe(true);
    expect(matchHost("*.example.com", "example.com")).toBe(false);
  });
  test("regex", () => {
    expect(matchHost("~^api\\d+\\.example\\.com$", "api2.example.com")).toBe(true);
    expect(matchHost("~^api\\d+\\.example\\.com$", "api.example.com")).toBe(false);
    expect(matchHost("~(unclosed", "x")).toBe(false);
  });
});

describe("globToRegExp", () => {
  test("* stays within a segment, ** crosses", () => {
    expect(globToRegExp("/static/*.css").test("/static/a.css")).toBe(true);
    expect(globToRegExp("/static/*.css").test("/static/a/b.css")).toBe(false);
    expect(globToRegExp("/static/**").test("/static/a/b.css")).toBe(true);
  });
});

describe("matchRoutePattern", () => {
  test("plain prefix respects segment boundaries", () => {
    expect(matchRoutePattern("/api", "/api").matched).toBe(true);
    expect(matchRoutePattern("/api", "/api/hello").matched).toBe(true);
    expect(matchRoutePattern("/api", "/apix").matched).toBe(false);
    const m = matchRoutePattern("/api", "/api/hello");
    expect(m.remainder).toBe("/hello");
  });
  test("root matches everything", () => {
    expect(matchRoutePattern("/", "/anything/at/all").matched).toBe(true);
  });
  test("glob and regex", () => {
    expect(matchRoutePattern("/s/*.zip", "/s/a.zip").matched).toBe(true);
    expect(matchRoutePattern("~^/api/v\\d+/", "/api/v2/x").matched).toBe(true);
    expect(matchRoutePattern("~^/api/v\\d+/", "/api/x").matched).toBe(false);
  });
});

describe("matchDeny", () => {
  test("plain pattern covers subtree", () => {
    expect(matchDeny(["/private"], "/private")).toBe(true);
    expect(matchDeny(["/private"], "/private/a/b")).toBe(true);
    expect(matchDeny(["/private"], "/privatex")).toBe(false);
    expect(matchDeny(["/p/**"], "/p/a/b")).toBe(true);
  });
});

describe("findRedirect", () => {
  test("exact and tail-preserving prefix", () => {
    expect(findRedirect([{ from: "/old", to: "/new", status: 301 }], "/old")).toEqual({
      to: "/new",
      status: 301,
    });
    expect(
      findRedirect([{ from: "/old/*", to: "/new/*", status: 302 }], "/old/a/b"),
    ).toEqual({ to: "/new/a/b", status: 302 });
    expect(findRedirect([{ from: "/old/*", to: "/new" }], "/other")).toBeNull();
  });
});

describe("isWithin", () => {
  test("blocks escapes", () => {
    expect(isWithin("/srv/root", "/srv/root/a/b")).toBe(true);
    expect(isWithin("/srv/root", "/srv/root")).toBe(true);
    expect(isWithin("/srv/root", "/srv/other")).toBe(false);
    expect(isWithin("/srv/root", "/srv/root/../other")).toBe(false);
  });
});

describe("decodePathname / header json", () => {
  test("malformed encodings are rejected", () => {
    expect(decodePathname("/%E0%A4%A")).toBeNull();
    expect(decodePathname("/ok/%20x")).toBe("/ok/ x");
  });
  test("unicode survives header round-trip", () => {
    const v = { s: "hello-世界", n: 1 };
    const back: unknown = decodeHeaderJson(encodeHeaderJson(v), null);
    expect(back).toEqual(v);
    expect(decodeHeaderJson("!!!", "fb")).toBe("fb");
  });
});

describe("compiled matchers (parity with interpreted)", () => {
  const paths = ["/api", "/api/hello", "/apix", "/", "/s/a.zip", "/s/a/b.zip", "/api/v2/x", "/private/a"];
  test("compileRoutePattern", () => {
    for (const pat of ["/api", "/", "/s/*.zip", "~^/api/v\\d+/", "/nope"]) {
      const c = compileRoutePattern(pat);
      for (const p of paths) {
        const m = matchRoutePattern(pat, p);
        expect(c.test(p)).toBe(m.matched);
        if (m.matched && c.kind === "plain") expect(c.remainder(p)).toBe(m.remainder);
      }
    }
    expect(compileRoutePattern("/api").literalLength).toBe(4);
    expect(compileRoutePattern("~(unclosed").test("/x")).toBe(false);
  });
  test("compileHostPattern", () => {
    for (const pat of ["example.com", "*.example.com", "~^api\\d+\\.example\\.com$"]) {
      const c = compileHostPattern(pat);
      for (const h of ["example.com", "api.example.com", "api2.example.com", "other.com", ""]) {
        expect(c(h)).toBe(matchHost(pat, h));
      }
    }
  });
  test("compileDenyPatterns", () => {
    const c = compileDenyPatterns(["/private", "/p/**", "~^/tmp/"]);
    for (const p of paths) {
      expect(c(p)).toBe(matchDeny(["/private", "/p/**", "~^/tmp/"], p));
    }
  });
  test("compileRedirects", () => {
    const rules = [
      { from: "/old", to: "/new", status: 301 },
      { from: "/legacy/*", to: "/api/*", status: 302 },
    ];
    const compiled = compileRedirects(rules);
    for (const p of ["/old", "/legacy/a/b", "/other"]) {
      const expected = findRedirect(rules as never, p);
      let got: { to: string; status: number } | null = null;
      for (const r of compiled) {
        const to = r.match(p);
        if (to !== null) {
          got = { to, status: r.status };
          break;
        }
      }
      expect(got).toEqual(expected);
    }
  });
  test("deny pattern edge: root denies all", () => {
    expect(matchDenyPattern("/", "/anything")).toBe(true);
  });
});
