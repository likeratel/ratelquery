//! Lists the profiles in the shared AWS config and credentials files so the connection form can
//! offer them. Only names, the DynamoDB region and whether a profile uses SSO are read; every
//! other value (keys, tokens, role ARNs) is skipped while parsing and never kept.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};

const CONFIG_ENV: &str = "AWS_CONFIG_FILE";
const CREDENTIALS_ENV: &str = "AWS_SHARED_CREDENTIALS_FILE";
const DEFAULT_CONFIG: &str = ".aws/config";
const DEFAULT_CREDENTIALS: &str = ".aws/credentials";
const DEFAULT_PROFILE: &str = "default";
const PROFILE_PREFIX: &str = "profile";

/// Which file defines a profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileSource {
    Config,
    Credentials,
    Both,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsProfile {
    pub name: String,
    /// `region` of the config file section. Never the SSO session's `sso_region`, which is where
    /// the SSO portal lives rather than where the tables are.
    pub region: Option<String>,
    pub source: ProfileSource,
    /// The config section has `sso_start_url` or `sso_session`.
    pub sso: bool,
}

/// What one file says about one profile.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct SectionInfo {
    region: Option<String>,
    sso: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FileKind {
    Config,
    Credentials,
}

/// Profile name of a section header's inner text, or None for sections that are not profiles
/// (`sso-session`, `services`, ...). The config file names profiles `[profile x]` except for
/// `[default]`; the credentials file uses bare `[x]`.
fn profile_name(header: &str, kind: FileKind) -> Option<String> {
    let header = header.trim();
    let name = match kind {
        FileKind::Credentials => header,
        FileKind::Config if header == DEFAULT_PROFILE => header,
        FileKind::Config => {
            let rest = header.strip_prefix(PROFILE_PREFIX)?;
            if !rest.starts_with(char::is_whitespace) {
                return None;
            }
            rest.trim()
        }
    };
    (!name.is_empty()).then(|| name.to_string())
}

/// Keeps only the keys this module needs; values of all other keys are dropped unread.
fn apply_property(info: SectionInfo, key: &str, value: &str) -> SectionInfo {
    match key {
        "region" if !value.is_empty() => SectionInfo { region: Some(value.to_string()), ..info },
        "sso_start_url" | "sso_session" => SectionInfo { sso: true, ..info },
        _ => info,
    }
}

/// Parses one INI-style AWS file. Comments, indented continuation lines, lines outside a
/// profile section and malformed lines are ignored. Repeated sections are merged.
fn parse_file(text: &str, kind: FileKind) -> BTreeMap<String, SectionInfo> {
    let mut profiles: BTreeMap<String, SectionInfo> = BTreeMap::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(inner) = line.strip_prefix('[') {
            current = inner.split_once(']').and_then(|(header, _)| profile_name(header, kind));
            if let Some(name) = &current {
                profiles.entry(name.clone()).or_default();
            }
            continue;
        }
        let (Some(name), Some((key, value))) = (&current, line.split_once('=')) else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        if let Some(info) = profiles.get(name) {
            let updated = apply_property(info.clone(), &key, value.trim());
            profiles.insert(name.clone(), updated);
        }
    }
    profiles
}

/// Joins both files' profiles, sorted by name. Region and SSO come from the config file only.
fn merge(
    config: BTreeMap<String, SectionInfo>,
    credentials: BTreeMap<String, SectionInfo>,
) -> Vec<AwsProfile> {
    let names: std::collections::BTreeSet<&String> =
        config.keys().chain(credentials.keys()).collect();
    names
        .into_iter()
        .map(|name| {
            let in_config = config.get(name);
            let source = match (in_config.is_some(), credentials.contains_key(name)) {
                (true, true) => ProfileSource::Both,
                (true, false) => ProfileSource::Config,
                _ => ProfileSource::Credentials,
            };
            AwsProfile {
                name: name.clone(),
                region: in_config.and_then(|info| info.region.clone()),
                source,
                sso: in_config.is_some_and(|info| info.sso),
            }
        })
        .collect()
}

/// Contents of `path`, or an empty string when it does not exist. Invalid UTF-8 is replaced
/// rather than failing the whole list.
fn read_optional(path: &Path) -> AppResult<String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(AppError::Io(format!("Couldn't read {}: {e}", path.display()))),
    }
}

/// The file named by the environment variable (with a leading `~` expanded), else the default
/// under the home directory. None when neither can be determined.
fn resolve_path(
    env_value: Option<OsString>,
    home: Option<&Path>,
    default_relative: &str,
) -> Option<PathBuf> {
    match env_value.filter(|v| !v.is_empty()) {
        Some(value) => {
            let value = PathBuf::from(value);
            match (value.strip_prefix("~"), home) {
                (Ok(rest), Some(home)) => Some(home.join(rest)),
                _ => Some(value),
            }
        }
        None => home.map(|home| home.join(default_relative)),
    }
}

/// Profiles from the given files; a missing path or file contributes nothing.
pub fn load_profiles(
    config_path: Option<&Path>,
    credentials_path: Option<&Path>,
) -> AppResult<Vec<AwsProfile>> {
    let read = |path: Option<&Path>, kind| -> AppResult<_> {
        let text = match path {
            Some(path) => read_optional(path)?,
            None => String::new(),
        };
        Ok(parse_file(&text, kind))
    };
    let config = read(config_path, FileKind::Config)?;
    let credentials = read(credentials_path, FileKind::Credentials)?;
    Ok(merge(config, credentials))
}

/// Profiles from the files the AWS SDK would use: `AWS_CONFIG_FILE` /
/// `AWS_SHARED_CREDENTIALS_FILE`, or `~/.aws/config` / `~/.aws/credentials`.
pub fn aws_profiles() -> AppResult<Vec<AwsProfile>> {
    let home = dirs::home_dir();
    let config = resolve_path(std::env::var_os(CONFIG_ENV), home.as_deref(), DEFAULT_CONFIG);
    let credentials =
        resolve_path(std::env::var_os(CREDENTIALS_ENV), home.as_deref(), DEFAULT_CREDENTIALS);
    load_profiles(config.as_deref(), credentials.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = "\
# comment
[default]
region = us-east-1
output = json

[profile prod]
region=eu-west-1
role_arn = arn:aws:iam::123:role/x
s3 =
  region = should-be-ignored

[profile sso-dev]
sso_session = corp
sso_account_id = 123

[sso-session corp]
sso_region = us-west-2
sso_start_url = https://corp.awsapps.com/start

[profile legacy-sso]
sso_start_url = https://legacy.awsapps.com/start
region = ap-northeast-2

[services local]
region = nope

[profilebroken]
region = nope
garbage line without equals
";

    const CREDENTIALS: &str = "\
[default]
aws_access_key_id = AKIADEFAULT
aws_secret_access_key = super-secret

[ci]
aws_access_key_id = AKIACI
aws_secret_access_key = other-secret
region = us-east-2
[unterminated
aws_secret_access_key = x
";

    fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, text).unwrap();
        path
    }

    fn profile(name: &str, region: Option<&str>, source: ProfileSource, sso: bool) -> AwsProfile {
        AwsProfile { name: name.into(), region: region.map(Into::into), source, sso }
    }

    #[test]
    fn aws_profiles_merges_both_files_sorted_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let config = write(dir.path(), "config", CONFIG);
        let credentials = write(dir.path(), "credentials", CREDENTIALS);
        let profiles = load_profiles(Some(&config), Some(&credentials)).unwrap();
        assert_eq!(
            profiles,
            vec![
                profile("ci", None, ProfileSource::Credentials, false),
                profile("default", Some("us-east-1"), ProfileSource::Both, false),
                profile("legacy-sso", Some("ap-northeast-2"), ProfileSource::Config, true),
                profile("prod", Some("eu-west-1"), ProfileSource::Config, false),
                profile("sso-dev", None, ProfileSource::Config, true),
            ]
        );
    }

    #[test]
    fn aws_profiles_never_serializes_secret_values() {
        let dir = tempfile::tempdir().unwrap();
        let config = write(dir.path(), "config", CONFIG);
        let credentials = write(dir.path(), "credentials", CREDENTIALS);
        let profiles = load_profiles(Some(&config), Some(&credentials)).unwrap();
        let json = serde_json::to_string(&profiles).unwrap();
        for secret in ["super-secret", "other-secret", "AKIA", "arn:aws", "awsapps"] {
            assert!(!json.contains(secret), "{json}");
        }
        assert!(json.contains(r#""source":"both""#), "{json}");
    }

    #[test]
    fn aws_profiles_missing_files_give_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert_eq!(load_profiles(Some(&missing), Some(&missing)).unwrap(), vec![]);
        assert_eq!(load_profiles(None, None).unwrap(), vec![]);
        let config = write(dir.path(), "config", "[default]\n");
        assert_eq!(
            load_profiles(Some(&config), Some(&missing)).unwrap(),
            vec![profile("default", None, ProfileSource::Config, false)]
        );
    }

    #[test]
    fn aws_profiles_accepts_profile_default_and_crlf() {
        let parsed = parse_file("[profile default]\r\nregion = sa-east-1\r\n", FileKind::Config);
        assert_eq!(parsed["default"].region.as_deref(), Some("sa-east-1"));
        // The credentials file has no `profile` prefix, so the header is the name as written.
        let parsed = parse_file("[ spaced ]\n", FileKind::Credentials);
        assert!(parsed.contains_key("spaced"));
    }

    #[test]
    fn aws_profiles_resolves_env_and_home_paths() {
        let home = Path::new("/home/me");
        assert_eq!(
            resolve_path(None, Some(home), DEFAULT_CONFIG),
            Some(PathBuf::from("/home/me/.aws/config"))
        );
        assert_eq!(
            resolve_path(Some("".into()), Some(home), DEFAULT_CONFIG),
            Some(PathBuf::from("/home/me/.aws/config"))
        );
        assert_eq!(
            resolve_path(Some("/etc/aws".into()), Some(home), DEFAULT_CONFIG),
            Some(PathBuf::from("/etc/aws"))
        );
        assert_eq!(
            resolve_path(Some("~/alt/config".into()), Some(home), DEFAULT_CONFIG),
            Some(PathBuf::from("/home/me/alt/config"))
        );
        assert_eq!(resolve_path(None, None, DEFAULT_CONFIG), None);
    }
}
