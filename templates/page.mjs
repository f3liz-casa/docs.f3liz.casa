// HTML の一枚。本文は markdown-it が出したもの、ここは殻だけ。
// nav は repo ごとの節、content は本文、footer には出典(repo + path + commit)。

const escape = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function sidebar(site, nav, current) {
  const groups = nav
    .map((g) => {
      const items = g.docs
        .map((d) => {
          const here = d.url === current ? ' aria-current="page"' : "";
          return `<li><a href="${d.url}"${here}>${escape(d.title)}</a></li>`;
        })
        .join("\n");
      return `<section><h2><a href="${g.url}">${escape(g.title)}</a></h2><ul>${items}</ul></section>`;
    })
    .join("\n");
  return `<nav class="side"><p class="brand"><a href="/">${escape(site.title)}</a></p>${groups}
<p class="side-foot"><a href="/llms.txt">llms.txt</a> · <a href="/index.json">index.json</a></p></nav>`;
}

function head(site, doc) {
  const title = doc?.title ?? site.title;
  const description = doc?.description;
  const canonical = doc ? site.base + doc.url : site.base + "/";
  const alt = doc
    ? `<link rel="alternate" type="text/markdown" href="${doc.rawUrl}">`
    : `<link rel="alternate" type="text/markdown" href="/llms.txt" title="llms.txt">`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}${title === site.title ? "" : " · " + escape(site.title)}</title>
${description ? `<meta name="description" content="${escape(description)}">` : ""}
<link rel="canonical" href="${canonical}">
<link rel="stylesheet" href="/style.css">
${alt}`;
}

/** 一枚の頁。markdown の隣に raw を置くので、AI はそこを引ける。 */
export function renderPage({ site, nav, doc, html }) {
  const gh = `https://github.com/${doc.org}/${doc.repo}/blob/${doc.commit}/${doc.path}`;
  const footer = `<footer class="src">
  <a href="${doc.rawUrl}">原文 (Markdown)</a>
  · <a href="${gh}">GitHub で見る</a>
  · <a href="/${doc.prefix}/">${escape(doc.org)}/${escape(doc.repo)} の目次</a>
  <span class="commit">${doc.commit.slice(0, 7)}</span>
</footer>`;
  return `<!doctype html>
<html lang="ja">
<head>${head(site, doc)}</head>
<body>
${sidebar(site, nav, doc.url)}
<main class="doc">
<article class="md">${html}</article>
${footer}
</main>
</body>
</html>
`;
}

/** 玄関。repo ごとに、README の題と説明の一行だけを並べる(全部は並べない)。 */
export function renderHome({ site, repos }) {
  const cards = repos
    .map(
      (r) => `<li>
  <h2><a href="${r.url}">${escape(r.title)}</a></h2>
  ${r.description ? `<p>${escape(r.description)}</p>` : ""}
  <p class="meta"><a href="https://github.com/${r.org}/${r.repo}">${escape(r.org)}/${escape(r.repo)}</a> · ${r.count} 枚</p>
</li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="ja">
<head>${head(site, null)}</head>
<body class="home">
<main>
<h1>${escape(site.title)}</h1>
<p class="lead">${escape(site.description)}</p>
<p class="meta">AI には <a href="/llms.txt">llms.txt</a> と <a href="/index.json">index.json</a>。各頁の原文は <code>/raw/…</code> に。</p>
<ul class="cards">${cards}</ul>
</main>
</body>
</html>
`;
}
