import { describe, expect, it } from "vitest";
import {
	attr,
	block,
	document,
	heredoc,
	interp,
	raw,
	ref,
	renderValue,
	tfName,
} from "../hcl.js";

describe("renderValue", () => {
	it("quotes and escapes plain strings", () => {
		expect(renderValue("hello")).toBe('"hello"');
		expect(renderValue('a"b')).toBe('"a\\"b"');
	});

	it("escapes interpolation in literal strings so user data can't inject refs", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: deliberately testing literal `${...}` escaping
		expect(renderValue("${danger}")).toBe('"$${danger}"');
		expect(renderValue("%{if x}")).toBe('"%%{if x}"');
	});

	it("emits raw expressions verbatim", () => {
		expect(renderValue(ref("aws_vpc", "main", "id"))).toBe("aws_vpc.main.id");
	});

	it("renders numbers and booleans unquoted", () => {
		expect(renderValue(3000)).toBe("3000");
		expect(renderValue(true)).toBe("true");
	});

	it("renders arrays inline", () => {
		expect(renderValue(["a", "b"])).toBe('["a", "b"]');
		expect(renderValue([])).toBe("[]");
	});

	it("renders objects as multi-line maps", () => {
		expect(renderValue({ Name: "x" })).toBe('{\n  Name = "x"\n}');
	});
});

describe("interp", () => {
	it("preserves Terraform interpolations but quotes the string", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal Terraform interpolation under test
		expect(renderValue(interp("http://${aws_lb.main.dns_name}"))).toBe(
			'"http://${aws_lb.main.dns_name}"',
		);
	});

	it("escapes embedded double quotes", () => {
		expect(renderValue(interp('a"b'))).toBe('"a\\"b"');
	});
});

describe("block", () => {
	it("renders an empty block", () => {
		expect(block("terraform", [], [])).toBe("terraform {}");
	});

	it("quotes labels and indents the body", () => {
		const out = block(
			"resource",
			["aws_vpc", "main"],
			[attr("cidr_block", "10.0.0.0/16")],
		);
		expect(out).toBe(
			'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}',
		);
	});

	it("nests blocks with correct indentation", () => {
		const inner = block("ingress", [], [attr("from_port", 80)]);
		const out = block("resource", ["aws_security_group", "x"], [inner]);
		expect(out).toBe(
			'resource "aws_security_group" "x" {\n  ingress {\n    from_port = 80\n  }\n}',
		);
	});
});

describe("heredoc", () => {
	it("uses the indented form so it survives nesting", () => {
		const h = heredoc("line1\nline2");
		expect(renderValue(h)).toBe("<<-EOT\nline1\nline2\nEOT");
	});
});

describe("document", () => {
	it("joins blocks with blank lines and a trailing newline", () => {
		expect(document(["a {}", "b {}"])).toBe("a {}\n\nb {}\n");
	});
});

describe("tfName", () => {
	it("sanitizes kebab and dotted names to valid identifiers", () => {
		expect(tfName("my-app")).toBe("my_app");
		expect(tfName("a.b.c")).toBe("a_b_c");
	});

	it("prefixes names starting with a digit", () => {
		expect(tfName("3scale")).toBe("_3scale");
	});

	it("falls back to a placeholder for empty results", () => {
		expect(tfName("---")).toBe("x");
	});
});

describe("raw", () => {
	it("round-trips through isRaw via renderValue", () => {
		expect(renderValue(raw("foo()"))).toBe("foo()");
	});
});
