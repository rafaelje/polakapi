use serde::Serialize;
use serde_json::Value;
use std::cmp::Ordering;
use std::time::Duration;
use tauri::AppHandle;

// Releases are published by `.github/workflows/build-desktop-release.yml`
// with the tag `v<version>` read from tauri.conf.json, so the latest GitHub
// release tag is the source of truth for "is there a newer build?".
const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/rafaelje/polakapi/releases/latest";
const USER_AGENT: &str = "polakapi-update-check";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    parts: Vec<u64>,
    pre_release: Option<String>,
}

impl Version {
    /// Accepts `1.2.3`, `v1.2.3` and `1.2.3-beta.1`; build metadata is dropped.
    pub fn parse(raw: &str) -> Option<Version> {
        let trimmed = raw.trim().trim_start_matches(['v', 'V']);
        let without_build = trimmed.split('+').next()?;
        let (core, pre_release) = match without_build.split_once('-') {
            Some((core, pre)) => (core, Some(pre.to_string())),
            None => (without_build, None),
        };
        if core.is_empty() {
            return None;
        }
        let parts = core
            .split('.')
            .map(|part| part.parse::<u64>().ok())
            .collect::<Option<Vec<u64>>>()?;
        Some(Version { parts, pre_release })
    }

    pub fn is_newer_than(&self, other: &Version) -> bool {
        self.cmp(other) == Ordering::Greater
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        let len = self.parts.len().max(other.parts.len());
        for index in 0..len {
            let a = self.parts.get(index).copied().unwrap_or(0);
            let b = other.parts.get(index).copied().unwrap_or(0);
            match a.cmp(&b) {
                Ordering::Equal => continue,
                unequal => return unequal,
            }
        }
        // A pre-release sorts below the matching final release.
        match (&self.pre_release, &other.pre_release) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(a), Some(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub fn build_check(current: &str, release: &Value) -> Result<UpdateCheck, String> {
    let tag = release
        .get("tag_name")
        .and_then(Value::as_str)
        .ok_or_else(|| "release payload has no tag_name".to_string())?;
    let release_url = release
        .get("html_url")
        .and_then(Value::as_str)
        .unwrap_or("https://github.com/rafaelje/polakapi/releases/latest")
        .to_string();
    let latest = Version::parse(tag).ok_or_else(|| format!("unparseable release tag: {tag}"))?;
    let current_version =
        Version::parse(current).ok_or_else(|| format!("unparseable app version: {current}"))?;
    Ok(UpdateCheck {
        current_version: current.to_string(),
        latest_version: tag.trim_start_matches(['v', 'V']).to_string(),
        update_available: latest.is_newer_than(&current_version),
        release_url,
    })
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.to_string();
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("http client init: {e}"))?;
    let response = client
        .get(LATEST_RELEASE_URL)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("release request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("release request returned HTTP {}", status.as_u16()));
    }
    let release: Value = response
        .json()
        .await
        .map_err(|e| format!("release parse error: {e}"))?;
    build_check(&current, &release)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v(raw: &str) -> Version {
        Version::parse(raw).unwrap()
    }

    #[test]
    fn parses_tags_with_and_without_prefix() {
        assert_eq!(v("v0.8.0"), v("0.8.0"));
        assert_eq!(v("1.2.3+build.7"), v("1.2.3"));
        assert!(Version::parse("").is_none());
        assert!(Version::parse("latest").is_none());
        assert!(Version::parse("1.x").is_none());
    }

    #[test]
    fn orders_numerically_not_lexically() {
        assert!(v("0.10.0").is_newer_than(&v("0.9.0")));
        assert!(v("1.0.0").is_newer_than(&v("0.99.99")));
        assert!(v("0.8.1").is_newer_than(&v("0.8")));
        assert!(!v("0.8.0").is_newer_than(&v("0.8.0")));
        assert!(!v("0.7.9").is_newer_than(&v("0.8.0")));
    }

    #[test]
    fn pre_release_sorts_below_final() {
        assert!(v("0.9.0").is_newer_than(&v("0.9.0-beta.1")));
        assert!(!v("0.9.0-rc.1").is_newer_than(&v("0.9.0")));
        assert!(v("0.9.0-rc.1").is_newer_than(&v("0.8.0")));
    }

    #[test]
    fn builds_check_from_release_payload() {
        let release = json!({
            "tag_name": "v0.9.0",
            "html_url": "https://github.com/rafaelje/polakapi/releases/tag/v0.9.0"
        });
        let check = build_check("0.8.0", &release).unwrap();
        assert_eq!(
            check,
            UpdateCheck {
                current_version: "0.8.0".into(),
                latest_version: "0.9.0".into(),
                update_available: true,
                release_url: "https://github.com/rafaelje/polakapi/releases/tag/v0.9.0".into(),
            }
        );
        assert!(!build_check("0.9.0", &release).unwrap().update_available);
        assert!(!build_check("0.10.0", &release).unwrap().update_available);
    }

    #[test]
    fn rejects_payload_without_tag() {
        assert!(build_check("0.8.0", &json!({ "html_url": "x" })).is_err());
    }
}
