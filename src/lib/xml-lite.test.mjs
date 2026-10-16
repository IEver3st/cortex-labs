import assert from "node:assert/strict";
import test from "node:test";
import {
  XmlParseError,
  attrValue,
  boolValue,
  childText,
  findChild,
  findChildren,
  numberValue,
  parseCharArray,
  parseXml,
} from "./xml-lite.js";

test("parses declaration, attributes, text, self-closing, CDATA and comments", () => {
  const root = parseXml(`﻿<?xml version="1.0" encoding="UTF-8"?>
<!-- leading comment -->
<Root attr="a &amp; b" other='single'>
  <Item value="12" />
  <Name>police &lt;1&gt; &#x41;&#66;</Name>
  <!-- inner comment -->
  <Data><![CDATA[<raw> & stuff]]></Data>
  <Empty></Empty>
</Root>`);
  assert.equal(root.name, "Root");
  assert.deepEqual(root.attrs, { attr: "a & b", other: "single" });
  assert.equal(root.children.length, 4);
  assert.equal(root.children[0].name, "Item");
  assert.equal(root.children[0].attrs.value, "12");
  assert.equal(root.children[1].text, "police <1> AB");
  assert.equal(root.children[2].text, "<raw> & stuff");
  assert.equal(root.children[3].text, "");
  assert.equal(root.text, "");
});

test("helpers are case-insensitive and read value attributes or text", () => {
  const root = parseXml(`<Root>
    <modelName>police</modelName>
    <id value="1337" />
    <hex value="0x1F" />
    <count>42</count>
    <flag value="true" />
    <Item>a</Item><Item>b</Item>
  </Root>`);
  assert.equal(findChild(root, "MODELNAME").text, "police");
  assert.equal(findChild(root, "missing"), null);
  assert.equal(childText(root, "modelname"), "police");
  assert.equal(childText(root, "missing", "x"), "x");
  assert.equal(findChildren(root, "item").length, 2);
  assert.equal(attrValue(findChild(root, "id"), "VALUE"), "1337");
  assert.equal(numberValue(findChild(root, "id")), 1337);
  assert.equal(numberValue(findChild(root, "hex")), 31);
  assert.equal(numberValue(findChild(root, "count")), 42);
  assert.ok(Number.isNaN(numberValue(findChild(root, "modelName"))));
  assert.equal(numberValue(null, 7), 7);
  assert.equal(boolValue(findChild(root, "flag")), true);
  assert.equal(boolValue(findChild(root, "count"), true), true);
});

test("parseCharArray reads whitespace separated numbers", () => {
  assert.deepEqual(parseCharArray("\n  111\n  0\n  0\n  156\n"), [111, 0, 0, 156]);
  assert.deepEqual(parseCharArray("1, 2,3"), [1, 2, 3]);
  assert.deepEqual(parseCharArray(""), []);
  assert.throws(() => parseCharArray("1 x"), /not a number/);
});

test("unterminated tags throw a located error instead of hanging", () => {
  assert.throws(() => parseXml("<Root><Item>text</Item>"), (error) => {
    assert.ok(error instanceof XmlParseError);
    assert.match(error.message, /unterminated element <Root>/);
    assert.equal(error.line, 1);
    return true;
  });
  assert.throws(() => parseXml("<Root><Item value=\"1\""), /unterminated start tag <Item>/);
  assert.throws(() => parseXml("<Root>\n<Item></Other></Root>"), /mismatched closing tag <\/Other> for <Item>.*/);
  assert.throws(() => parseXml("<Root><!-- never closed </Root>"), /unterminated comment/);
  assert.throws(() => parseXml("<Root><![CDATA[oops</Root>"), /unterminated CDATA/);
  assert.throws(() => parseXml("<Root attr=\"abc></Root>"), /unterminated attribute value/);
});

test("bad entities and structure throw clear errors", () => {
  assert.throws(() => parseXml("<Root>a &bogus; b</Root>"), /unknown entity "&bogus;"/);
  assert.throws(() => parseXml("<Root>a &amp b</Root>"), /bad entity/);
  assert.throws(() => parseXml("<Root>&#xZZ;</Root>"), /bad character reference/);
  assert.throws(() => parseXml("<A/><B/>"), /more than one root/);
  assert.throws(() => parseXml("   "), /no root element/);
  assert.throws(() => parseXml("text <A/>"), /text outside of the root/);
  assert.throws(() => parseXml(null), TypeError);
});
