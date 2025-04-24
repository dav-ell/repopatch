// public/js/utils.js
// Contains utility helper functions.

import { state } from './state.js'; // Keep state import for isTextFile

/**
 * Determines if a file is a text file based on its extension using the dynamic whitelist from the application state.
 * Supports wildcard patterns (e.g., "dockerfile*").
 * The check is performed on the base name of the file to handle full paths correctly.
 * IMPORTANT: This whitelist is no longer user-manageable via UI. Default list is used.
 * Consider if whitelisting is still the right approach for patching or if different logic is needed.
 * For now, keeping it to filter uploads.
 * @param {string} fileName - The full file path or name.
 * @returns {boolean} - True if the file is considered text-based, false otherwise.
 */
export function isTextFile(fileName) {
    // Default whitelist if state isn't loaded or doesn't have it (removed from UI)
     const defaultWhitelist = new Set([
         'dockerfile*',
         '.txt', '.md', '.json', '.xml', '.html', '.css', '.js', '.py', '.java', '.c',
         '.cpp', '.h', '.hpp', '.sh', '.bat', '.yml', '.yaml', '.ini', '.cfg', '.conf',
         '.log', '.csv', '.ts', '.jsx', '.tsx', '.php', '.rb', '.go', '.rs', '.swift',
         '.kt', '.kts', '.scala', '.pl', '.pm', '.r', '.sql', '.dart', '.lua', '.gitignore',
         '.patch', '.diff', // Add patch/diff files
         // Add other common text files if needed
     ]);
    const whitelist = (state && state.whitelist instanceof Set && state.whitelist.size > 0)
                       ? state.whitelist
                       : defaultWhitelist;

    // Extract the base name (i.e., the file name without the directory path)
    const baseName = fileName.includes('/') ? fileName.substring(fileName.lastIndexOf('/') + 1) : fileName;

     // Handle files with no extension (like Dockerfile, Makefile, etc.) - check basename directly
     if (!baseName.includes('.')) {
         return Array.from(whitelist).some(pattern => {
              if (pattern === baseName.toLowerCase() || (pattern.endsWith('*') && baseName.toLowerCase().startsWith(pattern.slice(0, -1)))) {
                  return true;
              }
              // Check regex for patterns like 'dockerfile*' against extensionless names
              if (pattern.includes("*")) {
                   const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
                   const regexPattern = '^' + escaped.replace(/\*/g, '.*') + '$';
                   const regex = new RegExp(regexPattern, 'i');
                   return regex.test(baseName);
               }
              return false;
         });
     }

    // Check against extensions for files that have them
    return Array.from(whitelist).some(pattern => {
        if (pattern.startsWith('.')) { // Standard extension check
            return baseName.toLowerCase().endsWith(pattern.toLowerCase());
        } else if (pattern.includes("*")) { // Wildcard check (might match filename part or extension)
            const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
            const regexPattern = '^' + escaped.replace(/\*/g, '.*') + '$';
            const regex = new RegExp(regexPattern, 'i');
            return regex.test(baseName);
        } else { // Exact filename match (e.g., "Makefile")
             return baseName.toLowerCase() === pattern.toLowerCase();
        }
    });
}


/**
 * Debounce function to limit the rate at which a function is called.
 * @param {Function} func - The function to debounce.
 * @param {number} wait - The wait time in milliseconds.
 * @returns {Function} - The debounced function.
 */
export function debounce(func, wait) {
    let timeout;
    return function(...args) {
        const context = this; // Capture context
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            timeout = null; // Clear timeout ID once executed
            func.apply(context, args);
        }, wait);
    };
}


// Removed: getLanguage, naturalCompare, sortTreeEntries, collectFolderPaths