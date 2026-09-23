# docs.f3liz.casa

f3liz の repo から **散文だけ** を引いて、一枚にした docs。
手で書くのは `sources.toml` だけで、site は生成物 ── `dist/` は直さない。真実は各 repo の
`docs/` と README にある。

人間には静的な一枚。AI には同じ内容の生 Markdown と `llms.txt` / `index.json` を置く。
**両方が同じ原文を見る**のが、いちばん簡単な「両方に親切」。

## 引く・組む・出す

```sh
npm install
DOCS_TOKEN=$(gh auth token) npm run build   # private も引くなら token を渡す
npm run dev                                  # wrangler dev で手元に
npm run deploy                               # build && wrangler deploy
```

## アプデ(これがやりたかったこと)

```sh
gh workflow run sync.yml -R f3liz-casa/docs.f3liz.casa
gh run watch -R f3liz-casa/docs.f3liz.casa
```

- `workflow_dispatch`(上の一行)のほかに、`schedule`(毎晩 03:00 JST)と、
  `repository_dispatch`(source の push から叩く)が働く。
- source の workflow に足す一行:

  ```sh
  gh api repos/f3liz-casa/docs.f3liz.casa/dispatches \
    -f event_type=docs -f client_payload[repo]=<repo>
  ```

## 何を引くか

`sources.toml` に `[[source]]` を一つ足す(`org` / `repo` / `ref` / `title` / `include`)。
private は `private = true`(Actions の `secrets.DOCS_TOKEN` で引く)。

各 repo は自分の `.docs.toml` で上書きできる ── `hide = [...]` / `title` / `description`。
**docs を書いた側が、出しかたを決める。**

## 生成物

| 道 | 誰のため | 中身 |
|---|---|---|
| `/<org>/<repo>/<path>` | 人間 | 静的な一枚。source へのリンク付き |
| `/raw/<org>/<repo>/<path>` | AI / 引用 | 原文そのまま(`text/markdown`) |
| `/llms.txt` | AI | 目次(題 + URL + 一行説明) |
| `/llms-full.txt` | AI | 全部を連結(文脈窓にそのまま) |
| `/index.json` | AI / 自分 | 機械向けの一覧(commit / hash / URL) |
| `/status.json` | 自分 | repo ごとの「最後に引いた commit」 |
| `/sitemap.xml` `/robots.txt` | 両方 | AI クローラを許す |

## secret

| 名前 | 何のため |
|---|---|
| `DOCS_TOKEN` | private repo を引く(fine-grained PAT / GitHub App) |
| `CLOUDFLARE_API_TOKEN` | `wrangler deploy` |
| `CLOUDFLARE_ACCOUNT_ID` | 同上 |

`DOCS_TOKEN` が無いと、private の source は黙って飛ばす(公開の面は壊さない)。
