// public/js/patcher.js
// Handles parsing patch files, generating previews, and initiating patch application.

import { state, saveStateToLocalStorage } from './state.js';
import { fetchPatchRequiredFiles } from './fileContent.js';
import { tryFetchWithFallback } from './connection.js';

const applyStatusEl = document.getElementById('apply-status');
const previewStatusEl = document.getElementById('preview-status');
const patchPreviewEl = document.getElementById('patch-preview');
const applyButton = document.getElementById('apply-patch-btn');

/**
 * Parses the patch content and identifies required file paths.
 * Uses jsdiff's parsePatch method.
 * @param {string} patchContent - The content of the patch file.
 * @returns {Array<object> | null} - Array of parsed patch objects (from jsdiff) or null on error.
 */
function parsePatch(patchContent) {
    try {
        // jsdiff can parse multi-file patches
        const patches = Diff.parsePatch(patchContent);
        if (!patches || patches.length === 0) {
             if (patchContent.trim()) { // If input wasn't empty but parsing failed
                 console.error("jsdiff couldn't parse the provided patch content.");
                 setStatus(previewStatusEl, 'Error: Invalid patch format.', true);
             } else {
                 setStatus(previewStatusEl, ''); // Clear status if input is empty
             }
            return null;
        }
         // Simple validation: check if essential properties exist
         if (!patches[0].oldFileName || !patches[0].newFileName || !Array.isArray(patches[0].hunks)) {
            console.error("Parsed patch object seems invalid (missing key properties).");
            setStatus(previewStatusEl, 'Error: Parsed patch structure invalid.', true);
            return null;
         }
        console.log(`Parsed ${patches.length} file patch(es).`);
        return patches;
    } catch (e) {
        console.error("Error parsing patch with jsdiff:", e);
         setStatus(previewStatusEl, `Error parsing patch: ${e.message}`, true);
        return null;
    }
}

/**
 * Generates an HTML preview of the patch application.
 * Fetches original file content and simulates applying the patch.
 * Highlights added/removed lines.
 * @param {string} patchContent - The content from the patch input textarea.
 */
export async function generatePatchPreview(patchContent) {
     clearPreview(); // Clear previous preview and status
    if (!patchContent.trim()) {
         setStatus(previewStatusEl, 'Paste patch content to see preview.');
        return;
    }
     if (!state.selectedDirectoryId) {
         setStatus(previewStatusEl, 'Select a project source first.', true);
         return;
     }

    const dir = state.directories.find(d => d.id === state.selectedDirectoryId);
     if (!dir) {
          setStatus(previewStatusEl, 'Selected project source not found.', true);
          return;
     }
     if (dir.error) {
         setStatus(previewStatusEl, `Cannot preview: Source has error - ${dir.error}`, true);
         return;
     }


    setStatus(previewStatusEl, 'Parsing patch...');
    const parsedPatches = parsePatch(patchContent);

    if (!parsedPatches) {
        // parsePatch sets the error status
        return;
    }

    // --- Identify required files ---
    // Paths in unified diff are typically relative to the repo root.
    // We need to fetch content based on these paths relative to the selected directory source.
    const requiredFilesRelative = new Set();
    parsedPatches.forEach(patch => {
         // Use oldFileName as the reference for fetching, handle /dev/null for new files
        if (patch.oldFileName && patch.oldFileName !== '/dev/null') {
            // Strip standard prefixes like 'a/' or 'b/' if present
             const path = patch.oldFileName.startsWith('a/') ? patch.oldFileName.substring(2) : patch.oldFileName;
             requiredFilesRelative.add(path);
        }
         // Although we apply patch based on old file, new file name might be needed for context or rename logic
         if (patch.newFileName && patch.newFileName !== '/dev/null') {
             const path = patch.newFileName.startsWith('b/') ? patch.newFileName.substring(2) : patch.newFileName;
             // If the path is different from old, maybe add it? For now, rely on oldFileName fetch.
             // requiredFilesRelative.add(path);
         }
    });

    if (requiredFilesRelative.size === 0) {
        setStatus(previewStatusEl, 'Patch seems empty or only affects /dev/null.', true);
        return;
    }

    // --- Fetch file contents ---
     setStatus(previewStatusEl, `Workspaceing ${requiredFilesRelative.size} file(s)...`);
    const fetchedFiles = await fetchPatchRequiredFiles(state.selectedDirectoryId, Array.from(requiredFilesRelative));
     setStatus(previewStatusEl, 'Generating preview...');

    // --- Generate HTML Preview ---
    let previewHTML = '';
    let filesWithErrors = [];

    for (const patch of parsedPatches) {
        const oldRelPath = patch.oldFileName?.startsWith('a/') ? patch.oldFileName.substring(2) : patch.oldFileName;
         const newRelPath = patch.newFileName?.startsWith('b/') ? patch.newFileName.substring(2) : patch.newFileName;

         const fileKey = (oldRelPath && oldRelPath !== '/dev/null') ? oldRelPath : newRelPath; // Use old path first for lookup
         const fileData = fetchedFiles.get(fileKey);

        // --- File Header ---
        previewHTML += `<div class="diff-file-header">`;
        previewHTML += `<strong>File: ${fileKey}</strong>`;
         if (fileData?.error && !fileData.error.includes('not found')) { // Show errors clearly, ignore simple not found
             previewHTML += ` <span class="diff-error">(Error: ${fileData.error})</span>`;
             filesWithErrors.push(fileKey);
         } else if (!fileData || fileData.content === null) {
              if (patch.oldFileName === '/dev/null' || patch.newFileName === '/dev/null') {
                  // Expected for new/deleted files
                   previewHTML += ` <span class="diff-info">(${patch.newFileName === '/dev/null' ? 'Deletion' : 'New File'})</span>`;
              } else {
                  previewHTML += ` <span class="diff-warning">(Original not found - assuming empty)</span>`;
              }
         }
        previewHTML += `</div>\n`;

        // --- Hunks ---
        if (!patch.hunks || patch.hunks.length === 0) {
             previewHTML += `<div class="diff-info">  (No content changes in patch)</div>\n`;
             continue;
         }

        patch.hunks.forEach((hunk, hunkIndex) => {
            // Hunk header
            previewHTML += `<span class="diff-header">${hunk.header || `@@ Hunk ${hunkIndex + 1} @@`}</span>\n`;

            // Hunk lines
             if (!Array.isArray(hunk.lines)) {
                 previewHTML += `<span class="diff-error">  Error: Invalid hunk lines format.</span>\n`;
                 return; // Skip invalid hunk
             }

            hunk.lines.forEach(line => {
                const lineContent = escapeHtml(line.substring(1)); // Remove +,-,' ' prefix and escape
                const prefix = line.charAt(0);

                switch (prefix) {
                    case '+':
                        previewHTML += `<span class="diff-added">+ ${lineContent}</span>\n`;
                        break;
                    case '-':
                        previewHTML += `<span class="diff-removed">- ${lineContent}</span>\n`;
                        break;
                    case ' ':
                        previewHTML += `<span class="diff-context">  ${lineContent}</span>\n`;
                        break;
                     case '\\': // Handle "\ No newline at end of file"
                         previewHTML += `<span class="diff-context">${escapeHtml(line)}</span>\n`;
                         break;
                    default:
                        // Should not happen with valid patches
                        previewHTML += `<span class="diff-context">${escapeHtml(line)}</span>\n`;
                        break;
                }
            });
        });
         previewHTML += '\n'; // Add space between files
    }

    patchPreviewEl.innerHTML = previewHTML;

    // Update final status
     if (filesWithErrors.length > 0) {
         setStatus(previewStatusEl, `Preview generated with errors in ${filesWithErrors.length} file(s).`, true);
     } else if(state.failedFiles.size > 0) {
          setStatus(previewStatusEl, `Preview generated. Some files failed to fetch.`, true);
     } else {
         setStatus(previewStatusEl, 'Preview generated successfully.');
     }

     // Enable/disable Apply button based on source type and errors
     updateApplyButtonState(dir?.type);

     // Update failed files list UI
     updateFailedFilesUI();

}


/**
 * Initiates the process to apply the patch to the selected directory source.
 * Sends a request to the backend API.
 * @param {string} patchContent - The patch content to apply.
 */
export async function applyPatch(patchContent) {
    if (!state.selectedDirectoryId) {
        setStatus(applyStatusEl, 'Error: No project source selected.', true);
        return;
    }
    const dir = state.directories.find(d => d.id === state.selectedDirectoryId);
    if (!dir) {
        setStatus(applyStatusEl, 'Error: Selected project source not found.', true);
        return;
    }
    if (dir.type === 'uploaded') {
        setStatus(applyStatusEl, 'Error: Cannot apply patch to uploaded directories.', true);
        alert("Applying patches directly to uploaded directories is not supported. Please use a server path source.");
        return;
    }
    if (!dir.path) {
         setStatus(applyStatusEl, 'Error: Selected source has no valid path.', true);
         return;
    }
    if (!patchContent.trim()) {
        setStatus(applyStatusEl, 'Error: Patch content is empty.', true);
        return;
    }

    // Disable button during operation
    applyButton.disabled = true;
    setStatus(applyStatusEl, 'Applying patch...');

    try {
        const url = `${state.baseEndpoint}/api/apply_patch`;
        const response = await tryFetchWithFallback(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directoryPath: dir.path,
                patchContent: patchContent
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            setStatus(applyStatusEl, `Patch applied successfully to ${data.appliedFiles?.length || 0} file(s).`, false);
            console.log("Patch application successful:", data);
             alert(`Patch applied successfully!\nFiles affected:\n${(data.appliedFiles || []).join('\n')}`);
            // Optionally: Re-fetch directory structure or clear preview?
             // await fetchDirectoryStructure(dir.id); // Re-fetch might be good practice
             // clearPreview(); // Clear preview after successful apply
        } else {
             const errorMsg = data.error || `Server responded with status ${response.status}`;
             const details = data.details ? `\nDetails:\n${data.details.join('\n')}` : '';
             const appliedCount = data.appliedFiles?.length || 0;
             let finalError = `Error applying patch: ${errorMsg}`;
             if (appliedCount > 0) {
                 finalError += ` (${appliedCount} file(s) might have been partially applied).`;
             }
            setStatus(applyStatusEl, finalError, true);
            console.error("Patch application failed:", data);
            alert(`Patch application failed: ${errorMsg}${details}`);
        }

    } catch (error) {
        setStatus(applyStatusEl, `Network/Request error: ${error.message}`, true);
        console.error("Error sending apply patch request:", error);
         alert(`Failed to send patch request: ${error.message}`);
    } finally {
        // Re-enable button only if source is still valid
         updateApplyButtonState(dir?.type);
    }
}

// --- Helper Functions ---

function clearPreview() {
    patchPreviewEl.innerHTML = '';
     setStatus(previewStatusEl, '');
     setStatus(applyStatusEl, '');
     state.failedFiles.clear();
     updateFailedFilesUI();
     applyButton.disabled = true; // Disable apply button when preview is cleared
}

function setStatus(element, message, isError = false) {
     if (!element) return;
    element.textContent = message;
    element.className = isError ? 'error' : (message.includes('success') ? 'success' : '');
     // Simple class setting based on message content or flag
}

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

function updateFailedFilesUI() {
     const failedFilesDiv = document.getElementById('failed-files');
     failedFilesDiv.innerHTML = ''; // Clear previous
     if (state.failedFiles.size > 0) {
         const header = document.createElement('h3');
         header.textContent = 'Files With Fetch/Preview Issues:';
         failedFilesDiv.appendChild(header);
         const ul = document.createElement('ul');
         state.failedFiles.forEach(filePath => {
             const li = document.createElement('li');
             li.textContent = filePath;
             ul.appendChild(li);
         });
         failedFilesDiv.appendChild(ul);
         failedFilesDiv.style.display = 'block'; // Show the container
     } else {
         failedFilesDiv.style.display = 'none'; // Hide if no errors
     }
 }

 function updateApplyButtonState(selectedDirType) {
     // Enable Apply button only if a 'path' type directory is selected and patch content exists
     const patchContentExists = state.patchContent && state.patchContent.trim().length > 0;
     applyButton.disabled = !(selectedDirType === 'path' && patchContentExists);

      if (selectedDirType === 'uploaded' && patchContentExists) {
           setStatus(applyStatusEl, 'Cannot apply patch to uploaded sources.', true);
      } else if (selectedDirType === 'path' && !patchContentExists) {
          setStatus(applyStatusEl, 'Paste patch content to enable apply.');
      } else if (selectedDirType !== 'path') {
           // Clear status if no dir or wrong type selected
            setStatus(applyStatusEl, '');
      }
      // If Apply was just clicked, the status is handled by applyPatch function
 }


 // Initial setup or export other functions if needed
 export function initializePatcher() {
     console.log("Patcher module initialized.");
     // Add any initial setup for the patcher module here
      applyButton.disabled = true; // Initially disabled
 }