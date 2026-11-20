const legacyWorkspaceSettings = new Set([
    'gpg.showEditorContextMenus',
    'gpg.encryptedFileSuffix',
    'gpg.encryptedBinaryFileSuffix',
]);

const legacyGpgSettings = new Set([
    'gpg.passphrases',
    'gpg.encryptedFileSuffix',
    'gpg.encryptedBinaryFileSuffix',
]);

function getLegacyValue(setting, allowWorkspace) {
    if (!setting) return undefined;
    if (allowWorkspace && setting.workspaceFolderValue !== undefined) return setting.workspaceFolderValue;
    if (allowWorkspace && setting.workspaceValue !== undefined) return setting.workspaceValue;
    return setting.globalValue;
}

/**
 * Read literal property names from the Cryptor object before falling back to old setting IDs.
 * @param {string} key
 * @param {import('vscode').Uri} [uri]
 */
function getCryptorSetting(key, uri) {
    const vscode = require('vscode');
    const config = vscode.workspace.getConfiguration(undefined, uri);
    const { globalValue, defaultValue } = config.inspect('cryptor') || {};
    if (globalValue && Object.prototype.hasOwnProperty.call(globalValue, key)) {
        return globalValue[key];
    }

    const allowWorkspace = legacyWorkspaceSettings.has(key);
    const legacy = getLegacyValue(config.inspect(`cryptor.${key}`), allowWorkspace);
    if (legacy !== undefined) return legacy;

    if (legacyGpgSettings.has(key)) {
        const oldGpg = getLegacyValue(config.inspect(key), allowWorkspace);
        if (oldGpg !== undefined) return oldGpg;
    }

    return defaultValue && defaultValue[key];
}

module.exports = { getCryptorSetting };
