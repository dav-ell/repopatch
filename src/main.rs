use actix_cors::Cors;
use actix_web::{get, post, web, App, HttpResponse, HttpRequest, HttpServer};
use actix_web::http::header;
use rust_embed::RustEmbed;
use mime_guess;
use ignore::gitignore::Gitignore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use alphanumeric_sort::compare_str;
use rustls_pemfile::{certs, pkcs8_private_keys};
use tokio::fs as tokio_fs;
use rustls::ServerConfig;
use futures::stream::{self, StreamExt};
use diff_match_patch_rs::{DiffMatchPatch, Compat};

#[derive(RustEmbed)]
#[folder = "public/"]
struct Asset;

#[derive(Serialize)]
struct TreeNode {
    #[serde(rename = "type")]
    node_type: String,
    path: String,
    children: Option<HashMap<String, TreeNode>>,
}

#[derive(Deserialize)]
struct DirectoryQuery {
    path: Option<String>,
}

#[derive(Serialize)]
struct FileResult {
    success: bool,
    content: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct FilesRequest {
    paths: Vec<String>,
}

#[derive(Deserialize)]
struct ApplyPatchRequest {
    #[serde(rename = "directoryPath")]
    directory_path: String,
    #[serde(rename = "patchContent")]
    patch_content: String,
}

#[derive(Deserialize)]
struct CheckWritableRequest {
    #[serde(rename = "directoryPath")]
    directory_path: String,
}

fn validate_path(requested_path: &str) -> Result<PathBuf, String> {
    let base_path = PathBuf::from(requested_path);
    let resolved_path = base_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize base directory path '{}': {}", requested_path, e))?;
    Ok(resolved_path)
}

fn natural_compare(a: &str, b: &str) -> std::cmp::Ordering {
    compare_str(a, b)
}

fn build_tree(path: &Path, ig: &Gitignore) -> Result<HashMap<String, TreeNode>, String> {
    let mut tree = HashMap::new();
    let entries = fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;
    let mut dirents = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Directory entry error: {}", e))?;
        let entry_path = entry.path();
        let check_path = if entry_path.is_absolute() {
            entry_path.clone()
        } else {
            path.join(&entry_path)
        };
        if ig.matched(&check_path, entry_path.is_dir()).is_ignore() {
            continue;
        }
        dirents.push(entry);
    }

    dirents.sort_by(|a, b| {
        let a_is_dir = a.path().is_dir();
        let b_is_dir = b.path().is_dir();
        if a_is_dir && !b_is_dir {
            std::cmp::Ordering::Less
        } else if !a_is_dir && b_is_dir {
            std::cmp::Ordering::Greater
        } else {
            natural_compare(&a.file_name().to_string_lossy(), &b.file_name().to_string_lossy())
        }
    });

    for dirent in dirents {
        let entry_path = dirent.path();
        let name = dirent.file_name().to_string_lossy().to_string();
        let entry_path_str = entry_path.to_string_lossy().to_string();
        if entry_path.is_dir() {
            let sub_ig_path = entry_path.join(".gitignore");
            let (sub_ig, _) = if sub_ig_path.exists() {
                Gitignore::new(sub_ig_path)
            } else {
                (ig.clone(), None)
            };
            match build_tree(&entry_path, &sub_ig) {
                Ok(children) => {
                    if !children.is_empty() {
                        tree.insert(
                            name,
                            TreeNode {
                                node_type: "folder".to_string(),
                                path: entry_path_str,
                                children: Some(children),
                            },
                        );
                    }
                }
                Err(e) => {
                    log::warn!("Skipping directory {}: {}", entry_path_str, e);
                }
            }
        } else {
            tree.insert(
                name,
                TreeNode {
                    node_type: "file".to_string(),
                    path: entry_path_str,
                    children: None,
                },
            );
        }
    }
    Ok(tree)
}

#[get("/api/directory")]
async fn get_directory(query: web::Query<DirectoryQuery>) -> HttpResponse {
    let requested_path = query.path.clone().unwrap_or_else(|| env::current_dir().unwrap().to_string_lossy().to_string());
    let dir_path = match validate_path(&requested_path) {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(json!({ "success": false, "error": e })),
    };

    if !dir_path.is_dir() {
        return HttpResponse::BadRequest().json(json!({ "success": false, "error": "Provided path is not a directory" }));
    }

    let ig_path = dir_path.join(".gitignore");
    let (ig, _) = if ig_path.exists() {
        Gitignore::new(ig_path)
    } else {
        (Gitignore::empty(), None)
    };

    match build_tree(&dir_path, &ig) {
        Ok(tree) => HttpResponse::Ok().json(json!({ "success": true, "tree": tree, "root": dir_path.to_string_lossy().to_string() })),
        Err(e) => HttpResponse::InternalServerError().json(json!({ "success": false, "error": e })),
    }
}

#[get("/api/file")]
async fn get_file(query: web::Query<DirectoryQuery>) -> HttpResponse {
    let file_path_str = match query.path.as_ref() {
        Some(p) => p,
        None => return HttpResponse::BadRequest().json(json!({ "success": false, "error": "Path parameter is required" })),
    };
    let file_path = match PathBuf::from(file_path_str).canonicalize() {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(json!({ "success": false, "error": format!("Invalid file path '{}': {}", file_path_str, e)})),
    };

    if !file_path.is_file() {
        return HttpResponse::BadRequest().json(json!({ "success": false, "error": "Path is not a file" }));
    }

    match fs::read_to_string(&file_path) {
        Ok(content) => HttpResponse::Ok().json(json!({ "success": true, "content": content })),
        Err(e) => HttpResponse::InternalServerError().json(json!({ "success": false, "error": format!("Failed to read file: {}", e) })),
    }
}

#[post("/api/files")]
async fn get_files_batch(body: web::Json<FilesRequest>) -> HttpResponse {
    let paths = body.paths.clone();
    if paths.is_empty() {
        return HttpResponse::BadRequest().json(json!({ "success": false, "error": "Paths array is required and cannot be empty" }));
    }

    let concurrency_limit = 50;
    let mut results = HashMap::new();
    let mut stream = stream::iter(paths).map(|path| {
        async move {
            let validated_path = match PathBuf::from(&path).canonicalize() {
                Ok(p) => p,
                Err(e) => return (path, FileResult { success: false, content: None, error: Some(format!("Invalid path: {}", e)) }),
            };

            if !validated_path.is_file() {
                return (path, FileResult { success: false, content: None, error: Some("Path is not a file".to_string()) });
            }

            match tokio_fs::read_to_string(&validated_path).await {
                Ok(content) => (path.clone(), FileResult { success: true, content: Some(content), error: None }),
                Err(e) => (path.clone(), FileResult { success: false, content: None, error: Some(format!("Failed to read file: {}", e)) }),
            }
        }
    }).buffer_unordered(concurrency_limit);

    while let Some((path, result)) = stream.next().await {
        results.insert(path, result);
    }

    HttpResponse::Ok().json(json!({ "success": true, "files": results }))
}

#[post("/api/check_writable")]
async fn check_writable(body: web::Json<CheckWritableRequest>) -> HttpResponse {
    let base_dir = match validate_path(&body.directory_path) {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(json!({
            "success": false,
            "writable": false,
            "error": format!("Invalid directory path: {}", e)
        })),
    };

    if !base_dir.is_dir() {
        return HttpResponse::BadRequest().json(json!({
            "success": false,
            "writable": false,
            "error": "Provided path is not a directory".to_string()
        }));
    }

    let test_file_name = format!(".repopatch_writetest_{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0));
    let test_file_path = base_dir.join(&test_file_name);

    log::debug!("Attempting writability check in {:?} with file {:?}", base_dir, test_file_path);

    match OpenOptions::new().write(true).create_new(true).open(&test_file_path) {
        Ok(_) => {
            log::debug!("Writability test file created successfully: {:?}", test_file_path);
            match fs::remove_file(&test_file_path) {
                Ok(_) => {
                    log::debug!("Writability test file deleted successfully: {:?}", test_file_path);
                    HttpResponse::Ok().json(json!({ "success": true, "writable": true }))
                }
                Err(e) => {
                    log::warn!("Failed to delete writability test file {:?}: {}", test_file_path, e);
                    HttpResponse::Ok().json(json!({
                        "success": true,
                        "writable": false,
                        "error": format!("Failed to delete temporary test file: {}", e)
                    }))
                }
            }
        }
        Err(e) => {
            log::info!("Failed to create writability test file {:?}: {}", test_file_path, e);
            HttpResponse::Ok().json(json!({
                "success": true,
                "writable": false,
                "error": format!("Failed to create temporary test file (check permissions): {}", e)
            }))
        }
    }
}

// Helper function to split patch content into per-file patches
fn split_patch_content(patch_content: &str) -> Vec<(String, String, String)> {
    let lines: Vec<&str> = patch_content.lines().map(|l| l.trim_end()).collect();
    let mut patches = Vec::new();
    let mut current_old_path = None;
    let mut current_new_path = None;
    let mut current_patch_lines = Vec::new();

    for line in lines {
        if line.starts_with("--- ") {
            // Store previous patch if it exists and is valid
            if let (Some(old_path), Some(new_path)) = (current_old_path.take(), current_new_path.take()) {
                if !current_patch_lines.is_empty() {
                    let patch_text = current_patch_lines.join("\n");
                    log::debug!("Collected patch for old_path: {}, new_path: {}, lines: {}", old_path, new_path, current_patch_lines.len());
                    patches.push((old_path, new_path, patch_text));
                } else {
                    log::warn!("Skipping empty patch for old_path: {}", old_path);
                }
            }
            current_old_path = Some(line[4..].trim().to_string());
            current_new_path = None;
            current_patch_lines = vec![line.to_string()];
        } else if line.starts_with("+++ ") {
            if current_old_path.is_none() {
                log::warn!("Found +++ line without preceding --- line: {}", line);
                current_patch_lines.clear(); // Reset to avoid malformed patch
                continue;
            }
            current_new_path = Some(line[4..].trim().to_string());
            current_patch_lines.push(line.to_string());
        } else if !line.is_empty() || !current_patch_lines.is_empty() {
            // Include non-empty lines or empty lines after content has started
            current_patch_lines.push(line.to_string());
        }
    }

    // Store the final patch if valid
    if let (Some(old_path), Some(new_path)) = (current_old_path, current_new_path) {
        if !current_patch_lines.is_empty() {
            let patch_text = current_patch_lines.join("\n");
            log::debug!("Collected final patch for old_path: {}, new_path: {}, lines: {}", old_path, new_path, current_patch_lines.len());
            patches.push((old_path, new_path, patch_text));
        } else {
            log::warn!("Skipping empty final patch for old_path: {}", old_path);
        }
    }

    patches
}

// Helper function to strip path components (e.g., to match -p1 behavior)
fn strip_path(path: &str, strip_level: usize) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() > strip_level {
        parts[strip_level..].join("/")
    } else {
        path.to_string()
    }
}

#[post("/api/apply_patch")]
async fn apply_patch(body: web::Json<ApplyPatchRequest>) -> HttpResponse {
    let base_dir = match validate_path(&body.directory_path) {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(json!({ 
            "success": false, 
            "error": format!("Invalid directory path: {}", e),
            "appliedFiles": [],
            "details": []
        })),
    };

    if !base_dir.is_dir() {
        return HttpResponse::BadRequest().json(json!({ 
            "success": false, 
            "error": "Provided path is not a directory".to_string(),
            "appliedFiles": [],
            "details": []
        }));
    }

    let patch_content = body.patch_content.trim();
    if patch_content.is_empty() {
        return HttpResponse::BadRequest().json(json!({ 
            "success": false, 
            "error": "Patch content cannot be empty".to_string(),
            "appliedFiles": [],
            "details": []
        }));
    }

    // Initialize diff-match-patch
    let dmp = DiffMatchPatch::new();

    // Log patch application attempt
    log::info!("Applying patch to directory: {:?}", base_dir);
    log::debug!("Patch content length: {} bytes", patch_content.len());

    // Split patch content into per-file patches
    let file_patches = split_patch_content(patch_content);
    let mut applied_files = Vec::new();
    let mut details = Vec::new();

    for (old_path, new_path, patch_text) in file_patches {
        // Strip paths to match -p1 behavior
        let stripped_old_path = if old_path != "/dev/null" {
            strip_path(&old_path, 1)
        } else {
            "/dev/null".to_string()
        };
        let stripped_new_path = if new_path != "/dev/null" {
            strip_path(&new_path, 1)
        } else {
            "/dev/null".to_string()
        };

        // Determine the target file path
        let file_path = if stripped_old_path != "/dev/null" {
            stripped_old_path.clone()
        } else {
            stripped_new_path.clone()
        };
        let full_path = base_dir.join(&file_path);

        log::debug!("Processing patch for file: {}", file_path);

        if stripped_old_path == "/dev/null" {
            // New file creation
            match dmp.patch_from_text::<Compat>(&patch_text) {
                Ok(patches) => {
                    match dmp.patch_apply(&patches, "") {
                        Ok((new_content, applied)) => {
                            if applied.iter().all(|&b| b) {
                                if let Some(parent) = full_path.parent() {
                                    if let Err(e) = fs::create_dir_all(parent) {
                                        details.push(format!("Failed to create directory for {}: {}", file_path, e));
                                        continue;
                                    }
                                }
                                if let Err(e) = fs::write(&full_path, &new_content) {
                                    details.push(format!("Failed to write new file {}: {}", file_path, e));
                                } else {
                                    applied_files.push(file_path.clone());
                                    log::info!("Created new file: {}", file_path);
                                }
                                log::debug!("Finished applying patch for new file {}", file_path);
                            } else {
                                details.push(format!("Failed to apply patch for new file {}: partial application", file_path));
                            }
                        }
                        Err(e) => {
                            details.push(format!("Error applying patch for new file {}: {:?}", file_path, e));
                        }
                    }
                }
                Err(e) => {
                    let patch_snippet = if patch_text.len() > 100 {
                        format!("{}...", &patch_text[..100])
                    } else {
                        patch_text.clone()
                    };
                    details.push(format!("Failed to parse patch for new file {}: {:?}. Patch text: {}", file_path, e, patch_snippet));
                }
            }
        } else if stripped_new_path == "/dev/null" {
            // File deletion
            log::debug!("Attempting to delete file: {}", file_path);
            if full_path.exists() {
                log::debug!("File {} exists, proceeding with deletion.", file_path);
                if let Err(e) = fs::remove_file(&full_path) {
                    details.push(format!("Failed to delete file {}: {}", file_path, e));
                } else {
                    applied_files.push(file_path.clone());
                    log::info!("Deleted file: {}", file_path);
                }
            } else {
                log::warn!("File {} marked for deletion in patch, but it does not exist.", file_path);
                details.push(format!("File to delete does not exist: {}", file_path));
            }
        } else {
            // File modification
            log::debug!("Attempting to modify file: {}", file_path);
            log::trace!("Full path for modification: {:?}", full_path);
            if full_path.exists() {
                match fs::read_to_string(&full_path) {
                    Ok(original_content) => {
                        match dmp.patch_from_text::<Compat>(&patch_text) {
                            Ok(patches) => {
                                log::trace!("Parsed {} patch hunk(s) for file {}", patches.len(), file_path);
                                log::trace!("Attempting to apply parsed hunks to original content of {}", file_path);
                                match dmp.patch_apply(&patches, &original_content) {
                                    Ok((new_content, applied)) => {
                                        if applied.iter().all(|&b| b) {
                                            if let Err(e) = fs::write(&full_path, &new_content) {
                                                details.push(format!("Failed to write modified file {}: {}", file_path, e));
                                            } else {
                                                applied_files.push(file_path.clone());
                                                log::info!("Modified file: {}", file_path);
                                            }
                                            log::debug!("Successfully applied patch and wrote modifications for {}", file_path);
                                        } else {
                                            details.push(format!("Failed to apply patch for file {}: partial application", file_path));
                                            log::warn!("Partial patch application for file {}: {:?}", file_path, applied);
                                            log::trace!("Original content length: {}, New content length: {}", original_content.len(), new_content.len());
                                        }
                                    }
                                    Err(e) => {
                                        details.push(format!("Error applying patch for file {}: {:?}", file_path, e));
                                    }
                                }
                            }
                            Err(e) => {
                                let patch_snippet = if patch_text.len() > 100 {
                                    format!("{}...", &patch_text[..100])
                                } else {
                                    patch_text.clone()
                                };
                                details.push(format!("Failed to parse patch for file {}: {:?}. Patch text: {}", file_path, e, patch_snippet));
                            }
                        }
                    }
                    Err(e) => {
                        log::error!("Failed to read existing file {} for patching: {}", file_path, e);
                        details.push(format!("Failed to read file {}: {}", file_path, e));
                    }
                }
                log::debug!("Finished processing modification for file: {}", file_path);
            } else {
                log::warn!("File {} marked for modification in patch, but it does not exist.", file_path);
                details.push(format!("File to modify does not exist: {}", file_path));
            }
        }
    }

    // Construct response
    if details.is_empty() {
        log::info!("Patch applied successfully to {} files", applied_files.len());
        HttpResponse::Ok().json(json!({
            "success": true,
            "message": "Patch applied successfully.",
            "appliedFiles": applied_files,
            "details": []
        }))
    } else {
        log::warn!("Patch application completed with issues: {:?}", details);
        HttpResponse::InternalServerError().json(json!({
            "success": false,
            "error": "Patch application failed for some files.",
            "appliedFiles": applied_files,
            "details": details
        }))
    }
}

#[get("/api/connect")]
async fn connect(_req: HttpRequest) -> HttpResponse {
    let port = env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    HttpResponse::Ok().json(json!({
        "success": true,
        "status": "Server is running",
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "port": port
    }))
}

async fn serve_asset(req: HttpRequest) -> actix_web::Result<HttpResponse> {
    let path = if req.path() == "/" {
        "index.html"
    } else {
        req.path().trim_start_matches('/')
    };
    match Asset::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            Ok(HttpResponse::Ok()
                .content_type(mime.as_ref())
                .insert_header(("Cache-Control", "no-cache"))
                .body(content.data.into_owned()))
        }
        None => {
            match Asset::get("index.html") {
                Some(content) => Ok(HttpResponse::Ok()
                    .content_type("text/html")
                    .insert_header(("Cache-Control", "no-cache"))
                    .body(content.data.into_owned())),
                None => Ok(HttpResponse::NotFound().body("404 Not Found")),
            }
        }
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));
    dotenv::dotenv().ok();

    let port = env::var("PORT").unwrap_or_else(|_| "3000".to_string()).parse::<u16>().unwrap();
    let use_https = env::var("USE_HTTPS").unwrap_or_else(|_| "false".to_string()) == "true";
    let allowed_origins: Vec<String> = env::var("ALLOWED_ORIGINS")
        .unwrap_or_else(|_| "https://repoprompt.netlify.app,http://localhost:8080,http://127.0.0.1:8080".to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    log::info!("Allowed Origins: {:?}", allowed_origins);

    let server = HttpServer::new(move || {
        let mut cors = Cors::default();
        for origin in &allowed_origins {
            log::debug!("Adding allowed origin: {}", origin);
            cors = cors.allowed_origin(origin);
        }
        cors = cors
            .allowed_methods(vec!["GET", "POST", "OPTIONS"])
            .allowed_headers(vec![
                header::CONTENT_TYPE,
                header::AUTHORIZATION,
                header::ACCEPT,
                header::HeaderName::from_static("ngrok-skip-browser-warning"),
            ])
            .supports_credentials()
            .max_age(3600);

        App::new()
            .wrap(cors)
            .wrap(actix_web::middleware::Logger::default())
            .service(get_directory)
            .service(get_file)
            .service(get_files_batch)
            .service(apply_patch)
            .service(check_writable)
            .service(connect)
            .default_service(web::to(serve_asset))
    });

    if use_https {
        let cert_file = File::open("server.cert").expect("Failed to open server.cert");
        let key_file = File::open("server.key").expect("Failed to open server.key");

        let cert_chain: Result<Vec<rustls::pki_types::CertificateDer<'static>>, _> = certs(&mut BufReader::new(cert_file)).collect();
        let cert_chain = cert_chain.map_err(|e| format!("Failed to parse certificate: {}", e)).expect("Failed to parse certificate");

        let keys: Result<Vec<rustls::pki_types::PrivatePkcs8KeyDer<'static>>, _> = pkcs8_private_keys(&mut BufReader::new(key_file)).collect();
        let keys = keys.map_err(|e| format!("Failed to parse private key: {}", e)).expect("Failed to parse private key");
        let private_key = keys.into_iter().next().expect("No private key found");

        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(cert_chain, rustls::pki_types::PrivateKeyDer::Pkcs8(private_key))
            .expect("Failed to build TLS config");

        log::info!("Starting HTTPS server at https://0.0.0.0:{}", port);
        server.bind_rustls_0_23(("0.0.0.0", port), config)?
            .run()
            .await
    } else {
        log::info!("Starting HTTP server at http://0.0.0.0:{}", port);
        server.bind(("0.0.0.0", port))?
            .run()
            .await
    }
}