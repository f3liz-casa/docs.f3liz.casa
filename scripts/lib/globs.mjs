// 小さな glob。`*` は / を跨がず、`**` は跨ぐ。`docs/**/*.md` は `docs/a.md` も
// `docs/x/y.md` も拾う。これだけの形のために依存を一つ増やしたくないので、
// ここに一つ書いて、試験で確かめる。

export function globToRegExp(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("+.^$()|[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re + "$");
}

export function matchGlob(path, glob) {
  return globToRegExp(glob).test(path);
}

/** include のどれかに当たり、exclude のどれにも当たらない */
export function selected(path, include, exclude) {
  if (!include.some((g) => matchGlob(path, g))) return false;
  return !exclude.some((g) => matchGlob(path, g));
}
