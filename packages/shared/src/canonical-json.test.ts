import { describe, expect, it } from "vitest";

import { CanonicalizationError, canonicalJson } from "./canonical-json.js";

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
