// public/js/db.js
// Handles interactions with IndexedDB for storing uploaded file contents.
// This module provides functions to open the database, store, retrieve, and clear uploaded files.

const DB_NAME = 'RepoPatchUploadedFilesDB'; // Renamed DB for uploaded files
const DB_VERSION = 1;
const STORE_NAME = 'uploadedFiles';

let dbPromise = null;

/**
 * Opens the IndexedDB database.
 * @returns {Promise<IDBDatabase>} - Promise that resolves to the opened database.
 */
function openDB() {
    if (dbPromise) {
        return dbPromise;
    }
    dbPromise = new Promise((resolve, reject) => {
        console.log(`Opening UploadedFilesDB: ${DB_NAME} v${DB_VERSION}`);
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (event) => {
            console.error('UploadedFilesDB error:', event.target.errorCode);
            reject(event.target.error);
            dbPromise = null; // Reset promise on error
        };
        request.onsuccess = (event) => {
            console.log(`UploadedFilesDB ${DB_NAME} opened successfully.`);
            resolve(event.target.result);
        };
        request.onupgradeneeded = (event) => {
            console.log(`Upgrading UploadedFilesDB ${DB_NAME} to version ${DB_VERSION}`);
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                console.log(`Object store '${STORE_NAME}' created in ${DB_NAME}.`);
            }
            // Handle future upgrades here
        };
        request.onblocked = () => {
            console.warn('UploadedFilesDB open request blocked.');
            reject(new Error('IndexedDB open request blocked'));
             dbPromise = null; // Reset promise
        };
    });
    return dbPromise;
}

/**
 * Stores an uploaded file's content in IndexedDB with a directory-specific key.
 * @param {number} dirId - The unique identifier of the directory.
 * @param {string} filePath - The file path used in the key.
 * @param {string} content - The content of the file.
 * @returns {Promise<void>}
 */
export async function putUploadedFile(dirId, filePath, content) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = (event) => {
                console.error(`Transaction error putting file ${dirId}:${filePath}:`, event.target.error);
                reject(event.target.error);
            };
             tx.onabort = (event) => {
                 console.warn(`Transaction aborted putting file ${dirId}:${filePath}:`, event.target.error);
                 reject(new Error(`Transaction aborted: ${event.target.error?.message}`));
             };
            const store = tx.objectStore(STORE_NAME);
            const key = `${dirId}:${filePath}`;
            const request = store.put({ key, content });
             request.onerror = (event) => { // Specific put errors
                 console.error(`Put error for key ${key}:`, event.target.error);
                 // Let tx.onerror handle rejection
             };
        } catch (error) {
             console.error(`Error initiating transaction for putting file ${dirId}:${filePath}:`, error);
             reject(error);
        }
    });
}

/**
 * Retrieves an uploaded file's content from IndexedDB using a directory-specific key.
 * @param {number} dirId - The unique identifier of the directory.
 * @param {string} filePath - The file path key.
 * @returns {Promise<string|null>} - Promise that resolves to the file content or null if not found.
 */
export async function getUploadedFile(dirId, filePath) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(STORE_NAME, 'readonly');
             let resultValue = null;
            tx.oncomplete = () => resolve(resultValue);
            tx.onerror = (event) => {
                console.error(`Transaction error getting file ${dirId}:${filePath}:`, event.target.error);
                reject(event.target.error);
            };
            tx.onabort = (event) => {
                 console.warn(`Transaction aborted getting file ${dirId}:${filePath}:`, event.target.error);
                 reject(new Error(`Transaction aborted: ${event.target.error?.message}`));
             };
            const store = tx.objectStore(STORE_NAME);
            const key = `${dirId}:${filePath}`;
            const request = store.get(key);
            request.onsuccess = (event) => {
                resultValue = event.target.result ? event.target.result.content : null;
            };
             request.onerror = (event) => { // Specific get errors
                 console.error(`Get error for key ${key}:`, event.target.error);
                 // Let tx.onerror handle rejection
             };
        } catch (error) {
            console.error(`Error initiating transaction for getting file ${dirId}:${filePath}:`, error);
            reject(error);
        }
    });
}

/**
 * Clears all uploaded files from IndexedDB for a specific directory ID.
 * @param {number} dirId - The unique identifier of the directory.
 * @returns {Promise<void>}
 */
export async function clearUploadedFilesForDir(dirId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const index = store.index('key'); // Assuming 'key' is indexed or using keyPath directly
            const lowerBound = `${dirId}:`;
            const upperBound = `${dirId};`; // Use next character to define range end

            const range = IDBKeyRange.bound(lowerBound, upperBound, false, true); // dirId: <= key < dirId;
            const request = store.openCursor(range);
             let deleteCount = 0;

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                     // Check if the key truly starts with the dirId prefix (extra safety)
                     if (cursor.key.startsWith(lowerBound)) {
                         cursor.delete();
                         deleteCount++;
                     }
                    cursor.continue();
                } else {
                    // End of cursor
                     console.log(`Cleared ${deleteCount} uploaded files for dirId ${dirId}.`);
                    resolve();
                }
            };
            request.onerror = (event) => {
                console.error(`Cursor error clearing files for dirId ${dirId}:`, event.target.error);
                reject(event.target.error);
            };
             tx.onerror = (event) => {
                 console.error(`Transaction error clearing files for dirId ${dirId}:`, event.target.error);
                 reject(event.target.error); // Reject promise on transaction error
             };
             tx.onabort = (event) => {
                 console.warn(`Transaction aborted clearing files for dirId ${dirId}:`, event.target.error);
                 reject(new Error(`Transaction aborted: ${event.target.error?.message}`));
             };
        } catch (error) {
             console.error(`Error initiating transaction for clearing files for dirId ${dirId}:`, error);
             reject(error);
        }
    });
}


/**
 * Clears ALL uploaded files from IndexedDB. Use with caution.
 * @returns {Promise<void>}
 */
export async function clearAllUploadedFiles() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
         try {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = (event) => {
                console.error("Transaction error clearing all uploaded files:", event.target.error);
                reject(event.target.error);
            };
             tx.onabort = (event) => {
                 console.warn(`Transaction aborted clearing all files:`, event.target.error);
                 reject(new Error(`Transaction aborted: ${event.target.error?.message}`));
             };
            const store = tx.objectStore(STORE_NAME);
            const request = store.clear();
             request.onerror = (event) => { // Specific clear errors
                 console.error("Store clear error:", event.target.error);
                 // Let tx.onerror handle rejection
             };
        } catch (error) {
             console.error("Error initiating transaction for clearing all files:", error);
             reject(error);
        }
    });
}