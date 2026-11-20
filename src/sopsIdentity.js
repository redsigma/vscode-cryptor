const { promises: fs } = require('fs');
const path = require('path');
const vscode = require('vscode');
const { createVariableExpander } = require('./toolEnvironment.js');
const { pickOrEnterCredential } = require('./credentialPrompt.js');

const ageSecretPrefix = 'AGE-SECRET-KEY-1';
const ageSecretPattern = /^AGE-SECRET-KEY-1[A-Z0-9]+$/;
const regexPrefix = 'regex:';

/** @typedef {{ group: string, directories: string[], filenames: string[], overrides?: { gpgExtensions?: string[] } }} AgeKeyLookup */

/** @returns {Map<string, AgeKeyLookup>} */
function getIdentityLookupGroups() {
    const lookups = vscode.workspace.getConfiguration('cryptor.sops').get('ageKeyLookups', []);
    if (!Array.isArray(lookups)) {
        throw new Error('cryptor.sops.ageKeyLookups must be a list of lookup groups.');
    }

    const groups = new Map();
    for (const lookup of lookups) {
        if (!lookup || typeof lookup.group !== 'string' || !lookup.group.trim()) continue;
        const group = lookup.group.trim();
        if (groups.has(group)) {
            throw new Error(`Use a unique group name in cryptor.sops.ageKeyLookups. "${group}" is listed twice.`);
        }
        groups.set(group, lookup);
    }
    return groups;
}

/**
 * @param {string} entry
 * @param {string} setting
 * @param {string} [flags]
 * @returns {(name: string) => boolean}
 */
function createRegexMatcher(entry, setting, flags = '') {
    const pattern = entry.slice(regexPrefix.length);
    if (!pattern) {
        throw new Error(`Add a pattern after regex: in ${setting}.`);
    }

    let expression;
    try {
        expression = new RegExp(pattern, flags);
    } catch (error) {
        throw new Error(`Invalid regex in ${setting}. ${error.message}`);
    }
    return name => expression.test(name);
}

/**
 * @param {string[]} entries
 * @param {string} setting
 * @param {(name: string, literal: string) => boolean} matchLiteral
 * @param {string} [flags]
 */
function createNameMatchers(entries, setting, matchLiteral, flags = '') {
    const matchers = [];
    for (const entry of entries) {
        if (typeof entry !== 'string') throw new Error(`Use string entries in ${setting}.`);
        if (!entry.trim()) continue;
        matchers.push(entry.startsWith(regexPrefix)
            ? createRegexMatcher(entry, setting, flags)
            : name => matchLiteral(name, entry));
    }
    return matchers;
}

/**
 * @param {vscode.Uri} uri
 * @param {AgeKeyLookup} lookup
 * @returns {Promise<Array<vscode.QuickPickItem & { file: string }>>}
 */
async function findIdentityFiles(uri, lookup) {
    const setting = `cryptor.sops.ageKeyLookups for "${lookup.group}"`;
    if (!Array.isArray(lookup.directories) || !Array.isArray(lookup.filenames)) {
        throw new Error(`${setting} requires directories and filenames lists.`);
    }
    const matchFilenames = createNameMatchers(lookup.filenames, `${setting}.filenames`, (name, literal) => name.includes(literal));
    if (!matchFilenames.length) return [];

    const sourceDirectory = path.dirname(uri.fsPath);
    const expand = createVariableExpander(uri);
    const choices = [];
    const normalize = file => process.platform === 'win32' ? file.toLowerCase() : file;
    const source = normalize(path.resolve(uri.fsPath));
    const listings = new Map();
    function readDirectory(directory) {
        const key = normalize(directory);
        if (!listings.has(key)) {
            listings.set(key, fs.readdir(directory, { withFileTypes: true }).catch(error => {
                if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return [];
                throw error;
            }));
        }
        return listings.get(key);
    }

    async function resolveDirectory(directory) {
        // A lookup can refer to a workspace folder that does not exist for this file.
        const expanded = await expand(directory, `${setting}.directories`).catch(() => undefined);
        if (expanded && expanded.trim() && !expanded.includes('\0')) {
            return path.resolve(sourceDirectory, expanded);
        }
    }

    const directories = new Map();
    const matchDirectoryNames = [];
    let hasLiteralDirectories = false;
    for (const entry of lookup.directories) {
        if (typeof entry !== 'string') throw new Error(`Use string entries in ${setting}.directories.`);
        if (!entry.trim()) continue;
        if (entry.startsWith(regexPrefix)) {
            matchDirectoryNames.push(createRegexMatcher(entry, `${setting}.directories`));
            continue;
        }

        hasLiteralDirectories = true;
        const directory = await resolveDirectory(entry);
        if (directory) directories.set(normalize(directory), directory);
    }

    if (matchDirectoryNames.length) {
        const parents = hasLiteralDirectories ? [...directories.values()] : [sourceDirectory];
        for (const parent of parents) {
            const entries = await readDirectory(parent);
            const matches = entries.filter(child => child.isDirectory() && matchDirectoryNames.some(match => match(child.name)));
            for (const child of matches.sort((left, right) => left.name.localeCompare(right.name))) {
                const directory = path.join(parent, child.name);
                directories.set(normalize(directory), directory);
            }
        }
    }

    for (const directory of directories.values()) {
        const entries = await readDirectory(directory);
        const matches = entries.filter(entry => entry.isFile() && matchFilenames.some(match => match(entry.name)));
        for (const entry of matches.sort((left, right) => left.name.localeCompare(right.name))) {
            const file = path.join(directory, entry.name);
            if (normalize(file) === source) continue;
            choices.push({ label: entry.name, description: path.relative(sourceDirectory, file), file });
        }
    }
    return choices;
}

/**
 * @param {vscode.Uri} uri
 * @param {Map<string, AgeKeyLookup>} groups
 */
async function selectIdentitySource(uri, groups) {
    const items = [...groups.keys()].map(label => ({ label }));
    for (;;) {
        const choice = await pickOrEnterCredential(items,
            { placeHolder: 'Select an age identity group', ignoreFocusOut: true },
            {
                title: 'SOPS needs a matching age identity',
                prompt: 'Paste your private age identity.',
                placeHolder: 'AGE-SECRET-KEY-1…',
                ignoreFocusOut: true,
                validateInput: value => ageSecretPattern.test(value.trim())
                    ? undefined
                    : 'Enter a private age identity beginning with AGE-SECRET-KEY-1.',
            }
        );
        if (!choice) return;
        if ('value' in choice) return { key: choice.value.trim() };

        const group = choice.item.label;
        const lookup = groups.get(group);
        const files = await findIdentityFiles(uri, lookup);
        if (!files.length) {
            vscode.window.showWarningMessage(`No age identity files found for "${group}".`);
            continue;
        }

        const selected = files.length === 1 ? files[0] : await vscode.window.showQuickPick(files, { placeHolder: 'Select an age identity file' });
        if (!selected) continue;

        const extensions = lookup.overrides && lookup.overrides.gpgExtensions;
        const matchExtensions = createNameMatchers(
            Array.isArray(extensions) ? extensions : [],
            `cryptor.sops.ageKeyLookups for "${group}".overrides.gpgExtensions`,
            (name, literal) => name.toLowerCase().endsWith(literal.trim().toLowerCase()),
            'i'
        );
        const encrypted = matchExtensions.some(match => match(selected.label));
        return { file: selected.file, encrypted };
    }
}

/** @param {string} text */
async function selectDecryptedAgeIdentity(text) {
    const keys = [...new Set(text.split(/\r?\n/).map(line => line.trim()).filter(line => ageSecretPattern.test(line)))];
    if (!keys.length) throw new Error('The decrypted GPG file contains no private age identities.');
    if (keys.length === 1) return { key: keys[0] };

    const items = keys.map((key, index) => ({
        label: `Age identity ${index + 1}`,
        description: `${ageSecretPrefix}…${key.length > ageSecretPrefix.length + 4 ? key.slice(-4) : ''}`,
    }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select an age identity from the decrypted file' });
    if (selected) return { key: keys[items.indexOf(selected)] };
}

/**
 * @param {vscode.Uri} uri
 * @param {(file: string) => Promise<string | undefined>} decryptIdentityFile
 */
async function selectSopsAgeIdentity(uri, decryptIdentityFile) {
    const groups = getIdentityLookupGroups();
    const selected = await selectIdentitySource(uri, groups);
    if (!selected || 'key' in selected) return selected;
    if (!selected.encrypted) return { file: selected.file };

    const decrypted = await decryptIdentityFile(selected.file);
    if (decrypted !== undefined) return selectDecryptedAgeIdentity(decrypted);
}

module.exports = { selectSopsAgeIdentity };
