// public/js/explorer.js
// Manages fetching directory contents from the server.

import { state, saveStateToLocalStorage } from './state.js';
// Removed UI related imports: renderFileExplorer, updateXMLPreview
import { tryFetchWithFallback } from './connection.js';

/**
 * Fetches the directory structure from the server for a specific directory ID
 * and stores it in the state. Does not render any UI.
 * @param {number} dirId - The ID of the directory to fetch.
 * @returns {Promise<boolean>} - True if fetch was successful, false otherwise.
 */
export async function fetchDirectoryStructure(dirId) {
    const dir = state.directories.find(d => d.id === dirId);
    if (!dir) {
        console.error(`Directory with ID ${dirId} not found.`);
        return false;
    }

    // Skip fetching for 'uploaded' type directories, their structure is built on upload
    if (dir.type === 'uploaded') {
        console.log(`Skipping fetch for uploaded directory: ${dir.name || dir.id}`);
        // Assume structure exists if needed later, or handle appropriately
        delete dir.error; // Clear any previous error state
        return true; // Indicate success as there's nothing to fetch
    }

    if (!dir.path) {
        dir.error = 'No path specified for this server directory';
        console.error(dir.error);
        await saveStateToLocalStorage(); // Save the error state
        return false;
    }

    try {
        console.log(`Workspaceing directory structure for: ${dir.path} from ${state.baseEndpoint}`);
        const url = `${state.baseEndpoint}/api/directory?path=${encodeURIComponent(dir.path)}`;
        const response = await tryFetchWithFallback(url);
        const data = await response.json();

        if (response.ok && data.success) {
            dir.path = data.root; // Update with canonicalized path from server
            dir.tree = data.tree; // Assign the full tree structure
            delete dir.error; // Clear any previous error
            console.log(`Directory structure updated successfully for ${dir.id}:`, dir.tree ? Object.keys(dir.tree).length + ' top-level items' : 'empty tree');
            // Don't save full tree to localStorage, saveStateToLocalStorage handles this
            await saveStateToLocalStorage();
            return true;
        } else {
            let errorMsg = data.error || `Server responded with status ${response.status}`;
            if (errorMsg.includes("permission denied")) {
                errorMsg = `Permission denied: The server cannot access ${dir.path}. Ensure the server has read permissions.`;
            } else if (response.status === 404) {
                 errorMsg = `Directory not found: ${dir.path}`;
            }
            dir.error = errorMsg;
            dir.tree = {}; // Clear tree on error
            console.error(`Failed to load directory structure for ${dir.id}:`, errorMsg);
            await saveStateToLocalStorage(); // Save error state and cleared tree
            return false;
        }
    } catch (error) {
        dir.error = `Network error fetching directory structure: ${error.message}`;
        dir.tree = {}; // Clear tree on error
        console.error(`Network error for directory ${dir.id}:`, error.message);
        await saveStateToLocalStorage();
        return false;
    }
}

// Removed generateFileExplorer UI function