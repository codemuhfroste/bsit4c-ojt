import assert from "node:assert/strict";
import { test } from "node:test";
import { similarCompany } from "../src/company-names.js";

test("the same company is recognised however it is typed", () => {
  for (const [a, b] of [
    ["Quanby Solutions", "quanby solutions"],
    ["Quanby Solutions, Inc.", "Quanby Solutions"],
    ["Quanby Solutions Inc", "QUANBY  SOLUTIONS"],
    ["Pixel8 Web Solutions & Consultancy Inc.", "Pixel8 Web Solutions and Consultancy"],
    ["Mayon Tech", "Mayon-Tech"],
  ]) {
    assert.equal(similarCompany(a, b), true, `${a} / ${b}`);
  }
});

test("one extra word, one typo or plural, or one different word in a long name still counts", () => {
  assert.equal(similarCompany("Quanby Solutions", "Quanby Solutions Philippines"), true); // an extra word
  assert.equal(similarCompany("Quanby Solutions", "Quanby Solution"), true); // plural / typo
  assert.equal(similarCompany("Highpoint Services Network Philippines", "Highpoint Services Network Legazpi"), true); // one different word, four words
  assert.equal(similarCompany("DTI", "DTI Albay"), true); // one extra word
});

test("different companies are never grouped", () => {
  for (const [a, b] of [
    ["DTI", "PNB"], // one word each, one word different: must not match
    ["Globe Telecom", "Smart Telecom"],
    ["Bicol Medical Center", "Bicol Regional Center"], // one different word, but only three words
    ["Quanby Solutions", "Pixel8 Web Solutions"],
    ["PhilHealth Regional Office V", "BFP Regional Office V"], // one word different, but a different agency (three words after "V")
    ["Quanby Solutions", "Quanby Solutions Legazpi Branch Office"], // two extra words
    ["", "Quanby"],
  ]) {
    assert.equal(similarCompany(a, b), false, `${a} / ${b}`);
  }
});
