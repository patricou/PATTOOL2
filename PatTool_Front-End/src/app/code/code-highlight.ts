/** Lightweight syntax highlighting — escapes HTML, then wraps tokens in spans. */

const C_KEYWORDS =
  'abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|from|function|goto|if|implements|import|in|instanceof|interface|let|new|null|of|package|private|protected|public|return|static|super|switch|this|throw|true|try|typeof|var|void|while|with|yield';

const JAVA_KEYWORDS =
  'abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|exports|extends|final|finally|float|for|goto|if|implements|import|instanceof|int|interface|long|module|native|new|null|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|true|false|try|var|void|volatile|while|record|sealed|permits|yield';

const PY_KEYWORDS =
  'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield|match|case';

const GO_KEYWORDS =
  'break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var|true|false|nil';

const CS_KEYWORDS =
  'abstract|as|async|await|base|bool|break|byte|case|catch|char|checked|class|const|continue|decimal|default|delegate|do|double|else|enum|event|explicit|extern|false|finally|fixed|float|for|foreach|goto|if|implicit|in|int|interface|internal|is|lock|long|namespace|new|null|object|operator|out|override|params|private|protected|public|readonly|ref|return|sbyte|sealed|short|sizeof|stackalloc|static|string|struct|switch|this|throw|true|try|typeof|uint|ulong|unchecked|unsafe|ushort|using|virtual|void|volatile|while|record|var|when|yield';

const RUST_KEYWORDS =
  'as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while';

const PHP_KEYWORDS =
  'abstract|and|array|as|break|callable|case|catch|class|clone|const|continue|declare|default|do|echo|else|elseif|empty|enddeclare|endfor|endforeach|endif|endswitch|endwhile|extends|final|finally|fn|for|foreach|function|global|goto|if|implements|include|include_once|instanceof|insteadof|interface|isset|list|match|namespace|new|or|print|private|protected|public|require|require_once|return|static|switch|throw|trait|try|unset|use|var|while|xor|true|false|null';

const SQL_KEYWORDS =
  'add|all|alter|and|as|asc|between|by|case|check|column|constraint|create|cross|delete|desc|distinct|drop|else|end|exists|foreign|from|full|group|having|in|index|inner|insert|into|is|join|key|left|like|limit|not|null|on|or|order|outer|primary|references|right|select|set|table|then|union|unique|update|values|view|where|with';

const KW: Record<string, string> = {
  javascript: C_KEYWORDS,
  typescript: C_KEYWORDS + '|type|namespace|declare|readonly|keyof|infer|never|unknown|any',
  java: JAVA_KEYWORDS,
  kotlin: JAVA_KEYWORDS + '|fun|val|var|object|companion|data|suspend',
  python: PY_KEYWORDS,
  go: GO_KEYWORDS,
  csharp: CS_KEYWORDS,
  rust: RUST_KEYWORDS,
  php: PHP_KEYWORDS,
  sql: SQL_KEYWORDS,
  ruby: 'alias|and|begin|break|case|class|def|defined|do|else|elsif|end|ensure|false|for|if|in|module|next|nil|not|or|redo|rescue|retry|return|self|super|then|true|undef|unless|until|when|while|yield',
  c: 'auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while',
  cpp: 'alignas|alignof|and|and_eq|asm|auto|bitand|bitor|bool|break|case|catch|char|class|compl|concept|const|consteval|constexpr|const_cast|continue|co_await|co_return|co_yield|decltype|default|delete|do|double|dynamic_cast|else|enum|explicit|export|extern|false|float|for|friend|goto|if|inline|int|long|mutable|namespace|new|noexcept|not|not_eq|nullptr|operator|or|or_eq|private|protected|public|register|reinterpret_cast|requires|return|short|signed|sizeof|static|static_assert|static_cast|struct|switch|template|this|throw|true|try|typedef|typeid|typename|union|unsigned|using|virtual|void|volatile|wchar_t|while|xor|xor_eq',
  swift: 'as|associatedtype|break|case|catch|class|continue|default|defer|deinit|do|else|enum|extension|fallthrough|false|fileprivate|for|func|guard|if|import|in|init|inout|internal|is|let|nil|open|operator|override|private|protocol|public|repeat|return|self|static|struct|subscript|super|switch|throw|throws|true|try|typealias|var|where|while',
  shell: 'alias|bg|bind|break|builtin|caller|case|cd|command|continue|declare|do|done|echo|elif|else|esac|eval|exec|exit|export|false|fi|for|function|getopts|hash|if|in|jobs|kill|let|local|printf|pwd|read|readonly|return|select|set|shift|source|then|time|trap|true|type|ulimit|umask|unalias|unset|until|wait|while'
};

function normalizeLang(language: string | null | undefined): string {
  const l = (language || '').trim().toLowerCase();
  if (l === 'js' || l === 'jsx' || l === 'mjs' || l === 'cjs') {
    return 'javascript';
  }
  if (l === 'ts' || l === 'tsx') {
    return 'typescript';
  }
  if (l === 'py') {
    return 'python';
  }
  if (l === 'cs') {
    return 'csharp';
  }
  if (l === 'rs') {
    return 'rust';
  }
  if (l === 'yml') {
    return 'yaml';
  }
  if (l === 'sh' || l === 'bash' || l === 'zsh' || l === 'powershell' || l === 'ps1') {
    return 'shell';
  }
  if (l === 'cc' || l === 'cxx' || l === 'hpp') {
    return 'cpp';
  }
  if (l === 'htm' || l === 'xml' || l === 'vue') {
    return 'html';
  }
  if (l === 'scss' || l === 'less' || l === 'sass') {
    return 'css';
  }
  if (l === 'md') {
    return 'markdown';
  }
  return l;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function span(cls: string, text: string): string {
  return `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
}

/**
 * Highlight source. Output is HTML-safe (all text escaped).
 */
const CONTROL =
  'if|else|elif|for|while|do|switch|case|break|continue|return|try|catch|finally|throw|yield|await|async|match|when|unless|until|goto|defer|select|range|guard|repeat|then|fi|esac|done|rescue|ensure|raise|pass|lambda|from|import|export|default|new|delete|in|of|as';

export function highlightSource(code: string, language?: string | null): string {
  if (!code) {
    return '';
  }
  const src = code.length > 140_000 ? code.slice(0, 140_000) + '\n…' : code;
  const lang = normalizeLang(language);
  if (lang === 'json') {
    return highlightJson(src);
  }
  if (lang === 'html' || lang === 'xml') {
    return highlightMarkup(src);
  }
  if (lang === 'css' || lang === 'scss' || lang === 'less') {
    return highlightCss(src);
  }
  if (lang === 'yaml') {
    return highlightYaml(src);
  }
  if (lang === 'markdown') {
    return highlightMarkdownSource(src);
  }
  return highlightGeneric(src, lang);
}

export function highlightMarkdown(text: string): string {
  if (!text) {
    return '';
  }
  const src = text.length > 180_000 ? text.slice(0, 180_000) + '\n…' : text;
  const re = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  let last = 0;
  let out = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) != null) {
    out += escapeHtml(src.slice(last, m.index));
    const lang = m[1] || '';
    out += `<pre class="code-hl-fence"><code>${highlightSource(m[2], lang)}</code></pre>`;
    last = m.index + m[0].length;
  }
  out += escapeHtml(src.slice(last));
  return out;
}

const ctrlRe = new RegExp('^(?:' + CONTROL + ')$');

function takeLineComment(src: string, i: number, n: number): number {
  const end = src.indexOf('\n', i);
  return end < 0 ? n : end;
}

function takeString(src: string, i: number, n: number): number {
  const q = src[i];
  if ((q === '"' || q === "'") && src.slice(i, i + 3) === q + q + q) {
    const end = src.indexOf(q + q + q, i + 3);
    return end < 0 ? n : end + 3;
  }
  let j = i + 1;
  while (j < n) {
    if (src[j] === '\\') {
      j += 2;
      continue;
    }
    if (src[j] === q) {
      return j + 1;
    }
    j++;
  }
  return n;
}

function highlightGeneric(src: string, lang: string): string {
  const kw = KW[lang] || C_KEYWORDS;
  const hashComments = lang === 'python' || lang === 'ruby' || lang === 'shell';
  const sqlComments = lang === 'sql';
  const parts: string[] = [];
  let i = 0;
  const n = src.length;
  const kwRe = new RegExp('^(?:' + kw + ')$');

  while (i < n) {
    const ch = src[i];
    const two = src.slice(i, i + 2);

    if (!hashComments && !sqlComments && two === '//') {
      const take = takeLineComment(src, i, n);
      parts.push(span('cmt', src.slice(i, take)));
      i = take;
      continue;
    }
    if (!hashComments && two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const take = end < 0 ? n : end + 2;
      parts.push(span('cmt', src.slice(i, take)));
      i = take;
      continue;
    }
    if ((hashComments && ch === '#') || (sqlComments && two === '--')) {
      const take = takeLineComment(src, i, n);
      parts.push(span('cmt', src.slice(i, take)));
      i = take;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const take = takeString(src, i, n);
      parts.push(span('str', src.slice(i, take)));
      i = take;
      continue;
    }
    if (ch === '@' && /[A-Za-z_]/.test(src[i + 1] || '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) {
        j++;
      }
      parts.push(span('dec', src.slice(i, j)));
      i = j;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i + 1;
      while (j < n && /[\d_.xXa-fA-F]/.test(src[j])) {
        j++;
      }
      parts.push(span('num', src.slice(i, j)));
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) {
        j++;
      }
      const word = src.slice(i, j);
      let k = j;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) {
        k++;
      }
      const afterDot = i > 0 && src[i - 1] === '.';
      if (ctrlRe.test(word) && kwRe.test(word)) {
        parts.push(span('ctrl', word));
      } else if (kwRe.test(word)) {
        parts.push(span('kw', word));
      } else if (src[k] === '(' || afterDot && src[k] === '(') {
        parts.push(span('fn', word));
      } else if (afterDot) {
        parts.push(span('prop', word));
      } else if (word[0] >= 'A' && word[0] <= 'Z') {
        parts.push(span('type', word));
      } else {
        parts.push(span('var', word));
      }
      i = j;
      continue;
    }
    parts.push(escapeHtml(ch));
    i++;
  }
  return parts.join('');
}

function highlightCss(src: string): string {
  const parts: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const two = src.slice(i, i + 2);
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const take = end < 0 ? n : end + 2;
      parts.push(span('cmt', src.slice(i, take)));
      i = take;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const take = takeString(src, i, n);
      parts.push(span('str', src.slice(i, take)));
      i = take;
      continue;
    }
    if (ch === '#' && /[0-9A-Fa-f]/.test(src[i + 1] || '')) {
      let j = i + 1;
      while (j < n && /[0-9A-Fa-f]/.test(src[j])) {
        j++;
      }
      parts.push(span('num', src.slice(i, j)));
      i = j;
      continue;
    }
    if (ch === '@' && /[A-Za-z-]/.test(src[i + 1] || '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9-]/.test(src[j])) {
        j++;
      }
      parts.push(span('dec', src.slice(i, j)));
      i = j;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i + 1;
      while (j < n && /[\d.]/.test(src[j])) {
        j++;
      }
      while (j < n && /[A-Za-z%]/.test(src[j])) {
        j++;
      }
      parts.push(span('num', src.slice(i, j)));
      i = j;
      continue;
    }
    if (/[A-Za-z_-]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_-]/.test(src[j])) {
        j++;
      }
      const word = src.slice(i, j);
      let k = j;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) {
        k++;
      }
      parts.push(span(src[k] === ':' ? 'key' : 'kw', word));
      i = j;
      continue;
    }
    parts.push(escapeHtml(ch));
    i++;
  }
  return parts.join('');
}

function highlightYaml(src: string): string {
  const parts: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '#') {
      const take = takeLineComment(src, i, n);
      parts.push(span('cmt', src.slice(i, take)));
      i = take;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const take = takeString(src, i, n);
      parts.push(span('str', src.slice(i, take)));
      i = take;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i + 1;
      while (j < n && /[\d.]/.test(src[j])) {
        j++;
      }
      parts.push(span('num', src.slice(i, j)));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_.-]/.test(src[j])) {
        j++;
      }
      const word = src.slice(i, j);
      let k = j;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) {
        k++;
      }
      if (src[k] === ':') {
        parts.push(span('key', word));
      } else if (/^(true|false|null|yes|no|on|off)$/i.test(word)) {
        parts.push(span('kw', word));
      } else {
        parts.push(span('str', word));
      }
      i = j;
      continue;
    }
    parts.push(escapeHtml(ch));
    i++;
  }
  return parts.join('');
}

function highlightMarkdownSource(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      if (/^#{1,6}\s/.test(line)) {
        return span('kw', line);
      }
      if (/^>\s/.test(line)) {
        return span('cmt', line);
      }
      let out = escapeHtml(line);
      out = out.replace(/`([^`]+)`/g, (_a, body) => `<span class="tok-str">\`${body}\`</span>`);
      out = out.replace(/\*\*([^*]+)\*\*/g, (_a, body) => `<span class="tok-fn">**${body}**</span>`);
      return out;
    })
    .join('\n');
}

function highlightJson(src: string): string {
  return escapeHtml(src).replace(
    /(&quot;(?:\\.|[^&])*?&quot;)\s*:|(&quot;(?:\\.|[^&])*?&quot;)|\b(-?\d[\d.eE+-]*)\b|\b(true|false|null)\b/g,
    (all, key, str, num, kw) => {
      if (key) {
        return `<span class="tok-key">${key}</span>` + all.slice(key.length);
      }
      if (str) {
        return `<span class="tok-str">${str}</span>`;
      }
      if (num) {
        return `<span class="tok-num">${num}</span>`;
      }
      return `<span class="tok-kw">${kw}</span>`;
    }
  );
}

function highlightMarkup(src: string): string {
  return escapeHtml(src)
    .replace(/(&lt;\/?)([A-Za-z][\w:-]*)/g, (_a, br, name) => `${br}<span class="tok-kw">${name}</span>`)
    .replace(/\s([A-Za-z_:][\w:.-]*)=/g, (_a, name) => ` <span class="tok-key">${name}</span>=`)
    .replace(/(&quot;(?:\\.|[^&])*?&quot;)/g, '<span class="tok-str">$1</span>')
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-cmt">$1</span>');
}
