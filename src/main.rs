// File: /Users/davell/Documents/github/repopatch/src/main.rs
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
// Keep OpenOptions, needed for check_writable if that code is kept
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Write}; // Keep Write for Command stdin
use std::path::{Path, PathBuf};
use alphanumeric_sort::compare_str;
use rustls_pemfile::{certs, pkcs8_private_keys};
use tokio::fs as tokio_fs;
use rustls::ServerConfig;
use futures::stream::{self, StreamExt};
use patch::Patch; // Keep for parsing patch metadata like file paths
use std::process::Command; // Import Command

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

// --- New Structs for Patching ---
#[derive(Deserialize)]
struct ApplyPatchRequest {
    #[serde(rename = "directoryPath")]
    directory_path: String,
    #[serde(rename = "patchContent")]
    patch_content: String,
}
// --- End New Structs ---

// --- Struct for Writability Check (if keeping this feature) ---
#[derive(Deserialize)]
struct CheckWritableRequest {
    #[serde(rename = "directoryPath")]
    directory_path: String,
}
// --- End Struct for Writability Check ---


fn validate_path(requested_path: &str) -> Result<PathBuf, String> {
    // Use std::fs::canonicalize which requires the path to exist for the base directory
    // For paths *within* the patch, they might not exist yet.
    let base_path = PathBuf::from(requested_path);

    // Attempt to canonicalize the base path. If it fails, the base doesn't exist or isn't accessible.
    let resolved_path = base_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize base directory path '{}': {}", requested_path, e))?;

    // Add checks if needed, e.g., ensure it's not pointing somewhere unexpected.
    // For now, rely on canonicalization and later checks.
    Ok(resolved_path)
}

fn natural_compare(a: &str, b: &str) -> std::cmp::Ordering {
    compare_str(a, b)
}

// build_tree function remains the same as before...
fn build_tree(path: &Path, ig: &Gitignore) -> Result<HashMap<String, TreeNode>, String> {
    let mut tree = HashMap::new();
    let entries = fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;
    let mut dirents = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Directory entry error: {}", e))?;
        let entry_path = entry.path();
        // Use absolute path for ignore check if root is absolute
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
        // Canonicalize paths before storing? Might be slow. Store as received for now.
        // let entry_path_str = entry_path.canonicalize().unwrap_or(entry_path.clone()).to_string_lossy().to_string();
        let entry_path_str = entry_path.to_string_lossy().to_string();
        if entry_path.is_dir() {
            let sub_ig_path = entry_path.join(".gitignore");
            let (sub_ig, _) = if sub_ig_path.exists() {
                Gitignore::new(sub_ig_path)
            } else {
                (ig.clone(), None) // Inherit parent ignore rules
            };
            match build_tree(&entry_path, &sub_ig) {
                Ok(children) => {
                    if !children.is_empty() { // Only add folders if they contain non-ignored items
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


// get_directory function remains the same...
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
        (Gitignore::empty(), None) // No base ignore file found
    };

    match build_tree(&dir_path, &ig) {
        Ok(tree) => HttpResponse::Ok().json(json!({ "success": true, "tree": tree, "root": dir_path.to_string_lossy().to_string() })),
        Err(e) => HttpResponse::InternalServerError().json(json!({ "success": false, "error": e })),
    }
}


// get_file function remains the same...
#[get("/api/file")]
async fn get_file(query: web::Query<DirectoryQuery>) -> HttpResponse {
    let file_path_str = match query.path.as_ref() {
        Some(p) => p,
        None => return HttpResponse::BadRequest().json(json!({ "success": false, "error": "Path parameter is required" })),
    };
    // Validate the path for reading
     let file_path = match PathBuf::from(file_path_str).canonicalize() {
         Ok(p) => p,
         Err(e) => return HttpResponse::BadRequest().json(json!({ "success": false, "error": format!("Invalid file path '{}': {}", file_path_str, e)})),
     };

    // Basic security check (example): Ensure it's under a permitted root if needed
    // let allowed_root = PathBuf::from("/path/to/allowed/files").canonicalize().unwrap();
    // if !file_path.starts_with(&allowed_root) {
    //      return HttpResponse::Forbidden().json(json!({ "success": false, "error": "Access denied" }));
    // }

    if !file_path.is_file() {
        return HttpResponse::BadRequest().json(json!({ "success": false, "error": "Path is not a file" }));
    }


    match fs::read_to_string(&file_path) {
        Ok(content) => HttpResponse::Ok().json(json!({ "success": true, "content": content })),
        Err(e) => HttpResponse::InternalServerError().json(json!({ "success": false, "error": format!("Failed to read file: {}", e) })),
    }
}

// get_files_batch function remains the same...
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
             // Validate each path for reading
             let validated_path = match PathBuf::from(&path).canonicalize() {
                 Ok(p) => p,
                 // If canonicalize fails, it likely doesn't exist or isn't accessible
                 Err(e) => return (path, FileResult { success: false, content: None, error: Some(format!("Invalid path: {}", e)) }),
             };

            // Add security checks if necessary here

            if !validated_path.is_file() {
                 return (path, FileResult { success: false, content: None, error: Some("Path is not a file".to_string()) });
            }

            match tokio_fs::read_to_string(&validated_path).await {
                Ok(content) => (path.clone(), FileResult { success: true, content: Some(content), error: None }), // Clone path for return tuple
                Err(e) => (path.clone(), FileResult { success: false, content: None, error: Some(format!("Failed to read file: {}", e)) }), // Clone path
            }
        }
    }).buffer_unordered(concurrency_limit);

    while let Some((path, result)) = stream.next().await {
        results.insert(path, result);
    }

    HttpResponse::Ok().json(json!({ "success": true, "files": results }))
}

// check_writable function (if keeping this feature)
#[post("/api/check_writable")]
async fn check_writable(body: web::Json<CheckWritableRequest>) -> HttpResponse {
    let base_dir = match validate_path(&body.directory_path) {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(json!({
            "success": false,
            "writable": false, // Assume not writable if path validation fails
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

    // Construct path for a temporary test file
    let test_file_name = format!(".repopatch_writetest_{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0));
    let test_file_path = base_dir.join(&test_file_name);

    log::debug!("Attempting writability check in {:?} with file {:?}", base_dir, test_file_path);

    // Attempt to create the file
    match OpenOptions::new().write(true).create_new(true).open(&test_file_path) {
        Ok(_) => {
            // Creation successful, now attempt to delete it
            log::debug!("Writability test file created successfully: {:?}", test_file_path);
            match fs::remove_file(&test_file_path) {
                Ok(_) => {
                    log::debug!("Writability test file deleted successfully: {:?}", test_file_path);
                    HttpResponse::Ok().json(json!({ "success": true, "writable": true }))
                }
                Err(e) => {
                    // Failed to delete, this is unusual but indicates an issue
                    log::warn!("Failed to delete writability test file {:?}: {}", test_file_path, e);
                    HttpResponse::Ok().json(json!({
                        "success": true, // Request succeeded, but check failed
                        "writable": false,
                        "error": format!("Failed to delete temporary test file: {}", e)
                    }))
                }
            }
        }
        Err(e) => {
            // Failed to create the file, likely a permissions issue
            log::info!("Failed to create writability test file {:?}: {}", test_file_path, e);
            HttpResponse::Ok().json(json!({
                "success": true, // Request succeeded, but check failed
                "writable": false,
                "error": format!("Failed to create temporary test file (check permissions): {}", e)
            }))
        }
    }
}


#[post("/api/apply_patch")]
async fn apply_patch(body: web::Json<ApplyPatchRequest>) -> HttpResponse {
    let base_dir = match validate_path(&body.directory_path) {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(json!({ "success": false, "error": format!("Invalid directory path: {}", e) })),
    };

    if !base_dir.is_dir() {
        return HttpResponse::BadRequest().json(json!({ "success": false, "error": "Provided path is not a directory".to_string() }));
    }

    let patch_content = body.patch_content.clone();
    if patch_content.trim().is_empty() {
         return HttpResponse::BadRequest().json(json!({ "success": false, "error": "Patch content cannot be empty".to_string() }));
    }

    // --- Use command-line patch tool ---
    let mut cmd = Command::new("patch");
    cmd.arg("-p1"); // Assume -p1 stripping (common for git patches)
    cmd.arg("--verbose"); // Get more info on stderr maybe
    // cmd.arg("--dry-run"); // Uncomment for testing without applying changes
    cmd.current_dir(&base_dir); // Run the command *in* the target directory
    cmd.stdin(std::process::Stdio::piped()); // Pipe patch content to stdin
    cmd.stdout(std::process::Stdio::piped()); // Capture stdout
    cmd.stderr(std::process::Stdio::piped()); // Capture stderr

    log::info!("Attempting to apply patch in directory: {:?}", base_dir);
    log::debug!("Running command: patch -p1 --verbose");

    let mut child = match cmd.spawn() {
         Ok(child) => child,
         Err(e) => {
             log::error!("Failed to spawn patch command: {}", e);
             return HttpResponse::InternalServerError().json(json!({
                 "success": false,
                 "error": format!("Failed to execute patch command: {}. Is 'patch' installed and in PATH?", e)
             }));
         }
    };

     // Write patch content to stdin
     // Need to handle potential errors during write
     if let Some(mut stdin) = child.stdin.take() {
         if let Err(e) = stdin.write_all(patch_content.as_bytes()) {
              log::error!("Failed to write patch content to patch command stdin: {}", e);
              // Try to kill the process gracefully?
              let _ = child.kill();
              return HttpResponse::InternalServerError().json(json!({
                  "success": false,
                  "error": format!("Failed write to patch command stdin: {}", e)
              }));
         }
         // stdin is dropped here, closing the pipe
     } else {
         log::error!("Failed to get stdin handle for patch command");
          let _ = child.kill();
         return HttpResponse::InternalServerError().json(json!({
             "success": false,
             "error": "Failed to get stdin handle for patch command"
         }));
     }


     // Wait for the command to finish and capture output
     let output = match child.wait_with_output() {
         Ok(output) => output,
         Err(e) => {
             log::error!("Failed to wait for patch command: {}", e);
             return HttpResponse::InternalServerError().json(json!({
                 "success": false,
                 "error": format!("Failed to wait for patch command execution: {}", e)
             }));
         }
     };

     let stdout = String::from_utf8_lossy(&output.stdout).to_string();
     let stderr = String::from_utf8_lossy(&output.stderr).to_string();

     log::info!("Patch command finished with status: {:?}", output.status.code());
     log::debug!("Patch stdout:\n{}", stdout);
     log::debug!("Patch stderr:\n{}", stderr);


     // --- Process results ---
     let mut applied_files_list = Vec::new();
     let mut error_details = Vec::new();
     error_details.push(format!("Patch command exit code: {:?}", output.status.code()));
     if !stderr.is_empty() {
        error_details.push(format!("Stderr:\n{}", stderr));
     }
     if !stdout.is_empty() { // Include stdout in details as well for context
        error_details.push(format!("Stdout:\n{}", stdout));
     }


     if output.status.success() {
         // --- Parse patch *only on success* to get filenames ---
         // This avoids the panic if the patch content is malformed AND the external command failed
         match Patch::from_multiple(&patch_content) {
            Ok(parsed_patches) => {
                 for p in parsed_patches {
                     let file_name = if p.new.path == "/dev/null" {
                         format!("{} (deleted)", p.old.path.trim_start_matches("a/"))
                     } else {
                         p.new.path.trim_start_matches("b/").to_string()
                     };
                     applied_files_list.push(file_name);
                 }
            }
            Err(parse_err) => {
                // This case should be rarer now, but handle if parsing fails even after external command succeeded
                log::warn!("External patch command succeeded, but failed to re-parse patch content to list filenames: {}", parse_err);
                error_details.push(format!("Warning: Failed to list affected files due to patch parse error: {}", parse_err));
                // Proceed with success, but note the listing failure.
            }
         }

         // Check stderr for potential warnings even on success
         if !stderr.is_empty() && (stderr.contains("fail") || stderr.contains("error") || stderr.contains("reject") || stderr.contains("warning")) {
             log::warn!("Patch command succeeded but produced warnings/errors on stderr:\n{}", stderr);
             // Report success but include stderr as warnings/details
              HttpResponse::Ok().json(json!({
                   "success": true,
                   "message": "Patch applied successfully, but with warnings.",
                   "appliedFiles": applied_files_list,
                   "details": error_details // Include stdout/stderr/code
              }))
         } else {
            // Clean success
            HttpResponse::Ok().json(json!({
                "success": true,
                "message": "Patch applied successfully.",
                "appliedFiles": applied_files_list,
                "details": error_details // Include stdout/stderr/code
            }))
         }
     } else {
         // Command failed
         log::error!("Patch command failed. Status: {:?}, Stderr: {}", output.status.code(), stderr);
         // *Don't* try to parse the patch content here as it might panic
         // Report the failure based on the command output
         HttpResponse::InternalServerError().json(json!({
             "success": false,
             "error": "Patch command failed to apply.",
             "details": error_details, // Include stdout/stderr/code
             "appliedFiles": [] // No files were successfully applied if command failed
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


// Handler to serve embedded static files (remains the same)
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


// main function remains largely the same, just ensure check_writable service is added if needed
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
        // Allow specific origins
        for origin in &allowed_origins {
             log::debug!("Adding allowed origin: {}", origin);
             cors = cors.allowed_origin(origin);
        }
        // Or allow any origin if needed (less secure)
        // cors = cors.allow_any_origin();

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
            .service(apply_patch) // Ensure this service is included
            .service(check_writable) // Add the new service if keeping it
            .service(connect)
            .default_service(web::to(serve_asset))
    });

     if use_https {
         // HTTPS setup remains the same...
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
         // HTTP setup remains the same...
         log::info!("Starting HTTP server at http://0.0.0.0:{}", port);
         server.bind(("0.0.0.0", port))?
              .run()
              .await
     }
}