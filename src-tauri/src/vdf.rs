//! Valve Data Format.
//!
//! Steam's `libraryfolders.vdf` and every `appmanifest_*.acf` are text VDF:
//! quoted keys, quoted values or a nested brace block, tabs between them. The
//! format is undocumented, so this parser is written to be tolerant of things
//! Valve does that a strict reader would reject -- comments, unquoted tokens,
//! duplicate keys, and a stray conditional suffix like `[$WINDOWS]`.
//!
//! It is deliberately its own module with its own tests. docs/PLAN.md §11
//! notes that Valve owes us nothing and could change any of this; when that
//! happens the failure should be one parse error in one place, not a mystery
//! somewhere in the scan.

use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Str(String),
    Map(BTreeMap<String, Value>),
}

impl Value {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            Value::Map(_) => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Map(m) => m.get(key).or_else(|| {
                // Valve is inconsistent about capitalisation across files and
                // even across versions of the same file -- `LastPlayed` and
                // `lastupdated` sit two lines apart in a real manifest. Fall
                // back to a case-insensitive match rather than making every
                // caller guess.
                let want = key.to_ascii_lowercase();
                m.iter()
                    .find(|(k, _)| k.to_ascii_lowercase() == want)
                    .map(|(_, v)| v)
            }),
            Value::Str(_) => None,
        }
    }

    pub fn str_at(&self, key: &str) -> Option<&str> {
        self.get(key)?.as_str()
    }

    pub fn u64_at(&self, key: &str) -> Option<u64> {
        self.str_at(key)?.trim().parse().ok()
    }

    /// The single child of a one-entry document, which is how every Steam file
    /// is shaped: `"AppState" { ... }`, `"libraryfolders" { ... }`.
    pub fn root_child(&self) -> Option<&Value> {
        match self {
            Value::Map(m) if m.len() == 1 => m.values().next(),
            _ => None,
        }
    }

    pub fn entries(&self) -> impl Iterator<Item = (&String, &Value)> {
        match self {
            Value::Map(m) => m.iter(),
            Value::Str(_) => EMPTY.iter(),
        }
    }
}

static EMPTY: BTreeMap<String, Value> = BTreeMap::new();

#[derive(Debug)]
pub struct ParseError {
    pub message: String,
    pub line: usize,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

impl std::error::Error for ParseError {}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    line: usize,
}

impl<'a> Parser<'a> {
    fn err<T>(&self, message: impl Into<String>) -> Result<T, ParseError> {
        Err(ParseError {
            message: message.into(),
            line: self.line,
        })
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn bump(&mut self) -> Option<u8> {
        let b = self.peek()?;
        self.pos += 1;
        if b == b'\n' {
            self.line += 1;
        }
        Some(b)
    }

    fn skip_trivia(&mut self) {
        loop {
            match self.peek() {
                Some(b) if b.is_ascii_whitespace() => {
                    self.bump();
                }
                Some(b'/') if self.bytes.get(self.pos + 1) == Some(&b'/') => {
                    while let Some(b) = self.bump() {
                        if b == b'\n' {
                            break;
                        }
                    }
                }
                _ => return,
            }
        }
    }

    fn quoted(&mut self) -> Result<String, ParseError> {
        self.bump(); // opening quote
        let mut out = String::new();
        loop {
            match self.bump() {
                None => return self.err("unterminated string"),
                Some(b'"') => return Ok(out),
                Some(b'\\') => match self.bump() {
                    Some(b'n') => out.push('\n'),
                    Some(b't') => out.push('\t'),
                    Some(b'\\') => out.push('\\'),
                    Some(b'"') => out.push('"'),
                    // Windows paths in these files are written with single
                    // backslashes as often as escaped ones. Keep whatever
                    // followed rather than losing a path separator.
                    Some(other) => {
                        out.push('\\');
                        out.push(other as char);
                    }
                    None => return self.err("unterminated escape"),
                },
                Some(b) => out.push(b as char),
            }
        }
    }

    fn bare(&mut self) -> String {
        let start = self.pos;
        while let Some(b) = self.peek() {
            if b.is_ascii_whitespace() || b == b'"' || b == b'{' || b == b'}' {
                break;
            }
            self.bump();
        }
        String::from_utf8_lossy(&self.bytes[start..self.pos]).into_owned()
    }

    fn token(&mut self) -> Result<String, ParseError> {
        if self.peek() == Some(b'"') {
            self.quoted()
        } else {
            Ok(self.bare())
        }
    }

    fn map(&mut self, depth: usize) -> Result<Value, ParseError> {
        // A malformed or hostile file must not blow the stack. Real Steam
        // files nest four or five deep.
        if depth > 64 {
            return self.err("nested too deeply");
        }
        let mut out = BTreeMap::new();
        loop {
            self.skip_trivia();
            match self.peek() {
                None => return Ok(Value::Map(out)),
                Some(b'}') => {
                    self.bump();
                    return Ok(Value::Map(out));
                }
                Some(_) => {}
            }

            let key = self.token()?;
            if key.is_empty() {
                self.bump();
                continue;
            }
            self.skip_trivia();

            // `"key" "value" [$WINDOWS]` -- a platform conditional we ignore.
            let value = match self.peek() {
                Some(b'{') => {
                    self.bump();
                    self.map(depth + 1)?
                }
                None => return self.err("key with no value"),
                _ => Value::Str(self.token()?),
            };
            self.skip_trivia();
            if self.peek() == Some(b'[') {
                while let Some(b) = self.bump() {
                    if b == b']' {
                        break;
                    }
                }
            }
            // Last wins. Valve emits duplicate keys occasionally and the later
            // one is the live value.
            out.insert(key, value);
        }
    }
}

pub fn parse(input: &str) -> Result<Value, ParseError> {
    // Some Steam files are written with a UTF-8 BOM.
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    Parser {
        bytes: input.as_bytes(),
        pos: 0,
        line: 1,
    }
    .map(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real file, captured from a working Steam install with only the home
    /// path anonymised. docs/PLAN.md §11 is explicit that these tests cannot
    /// prevent Valve changing the format -- they catch us breaking the reader,
    /// which is the failure we control.
    const REAL_MANIFEST: &str = include_str!("../tests/fixtures/appmanifest_365670.acf");
    const REAL_LIBFOLDERS: &str = include_str!("../tests/fixtures/libraryfolders.vdf");
    const MULTI_LIBFOLDERS: &str = include_str!("../tests/fixtures/libraryfolders_multi.vdf");

    #[test]
    fn reads_a_real_appmanifest() {
        let app = parse(REAL_MANIFEST).unwrap();
        let app = app.root_child().unwrap();
        assert_eq!(app.str_at("appid"), Some("365670"));
        assert_eq!(app.str_at("name"), Some("Blender"));
        assert_eq!(app.str_at("installdir"), Some("Blender"));
        assert_eq!(app.u64_at("StateFlags"), Some(4));
        assert_eq!(app.u64_at("SizeOnDisk"), Some(901233084));
        // Nested block, several levels down.
        assert!(app.get("InstalledDepots").is_some());
    }

    #[test]
    fn reads_a_real_libraryfolders() {
        let v = parse(REAL_LIBFOLDERS).unwrap();
        let folders = v.root_child().unwrap();
        let first = folders.get("0").unwrap();
        assert!(first.str_at("path").unwrap().ends_with("Steam"));
    }

    /// Valve is inconsistent about capitalisation inside a single file --
    /// `LastPlayed` and `lastupdated` sit two lines apart in the real manifest
    /// above. Callers should not have to guess.
    #[test]
    fn key_lookup_is_case_insensitive() {
        let app = parse(REAL_MANIFEST).unwrap();
        let app = app.root_child().unwrap();
        assert_eq!(app.u64_at("stateflags"), Some(4));
        assert_eq!(app.u64_at("LASTUPDATED"), Some(1728908810));
    }

    #[test]
    fn handles_comments_conditionals_and_escaped_paths() {
        let v = parse(MULTI_LIBFOLDERS).unwrap();
        let folders = v.root_child().unwrap();
        assert_eq!(
            folders.get("0").unwrap().str_at("path"),
            Some("C:\\Program Files (x86)\\Steam")
        );
        // `"label" "games" [$WINDOWS]` -- the conditional must not become a key.
        assert_eq!(folders.get("1").unwrap().str_at("label"), Some("games"));
        assert_eq!(
            folders.get("1").unwrap().str_at("path"),
            Some("D:\\SteamLibrary")
        );
    }

    #[test]
    fn a_truncated_file_is_an_error_not_a_panic() {
        // A manifest half-written by Steam while we happened to read it. This
        // must degrade, never crash -- priority #2.
        let truncated = &REAL_MANIFEST[..REAL_MANIFEST.len() / 2];
        let _ = parse(truncated);

        assert!(parse("\"AppState\" { \"name\" \"unterminated").is_err());
        assert!(parse("\"a\"").is_err());
    }

    #[test]
    fn deep_nesting_does_not_blow_the_stack() {
        let bomb = "\"a\" {".repeat(500);
        assert!(parse(&bomb).is_err());
    }

    #[test]
    fn last_duplicate_key_wins() {
        let v = parse("\"r\" { \"k\" \"first\" \"k\" \"second\" }").unwrap();
        assert_eq!(v.root_child().unwrap().str_at("k"), Some("second"));
    }
}
