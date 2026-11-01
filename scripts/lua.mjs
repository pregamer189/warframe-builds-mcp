// A small parser for the Lua data tables in the wiki's modules: strings, numbers, booleans, nil and nested tables.
export function parseLua(source, start = 0) {
  let i = start;

  const skip = () => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i])) i++;
      if (source.startsWith("--[[", i) || source.startsWith("--[==[", i)) {
        const close = source.startsWith("--[==[", i) ? "]==]" : "]]";
        const end = source.indexOf(close, i);
        i = end < 0 ? source.length : end + close.length;
      } else if (source.startsWith("--", i)) {
        const end = source.indexOf("\n", i);
        i = end < 0 ? source.length : end + 1;
      } else return;
    }
  };

  const string = () => {
    const quote = source[i++];
    let text = "";
    while (i < source.length && source[i] !== quote) {
      if (source[i] === "\\") {
        i++;
        text += { n: "\n", r: "\r", t: "\t" }[source[i]] ?? source[i];
      } else text += source[i];
      i++;
    }
    i++;
    return text;
  };

  const value = () => {
    skip();
    const char = source[i];
    if (char === "{") return table();
    if (char === '"' || char === "'") return string();
    const token = source.slice(i).match(/^[-\w.+]+/)?.[0];
    if (!token) throw new Error(`Unexpected "${source.slice(i, i + 30)}" in Lua table`);
    i += token.length;
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "nil") return undefined;
    if (token === "math.huge") return Infinity;
    if (/^[A-Za-z_]/.test(token)) return undefined; // a bare name reads as nil in Lua, and the modules have a few typos
    const number = Number(token);
    if (Number.isNaN(number)) throw new Error(`Unexpected token "${token}" in Lua table`);
    return number;
  };

  const table = () => {
    i++; // the opening brace
    const list = [];
    const record = {};
    let isRecord = false;
    for (;;) {
      skip();
      if (source[i] === "}") {
        i++;
        return isRecord ? record : list;
      }
      let key;
      if (source[i] === "[") {
        i++;
        skip();
        key = value();
        skip();
        i++; // the closing bracket
        skip();
        i++; // the equals sign
      } else {
        const name = source.slice(i).match(/^([A-Za-z_]\w*)\s*=(?!=)/);
        if (name) {
          key = name[1];
          i += name[0].length;
        }
      }
      const item = value();
      if (key === undefined) list.push(item);
      else {
        record[key] = item;
        isRecord = true;
      }
      skip();
      if (source[i] === "," || source[i] === ";") i++;
    }
  };

  skip();
  return value();
}

// Parses the table that follows a marker such as "return" or "local StanceData =".
export function parseLuaAfter(source, marker) {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`Lua source has no "${marker}"`);
  return parseLua(source, at + marker.length);
}
