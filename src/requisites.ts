/**
 * Parses and evaluates UOW enrolment-rule text such as
 *   "(CSIT110 or CSIT111) and another 18cp at 100 level"
 *   "CSIT214, and an additional 18cp 200 level CSCI/CSIT/ISIT"
 * into a tree, then evaluates it against a student's completed subjects with
 * three-valued logic (true / false / null = can't tell, e.g. free-text conditions).
 */
import { subjectLevel } from "./parse.js";

export interface CompletedSubject {
  code: string;
  credit_points: number;
}

export type RuleNode =
  | { type: "subject"; code: string }
  | { type: "credit_points"; text: string; cp: number; level?: number; prefixes?: string[]; excludes_mentioned: boolean }
  | { type: "unknown"; text: string }
  | { type: "and" | "or"; children: RuleNode[] };

export type Evaluated =
  | { type: "subject"; code: string; met: boolean }
  | { type: "credit_points"; text: string; met: boolean; required_cp: number; counted_cp: number; counted: string[] }
  | { type: "unknown"; text: string; met: null }
  | { type: "and" | "or"; met: boolean | null; children: Evaluated[] };

type Token = { t: "(" | ")" | "and" | "or" } | { t: "code"; v: string } | { t: "text"; v: string };

const CODE = /^[A-Z]{4}\d{3}[A-Z]?$/;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length) out.push({ t: "text", v: text.join(" ") });
    text = [];
  };
  const parts = src
    .replace(/,\s*and\b/gi, " and ")
    .replace(/[()]/g, " $& ")
    .replace(/,/g, " , ")
    .replace(/\+/g, " + ")
    .split(/\s+/)
    .filter(Boolean);
  for (const p of parts) {
    const w = p.toLowerCase();
    if (p === "(" || p === ")") {
      flush();
      out.push({ t: p });
    } else if (w === "and" || w === "," || w === "+" || w === "plus" || w === "&") {
      flush();
      out.push({ t: "and" });
    } else if (w === "or") {
      flush();
      out.push({ t: "or" });
    } else if (CODE.test(p.toUpperCase().replace(/[.;]$/, "")) && /\d/.test(p)) {
      flush();
      out.push({ t: "code", v: p.toUpperCase().replace(/[.;]$/, "") });
    } else {
      text.push(p);
    }
  }
  flush();
  return out;
}

function textLeaf(text: string): RuleNode {
  const t = text.replace(/credit\s*points?/gi, "cp").replace(/-level/gi, " level");
  // Match the entire supported clause. Recognising a credit amount alone must not
  // discard grade, permission, discipline, or other conditions in the same text.
  const clause = t.trim().match(/^(?:(?:an?\s+)?(another|additional|further|other)\s+)?(?:at least\s+)?(\d+)\s*cp(?:\s+(?:at\s+)?([1-9]00)\s+level)?(?:\s+(?:(?:of|in)\s+)?([A-Z]{4}(?:\s*\/\s*[A-Z]{4})*))?[.;]?$/i);
  if (!clause || (clause[4] && !/^[A-Z]{4}(?:\s*\/\s*[A-Z]{4})*$/.test(clause[4]))) {
    return { type: "unknown", text };
  }
  return {
    type: "credit_points",
    text,
    cp: Number(clause[2]),
    level: clause[3] ? Number(clause[3]) : undefined,
    prefixes: clause[4]?.split(/\s*\/\s*/),
    excludes_mentioned: Boolean(clause[1]),
  };
}

export function parseRule(src: string): RuleNode {
  const toks = tokenize(src);
  let i = 0;
  let invalid = false;
  const peek = () => toks[i];

  function primary(): RuleNode {
    const tok = toks[i++];
    if (!tok) return { type: "unknown", text: src };
    if (tok.t === "(") {
      const e = orExpr();
      if (peek()?.t === ")") i++;
      else invalid = true;
      return e;
    }
    if (tok.t === "code") return { type: "subject", code: tok.v };
    if (tok.t === "text") return textLeaf(tok.v);
    return { type: "unknown", text: src };
  }
  function andExpr(): RuleNode {
    const children = [primary()];
    while (peek()?.t === "and") {
      i++;
      children.push(primary());
    }
    return children.length === 1 ? children[0] : { type: "and", children };
  }
  function orExpr(): RuleNode {
    const children = [andExpr()];
    while (peek()?.t === "or") {
      i++;
      children.push(andExpr());
    }
    return children.length === 1 ? children[0] : { type: "or", children };
  }
  const tree = orExpr();
  const hasUnknown = (node: RuleNode): boolean =>
    node.type === "unknown" || ((node.type === "and" || node.type === "or") && node.children.some(hasUnknown));
  // Natural-language "or" may be part of a qualifier (e.g. "200 level or
  // above"). Do not approve one parsed branch when the rest is unsupported.
  return invalid || i < toks.length || hasUnknown(tree) ? { type: "unknown", text: src } : tree;
}

function mentioned(n: RuleNode, acc = new Set<string>()): Set<string> {
  if (n.type === "subject") acc.add(n.code);
  if (n.type === "and" || n.type === "or") for (const c of n.children) mentioned(c, acc);
  return acc;
}

export function evaluateRule(root: RuleNode, completed: CompletedSubject[]): Evaluated {
  const have = new Set(completed.map((c) => c.code));
  // "another Ncp" excludes only the named subjects used to satisfy the rest of the rule. For an
  // "or", that is the cheapest satisfied alternative, not every alternative the rule mentions.
  const consume = (n: RuleNode): Set<string> | null => {
    if (n.type === "subject") return have.has(n.code) ? new Set([n.code]) : null;
    if (n.type === "and") {
      const acc = new Set<string>();
      for (const c of n.children) {
        const s = consume(c);
        if (!s) return null;
        for (const x of s) acc.add(x);
      }
      return acc;
    }
    if (n.type === "or") {
      let best: Set<string> | null = null;
      for (const c of n.children) {
        const s = consume(c);
        if (s && (!best || s.size < best.size)) best = s;
      }
      return best;
    }
    return new Set();
  };
  const named = consume(root) ?? mentioned(root);
  const ev = (n: RuleNode): Evaluated => {
    switch (n.type) {
      case "subject":
        return { type: "subject", code: n.code, met: have.has(n.code) };
      case "unknown":
        return { type: "unknown", text: n.text, met: null };
      case "credit_points": {
        const pool = completed.filter(
          (c) =>
            (!n.level || subjectLevel(c.code) === n.level) &&
            (!n.prefixes || n.prefixes.some((p) => c.code.startsWith(p))) &&
            (!n.excludes_mentioned || !named.has(c.code)),
        );
        const counted_cp = pool.reduce((s, c) => s + c.credit_points, 0);
        return { type: "credit_points", text: n.text, met: counted_cp >= n.cp, required_cp: n.cp, counted_cp, counted: pool.map((c) => c.code) };
      }
      default: {
        const children = n.children.map(ev);
        const vals = children.map((c) => c.met);
        const met =
          n.type === "and"
            ? vals.includes(false) ? false : vals.includes(null) ? null : true
            : vals.includes(true) ? true : vals.includes(null) ? null : false;
        return { type: n.type, met, children };
      }
    }
  };
  return ev(root);
}

/** Short human-readable list of what's still missing. */
export function missingParts(e: Evaluated): string[] {
  if (e.met === true) return [];
  switch (e.type) {
    case "subject":
      return [e.code];
    case "credit_points":
      return [`${e.text} (have ${e.counted_cp}cp of ${e.required_cp}cp)`];
    case "unknown":
      return [`verify manually: "${e.text}"`];
    case "and":
      return e.children.flatMap(missingParts);
    case "or":
      return [`one of: ${e.children.map((c) => missingParts(c).join(" + ") || "(met)").join(" | ")}`];
  }
}
