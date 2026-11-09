import type { AimedInvocation, ModelInvocation, WindowKind } from "@bots/protocol";

// What a call becomes at the Automatic level once the rules have read it. run means the call goes with no card. Otherwise the owner
// sees a card whose one plain sentence is reason. rule names which rule decided, so a later PR can add user rules to the same table
// and the card can say which one fired.
export type RuleOutcome = { run: true; rule: string } | { run: false; rule: string; reason: string };

// A desktop input's resolved aim, reduced to what the rules read. The orchestrator fills it from the run's newest look, so the same
// stored look decides the same way on a resume. element is null for typing or a key with no target, window is null with none active.
export type DesktopAim = {
  element: { role: string; name: string } | null;
  window: { app: string; kind: WindowKind } | null;
};

// The one input to the rules. It is a pure function of data Convex has stored: the parsed call, the desktop aim when there is one,
// and the bot's workspace path. A later PR adds the run's events here for bound files and user rules.
export type RuleInput = {
  invocation: ModelInvocation;
  aim: DesktopAim | null;
  workspace: string;
};

export function desktopAim(tool: AimedInvocation): DesktopAim {
  const window = (ref: { app: string; kind: WindowKind } | null) => (ref === null ? null : { app: ref.app, kind: ref.kind });
  switch (tool.name) {
    case "desktop_click":
    case "desktop_scroll":
      return { element: { role: tool.aim.element.role, name: tool.aim.element.name }, window: window(tool.aim.window) };
    case "desktop_type":
      return { element: tool.aim.element === null ? null : { role: tool.aim.element.role, name: tool.aim.element.name }, window: window(tool.aim.window) };
    case "desktop_key":
      return { element: null, window: window(tool.aim.window) };
  }
}

// Decide one call at the Automatic level. Built-in ask rules run first, so a built-in's reason wins even over an allow rule. Then a
// tool's own allow rule may let the call through. Anything else asks.
export function decideByRules(input: RuleInput): RuleOutcome {
  for (const name of BUILT_IN_ORDER) {
    if (BUILT_IN_RULES[name].applies(input)) {
      return { run: false, rule: name, reason: BUILT_IN_RULES[name].reason };
    }
  }
  return allow(input);
}

// ---- Allow rules, one per tool that reaches the Automatic byRules effects.

const DEFAULT_REASON = "This action needs your approval.";

function allow(input: RuleInput): RuleOutcome {
  const { invocation, aim } = input;
  switch (invocation.name) {
    // write_file runs as it does at Outside, unless a built-in above fired.
    case "write_file":
      return { run: true, rule: "writeFile" };
    case "shell":
      return readOnlyShell(invocation.args.command)
        ? { run: true, rule: "readOnlyShell" }
        : { run: false, rule: "default", reason: "This command isn't a known read-only one, so it needs your approval." };
    case "desktop_scroll":
      return { run: true, rule: "desktopScroll" };
    case "desktop_click":
      return deskClickAllowed(invocation.args.button, aim);
    case "desktop_type":
      return deskTypeAllowed({ submit: invocation.args.submit, text: invocation.args.text, aim });
    case "desktop_key":
      return deskKeyAllowed(invocation.args.keys);
    // The page's own targets aren't named yet, so a page action still asks. A later PR names them from the snapshot.
    case "browser_click":
    case "browser_type":
    case "browser_press":
      return { run: false, rule: "browserTarget", reason: "This acts on a web page, whose buttons aren't named yet, so it needs your approval." };
    default:
      return { run: false, rule: "default", reason: DEFAULT_REASON };
  }
}

// ---- Desktop allow rules. The element's role and name and its window come from the run's newest look.

// A commit word in a button's name means the click sends, publishes, deletes, pays, or otherwise commits something. continue counts,
// because it often confirms a payment. export counts, because exporting logins or data shares it.
const COMMIT_WORDS: readonly string[] = [
  "send", "post", "publish", "submit", "confirm", "delete", "remove", "discard", "erase", "wipe", "close account", "replace",
  "overwrite", "save", "pay", "buy", "purchase", "order", "checkout", "subscribe", "donate", "transfer", "sign", "accept", "agree",
  "allow", "grant", "install", "uninstall", "apply", "reset", "format", "empty trash", "export", "continue",
];
const COMMIT_WORD_RES: readonly RegExp[] = COMMIT_WORDS.map((word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));

// The terminal emulators on a bot's desktop. A click or typed line in one of them runs a command, so it is never an allowed target.
const TERMINAL_APPS: ReadonlySet<string> = new Set(["xfce4-terminal", "xterm", "uxterm"]);

// The keys that only move around. Enter and Return commit, so they always ask.
const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  "Up", "Down", "Left", "Right", "Page_Up", "Page_Down", "Home", "End", "Tab", "shift+Tab", "Escape",
]);

function isTerminal(aim: DesktopAim): boolean {
  return aim.window !== null && TERMINAL_APPS.has(aim.window.app);
}

function hasCommitWord(name: string): boolean {
  return COMMIT_WORD_RES.some((pattern) => pattern.test(name));
}

function deskClickAllowed(button: string, aim: DesktopAim | null): RuleOutcome {
  if (aim === null) {
    return { run: false, rule: "default", reason: DEFAULT_REASON };
  }
  if (button !== "left" && button !== "right") {
    return { run: false, rule: "desktopClick", reason: "This is a double or middle click, so it needs your approval." };
  }
  const name = aim.element?.name ?? "";
  if (name.trim() === "") {
    return { run: false, rule: "desktopClick", reason: "This clicks a control with no name, so it needs your approval." };
  }
  if (isTerminal(aim)) {
    return { run: false, rule: "desktopClick", reason: "This clicks inside a terminal, so it needs your approval." };
  }
  if (hasCommitWord(name)) {
    return { run: false, rule: "desktopClick", reason: "This looks like it commits or confirms something, so it needs your approval." };
  }
  return { run: true, rule: "desktopClick" };
}

function deskTypeAllowed(args: { submit: boolean; text: string; aim: DesktopAim | null }): RuleOutcome {
  const { submit, text, aim } = args;
  if (submit) {
    return { run: false, rule: "desktopType", reason: "This types and then presses Enter, so it needs your approval." };
  }
  if (/[\r\n]/.test(text)) {
    return { run: false, rule: "desktopType", reason: "This types more than one line, so it needs your approval." };
  }
  if (aim !== null && isTerminal(aim)) {
    return { run: false, rule: "desktopType", reason: "This types into a terminal, so it needs your approval." };
  }
  return { run: true, rule: "desktopType" };
}

function deskKeyAllowed(keys: string): RuleOutcome {
  return NAVIGATION_KEYS.has(keys)
    ? { run: true, rule: "desktopKey" }
    : { run: false, rule: "desktopKey", reason: "This presses a key that isn't plain navigation, so it needs your approval." };
}

// ---- The read-only shell allow rule. A conservative tokenizer parses the command, and anything it cannot parse with certainty asks.

type ShellParse = { ok: true; segments: string[][] } | { ok: false };

// Splits a command into segments on &&, ||, ;, and |, with each segment's words. It respects single and double quotes and a
// backslash escape. It fails, so the call asks, on a command substitution, a backtick, a process substitution, a here-doc, a
// subshell or group, a background &, a |& pipe, or any redirection other than 2>&1 and >/dev/null.
function parseShell(command: string): ShellParse {
  const chars = [...command];
  const segments: string[][] = [];
  let segment: string[] = [];
  let token = "";
  let quote: "" | "'" | '"' = "";
  const endToken = () => {
    if (token !== "") {
      segment.push(token);
      token = "";
    }
  };
  const endSegment = () => {
    endToken();
    if (segment.length > 0) {
      segments.push(segment);
      segment = [];
    }
  };
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    const next = chars[index + 1];
    if (quote !== "") {
      if (char === quote) {
        quote = "";
      } else {
        token += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\") {
      if (next === undefined) {
        return { ok: false };
      }
      token += next;
      index += 1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n") {
      endToken();
      continue;
    }
    if (char === "`" || char === "(" || char === ")" || char === "{" || char === "}" || char === "<") {
      return { ok: false };
    }
    if (char === "$") {
      if (next === "(") {
        return { ok: false };
      }
      token += char;
      continue;
    }
    if (char === ">") {
      if (token === "2" && next === "&" && chars[index + 2] === "1") {
        token = "";
        index += 2;
        continue;
      }
      if (token !== "" || next === "(") {
        return { ok: false };
      }
      let scan = index + 1;
      if (chars[scan] === ">") {
        scan += 1;
      }
      while (chars[scan] === " ") {
        scan += 1;
      }
      const rest = chars.slice(scan).join("");
      if (rest.startsWith("/dev/null")) {
        const after = rest.slice("/dev/null".length);
        if (after === "" || /^[\s;|&]/.test(after)) {
          index = scan + "/dev/null".length - 1;
          continue;
        }
      }
      return { ok: false };
    }
    if (char === "&") {
      if (next === "&") {
        endSegment();
        index += 1;
        continue;
      }
      return { ok: false };
    }
    if (char === "|") {
      if (next === "&") {
        return { ok: false };
      }
      endSegment();
      if (next === "|") {
        index += 1;
      }
      continue;
    }
    if (char === ";") {
      endSegment();
      continue;
    }
    token += char;
  }
  if (quote !== "") {
    return { ok: false };
  }
  endSegment();
  return { ok: true, segments };
}

function readOnlyShell(command: string): boolean {
  const parsed = parseShell(command);
  return parsed.ok && parsed.segments.length > 0 && parsed.segments.every(segmentAllowed);
}

// A segment runs only when its program is a known read-only one and none of that program's forbidden flags appear. A program with a
// slash in its name is never matched, so a path such as ./script.sh asks.
function segmentAllowed(words: string[]): boolean {
  const [program, ...rest] = words;
  if (program === undefined || program.includes("/")) {
    return false;
  }
  if (program === "git") {
    return gitAllowed(rest);
  }
  const check = READ_ONLY_PROGRAMS[program];
  return check !== undefined && check(rest);
}

const has = (rest: string[], ...flags: string[]): boolean =>
  rest.some((token) => flags.some((flag) => token === flag || token.startsWith(`${flag}=`)));
const operands = (rest: string[]): string[] => rest.filter((token) => !token.startsWith("-") || token === "-");

// Each program maps to a test that returns true when the call is read-only. A test built from forbidden flags returns false when one
// appears. Programs with no forbidden flags always pass.
const READ_ONLY_PROGRAMS: Readonly<Record<string, (rest: string[]) => boolean>> = {
  ls: () => true,
  cat: () => true,
  head: () => true,
  tail: () => true,
  wc: () => true,
  grep: () => true,
  egrep: () => true,
  fgrep: () => true,
  rg: (rest) => !has(rest, "--pre", "--pre-glob"),
  find: (rest) => !rest.some((token) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls"].includes(token) || token.startsWith("-fprint")),
  pwd: () => true,
  echo: () => true,
  printf: () => true,
  stat: () => true,
  file: () => true,
  du: () => true,
  df: () => true,
  which: () => true,
  type: () => true,
  tree: (rest) => !has(rest, "-o", "--output"),
  diff: () => true,
  cmp: () => true,
  sort: (rest) => !has(rest, "-o", "--output", "--compress-program"),
  uniq: (rest) => operands(rest).length <= 1,
  cut: () => true,
  tr: () => true,
  nl: () => true,
  basename: () => true,
  dirname: () => true,
  realpath: () => true,
  date: (rest) => !has(rest, "-s", "--set"),
  whoami: () => true,
  id: () => true,
  uname: () => true,
  hostname: (rest) => rest.length === 0,
  jq: () => true,
  column: () => true,
  md5sum: () => true,
  sha1sum: () => true,
  sha224sum: () => true,
  sha256sum: () => true,
  sha384sum: () => true,
  sha512sum: () => true,
  ps: () => true,
  free: () => true,
  uptime: () => true,
  mkdir: () => true,
  touch: () => true,
};

const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame"]);
const GIT_BRANCH_LIST_FLAGS: ReadonlySet<string> = new Set(["-a", "-r", "-v", "-vv", "-l", "--list", "--all", "--verbose", "--remotes"]);
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);

// git runs with only the listed read subcommands, and never with an option that makes it run a program or write a file.
function gitAllowed(rest: string[]): boolean {
  if (rest.some((token) => token === "-c" || token.startsWith("-c=") || token === "--exec-path" || token.startsWith("--exec-path=") || token === "--output" || token.startsWith("--output=") || token === "--ext-diff")) {
    return false;
  }
  let index = 0;
  while (index < rest.length && rest[index]!.startsWith("-")) {
    const option = rest[index]!;
    index += 1;
    if (GIT_VALUE_OPTIONS.has(option) && index < rest.length) {
      index += 1;
    }
  }
  const subcommand = rest[index];
  if (subcommand === undefined) {
    return false;
  }
  const after = rest.slice(index + 1);
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) {
    return true;
  }
  if (subcommand === "remote") {
    return after.every((token) => token === "-v" || token === "--verbose");
  }
  if (subcommand === "branch") {
    return after.every((token) => GIT_BRANCH_LIST_FLAGS.has(token));
  }
  return false;
}

// ---- Built-in ask rules. Deterministic, with fixed words, ported from the research branch. gitConfig is new.

type BuiltInRule = { reason: string; applies: (input: RuleInput) => boolean };

const MAX_ACTION_BYTES = 16 * 1024;

const BUILT_IN_RULES = {
  hiddenText: {
    reason: "This action holds characters that don't show on screen.",
    applies: (input) => stringArgsOf(input.invocation.args).some(hasHiddenChar),
  },
  tooLong: {
    reason: "This action is too long to check automatically.",
    applies: (input) => Buffer.byteLength(JSON.stringify(input.invocation.args), "utf8") > MAX_ACTION_BYTES,
  },
  downloadIntoShell: {
    reason: "This downloads something from the internet and runs it without reading it first.",
    applies: (input) => shellCommands(input).some(isDownloadIntoShell),
  },
  startsLater: {
    reason: "This sets up something that runs later by itself, such as at login, on a schedule, or on a git action.",
    applies: (input) => writtenPlaces(input).some((value) => STARTS_LATER.some((pattern) => pattern.test(value))),
  },
  gitConfig: {
    reason: "This changes a git setting that makes git run a program of its own.",
    applies: (input) => writtenPlaces(input).some((value) => GIT_CONFIG_FILE.test(value)) || shellCommands(input).some((command) => GIT_CONFIG_SET.test(command)),
  },
  ownerLogins: {
    reason: "This action reaches your browser's logins or your computer's own records.",
    applies: (input) => stringArgsOf(input.invocation.args).some((value) => OWNER_LOGIN_PATHS.some((pattern) => pattern.test(value))),
  },
  credentialFiles: {
    reason: "This reads or copies saved logins, keys, or credential files.",
    applies: (input) => stringArgsOf(input.invocation.args).some((value) => reachesCredentialFile(value, input.workspace)),
  },
  otherBot: {
    reason: "This action reaches another bot's files.",
    applies: (input) => stringArgsOf(input.invocation.args).some((value) => reachesOtherBot(value, input.workspace)),
  },
} as const satisfies Record<string, BuiltInRule>;

const BUILT_IN_ORDER = Object.keys(BUILT_IN_RULES) as (keyof typeof BUILT_IN_RULES)[];

// ---- Shared pure helpers, ported from the research branch's review module.

// A write of a startup file is harmless to read, so only a write_file's path or a shell command that writes is matched.
const WRITES = /(?:>|\btee\b|\bcp\b|\bmv\b|\bln\b|\binstall\b|\bsed\s+-i|\bchmod\b|\btouch\b|\bsystemctl\b|\bcrontab\b|\bgit\s+config\b)/;

const STARTS_LATER: readonly RegExp[] = [
  /\.config\/autostart(\/|\b)/,
  /\/etc\/xdg\/autostart(\/|\b)/,
  /\.config\/systemd\/user(\/|\b)/,
  /\/etc\/systemd\/system(\/|\b)/,
  /\bsystemctl\s+(?:--user\s+)?enable\b/,
  /\/etc\/cron[\w.]*(\/|\b)/,
  /\/var\/spool\/cron(\/|\b)/,
  /\bcrontab\b(?!\s+-l\b)/,
  /\/etc\/profile(\.d)?(\/|\b)/,
  /\/etc\/(?:bash\.bashrc|zsh\/|environment\b|rc\.local\b)/,
  /(?:^|[\s/~'"=])\.(?:bashrc|bash_profile|bash_login|profile|zshrc|zprofile|zshenv|xprofile|xsessionrc|xinitrc)\b/,
  /\.git\/hooks\//,
  /\bgit\s+config\b[^\n]*\bcore\.hooksPath\b/,
];

// git itself runs these settings, so setting one is as powerful as a command. A write to its config file does the same.
const GIT_CONFIG_FILE = /(?:^|\/)\.git\/config\b|(?:^|\/|~|\$HOME\/|\bHOME\/)\.gitconfig\b/;
const GIT_CONFIG_SET = /\bgit\b[^\n]*\bconfig\b[^\n]*(?:\bcore\.fsmonitor\b|\bcore\.pager\b|\bcore\.sshCommand\b|\bcore\.hooksPath\b|\balias\.)/i;

const OWNER_LOGIN_PATHS: readonly RegExp[] = [
  /\/home\/browser(\/|\b)/,
  /\/var\/lib\/computerd(\/|\b)/,
  /--remote-debugging/,
  /(?:127\.0\.0\.1|localhost|\[::1\]):930\d\b/,
  /:930\d\/json\b/,
];

const CREDENTIAL_DIRS: readonly RegExp[] = [
  /(?:^|\/|~|\$HOME\/|\bHOME\/)\.ssh(\/|\b)/,
  /(?:^|\/|~|\$HOME\/|\bHOME\/)\.aws(\/|\b)/,
  /(?:^|\/|~|\$HOME\/|\bHOME\/)\.config\/gh(\/|\b)/,
  /(?:^|\/|~|\$HOME\/|\bHOME\/)\.netrc(?:\b)/,
  /(?:^|\/|~|\$HOME\/|\bHOME\/)\.gnupg(\/|\b)/,
];
const BROWSER_CREDENTIAL_FILES: readonly RegExp[] = [/\/Login Data(?:\b|$)/, /\/Local State(?:\b|$)/, /\/Cookies(?:\b|$)/];

function reachesCredentialFile(value: string, workspace: string): boolean {
  if (CREDENTIAL_DIRS.some((pattern) => pattern.test(value)) || BROWSER_CREDENTIAL_FILES.some((pattern) => pattern.test(value))) {
    return true;
  }
  return tokens(value).some((token) => /(?:^|\/)\.env(?:\.|$)/.test(token) && !within(resolvePath(workspace, token), workspace));
}

function reachesOtherBot(value: string, workspace: string): boolean {
  const thisBot = basename(workspace);
  for (const match of value.matchAll(/\/workspace\/([^/\s"'`]+)/g)) {
    if (match[1] !== undefined && match[1] !== thisBot) {
      return true;
    }
  }
  return false;
}

function shellCommands(input: RuleInput): string[] {
  return input.invocation.name === "shell" ? [input.invocation.args.command] : [];
}

function writtenPlaces(input: RuleInput): string[] {
  if (input.invocation.name === "write_file") {
    return [input.invocation.args.path];
  }
  return shellCommands(input).filter((command) => WRITES.test(command));
}

const DOWNLOADER = "(?:curl|wget|fetch)";
const INTERPRETER = "(?:sh|bash|dash|zsh|ksh|python3?|node|nodejs|ruby|perl|php|pwsh)";
function isDownloadIntoShell(command: string): boolean {
  if (new RegExp(`<\\(\\s*${DOWNLOADER}\\b`).test(command) && new RegExp(`\\b${INTERPRETER}\\b`).test(command)) {
    return true;
  }
  if (new RegExp(`\\b(?:eval|${INTERPRETER}\\s+-c)\\b[\\s\\S]*(?:\\$\\(\\s*${DOWNLOADER}\\b|\`\\s*${DOWNLOADER}\\b)`).test(command)) {
    return true;
  }
  return new RegExp(`\\b${DOWNLOADER}\\b[\\s\\S]*\\|\\s*(?:sudo\\s+|env\\s+\\S+\\s+)*${INTERPRETER}\\b`).test(command);
}

// Bidi controls, zero-width space, word joiner, a BOM, tag characters, and C0/C1 controls other than tab, CR, LF. Text the owner
// cannot see on a card must not reach a rule that reads it differently.
function isHiddenCode(code: number): boolean {
  return (
    code <= 0x08 ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x206f) ||
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
}

function hasHiddenChar(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code !== undefined && isHiddenCode(code)) {
      return true;
    }
  }
  return false;
}

function stringArgsOf(args: unknown): string[] {
  if (typeof args === "string") {
    return [args];
  }
  if (Array.isArray(args)) {
    return args.flatMap(stringArgsOf);
  }
  if (args !== null && typeof args === "object") {
    return Object.values(args).flatMap(stringArgsOf);
  }
  return [];
}

function tokens(value: string): string[] {
  return value.split(/[\s|&;()<>"'`$]+/).filter((token) => token !== "");
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

// A relative token resolves against the workspace. An absolute one stays. A ~ or $HOME token is left literal, because the home is not
// the workspace and the credential checks match it by name.
function resolvePath(workspace: string, token: string): string {
  if (token.startsWith("/")) {
    return normalize(token);
  }
  if (token.startsWith("~") || token.startsWith("$")) {
    return token;
  }
  return normalize(`${workspace}/${token}`);
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

function within(path: string, workspace: string): boolean {
  const root = normalize(workspace);
  return path === root || path.startsWith(`${root}/`);
}
