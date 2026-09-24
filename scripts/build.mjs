// docs.f3liz.casa の build。
//
//   sources.toml に書いた repo を浅く引き(gh の token があれば private も)、
//   散文(.md / .mdx)だけを選び、本文は書き換えずに一枚の HTML にし、同じ原文を
//   /raw/ に置き、llms.txt / index.json を組む。落とすのはバッジ・license・生成物・
//   重複 i18n ── 人間にも AI にも要らないもの。
//
//   生成物は dist/。手で直さない。真実は各 repo の docs/。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import MarkdownIt from "markdown-it";
import markdownItShiki from "@shikijs/markdown-it";
import githubAlerts from "markdown-it-github-alerts";
import { selected } from "./lib/globs.mjs";
import { renderPage, renderHome } from "../templates/page.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const CACHE = path.join(ROOT, ".cache");
const TOKEN = process.env.DOCS_TOKEN || process.env.GH_TOKEN || "";
const BASE = process.env.DOCS_BASE || "https://docs.f3liz.casa";

const SITE = {
  title: "docs.f3liz.casa",
  base: BASE,
  description: "f3liz の repo から、散文だけを引いて一枚にした docs。原文はそのまま置いてある。",
};

// 書かなくても常に外れるもの。生成物・依存・写しは、AI にも人間にも要らない。
const ALWAYS_EXCLUDE = [
  "**/node_modules/**", "**/.git/**", "**/dist/**", "**/_build/**", "**/_stage/**",
  "**/vendor/**", "**/target/**", "**/.wrangler/**", "**/source/**", "**/coverage/**",
];
const TEXT = /\.(md|mdx|mdoc)$/i;
const MAX_BYTES = 512 * 1024;

const log = (...a) => console.log(...a);
const sha256 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── 取る ────────────────────────────────────────────────────────────────────
// token は **private のときだけ**載せる。App の token は名指しした repo しか
// 見えないので、public に載せると 404 になる(public は未認証で読める)。
async function ghJson(org, repo, ref, useToken) {
  const url = `https://api.github.com/repos/${org}/${repo}/commits/${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: headers(useToken), redirect: "follow" });
  if (!res.ok) throw new Error(`${org}/${repo}@${ref}: commit ${res.status}`);
  const j = await res.json();
  return { sha: j.sha, date: j.commit?.committer?.date ?? "" };
}
function headers(useToken) {
  const h = { "User-Agent": "docs.f3liz.casa", Accept: "application/vnd.github+json" };
  if (useToken && TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}
async function tarball(org, repo, ref, useToken) {
  const url = `https://api.github.com/repos/${org}/${repo}/tarball/${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: headers(useToken), redirect: "follow" });
  if (!res.ok) throw new Error(`${org}/${repo}@${ref}: tarball ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
function extract(buf, slug) {
  const dir = path.join(CACHE, slug);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tgz = path.join(CACHE, `${slug.replace(/\W+/g, "_")}.tgz`);
  fs.writeFileSync(tgz, buf);
  execFileSync("tar", ["-xzf", tgz, "-C", dir, "--strip-components=1"]);
  fs.rmSync(tgz, { force: true });
  return dir;
}
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

// ── 本文 ────────────────────────────────────────────────────────────────────
function frontmatter(text) {
  if (!text.startsWith("---")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: text };
  const data = {};
  for (const line of text.slice(3, end).split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) data[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { data, body: text.slice(end + 4).replace(/^\n/, "") };
}
function titleOf(body, data, p) {
  if (data.title) return data.title;
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1].trim() : path.basename(p).replace(TEXT, "");
}
function descriptionOf(body) {
  const para = body
    .replace(/^#.*$/gm, "")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("![") && !s.startsWith("<") && !s.startsWith("|") && !s.startsWith("-") && !s.startsWith(">") && !s.startsWith("```"));
  return (para ?? "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

// ── 組む ────────────────────────────────────────────────────────────────────
async function makeMd() {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false });
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const tok = tokens[idx];
    const i = tok.attrIndex("href");
    if (i >= 0) {
      const out = resolveLink(tok.attrs[i][1], env.doc);
      if (out) tok.attrs[i][1] = out;
      // 外へ出るリンクは、そうと分かるように(印は CSS、別の窓は noopener つきで)
      if (/^https?:\/\//i.test(tok.attrs[i][1])) {
        tok.attrSet("rel", "noopener noreferrer");
        tok.attrSet("target", "_blank");
        tok.attrJoin("class", "ext");
      }
    }
    return self.renderToken(tokens, idx, opts);
  };
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const i = tokens[idx].attrIndex("src");
    if (i >= 0) {
      const out = copyImage(tokens[idx].attrs[i][1], env.doc);
      if (out) tokens[idx].attrs[i][1] = out;
    }
    return self.renderToken(tokens, idx, opts);
  };
  // Shiki。明暗ぶんの色を CSS 変数で出し、どちらを出すかは style.css が決める
  // (defaultColor: false = 直に色を書かず、変数だけ置く)。
  md.use(await markdownItShiki({
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
    fallbackLanguage: "text",
  }));
  // GitHub の alert(`> [!NOTE]` など)。GitHub でも同じに見えるので、docs も素直。
  md.use(githubAlerts);
  // mermaid は Shiki に渡さず、素のまま残す。描くのは頁の script(要る頁だけ読む)。
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const lang = (token.info ?? "").trim().split(/\s+/)[0];
    if (lang === "mermaid") {
      if (env) env.hasMermaid = true;
      return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`;
    }
    return fence ? fence(tokens, idx, opts, env, self)
      : `<pre><code>${md.utils.escapeHtml(token.content)}</code></pre>\n`;
  };
  return md;
}

/** 見出しに id を振り、目次を作る(同じ一巡で、同じ slug を二度作らない) */
function prepareHeadings(tokens) {
  const seen = new Map();
  const toc = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "heading_open" || (t.tag !== "h2" && t.tag !== "h3")) continue;
    const text = tokens[i + 1]?.content ?? "";
    const base = slugify(text) || "section";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const id = n === 0 ? base : `${base}-${n}`;
    t.attrSet("id", id);
    toc.push({ level: Number(t.tag[1]), text, id });
  }
  return toc;
}

/**
 * 相対リンクの行き先。
 *   1. site の中の頁(.md で、引いてきた中にある) → site の URL
 *   2. それ以外で、その repo に実物がある → GitHub の、その commit の URL
 *   3. どちらでもない → そのまま(触らない)
 * 「.md じゃないから 404」を作らないのがここの役目。
 */
function resolveLink(href, doc) {
  if (!href) return null;
  // root 相対。この repo の頁の route に当たれば、その頁の URL へ。
  // `.mdoc` の記事が `/ja/slug/` のように書く内部リンクのため(blog の作法)。
  // 当たらなければ触らない(既に正しい site の path かもしれない)。
  if (href.startsWith("/") && !href.startsWith("//")) {
    const [pathPart, hash = ""] = href.split("#");
    const route = pathPart.replace(/^\/+|\/+$/g, "");
    const found = doc.byRoute?.get(route);
    return found ? found.url + (hash ? `#${hash}` : "") : null;
  }
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return null;
  const [targetRaw, hash = ""] = href.split("#");
  if (!targetRaw) return null;
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(doc.path), decodeURIComponent(targetRaw)));
  if (rel.startsWith("..")) return null;
  if (TEXT.test(rel)) {
    const found = doc.index.get(rel);
    if (found) return found.url + (hash ? `#${hash}` : "");
  }
  const abs = path.join(doc.root, rel);
  if (!fs.existsSync(abs)) return null;
  const kind = fs.statSync(abs).isDirectory() ? "tree" : "blob";
  return `https://github.com/${doc.org}/${doc.repo}/${kind}/${doc.commit}/${rel}${hash ? `#${hash}` : ""}`;
}
const slugify = (s) =>
  String(s).trim().toLowerCase().replace(/[`*_]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);
/** 本文が参照している画像を写す。道が repo の外に出るものは、そのまま */
function copyImage(src, doc) {
  if (!src || /^([a-z][a-z0-9+.-]*:|\/\/|\/|data:)/i.test(src)) return null;
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(doc.path), decodeURIComponent(src)));
  if (rel.startsWith("..")) return null;
  const from = path.join(doc.root, rel);
  if (!fs.existsSync(from) || !fs.statSync(from).isFile()) return null;
  const out = path.join(DIST, "assets", doc.prefix, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(from, out);
  return `/assets/${doc.prefix}/${rel}`;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const cfg = parseToml(fs.readFileSync(path.join(ROOT, "sources.toml"), "utf8"));
  const sources = [...cfg.source].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  const md = await makeMd();

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true });

  const prev = readStatus();
  const groups = [];
  const status = [];

  for (const src of sources) {
    const { org, repo, ref = "main" } = src;
    const prefix = `${org}/${repo}`;
    if (src.private && !TOKEN) {
      log(`skip  ${prefix} (private, no DOCS_TOKEN)`);
      status.push({ org, repo, ref, skipped: "private (no token)" });
      continue;
    }
    try {
      const useToken = !!src.private;
      const { sha, date } = await ghJson(org, repo, ref, useToken);
      const root = extract(await tarball(org, repo, ref, useToken), prefix);

      // その repo の .docs.toml(docs を書いた側の申告)。hide / description / order
      const local = readLocalDocs(root);
      const include = [...(src.include ?? ["README.md", "docs/**/*.md"])];
      const exclude = [...ALWAYS_EXCLUDE, ...(src.exclude ?? []), ...(local.hide ?? [])];

      const files = walk(root)
        .filter((p) => selected(p, include, exclude))
        .filter((p) => !p.split("/").some((s) => s.startsWith(".")))
        .filter((p) => TEXT.test(p) || p.endsWith(".json"))
        .sort();

      const stripRe = src.strip ? new RegExp("^" + escapeRe(src.strip)) : null;
      const docs = [];
      for (const p of files) {
        const from = path.join(root, p);
        if (fs.statSync(from).size > MAX_BYTES) { log(`big   ${prefix}/${p} は大きすぎるので飛ばす`); continue; }
        const { data, body } = frontmatter(fs.readFileSync(from, "utf8"));
        if (data.docs === "false" || data.hidden === "true") continue;
        const key = stripRe ? p.replace(stripRe, "") : p;
        const isReadme = key.toLowerCase() === "readme.md";
        docs.push({
          org, repo, ref, commit: sha, root, prefix, path: p, key, data, body,
          title: titleOf(body, data, p),
          description: data.description ?? "",
          order: data.order ? Number(data.order) : 999,
          url: isReadme ? `/${prefix}/` : `/${prefix}/${key.replace(TEXT, "")}`,
          route: isReadme ? "" : key.replace(TEXT, ""),
          rawUrl: `/raw/${prefix}/${p}`,
          rawOnly: !TEXT.test(p),
          hash: sha256(body),
          index: null, byRoute: null, // あとで張る
        });
      }
      if (docs.length === 0) { log(`--    ${prefix}: 拾うものが無い`); status.push({ org, repo, ref, commit: sha, files: 0 }); continue; }

      const index = new Map(docs.map((d) => [d.path, d]));
      const byRoute = new Map(docs.map((d) => [d.route, d]));
      for (const d of docs) { d.index = index; d.byRoute = byRoute; }
      docs.sort((a, b) => (a.path === "README.md" ? -1 : b.path === "README.md" ? 1 : a.order - b.order || a.path.localeCompare(b.path)));

      // 原文はここで置く(頁は、全部の repo が集まってから。nav が一枚の木になるように)
      for (const d of docs) write(path.join("raw", d.prefix, d.path), d.body);

      const title = local.title ?? src.title ?? repo;
      const description = local.description ?? src.description ?? "";
      const front = docs.find((d) => d.path.toLowerCase() === "readme.md");
      groups.push({ org, repo, title, description, url: front ? `/${prefix}/` : docs[0].url, docs });
      status.push({ org, repo, ref, commit: sha, date, files: docs.length });
      const was = prev.find((s) => s.org === org && s.repo === repo);
      const moved = was?.commit && was.commit !== sha ? ` (${was.commit.slice(0, 7)}→${sha.slice(0, 7)})` : "";
      log(`ok    ${prefix}: ${docs.length} 枚${moved}`);
    } catch (e) {
      log(`FAIL  ${prefix}: ${e.message}`);
      status.push({ org, repo, ref, error: String(e.message ?? e) });
    }
  }

  // 全部集まってから、頁を描く。nav が一枚の木になるように(raw だけのものは頁にしない)。
  const nav = groups.map((g) => ({
    title: g.title,
    url: g.url,
    docs: g.docs.filter((d) => !d.rawOnly).map((d) => ({ title: d.title, url: d.url })),
  }));
  for (const g of groups) {
    for (const d of g.docs) {
      if (d.rawOnly) continue;
      const env = { doc: d };
      const tokens = md.parse(d.body, env);
      const toc = prepareHeadings(tokens);
      const html = md.renderer.render(tokens, md.options, env);
      write(joinUrl(d.url), renderPage({ site: SITE, nav, doc: d, html, toc, hasMermaid: !!env.hasMermaid }));
    }
  }

  // 玄関・AI の入口・そのほか
  write("index.html", renderHome({ site: SITE, repos: groups.map((g) => ({ ...g, count: g.docs.length })) }));
  writeLlms(groups);
  writeIndexJson(groups);
  writeSitemap(groups, status);
  fs.writeFileSync(path.join(DIST, "robots.txt"), robots());
  fs.writeFileSync(path.join(DIST, "_headers"), headersFile());
  fs.writeFileSync(path.join(DIST, "_redirects"), "# 動いた頁の転送をここに(例: /old/path /new/path 301)\n");
  fs.copyFileSync(path.join(ROOT, "theme", "style.css"), path.join(DIST, "style.css"));
  fs.writeFileSync(path.join(DIST, "status.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sources: status }, null, 2) + "\n");

  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  const ok = status.filter((s) => s.files).reduce((n, s) => n + s.files, 0);
  log(`\n${ok} 枚 / ${status.filter((s) => s.files).length} repo → dist/`);
}

function readLocalDocs(root) {
  const p = path.join(root, ".docs.toml");
  if (!fs.existsSync(p)) return {};
  try { return parseToml(fs.readFileSync(p, "utf8")); } catch { return {}; }
}
function readStatus() {
  try { return JSON.parse(fs.readFileSync(path.join(DIST, "status.json"), "utf8")).sources ?? []; } catch { return []; }
}
function joinUrl(url) {
  const p = url.replace(/^\//, "");
  return url.endsWith("/") ? path.join(p, "index.html") : `${p}.html`;
}
function write(rel, text) {
  const out = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
}

function writeLlms(groups) {
  const lines = [`# ${SITE.title}`, "", `> ${SITE.description}`, ""];
  for (const g of groups) {
    lines.push(`## ${g.title}`, "");
    for (const d of g.docs) {
      const href = d.rawOnly ? BASE + d.rawUrl : BASE + d.url;
      const desc = d.rawOnly ? "" : oneLine(d.description || descriptionOf(d.body));
      lines.push(`- [${d.title}](${href})${d.rawOnly ? " (data)" : ""}${desc ? ": " + desc : ""}`);
    }
    lines.push("");
  }
  fs.writeFileSync(path.join(DIST, "llms.txt"), lines.join("\n"));
  const full = groups
    .flatMap((g) => g.docs)
    .map((d) => `# ${d.prefix}/${d.path}\n${BASE}${d.rawUrl}\n\n${d.body.trim()}\n`)
    .join("\n\n---\n\n");
  fs.writeFileSync(path.join(DIST, "llms-full.txt"), `${full}`);
}
function writeIndexJson(groups) {
  const entries = groups.flatMap((g) =>
    g.docs.map((d) => ({
      org: d.org, repo: d.repo, ref: d.ref, commit: d.commit, path: d.path,
      title: d.title, description: d.rawOnly ? "" : oneLine(d.description || descriptionOf(d.body)),
      kind: d.rawOnly ? "data" : "doc",
      hash: d.hash, url: d.rawOnly ? null : BASE + d.url, raw_url: BASE + d.rawUrl,
    })),
  );
  fs.writeFileSync(path.join(DIST, "index.json"), JSON.stringify({ generatedAt: new Date().toISOString(), count: entries.length, docs: entries }, null, 2) + "\n");
}
function writeSitemap(groups, status) {
  const urls = [BASE + "/", ...groups.flatMap((g) => g.docs.map((d) => BASE + d.url))];
  const body = urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n");
  fs.writeFileSync(path.join(DIST, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
}
function robots() {
  const bots = ["GPTBot", "ClaudeBot", "Claude-Web", "PerplexityBot", "Google-Extended", "Applebot-Extended", "OAI-SearchBot", "CCBot"];
  return [
    ...bots.map((b) => `User-agent: ${b}\nAllow: /`),
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${BASE}/sitemap.xml`,
    `# AI へ: ${BASE}/llms.txt と ${BASE}/index.json をどうぞ`,
    "",
  ].join("\n");
}
function headersFile() {
  return [
    "/raw/*",
    "  Content-Type: text/markdown; charset=utf-8",
    "/llms.txt",
    "  Content-Type: text/plain; charset=utf-8",
    "/llms-full.txt",
    "  Content-Type: text/plain; charset=utf-8",
    "/index.json",
    "  Content-Type: application/json; charset=utf-8",
    "/status.json",
    "  Content-Type: application/json; charset=utf-8",
    "",
  ].join("\n");
}

export { makeMd };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
