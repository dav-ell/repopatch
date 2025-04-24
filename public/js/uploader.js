// public/js/uploader.js
// Handles the uploading and processing of a zip file or folder containing a directory.
// Uses JSZip (loaded from the CDN) to unzip and build a file tree with file contents for zip uploads,
// and uses the browser File API for folder uploads. Stores contents in IndexedDB.

import { state, saveStateToLocalStorage } from './state.js';
// Removed: renderFileExplorer, updateXMLPreview
import { isTextFile } from './utils.js'; // Keep isTextFile
import { putUploadedFile, clearAllUploadedFiles, clearUploadedFilesForDir } from './db.js'; // Use clearUploadedFilesForDir

/**
 * Handles the uploaded zip file.
 * @param {File} file - The uploaded zip file.
 * @param {number} dirId - The assigned ID for this new directory.
 */
export async function handleZipUpload(file, dirId) {
    const dir = state.directories.find(d => d.id === dirId);
    if (!dir) {
        console.error(`handleZipUpload: Directory with ID ${dirId} not found.`);
        alert(`Error: Could not find state for uploaded directory ${dirId}.`);
        return;
    }
    console.log(`Processing ZIP upload for dir ${dirId}: ${file.name}`);
    try {
        const zip = await JSZip.loadAsync(file);
        const { tree, files: fileContents } = await buildTreeFromZip(zip);
        dir.tree = tree;
        dir.name = file.name.replace(/\.zip$/i, ''); // Use zip name as dir name
        delete dir.error;

        // Clear previous content *for this dirId* before adding new ones
        await clearUploadedFilesForDir(dir.id);

        let storedCount = 0;
        for (const [filePath, content] of Object.entries(fileContents)) {
            // No need to check isTextFile here, buildTreeFromZip already filters
            await putUploadedFile(dir.id, filePath, content);
            storedCount++;
        }
        console.log(`Stored ${storedCount} text files from ZIP for dir ${dirId}.`);

        // Update state persistence (without UI updates)
        await saveStateToLocalStorage();
        console.log(`ZIP Upload processed for dir ${dirId}. State saved.`);

    } catch (err) {
        console.error(`Error processing zip file for dir ${dirId}: `, err);
        dir.error = `Failed to process zip file: ${err.message}`;
        dir.tree = {}; // Clear tree on error
        await saveStateToLocalStorage(); // Save error state
        alert(`Failed to process zip file "${file.name}": ${err.message}`);
    }
}

/**
 * Builds a file tree and file content dictionary from the loaded zip.
 * Only includes text files recognized by isTextFile.
 * @param {JSZip} zip - The loaded zip object.
 * @returns {Promise<{tree: object, files: object}>} - An object containing the file tree and files dictionary.
 */
async function buildTreeFromZip(zip) {
    const tree = {};
    const files = {}; // Mapping from file path to file content
    const fileEntries = Object.values(zip.files);

    // Sort entries to process directories before files within them (helps tree building)
    fileEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const fileObj of fileEntries) {
         // Skip mac metadata files/folders
        if (fileObj.name.startsWith('__MACOSX/')) {
            continue;
        }
        // Standardize path separators
        const filePath = fileObj.name.replace(/\\/g, '/');
        // Skip empty directory entries if they end with /
        if (fileObj.dir || filePath.endsWith('/')) {
             // Optionally create structure for empty dirs if needed by addToTree logic
             // addToTree(tree, filePath.endsWith('/') ? filePath.slice(0, -1) : filePath, true);
             continue; // Skip processing folders directly, structure built from file paths
        }

        // Only process text files
        if (!isTextFile(filePath)) {
            // console.log(`Skipping non-text file (zip): ${filePath}`);
            continue;
        }

        // For files, add to tree and extract content
        addToTree(tree, filePath, false); // Add file path to tree
        try {
            const content = await fileObj.async("string"); // Use string directly
             // Basic check for binary-like content (optional)
             // if (content.includes('\uFFFD') && content.length > 100) { // Check for replacement character
             //    console.warn(`File ${filePath} might be binary despite extension, skipping content storage.`);
             //    continue;
             // }
            files[filePath] = content;
        } catch (err) {
            console.warn(`Could not read content as text for ${filePath}: ${err.message}`);
            // Decide how to handle: skip file, add empty content? Skip for now.
        }
    }
     // console.log("Built tree from zip:", tree);
     // console.log("Extracted files from zip:", Object.keys(files));
    return { tree, files };
}


/**
 * Adds a file or directory path to the tree structure.
 * Ensures parent directories exist in the structure.
 * @param {Object} tree - The current tree structure.
 * @param {string} filePath - The full file path from the zip/folder.
 * @param {boolean} isDir - Flag indicating whether the entry is a directory (less used now).
 */
function addToTree(tree, filePath, isDir = false) { // isDir defaults to false
    const parts = filePath.split('/').filter(Boolean); // Filter empty parts from leading/trailing/double slashes
    let current = tree;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const currentPath = parts.slice(0, i + 1).join('/'); // Path up to this part

        if (i === parts.length - 1) {
            // Last part: it's the file (or directory if isDir was true)
            if (!isDir) {
                if (!current[part]) { // Avoid overwriting if a folder with same name was implicitly created
                    current[part] = { type: "file", path: filePath };
                } else if (current[part].type !== "folder") {
                     // If something exists but isn't a folder, overwrite (should be rare)
                     current[part] = { type: "file", path: filePath };
                } else {
                     // Exists as a folder, log conflict?
                     console.warn(`File path conflicts with existing folder structure: ${filePath}`);
                }
            } else {
                 // If isDir is true (less common now)
                 if (!current[part]) {
                     current[part] = { type: "folder", path: filePath, children: {} };
                 } // Don't overwrite existing file/folder
            }
        } else {
            // Intermediate part: ensure the folder exists
            if (!current[part]) {
                // Create the folder node
                current[part] = { type: "folder", path: currentPath, children: {} };
                current = current[part].children;
            } else if (current[part].type === "folder") {
                // Folder already exists, move into its children
                 // Ensure children object exists
                 current[part].children = current[part].children || {};
                current = current[part].children;
            } else {
                // Path conflict: a file exists where a directory is needed
                console.error(`Path conflict: trying to create directory part '${part}' but a file exists at '${currentPath}'. Skipping subtree.`);
                // Cannot continue down this path
                return;
            }
        }
    }
}


/**
 * Handles the uploaded folder.
 * @param {FileList} fileList - List of files selected from the folder.
 * @param {number} dirId - The assigned ID for this new directory.
 */
export async function handleFolderUpload(fileList, dirId) {
    const dir = state.directories.find(d => d.id === dirId);
     if (!dir) {
         console.error(`handleFolderUpload: Directory with ID ${dirId} not found.`);
         alert(`Error: Could not find state for uploaded directory ${dirId}.`);
         return;
     }
    console.log(`Processing Folder upload for dir ${dirId}. Files count: ${fileList.length}`);
    try {
        const { tree, files: fileContents, baseFolder } = await buildTreeFromFolder(fileList);
        dir.tree = tree;
        dir.name = baseFolder || `folder-${dir.id}`; // Use detected base folder name
        delete dir.error;

        // Clear previous content for this dirId before adding new ones
        await clearUploadedFilesForDir(dir.id);

        let storedCount = 0;
        for (const [relativePath, content] of Object.entries(fileContents)) {
            // No need to check isTextFile here, buildTreeFromFolder already filters
            await putUploadedFile(dir.id, relativePath, content);
            storedCount++;
        }
        console.log(`Stored ${storedCount} text files from Folder for dir ${dirId}.`);

        // Update state persistence (without UI updates)
        await saveStateToLocalStorage();
         console.log(`Folder Upload processed for dir ${dirId}. State saved.`);

    } catch (err) {
        console.error(`Error processing folder upload for dir ${dirId}: `, err);
        dir.error = `Failed to process folder upload: ${err.message}`;
        dir.tree = {}; // Clear tree on error
        await saveStateToLocalStorage(); // Save error state
        alert(`Failed to process folder upload: ${err.message}`);
    }
}

/**
 * Builds a file tree and file content dictionary from the selected folder.
 * Only text files are included. Paths are stored relative to the base folder.
 * @param {FileList} fileList - The FileList from the folder upload input.
 * @returns {Promise<{tree: object, files: object, baseFolder: string}>} - Object containing tree, files map, base folder name.
 */
async function buildTreeFromFolder(fileList) {
    const tree = {};
    const files = {}; // relativePath: content
    let baseFolder = "";
    const fileArray = Array.from(fileList);

    if (fileArray.length === 0) {
        return { tree, files, baseFolder };
    }

    // Determine base folder from the first file's webkitRelativePath
    const firstPath = fileArray[0].webkitRelativePath;
    const firstParts = firstPath.split('/');
    baseFolder = firstParts.length > 1 ? firstParts[0] : "";
     console.log(`Determined base folder: '${baseFolder}'`);

    // Process each file
    for (const file of fileArray) {
        // webkitRelativePath includes the base folder, e.g., "baseFolder/sub/file.txt"
        const fullRelativePath = file.webkitRelativePath.replace(/\\/g, '/');

         // Skip non-text files
        if (!isTextFile(fullRelativePath)) {
             // console.log(`Skipping non-text file (folder): ${fullRelativePath}`);
            continue;
        }

        // Get path relative to the base folder
        let relativePath = fullRelativePath;
        if (baseFolder && fullRelativePath.startsWith(baseFolder + '/')) {
            relativePath = fullRelativePath.substring(baseFolder.length + 1);
        } else if (baseFolder === "" && firstParts.length === 1) {
             // Handle case where files are directly in the selected root (no base folder prefix)
             relativePath = fullRelativePath;
        } else if (baseFolder && !fullRelativePath.startsWith(baseFolder + '/')) {
             // Should not happen if webkitdirectory is consistent, but handle defensively
             console.warn(`File path ${fullRelativePath} does not start with detected base folder ${baseFolder}. Using full path as key.`);
             relativePath = fullRelativePath; // Use the full path as the key in this edge case
        }


         if (!relativePath) {
             console.warn(`Skipping file with empty relative path: ${file.name}`);
             continue; // Skip files that end up with no relative path (e.g., base folder itself selected?)
         }

        // Add to tree structure using the path relative *within* the base folder
        addToTree(tree, relativePath, false);

        // Read content and store using the same relative path key
        try {
            const content = await file.text();
            // Optional: Check for binary content?
            files[relativePath] = content;
        } catch (err) {
            console.warn(`Could not read content for ${relativePath}: ${err.message}`);
            // Skip storing content for this file
        }
    }

    // console.log("Built tree from folder:", tree);
    // console.log("Extracted files from folder:", Object.keys(files));
    return { tree, files, baseFolder };
}

// Removed addToTreeFromFolder as addToTree is now generic enough