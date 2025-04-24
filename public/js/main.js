// File: /Users/davell/Documents/github/repoprompt/public/js/main.js
// Main entry point for the Patch Preview application.

import { state, loadStateFromLocalStorage, saveStateToLocalStorage } from './state.js';
import { debounce } from './utils.js'; // Keep debounce
import { fetchDirectoryStructure } from './explorer.js'; // Keep for fetching structure
import { checkConnection, tryFetchWithFallback } from './connection.js'; // Keep connection
import { handleZipUpload, handleFolderUpload } from './uploader.js'; // Keep uploader
import { initializePatcher, generatePatchPreview, applyPatch } from './patcher.js'; // Import new patcher module

/**
 * Renders the list of directories in the UI, handling selection.
 */
function renderDirectoriesList() {
    const list = document.getElementById('directories-list');
    const applyBtn = document.getElementById('apply-patch-btn');
    list.innerHTML = ''; // Clear previous list

    if (state.directories.length === 0) {
        list.innerHTML = '<li>No project sources added yet.</li>';
         state.selectedDirectoryId = null;
         applyBtn.disabled = true; // Disable apply if no sources
        return;
    }

    let validSelectionExists = false;
    state.directories.forEach(dir => {
        const div = document.createElement('div');
        div.className = 'directory-item';
        div.setAttribute('data-dir-id', dir.id);
        div.title = `Type: ${dir.type}\nPath: ${dir.path || dir.name || 'N/A'}${dir.error ? `\nError: ${dir.error}` : ''}`;

        if (dir.id === state.selectedDirectoryId) {
            div.classList.add('selected');
            validSelectionExists = true;
        }

        // Directory Name and Type Badge
         const nameSpan = document.createElement('span');
         nameSpan.textContent = dir.name || (dir.path ? dir.path.split(/[\\/]/).pop() : `source-${dir.id}`);
         const typeBadge = document.createElement('span');
         typeBadge.className = 'dir-type';
         typeBadge.textContent = dir.type === 'path' ? 'Server' : 'Uploaded';
         nameSpan.prepend(typeBadge); // Add badge before name
         div.appendChild(nameSpan);


        const buttonContainer = document.createElement('div');
        buttonContainer.style.display = 'flex';
        buttonContainer.style.alignItems = 'center';

        // Add Fetch/Update button only for 'path' type directories
        if (dir.type === 'path') {
            const updateBtn = document.createElement('button');
            updateBtn.textContent = dir.tree ? 'Update' : 'Fetch'; // Change text based on if tree exists
            updateBtn.title = `Workspace or refresh directory structure for ${dir.path}`;
            updateBtn.addEventListener('click', async (e) => {
                 e.stopPropagation(); // Prevent directory selection when clicking button
                console.log(`Manual update triggered for directory ID: ${dir.id}`);
                updateBtn.textContent = 'Fetching...';
                updateBtn.disabled = true;
                const success = await fetchDirectoryStructure(dir.id);
                // Re-render list to show potential error changes or updated state
                renderDirectoriesList();
                // Trigger preview regeneration if this was the selected dir
                if (dir.id === state.selectedDirectoryId) {
                    debouncedPreview();
                }
                alert(success ? `Directory ${dir.name || dir.id} updated.` : `Failed to update directory ${dir.name || dir.id}.`);
                 // Button state is reset by renderDirectoriesList
            });
             if (dir.error) {
                 updateBtn.style.backgroundColor = '#f85149'; // Indicate error state
                 updateBtn.title = `Error fetching directory: ${dir.error}. Click to retry.`;
             }

            buttonContainer.appendChild(updateBtn);
        }

        // Remove Button (Common)
        const removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remove';
        removeBtn.title = `Remove source: ${dir.name || dir.id}`;
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent directory selection
            if (confirm(`Are you sure you want to remove the source "${dir.name || dir.id}"?`)) {
                state.directories = state.directories.filter(d => d.id !== dir.id);
                // If the removed dir was selected, reset selection
                if (state.selectedDirectoryId === dir.id) {
                    state.selectedDirectoryId = state.directories.length > 0 ? state.directories[0].id : null;
                     // Trigger preview update if selection changed
                     debouncedPreview();
                }
                renderDirectoriesList(); // Re-render the list
                saveStateToLocalStorage();
                // Update apply button state based on new selection
                updateApplyButtonState();
            }
        });
        buttonContainer.appendChild(removeBtn);

        div.appendChild(buttonContainer);
        list.appendChild(div);

         // Click listener for the entire item to select the directory
         div.addEventListener('click', () => {
             if (state.selectedDirectoryId !== dir.id) {
                 state.selectedDirectoryId = dir.id;
                 console.log(`Selected directory: ${dir.id}`);
                 renderDirectoriesList(); // Re-render to show selection highlight
                 saveStateToLocalStorage(); // Save the new selection
                 updateApplyButtonState(); // Update button state
                 debouncedPreview(); // Regenerate preview for the new source
             }
         });

    });

     // If the initially selected ID wasn't found (e.g., after deletion), select the first one if possible
     if (!validSelectionExists && state.directories.length > 0) {
         state.selectedDirectoryId = state.directories[0].id;
         console.log(`Defaulting selection to first directory: ${state.selectedDirectoryId}`);
         saveStateToLocalStorage();
         renderDirectoriesList(); // Re-render again to show the new default selection
     } else if (state.directories.length === 0) {
          state.selectedDirectoryId = null; // Ensure selection is null if no directories
          saveStateToLocalStorage();
     }

     updateApplyButtonState(); // Ensure apply button state is correct after render
}

/**
 * Updates the enabled/disabled state of the Apply Patch button
 * based on the selected directory type and patch content.
 */
function updateApplyButtonState() {
     const applyBtn = document.getElementById('apply-patch-btn');
     const selectedDir = state.directories.find(d => d.id === state.selectedDirectoryId);
     const patchContent = document.getElementById('patch-input').value.trim();

     applyBtn.disabled = !(selectedDir && selectedDir.type === 'path' && patchContent && !selectedDir.error);

     // Update tooltip based on state
     if (!selectedDir) {
         applyBtn.title = "Select a project source first.";
     } else if (selectedDir.type === 'uploaded') {
          applyBtn.title = "Cannot apply patch to uploaded sources.";
     } else if (!patchContent) {
          applyBtn.title = "Paste patch content first.";
     } else if (selectedDir.error) {
          applyBtn.title = `Cannot apply patch: Source has error - ${selectedDir.error}`;
     } else {
          applyBtn.title = `Apply the patch to the selected source: ${selectedDir.name || selectedDir.path}`;
     }

}


// --- Debounced preview function ---
const debouncedPreview = debounce(() => {
    const patchContent = document.getElementById('patch-input').value;
    state.patchContent = patchContent; // Store current content in state
    generatePatchPreview(patchContent);
    updateApplyButtonState(); // Update button state after preview generation/patch input change
}, 500); // 500ms debounce delay


// --- Main Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    console.log("DOM Loaded. Initializing Patch Preview App.");
    // Load saved state
    await loadStateFromLocalStorage();

    // Initialize UI elements with saved state
    const endpointInput = document.getElementById('endpoint-url');
    if (state.baseEndpoint) {
        endpointInput.value = state.baseEndpoint;
    } else {
         endpointInput.value = ''; // Ensure placeholder shows if no value
    }


    // Initial connection check if endpoint exists
    if (state.baseEndpoint && state.baseEndpoint !== "/") {
        console.log("Attempting initial connection check...");
        await checkConnection(); // Updates status element internally
    } else {
        document.getElementById('connection-status').textContent = 'Not connected';
    }

    // Initialize patcher module
    initializePatcher();

    // Render initial directories list
    renderDirectoriesList();

    // --- Event Listeners ---

    // Patch Input Listener
    document.getElementById('patch-input').addEventListener('input', debouncedPreview);

    // Apply Patch Button Listener
    document.getElementById('apply-patch-btn').addEventListener('click', () => {
        const patchContent = document.getElementById('patch-input').value;
        applyPatch(patchContent);
    });

    // Connect Endpoint Button
    document.getElementById('connect-endpoint').addEventListener('click', async () => {
         await checkConnection();
         // Optionally re-fetch structures for all 'path' directories after successful connection?
         // Or just let the user update them manually via the list buttons.
    });

    // Add Directory Path Button
    document.getElementById('add-path-btn').addEventListener('click', async () => {
        const path = prompt('Enter absolute server directory path (e.g., /home/user/project):');
        if (path && path.trim()) {
            const dirId = Date.now(); // Simple unique ID
            const newDir = {
                id: dirId,
                type: 'path',
                path: path.trim(),
                name: path.trim().split(/[\\/]/).pop() || `path-${dirId}`, // Basic name generation
                tree: null, // Structure not fetched yet
                error: null
             };
            state.directories.push(newDir);
            state.selectedDirectoryId = dirId; // Select the newly added directory
            renderDirectoriesList(); // Update the list UI

            // Attempt to fetch structure immediately
            const fetchBtn = document.querySelector(`.directory-item[data-dir-id="${dirId}"] button`);
             if (fetchBtn) {
                 fetchBtn.textContent = 'Fetching...';
                 fetchBtn.disabled = true;
             }
            await fetchDirectoryStructure(dirId); // Fetch structure
            renderDirectoriesList(); // Re-render to show fetched status/error
            saveStateToLocalStorage();
            debouncedPreview(); // Trigger preview update if patch content exists
             updateApplyButtonState();
        }
    });

    // Upload ZIP Button
    const uploadBtn = document.getElementById('upload-btn');
    const zipInput = document.getElementById('zip-upload');
    uploadBtn.addEventListener('click', () => zipInput.click());
    zipInput.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (file) {
            const dirId = Date.now();
            const newDir = {
                 id: dirId,
                 type: 'uploaded',
                 name: file.name.replace(/\.zip$/i, '') || `zip-${dirId}`,
                 tree: {}, // Will be populated by handler
                 error: null
             };
            state.directories.push(newDir);
            state.selectedDirectoryId = dirId; // Select the new dir
            renderDirectoriesList(); // Show the new entry (might show as 'processing')

            await handleZipUpload(file, dirId); // Pass dirId

            // Re-render list to reflect processed state (name, potential error)
            renderDirectoriesList();
            saveStateToLocalStorage();
            debouncedPreview(); // Trigger preview for new source
             updateApplyButtonState();
             zipInput.value = ''; // Reset input
        }
    });

    // Upload Folder Button
    const uploadFolderBtn = document.getElementById('upload-folder-btn');
    const folderInput = document.getElementById('folder-upload');
    uploadFolderBtn.addEventListener('click', () => folderInput.click());
    folderInput.addEventListener('change', async (event) => {
        const files = event.target.files;
        if (files && files.length > 0) {
            const dirId = Date.now();
             // Name will be determined by handler
             const newDir = { id: dirId, type: 'uploaded', name: `folder-${dirId}`, tree: {}, error: null };
            state.directories.push(newDir);
            state.selectedDirectoryId = dirId; // Select the new dir
            renderDirectoriesList(); // Show new entry

            await handleFolderUpload(files, dirId); // Pass dirId

            renderDirectoriesList(); // Re-render list with correct name/state
            saveStateToLocalStorage();
            debouncedPreview(); // Trigger preview
             updateApplyButtonState();
             folderInput.value = ''; // Reset input
        }
    });

     console.log("Initialization complete. Application ready.");
});