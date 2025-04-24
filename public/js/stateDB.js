// public/js/stateDB.js
// Provides functions to store and retrieve application state in IndexedDB.

// Consider changing DB Name if this is a truly separate application
const DB_NAME = 'RepoPatchStateDB'; // Renamed DB
const DB_VERSION = 1; // Keep version or increment if schema changes
const STORE_NAME = 'appState';

let dbPromise = null;

function openStateDB() {
    if (dbPromise) {
        return dbPromise;
    }
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (event) => {
            console.error('StateDB error:', event.target.errorCode);
            reject(event.target.error);
            dbPromise = null; // Reset promise on error
        };
        request.onsuccess = (event) => {
            console.log(`StateDB ${DB_NAME} opened successfully.`);
            resolve(event.target.result);
        };
        request.onupgradeneeded = (event) => {
            console.log(`Upgrading StateDB ${DB_NAME} to version ${DB_VERSION}`);
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                 console.log(`Object store '${STORE_NAME}' created.`);
            }
            // Handle future upgrades here if needed
        };
         request.onblocked = () => {
             console.warn('StateDB open request blocked, possibly due to open connections in other tabs.');
             reject(new Error('IndexedDB open request blocked'));
             dbPromise = null; // Reset promise
         };
    });
    return dbPromise;
}


/**
* Stores a value associated with a key in the appState store.
* @param {string} key - The state key.
* @param {any} value - The value to store.
* @returns {Promise<void>}
*/
export async function setState(key, value) {
    const db = await openStateDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(STORE_NAME, 'readwrite');
             tx.oncomplete = () => {
                 // console.log(`StateDB transaction completed for setting key: ${key}`);
                 resolve();
             };
             tx.onerror = (event) => {
                 console.error(`StateDB transaction error setting key ${key}:`, event.target.error);
                 reject(event.target.error);
             };
             tx.onabort = (event) => {
                 console.warn(`StateDB transaction aborted setting key ${key}:`, event.target.error);
                 reject(new Error(`Transaction aborted: ${event.target.error?.message}`));
             };
            const store = tx.objectStore(STORE_NAME);
            const request = store.put({ key, value });
            // request.onsuccess is handled by tx.oncomplete for writes generally
            request.onerror = (event) => { // Still useful for specific put errors
                console.error(`StateDB put error for key ${key}:`, event.target.error);
                // Don't reject here, let tx.onerror handle it
            };
        } catch (error) {
             console.error(`Error initiating StateDB transaction for key ${key}:`, error);
             reject(error);
        }
    });
}

/**
* Retrieves a value associated with a key from the appState store.
* @param {string} key - The state key.
* @returns {Promise<any>} - The stored value or null if not found.
*/
export async function getState(key) {
    const db = await openStateDB();
    return new Promise((resolve, reject) => {
         try {
            const tx = db.transaction(STORE_NAME, 'readonly');
             let resultValue = null;
             tx.oncomplete = () => {
                // console.log(`StateDB transaction completed for getting key: ${key}`);
                resolve(resultValue);
             };
             tx.onerror = (event) => {
                console.error(`StateDB transaction error getting key ${key}:`, event.target.error);
                reject(event.target.error);
            };
             tx.onabort = (event) => {
                 console.warn(`StateDB transaction aborted getting key ${key}:`, event.target.error);
                 reject(new Error(`Transaction aborted: ${event.target.error?.message}`));
             };

            const store = tx.objectStore(STORE_NAME);
            const request = store.get(key);
            request.onsuccess = (event) => {
                resultValue = event.target.result ? event.target.result.value : null;
            };
            request.onerror = (event) => { // Specific get errors
                 console.error(`StateDB get error for key ${key}:`, event.target.error);
                 // Let tx.onerror handle rejection
            };
        } catch (error) {
            console.error(`Error initiating StateDB transaction for key ${key}:`, error);
            reject(error);
        }
    });
}

/**
* Stores the directories array in the appState store.
* @param {Array} directories - Array of directory objects to store.
* @returns {Promise<void>}
*/
export async function setDirectories(directories) {
    // Ensure directories is an array before storing
    if (!Array.isArray(directories)) {
        console.error("Attempted to save non-array value for directories:", directories);
        return Promise.reject(new Error("Invalid data type for directories, expected array."));
    }
    return setState('directories', directories);
}

/**
* Retrieves the directories array from the appState store.
* @returns {Promise<Array>} - The stored directories array or an empty array if not found or invalid.
*/
export async function getDirectories() {
    const storedValue = await getState('directories');
    // Return an empty array if null, undefined, or not an array
    if (Array.isArray(storedValue)) {
        // Convert legacy Set objects in collapsedFolders to arrays for JSON compatibility if needed
        // (Though collapsedFolders is removed from the main state now)
        return storedValue.map(dir => ({
            ...dir,
            // collapsedFolders: dir.collapsedFolders instanceof Set ? Array.from(dir.collapsedFolders) : (dir.collapsedFolders || []) // Example conversion
        }));
    } else {
         if (storedValue != null) { // Check for not null/undefined
             console.warn("Stored value for 'directories' is not an array, returning empty array. Value:", storedValue);
         }
        return [];
    }
}