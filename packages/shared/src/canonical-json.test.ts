import { describe, expect, it } from "vitest";

import {
  CanonicalizationError,
  canonicalJson,
  findIllFormedString,
  IllFormedStringError,
} from "./canonical-json.js";

describe("canonicalJson — RFC 8785 conformance", () => {
  it("serializes literals", () => {
    expect(canonicalJson({ literals: [null, true, false] })).toBe(
      '{"literals":[null,true,false]}',
    );
  });

  it("serializes numbers per the ECMAScript number-to-string algorithm (RFC 8785 §3.2.2.3)", () => {
    expect(
      canonicalJson({
        numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      }),
    ).toBe('{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}');
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(1)).toBe("1");
  });

  it("sorts object keys by UTF-16 code units (RFC 8785 §3.2.3 example)", () => {
    const input: Record<string, string> = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    // Note: can't JSON.parse and inspect Object.keys — JS hoists integer-like
    // keys ("1") ahead of insertion order. Compare the serialized form directly.
    const expectedKeyOrder = ["\r", "1", "\u0080", "ö", "€", "😀", "דּ"];
    const expected = `{${expectedKeyOrder
      .map((k) => `${JSON.stringify(k)}:${JSON.stringify(input[k])}`)
      .join(",")}}`;
    expect(canonicalJson(input)).toBe(expected);
  });

  it("sorts nested object keys and emits no whitespace", () => {
    expect(canonicalJson({ b: { d: 2, c: 1 }, a: [{ z: 0, y: 0 }] })).toBe(
      '{"a":[{"y":0,"z":0}],"b":{"c":1,"d":2}}',
    );
  });

  it("escapes strings exactly as JSON.stringify does", () => {
    expect(canonicalJson('back\\slash "quote" \n \t ')).toBe(
      JSON.stringify('back\\slash "quote" \n \t '),
    );
  });

  it("produces identical output regardless of key insertion order", () => {
    const a = canonicalJson({ x: 1, y: { b: 2, a: 3 } });
    const b = canonicalJson({ y: { a: 3, b: 2 }, x: 1 });
    expect(a).toBe(b);
  });

  it("round-trips through JSON.parse losslessly", () => {
    const value = { nested: { arr: [1, "two", null, { deep: true }] }, n: 1.5 };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });
});

describe("canonicalJson — adversarial inputs", () => {
  it("rejects NaN and Infinity rather than silently emitting null", () => {
    expect(() => canonicalJson({ v: NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalJson({ v: Infinity })).toThrow(CanonicalizationError);
    expect(() => canonicalJson([-Infinity])).toThrow(/non-finite number at \$\[0\]/);
  });

  it("rejects undefined, functions, symbols, and bigints at the top level", () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalizationError);
    expect(() => canonicalJson(() => 1)).toThrow(CanonicalizationError);
    expect(() => canonicalJson(Symbol("s"))).toThrow(CanonicalizationError);
    expect(() => canonicalJson(10n)).toThrow(CanonicalizationError);
  });

  it("drops undefined-valued keys and nullifies undefined array slots, matching JSON.stringify", () => {
    expect(canonicalJson({ a: 1, gone: undefined })).toBe('{"a":1}');
    expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]");
  });

  it("rejects non-plain objects (Date, Map, class instances) instead of guessing a serialization", () => {
    expect(() => canonicalJson(new Date(0))).toThrow(/non-plain object/);
    expect(() => canonicalJson(new Map())).toThrow(CanonicalizationError);
    class Sneaky {
      toJSON() {
        return { fooled: true };
      }
    }
    expect(() => canonicalJson(new Sneaky())).toThrow(CanonicalizationError);
  });

  it("accepts null-prototype objects", () => {
    const obj = Object.create(null) as Record<string, unknown>;
    obj.b = 2;
    obj.a = 1;
    expect(canonicalJson(obj)).toBe('{"a":1,"b":2}');
  });

  it("reports the path of the offending value in nested structures", () => {
    expect(() => canonicalJson({ outer: { inner: [1, NaN] } })).toThrow(
      /\$\.outer\.inner\[1\]/,
    );
  });
});

describe("canonicalJson — I-JSON (RFC 7493) well-formed strings", () => {
  it("rejects a lone high surrogate, fail closed, with the JSON path", () => {
    // Reachable via the API: JSON.parse('{"note":"\ud800"}') succeeds and
    // yields this exact string. RFC 8785 assumes I-JSON input; hashing the
    // ES2019 \ud800 escape can never cross-verify in Python/Go.
    const loneHigh = JSON.parse('{"payload":{"note":"\\ud800"}}') as Record<string, unknown>;
    expect(() => canonicalJson(loneHigh)).toThrow(IllFormedStringError);
    expect(() => canonicalJson(loneHigh)).toThrow(
      "ill-formed Unicode (unpaired surrogate) in string at $.payload.note",
    );
    // The typed error is also a CanonicalizationError, so existing catch sites hold.
    expect(() => canonicalJson(loneHigh)).toThrow(CanonicalizationError);
  });

  it("rejects a lone low surrogate", () => {
    expect(() => canonicalJson({ v: "\udfff" })).toThrow(IllFormedStringError);
    expect(() => canonicalJson({ v: "tail\udc00" })).toThrow(/\$\.v/);
  });

  it("rejects a reversed pair and a high surrogate followed by a non-low unit", () => {
    expect(() => canonicalJson(["\udc00\ud800"])).toThrow(/\$\[0\]/);
    expect(() => canonicalJson({ v: "\ud800x" })).toThrow(IllFormedStringError);
  });

  it("rejects an unpaired surrogate in an object KEY, naming the member path", () => {
    const badKey = JSON.parse('{"\\ud800k":1}') as Record<string, unknown>;
    expect(() => canonicalJson(badKey)).toThrow(IllFormedStringError);
    expect(() => canonicalJson(badKey)).toThrow(/at \$\./);
  });

  it("PASSES a valid astral pair (U+1F600) unchanged and serializes it literally", () => {
    // RFC 8785 emits characters above the escape set literally: the astral
    // pair must appear as the actual character, never as \\ud83d\\ude00 escapes.
    expect(canonicalJson({ emoji: "\u{1F600}" })).toBe('{"emoji":"\u{1F600}"}');
    expect(canonicalJson("\u{1F600}")).toBe('"\u{1F600}"');
    // NFC/NFD forms stay distinct, byte for byte: no normalization is applied.
    expect(canonicalJson({ nfc: "\u00e9", nfd: "e\u0301" })).toBe(
      '{"nfc":"\u00e9","nfd":"e\u0301"}',
    );
  });

  it("findIllFormedString reports the same path canonicalJson throws for", () => {
    const bad = { outer: { list: ["ok", "\ud800"] } };
    expect(findIllFormedString(bad)).toBe("$.outer.list[1]");
    expect(() => canonicalJson(bad)).toThrow("$.outer.list[1]");
    expect(findIllFormedString({ fine: "😀", also: ["é"] })).toBeNull();
    expect(findIllFormedString("\udc00")).toBe("$");
    expect(findIllFormedString(42)).toBeNull();
  });
});
