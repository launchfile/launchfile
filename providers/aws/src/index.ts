/**
 * @launchfile/aws — translate a Launchfile into Terraform (EC2 + RDS + ALB).
 *
 * Translation-only: this provider implements the `translate` verb (PROVIDERS.md
 * §2) and nothing else. It never provisions, never applies, never bills. Its
 * job is to answer one question — "does the same file map to AWS?" — and to
 * record, field by field, where it does and doesn't.
 */

export {
	Conformance,
	type ConformanceEntry,
	type Gap,
	type Ignored,
	type Mapping,
	renderConformanceReport,
	renderConformanceSection,
	type Severity,
} from "./gaps.js";
export {
	attr,
	block,
	document,
	heredoc,
	interp,
	raw,
	ref,
	renderValue,
	tfName,
} from "./hcl.js";
export {
	type TranslateOptions,
	type TranslateResult,
	translate,
} from "./translate.js";
