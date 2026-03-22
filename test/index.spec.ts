// test/index.spec.ts
import { describe, it, expect } from 'vitest';
import { processMarkdownLinks, toSuperscript } from "./../src/index"

describe("test fix link", () => {
	it("should fix link", () => {
		const markdown = `
		This is a test text
		[link11111](link11111)     // identical, will be processed
		[link11111](link11112221)  // not identical, keep as is
		[another text](link11112221) // not same, keep as is
		[link22222](link22222)     // identical, will be processed
		[link11111](link11111)     // identical, will reuse number
		`;
		const result = processMarkdownLinks(markdown);
		expect(result).toBe(`
		This is a test text
		[reference¹](link11111)     // identical, will be processed
		[link11111](link11112221)  // not identical, keep as is
		[another text](link11112221) // not same, keep as is
		[reference²](link22222)     // identical, will be processed
		[reference¹](link11111)     // identical, will reuse number
		`);
	})
})
describe("upper number", () => {
	it("should upper number", () => {
		expect(toSuperscript(1234)).toBe("¹²³⁴");
	})
}
)
