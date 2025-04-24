// File: /Users/davell/Documents/github/repoprompt/public/js/state.js
// Manages application state and persistence.
// State properties are persisted in IndexedDB via stateDB.js.

import { getState, setState, getDirectories, setDirectories } from './stateDB.js';

export const STORAGE_KEYS = {
    ENDPOINT_URL: 'repoPatch_endpointUrl', // Changed prefix
    DIRECTORIES: 'repoPatch_directories', // Use stateDB for directories
    SELECTED_DIRECTORY_ID: 'repoPatch_selectedDirectoryId', // Store selected ID
    FAILED_FILES: 'repoPatch_failedFiles' // Keep for tracking fetch/patch errors maybe
};

export const state = {
    directories: [],                  // Array of { id, type, path, name, tree (optional, fetched on demand) }
    selectedDirectoryId: null,        // ID of the directory selected to apply the patch against
    baseEndpoint: "/",                // Base endpoint URL set to relative root by default
    failedFiles: new Set(),           // Track files that failed to fetch (useful for preview)
    patchContent: '',                 // Store the current patch content from the input
    patchPreviewContent: '',          // Store the generated preview content
    // Removed: fileCache, currentDirectoryId (using selectedDirectoryId), userInstructions, debounceTimer, selectedPrompts, whitelist
};

/**
 * Saves the current application state.
 * Small properties are saved in localStorage; larger objects (directories, failed files) are saved in IndexedDB.
 */
export async function saveStateToLocalStorage() {
    localStorage.setItem(STORAGE_KEYS.ENDPOINT_URL, state.baseEndpoint);
    localStorage.setItem(STORAGE_KEYS.SELECTED_DIRECTORY_ID, state.selectedDirectoryId); // Save selected ID

    // Save larger/complex state items to IndexedDB
    await setDirectories(state.directories.map(dir => ({ // Don't save fetched tree in stateDB
        id: dir.id,
        type: dir.type,
        path: dir.path,
        name: dir.name,
        error: dir.error // Save error state
        // Exclude 'tree'
    })));
    await setState(STORAGE_KEYS.FAILED_FILES, [...state.failedFiles]);

    // Don't save patchContent or patchPreviewContent to persistence
}

/**
 * Loads the application state.
 * Small properties are loaded from localStorage; larger objects (directories, failed files) are loaded from IndexedDB.
 */
export async function loadStateFromLocalStorage() {
    const savedEndpoint = localStorage.getItem(STORAGE_KEYS.ENDPOINT_URL);
    // Default to relative path '/' if nothing is saved or if it's explicitly empty
    state.baseEndpoint = savedEndpoint || "/";
    if (state.baseEndpoint === 'null' || state.baseEndpoint === 'undefined') {
         state.baseEndpoint = "/"; // Handle legacy bad values
    }


    // Load directories from IndexedDB
    state.directories = await getDirectories();

    const savedSelectedId = localStorage.getItem(STORAGE_KEYS.SELECTED_DIRECTORY_ID);
     // Ensure the saved ID is valid and exists in the loaded directories
     if (savedSelectedId && state.directories.some(dir => String(dir.id) === savedSelectedId)) {
         state.selectedDirectoryId = parseInt(savedSelectedId, 10);
     } else if (state.directories.length > 0) {
         // Default to the first directory if no valid selection or no directories saved
         state.selectedDirectoryId = state.directories[0].id;
     } else {
         state.selectedDirectoryId = null;
     }


    // Load failed files from IndexedDB
    const failedFiles = await getState(STORAGE_KEYS.FAILED_FILES);
    try {
        state.failedFiles = new Set(Array.isArray(failedFiles) ? failedFiles : []);
    } catch (error) {
        console.error("Failed to load failed files state:", error);
        state.failedFiles = new Set();
    }

     // Initialize transient state
     state.patchContent = '';
     state.patchPreviewContent = '';
}