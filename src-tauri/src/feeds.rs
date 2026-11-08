use crate::game::{engine::Engine, transfer};
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

#[derive(Default)]
struct Cache {
    at: Option<Instant>,
    news: Value,
    silver: Value,
    status: Value,
}
#[derive(Default)]
pub struct Feeds {
    news: Mutex<Cache>,
    silver: Mutex<Cache>,
    status: Mutex<Cache>,
}
fn text<'a>(value: &'a Value, limit: usize) -> Result<&'a str> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.encode_utf16().count() <= limit && !s.contains('\0'))
        .context("Invalid notice text")
}
fn number(value: &Value) -> Result<u64> {
    value
        .as_u64()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .context("Invalid notice number")
}
pub fn plain_text(value: &str) -> String {
    let mut stripped = String::new();
    let mut remaining = value;
    while let Some(index) = remaining.find('<') {
        stripped.push_str(&remaining[..index]);
        remaining = &remaining[index..];
        if let Some(end) = remaining.find('>') {
            let tag = &remaining[1..end];
            let name = tag.strip_prefix('/').unwrap_or(tag);
            if tag == "/" || name.starts_with(|c: char| c.is_ascii_alphabetic()) {
                remaining = &remaining[end + 1..];
                continue;
            }
        }
        stripped.push('<');
        remaining = &remaining[1..];
    }
    stripped.push_str(remaining);
    let mut output = String::new();
    let mut remaining = stripped.as_str();
    while let Some(index) = remaining.find('&') {
        output.push_str(&remaining[..index]);
        remaining = &remaining[index..];
        if let Some(end) = remaining.find(';').filter(|n| *n < 16) {
            let entity = &remaining[1..end];
            let decoded = match entity.to_ascii_lowercase().as_str() {
                "lt" => Some('<'),
                "gt" => Some('>'),
                "amp" => Some('&'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                _ => {
                    let number = entity
                        .strip_prefix("#x")
                        .or_else(|| entity.strip_prefix("#X"))
                        .and_then(|s| u32::from_str_radix(s, 16).ok())
                        .or_else(|| entity.strip_prefix('#').and_then(|s| s.parse().ok()));
                    number.filter(|n| *n > 0).and_then(char::from_u32)
                }
            };
            if let Some(c) = decoded {
                output.push(c);
                remaining = &remaining[end + 1..];
                continue;
            }
        }
        output.push('&');
        remaining = &remaining[1..];
    }
    output.push_str(remaining);
    output
}
pub fn parse_silver(body: &Value) -> Result<Vec<Value>> {
    if body["code"] != 0 {
        bail!("Notice service unavailable.")
    }
    let rows = body["ret"]["data"]
        .as_array()
        .filter(|a| a.len() <= 64)
        .context("Invalid notice list")?;
    let mut ids = HashSet::new();
    let mut output = Vec::new();
    for row in rows {
        let id = number(&row["noticeId"])?;
        let kind = number(&row["noticeType"])?;
        if id == 0 || !ids.insert(id) || ![1, 2].contains(&kind) {
            bail!("Invalid notice identity.")
        }
        let deleted = number(row.get("isDelete").unwrap_or(&json!(0)))?;
        let starts = number(row.get("pushTime").unwrap_or(&json!(0)))?;
        let ends = number(row.get("endTime").unwrap_or(&json!(0)))?;
        if deleted > 1 || ends != 0 && ends <= starts {
            bail!("Invalid notice schedule.")
        }
        let rows = row["contentList"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 16)
            .context("Invalid notice translations")?;
        let mut languages = HashSet::new();
        let mut translations = Vec::new();
        for row in rows {
            let language = text(&row["languageType"], 32)?;
            if !languages.insert(language) {
                bail!("Duplicate notice translation.")
            }
            translations.push(json!({"language":language,"title":text(&row["longTitle"],200)?,"shortTitle":text(&row["shortTitle"],100)?,"content":plain_text(text(&row["noticeContent"],32000)?)}));
        }
        if deleted == 1 {
            continue;
        }
        output.push(json!({"id":id,"category":if kind==2{"event"}else{"news"},"createdAt":number(row.get("createTime").unwrap_or(&json!(0)))?,"startsAt":starts,"endsAt":ends,"priority":number(row.get("priority").unwrap_or(&json!(0)))?,"translations":translations,"imagePath":row["launcherImage"]}));
    }
    output.sort_by_key(|v| {
        std::cmp::Reverse((
            v["priority"].as_u64(),
            v["createdAt"].as_u64(),
            v["id"].as_u64(),
        ))
    });
    Ok(output)
}
fn visible(mut feed: Value) -> Value {
    let now = chrono::Utc::now().timestamp_millis().max(0) as u64;
    if let Some(items) = feed["items"].as_array_mut() {
        items.retain(|v| {
            v["startsAt"].as_u64().unwrap_or(0) <= now
                && (v["endsAt"] == 0 || v["endsAt"].as_u64().unwrap_or(0) > now)
        });
    }
    feed
}
fn image_path(path: &str) -> bool {
    let Some(name) = path.strip_prefix("/notice-images/") else {
        return false;
    };
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && stem.len() <= 96
        && (stem.as_bytes()[0].is_ascii_lowercase() || stem.as_bytes()[0].is_ascii_digit())
        && stem
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
        && ["webp", "png", "jpg", "jpeg"].contains(&ext)
}
async fn fetch_silver(engine: &Engine) -> Result<Value> {
    let mut config = engine.resources.join("game-runtime/launcher-services.json");
    if !config.is_file() {
        config = engine
            .resources
            .join("resources/game-runtime/launcher-services.json");
    }
    #[cfg(debug_assertions)]
    if !config.is_file() {
        config = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../build/native/cedar/launcher-services.json");
    }
    if std::fs::metadata(&config)?.len() > 16384 {
        bail!("Invalid notice configuration.")
    }
    let config: Value = serde_json::from_slice(&tokio::fs::read(config).await?)?;
    if config["version"] != 1 {
        bail!("Invalid notice configuration.")
    }
    let mut url = transfer::validate_url(text(&config["notices"], 2048)?)?;
    if url.scheme() != "https" {
        bail!("Invalid notice configuration.")
    }
    url.query_pairs_mut().append_pair("client", "tia");
    let response = engine
        .client
        .get(url.clone())
        .timeout(Duration::from_secs(8))
        .send()
        .await?
        .error_for_status()?;
    let body: Value = serde_json::from_slice(&transfer::bounded_body(response, 256 * 1024).await?)?;
    let mut items = parse_silver(&body)?;
    let mut images = std::collections::HashMap::new();
    let mut total = 0;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    for item in &mut items {
        if let Some(path) = item["imagePath"]
            .as_str()
            .filter(|p| image_path(p))
            .map(String::from)
        {
            if !images.contains_key(&path) && images.len() < 8 {
                let image = async {
                    let response = client
                        .get(url.join(&path)?)
                        .timeout(Duration::from_secs(5))
                        .send()
                        .await?
                        .error_for_status()?;
                    let mime = response
                        .headers()
                        .get("content-type")
                        .and_then(|h| h.to_str().ok())
                        .unwrap_or("")
                        .split(';')
                        .next()
                        .unwrap_or("")
                        .to_owned();
                    let bytes = transfer::bounded_body(response, 2 * 1024 * 1024).await?;
                    let valid = match mime.as_str() {
                        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
                        "image/webp" => {
                            bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP")
                        }
                        _ => false,
                    };
                    total += bytes.len();
                    if !valid || total > 8 * 1024 * 1024 {
                        bail!("Invalid notice image.")
                    }
                    Ok::<_, anyhow::Error>(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
                }
                .await
                .ok();
                images.insert(path.clone(), image);
            }
            if let Some(Some(image)) = images.get(&path) {
                item["image"] = json!(image)
            }
        }
        item.as_object_mut().unwrap().remove("imagePath");
    }
    Ok(json!({"items":items,"available":true,"stale":false}))
}
impl Feeds {
    pub async fn news(&self, engine: &Engine) -> Value {
        let mut cache = self.news.lock().await;
        if cache
            .at
            .is_some_and(|at| at.elapsed() < Duration::from_secs(900))
        {
            return cache.news.clone();
        }
        let result = async {
            let response = engine
                .client
                .get("https://cso-rse.my.id/api/v1/news?method=apiv1")
                .timeout(Duration::from_secs(15))
                .send()
                .await?
                .error_for_status()?;
            let body: Value =
                serde_json::from_slice(&transfer::bounded_body(response, 2 * 1024 * 1024).await?)?;
            let rows = body["data"]["news"]
                .as_array()
                .filter(|a| a.len() <= 256)
                .context("Invalid news list")?;
            if body["success"] != true {
                bail!("News unavailable.")
            }
            for row in rows {
                number(&row["id"])?;
                for field in ["title", "slug", "category", "image", "created_at"] {
                    text(&row[field], 4096)?;
                }
            }
            Ok::<_, anyhow::Error>(json!(rows))
        }
        .await;
        if let Ok(news) = result {
            cache.news = news
        }
        if cache.news.is_null() {
            cache.news = json!([])
        }
        cache.at = Some(Instant::now());
        cache.news.clone()
    }
    pub async fn silver(&self, engine: &Engine) -> Value {
        let mut cache = self.silver.lock().await;
        if cache
            .at
            .is_some_and(|at| at.elapsed() < Duration::from_secs(900))
        {
            return visible(cache.silver.clone());
        }
        match fetch_silver(engine).await {
            Ok(value) => cache.silver = value,
            Err(_) => {
                if cache.silver.is_null() {
                    cache.silver = json!({"items":[],"available":false,"stale":false})
                } else {
                    cache.silver["stale"] = cache.silver["available"].clone()
                }
            }
        }
        cache.at = Some(Instant::now());
        visible(cache.silver.clone())
    }
    pub async fn status(&self, engine: &Engine, command: &str) -> Value {
        let unknown = json!({"status":"unknown","checkedAt":null});
        if custom_server(command) {
            return json!({"status":"custom","checkedAt":null});
        }
        let mut cache = self.status.lock().await;
        if cache
            .at
            .is_some_and(|at| at.elapsed() < Duration::from_secs(10))
        {
            return cache.status.clone();
        }
        let result = async {
            let response = engine
                .client
                .get(format!(
                    "{}/api/game_status",
                    engine.api.trim_end_matches('/')
                ))
                .timeout(Duration::from_secs(8))
                .header("Cache-Control", "no-store")
                .send()
                .await?
                .error_for_status()?;
            let value: Value =
                serde_json::from_slice(&transfer::bounded_body(response, 16384).await?)?;
            let at = chrono::DateTime::parse_from_rfc3339(
                value["checkedAt"].as_str().context("Invalid status time")?,
            )?;
            if !matches!(
                value["status"].as_str(),
                Some("online" | "maintenance" | "unknown")
            ) || (chrono::Utc::now().timestamp_millis() - at.timestamp_millis()).unsigned_abs()
                > 60_000
            {
                bail!("Invalid server status.")
            }
            Ok::<_, anyhow::Error>(json!({"status":value["status"],"checkedAt":value["checkedAt"]}))
        }
        .await;
        cache.status = result.unwrap_or(unknown);
        cache.at = Some(Instant::now());
        cache.status.clone()
    }
}
pub fn custom_server(command: &str) -> bool {
    let Ok((args, wrapper)) =
        crate::game::launch::client_args("", &json!({"launchCommand":command}))
    else {
        return false;
    };
    if wrapper.is_some() {
        return false;
    }
    args.windows(2).any(|pair| match pair[0].as_str() {
        "-ip" => {
            !pair[1].is_empty()
                && !pair[1].starts_with('-')
                && pair[1]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".:[]_-".contains(&b))
        }
        "-port" => {
            pair[1].bytes().all(|b| b.is_ascii_digit())
                && pair[1].parse::<u16>().is_ok_and(|n| n > 0)
        }
        _ => false,
    })
}
