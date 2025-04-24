// File: /Users/davell/Documents/github/repoprompt/public/js/fileContent.js
// Manages file content fetching and potentially caching (though cache might be less useful for patching).

import { state } from './state.js';
// Removed getLanguage (use diff lib instead), removed utils dependency
import { tryFetchWithFallback } from './connection.js';
import { getUploadedFile } from './db.js'; // Needed for uploaded files

/**
 * Recursively retrieves all file node paths from a file tree structure.
 * Used to identify files within a directory structure (fetched or from upload).
 * @param {Object} tree - The file tree object.
 * @param {string} [currentPath=''] - Internal accumulator for the current path.
 * @returns {Array<string>} - Array of full file paths.
 */
export function getFilePathsFromTree(tree, currentPath = '') {
    let paths = [];
    if (!tree) return paths;

    for (let key in tree) {
        const node = tree[key];
        const nodePath = node.path || (currentPath ? `${currentPath}/${key}` : key); // Use explicit path if available

        if (node.type === "file") {
            paths.push(nodePath);
        } else if (node.type === "folder" && node.children) {
            paths = paths.concat(getFilePathsFromTree(node.children, nodePath));
        }
    }
    return paths;
}


/**
 * Fetches contents for a batch of file paths required by a patch.
 * Handles both server-based ('path') and uploaded ('uploaded') directories.
 * @param {number} dirId - The ID of the target directory.
 * @param {Array<string>} filePaths - Array of relative or absolute file paths needed.
 * @returns {Promise<Map<string, { content: string | null, error: string | null }>>} - Map where keys are file paths and values are objects containing content or error.
 */
export async function fetchPatchRequiredFiles(dirId, filePaths) {
    const results = new Map();
    state.failedFiles.clear(); // Clear previous failures

    const dir = state.directories.find(d => d.id === dirId);
    if (!dir) {
        console.error(`WorkspacePatchRequiredFiles: Directory with ID ${dirId} not found.`);
        filePaths.forEach(p => results.set(p, { content: null, error: 'Target directory not found' }));
        return results;
    }

    console.log(`Workspaceing contents for ${filePaths.length} files from directory ${dir.id} (${dir.type})`);

    if (dir.type === 'uploaded') {
        // Fetch from IndexedDB
        await Promise.all(filePaths.map(async (filePath) => {
            try {
                const content = await getUploadedFile(dir.id, filePath);
                if (content !== null) {
                    results.set(filePath, { content: content, error: null });
                    // console.log(`Workspaceed uploaded file ${filePath} successfully.`);
                } else {
                    // File might be mentioned in patch but not exist (e.g., deletion)
                    // Or it wasn't uploaded correctly. Treat as non-existent for preview.
                    results.set(filePath, { content: null, error: 'File not found in uploaded data (may be deleted by patch)' });
                     console.warn(`File ${filePath} not found in uploaded data for dir ${dir.id}.`);
                }
            } catch (error) {
                console.error(`Error fetching uploaded file ${filePath} for dir ${dir.id}:`, error);
                results.set(filePath, { content: null, error: `DB error: ${error.message}` });
                state.failedFiles.add(filePath);
            }
        }));
    } else if (dir.type === 'path') {
        // Fetch from server API (/api/files)
        // Ensure paths sent to backend are absolute based on dir.path
        const absolutePathsToFetch = filePaths.map(p => {
            // Naive join, assumes p is relative to dir.path. Needs improvement
            // if patch paths can be absolute or complex relative.
            // For now, assume patch paths are relative to the dir root.
             const potentialPath = PathUtils.join(dir.path, p);
             // console.log(`Mapping relative path ${p} to absolute ${potentialPath}`);
             return potentialPath;
             // TODO: Robust path joining needed here based on how patch paths are structured.
        });


        if (absolutePathsToFetch.length > 0) {
            try {
                const url = `${state.baseEndpoint}/api/files`;
                const response = await tryFetchWithFallback(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ paths: absolutePathsToFetch })
                });

                 if (!response.ok) {
                     const errorText = await response.text().catch(() => `HTTP ${response.status}`);
                     throw new Error(`Server error: ${response.status} - ${errorText.substring(0,100)}`);
                 }

                const data = await response.json();
                if (data.success && data.files) {
                     // Map results back to original relative paths
                    absolutePathsToFetch.forEach((absPath, index) => {
                        const relPath = filePaths[index]; // Get original relative path
                        const result = data.files[absPath];
                        if (result && result.success) {
                            results.set(relPath, { content: result.content, error: null });
                        } else {
                            // If the file wasn't found server-side, it might be ok (deletion patch)
                            // Or it could be an error. The patch library should handle this.
                            const errorMsg = result ? result.error : "File not found by server (may be deleted by patch)";
                             console.warn(`Server fetch issue for ${absPath} (relative: ${relPath}): ${errorMsg}`);
                             results.set(relPath, { content: null, error: errorMsg });
                            if(result && result.error && !errorMsg.includes("not found")) { // Only add actual errors to failedFiles
                                 state.failedFiles.add(relPath);
                            }
                        }
                    });

                     // Check for paths requested but not returned by server (shouldn't happen with current backend)
                    filePaths.forEach(relPath => {
                        if (!results.has(relPath)) {
                            console.warn(`Path ${relPath} requested but no result received from server.`);
                             results.set(relPath, { content: null, error: 'No response from server for this file.' });
                            state.failedFiles.add(relPath);
                        }
                    });

                } else {
                     const errorMsg = data.error || "Batch fetch failed with unknown server error";
                     console.error("Batch fetch failed:", errorMsg);
                     filePaths.forEach(p => {
                         results.set(p, { content: null, error: errorMsg });
                         state.failedFiles.add(p);
                     });
                }
            } catch (error) {
                console.error(`Batch fetch network/request error: ${error.message}`);
                filePaths.forEach(p => {
                    results.set(p, { content: null, error: `Network error: ${error.message}` });
                    state.failedFiles.add(p);
                });
            }
        }

    } else {
         console.error(`Unsupported directory type: ${dir.type}`);
          filePaths.forEach(p => {
             results.set(p, { content: null, error: `Unsupported directory type: ${dir.type}` });
             state.failedFiles.add(p);
         });
    }

    console.log(`Finished fetching files. Results count: ${results.size}. Failed count: ${state.failedFiles.size}`);
    return results;
}


// --- Helper for path joining (basic) ---
// Node.js 'path' module is not available in browser, so we need a simple polyfill or implementation
const PathUtils = {
    join: (...args) => {
        // Simple join, handles basic cases, might need refinement for complex paths like ../
        const parts = args.flatMap(part => part.split(/[\\/]/)).filter(Boolean);
        let result = parts[0] || '';
         if(args[0].startsWith('/')) result = '/' + result; // Preserve leading slash if present

        for (let i = 1; i < parts.length; i++) {
            result += '/' + parts[i];
        }
        // Normalize to remove // etc.
        return result.replace(/\/+/g, '/');
    }
};

// Removed getFileNodes (use getFilePathsFromTree instead)
// Removed fetchFileContent (single file fetch - use batch)