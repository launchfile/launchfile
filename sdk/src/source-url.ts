/**
 * Credential-free identity for a URL source (D-55 rule 3).
 *
 * A credential gives access to a source; it does not identify one. The same
 * repository fetched with a rotated token is the same source, so providers
 * compare and persist the URL with its credentials removed.
 */

/**
 * Query parameter names that carry a credential, lowercase. Matching is
 * case-insensitive. This is the one list of credential-bearing query keys:
 * anything that persists or compares a source URL uses it, so storage and
 * redaction agree on what a credential is.
 */
export const CREDENTIAL_QUERY_KEYS: readonly string[] = [
	"token",
	"access_token",
	"private_token",
	"refresh_token",
	"id_token",
	"oauth_token",
	"auth",
	"key",
	"api_key",
	"apikey",
	"password",
	"secret",
	"client_secret",
	"sig",
	"signature",
	"x-amz-signature",
	"x-amz-credential",
	"x-amz-security-token",
	"x-goog-signature",
	"x-goog-credential",
];

const CREDENTIAL_KEYS = new Set(CREDENTIAL_QUERY_KEYS);

/** True when a query parameter name is on `CREDENTIAL_QUERY_KEYS`. */
export function isCredentialQueryKey(name: string): boolean {
	return CREDENTIAL_KEYS.has(name.toLowerCase());
}

// Only `scheme://authority...` strings are treated as URLs. A catalog slug, a
// local path, or a Windows drive path (`C:\x`) is returned unchanged.
const URL_WITH_AUTHORITY = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * The source identity of `url`: userinfo removed, and every query parameter
 * whose name is on `CREDENTIAL_QUERY_KEYS` removed. Scheme, host, port, path,
 * the other query parameters and the `#<ref>` fragment are kept, so `?ref=v1`
 * and `?ref=v2`, or `#main` and `#v2`, stay different sources.
 *
 * The result is the WHATWG URL serialization, so two spellings of one URL
 * (`HTTPS://Host:443/x` and `https://host/x`) compare equal. The function is
 * idempotent. A string that is not a `scheme://` URL is returned unchanged.
 */
export function canonicalSourceUrl(url: string): string {
	if (!URL_WITH_AUTHORITY.test(url)) return url;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return canonicalUnparsed(url);
	}
	parsed.username = "";
	parsed.password = "";
	const credentialKeys = [...parsed.searchParams.keys()].filter(
		isCredentialQueryKey,
	);
	// Mutating searchParams re-serializes the whole query, so it is touched
	// only when there is something to remove.
	for (const key of new Set(credentialKeys)) parsed.searchParams.delete(key);
	return parsed.href;
}

/**
 * The same removals for a `scheme://` string the URL parser rejects, done on
 * the text. It never returns the userinfo or a listed query value: a URL that
 * fails to parse still must not be written to disk with its credential.
 */
function canonicalUnparsed(url: string): string {
	const hash = url.indexOf("#");
	const fragment = hash === -1 ? "" : url.slice(hash);
	const beforeFragment = hash === -1 ? url : url.slice(0, hash);
	const question = beforeFragment.indexOf("?");
	const base =
		question === -1 ? beforeFragment : beforeFragment.slice(0, question);
	const query =
		question === -1 ? undefined : beforeFragment.slice(question + 1);

	const schemeEnd = base.indexOf("://") + 3;
	const authorityEnd = base.indexOf("/", schemeEnd);
	const authority =
		authorityEnd === -1
			? base.slice(schemeEnd)
			: base.slice(schemeEnd, authorityEnd);
	const at = authority.lastIndexOf("@");
	const host = at === -1 ? authority : authority.slice(at + 1);
	const rest = authorityEnd === -1 ? "" : base.slice(authorityEnd);

	let out = `${base.slice(0, schemeEnd)}${host}${rest}`;
	if (query !== undefined) {
		const kept = query.split("&").filter((param) => {
			const eq = param.indexOf("=");
			const name = eq === -1 ? param : param.slice(0, eq);
			return !isCredentialQueryKey(safeDecode(name));
		});
		if (kept.length > 0) out += `?${kept.join("&")}`;
	}
	return out + fragment;
}

function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text.replace(/\+/g, " "));
	} catch {
		return text;
	}
}
