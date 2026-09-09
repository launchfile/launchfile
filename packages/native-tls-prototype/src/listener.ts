import { parseExpression, resolveExpression } from "@launchfile/sdk";

/** Resolve only this proposed namespace; leave every ordinary reference for the provider. */
export function bindListenerPort(value: string, port: number): string {
  const expression = parseExpression(value);
  if (expression.kind === "literal") return value;
  const refs = expression.kind === "reference" ? [expression]
    : expression.parts.filter((part) => part.kind === "ref");
  if (!refs.some((ref) => ref.path[0] === "listener")) return value;
  const literal = (text: string): string => text.replaceAll("$", () => "$$");
  const reference = (ref: (typeof refs)[number]): string => {
    const source = "${" + ref.path.join(".") + (ref.transforms?.length ? "|" + ref.transforms.join("|") : "") +
      (ref.fallback === undefined ? "" : ":-" + ref.fallback) + "}";
    return ref.path[0] === "listener"
      ? literal(resolveExpression(source, { resources: { listener: { port } } })) : source;
  };
  return expression.kind === "reference" ? reference(expression)
    : expression.parts.map((part) => part.kind === "text" ? literal(part.value) : reference(part)).join("");
}
