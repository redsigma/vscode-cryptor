// The module 'vscode' contains the VS Code extensibility API
const vscode = require('vscode');
// GPG command wrapper
const gpg = require('./gpg.js');
const sops = require('./sops.js');
const { resolveToolEnvironment, mergeToolEnvironment } = require('./toolEnvironment.js');
const { selectSopsAgeIdentity } = require('./sopsIdentity.js');
const { pickOrEnterCredential } = require('./credentialPrompt.js');
const { getCryptorSetting } = require('./configuration.js');
const { gpgArgumentHovers } = require('./gpgArguments.js');
const { registerSettingHovers } = require('./settingHovers.js');
// fs module for interacting with the file system
const fs = require('fs');

/**
 * This method is called when the extension is activated
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    const { contributes } = context.extension.packageJSON;
    const handlers = {
        gpg: {
            editor: { encryptSelection, decryptSelection, clearSignSelection, validateSelectionClearSign },
            file: {
                encryptArmoredFile: uri => encryptGpgFile(uri, 'armored'),
                encryptBinaryFile: uri => encryptGpgFile(uri, 'binary'),
                decryptFile,
            },
        },
        sops: {
            editor: {},
            file: {
                encryptFile: uri => runSops('encrypt', uri),
                decryptFile: uri => runSops('decrypt', uri),
            },
        },
    };

    for (const { command } of contributes.commands) {
        const [, , tool, action] = command.split('.');
        const toolHandlers = handlers[tool];
        const editorHandler = toolHandlers && toolHandlers.editor[action];
        const fileHandler = toolHandlers && toolHandlers.file[action];
        if (!editorHandler && !fileHandler) {
            throw new Error(`No handler for ${command}`);
        }

        const registration = editorHandler
            ? vscode.commands.registerTextEditorCommand(command, editorHandler)
            : vscode.commands.registerCommand(command, fileHandler);
        context.subscriptions.push(registration);
    }
    context.subscriptions.push(registerSettingHovers(gpgArgumentHovers));
    const updateEditorMenus = () => vscode.commands.executeCommand(
        'setContext',
        'cryptor.hideGpgEditorContextMenus',
        getCryptorSetting('gpg.showEditorContextMenus') === false
    );
    updateEditorMenus();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('cryptor')) updateEditorMenus();
    }));
}

/**
 * This method is called when your extension is deactivated
 */
function deactivate() {}

module.exports = {
	activate,
	deactivate
}

/** @param {vscode.Uri} uri */
async function getGpgEnvironment(uri) {
    const overrides = await resolveToolEnvironment(getCryptorSetting('gpg.env', uri), uri, 'cryptor["gpg.env"]');
    return Object.keys(overrides).length ? mergeToolEnvironment(overrides) : undefined;
}

/**
 * @param {'encrypt' | 'decrypt'} operation
 * @param {vscode.Uri} uri
 */
async function runSops(operation, uri) {
    if (!uri || !['file', 'vscode-remote'].includes(uri.scheme)) {
        vscode.window.showErrorMessage('Select a file in Explorer to run SOPS.');
        return;
    }

    let output;
    try {
        output = await transformSopsFile(operation, uri);
    } catch (error) {
        vscode.window.showErrorMessage(`SOPS could not ${operation} the file. ${error.message}`);
        return;
    }

    if (output) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(output));
}

/**
 * @param {'encrypt' | 'decrypt'} operation
 * @param {vscode.Uri} uri
 */
async function transformSopsFile(operation, uri) {
    const executable = getCryptorSetting('sops.path', uri);
    const env = await resolveToolEnvironment(getCryptorSetting('sops.env', uri), uri, 'cryptor["sops.env"]');
    try {
        return await sops.transformFile(operation, uri.fsPath, executable, { env });
    } catch (error) {
        if (operation !== 'decrypt' || !(error instanceof sops.AgeIdentityError)) throw error;
    }

    const identity = await selectSopsAgeIdentity(uri, decryptSopsIdentityFile);
    if (identity) return sops.transformFile(operation, uri.fsPath, executable, { env, identity });
}

/** @param {string} file */
async function decryptSopsIdentityFile(file) {
    const env = await getGpgEnvironment(vscode.Uri.file(file));
    const passphrase = await getPassphrase();
    if (passphrase) return gpg.decryptFileToText(file, passphrase, env);
}

/**
 * Encrypt text selection command
 *
 * @param {vscode.TextEditor} textEditor
 */
async function encryptSelection(textEditor) {

    let selection = textEditor.selection;
    let text = textEditor.document.getText(selection);

    if (!text || text.length === 0) {
        console.warn("zero length selection");
        vscode.window.setStatusBarMessage('No text selected', 2000);
        vscode.window.showWarningMessage("No text selected");
        return;
    }

    try {
        const env = await getGpgEnvironment(textEditor.document.uri);
        const selected = await getEncryptionChoice(env);
        if (!selected) return;

        const encrypted = 'passphrase' in selected
            ? await gpg.encryptWithPassphrase(text, selected.passphrase, env)
            : await gpg.encrypt(text, selected.email, env);
        textEditor.edit(edit => edit.replace(selection, encrypted));
        vscode.window.setStatusBarMessage('GPG Encrypted!', 2000);
    } catch (error) {
        vscode.window.showErrorMessage(error.message || 'Unable to encrypt text.');
    }
}

/**
 * Decrypt text selection command
 *
 * @param {vscode.TextEditor} textEditor
 */
async function decryptSelection(textEditor) {
    let selection = textEditor.selection;
    let text = textEditor.document.getText(selection);

    if (!text || text.length === 0) {
        console.warn("zero length selection");
        vscode.window.setStatusBarMessage('No text selected', 2000);
        vscode.window.showWarningMessage("No text selected");
        return;
    }

    try {
        const env = await getGpgEnvironment(textEditor.document.uri);
        const decrypted = await gpg.decrypt(text, env);
        textEditor.edit(editBuilder => editBuilder.replace(selection, decrypted));
        vscode.window.setStatusBarMessage('GPG Decrypted!', 2000);
    } catch (error) {
        console.error("unable to decrypt text", error);
        vscode.window.showErrorMessage(error.message || "unable to decrypt text");
    }
}

/**
 * Encrypt a file using the selected output format.
 *
 * @param {vscode.Uri} uri
 * @param {'armored' | 'binary'} format
 */
async function encryptGpgFile(uri, format) {
    const inputFilePath = uri.fsPath;
    const suffix = getCryptorSetting(format === 'binary' ? 'gpg.encryptedBinaryFileSuffix' : 'gpg.encryptedFileSuffix', uri);
    const destFilePath = `${inputFilePath}.${suffix}`;

    try {
        const overwrite = await checkFile(inputFilePath, destFilePath);
        if (overwrite === undefined) return;

        const env = await getGpgEnvironment(uri);
        const selected = await getEncryptionChoice(env);
        if (!selected) return;

        const resultFile = 'passphrase' in selected
            ? await gpg.encryptFileWithPassphrase(inputFilePath, destFilePath, selected.passphrase, env, overwrite, format)
            : await gpg.encryptFile(inputFilePath, destFilePath, selected.email, env, overwrite, format);
        if (resultFile && fs.existsSync(resultFile)) {
            if (format === 'armored') vscode.window.showTextDocument(vscode.Uri.file(resultFile));
            vscode.window.setStatusBarMessage('GPG Encrypted!', 2000);
        }
    } catch (error) {
        console.error("unable to encrypt file", error);
        vscode.window.showErrorMessage(error.message || "unable to encrypt file");
    }
}

/**
 * Decrypt file command
 *
 * @param {vscode.Uri} uri
 */
async function decryptFile(uri) {
    const inputFilePath = uri.fsPath;
    const destFilePath = inputFilePath.replace(/(\.gpg)?(\.asc)?$/i, '');

    try {
        if (inputFilePath === destFilePath) {
            throw new Error('Select a .gpg or .asc file to decrypt.');
        }

        const overwrite = await checkFile(inputFilePath, destFilePath);
        if (overwrite === undefined) return;

        const env = await getGpgEnvironment(uri);
        const passphrase = await getPassphrase();
        if (!passphrase) {
            vscode.window.setStatusBarMessage('No passphrase provided', 2000);
            return;
        }

        const resultFile = await gpg.decryptFile(inputFilePath, destFilePath, passphrase, overwrite, env);
        vscode.window.showTextDocument(vscode.Uri.file(resultFile));
        vscode.window.setStatusBarMessage('GPG Decrypted!', 2000);
    } catch (error) {
        console.error('unable to decrypt file', error);
        vscode.window.showErrorMessage(error.message || 'unable to decrypt file');
    }
}

/**
 * Check input and destination file existence
 *
 * @param {string} inputFilePath
 * @param {string} destFilePath
 * @returns {Promise<boolean | undefined>} Overwrite approval, or undefined if cancelled.
 */
async function checkFile(inputFilePath, destFilePath) {
    if (!inputFilePath || !fs.existsSync(inputFilePath)) {
        throw new Error('Invalid file path: ' + inputFilePath);
    }
    if (!fs.existsSync(destFilePath)) return false;

    const choice = await vscode.window.showInformationMessage('Overwrite ' + destFilePath + '?', 'Yes', 'No');
    return choice === 'Yes' ? true : undefined;
}

function getStoredPassphraseItems() {
    const configured = getCryptorSetting('gpg.passphrases');
    const passphrases = Array.isArray(configured) ? configured : [];
    return passphrases.filter(entry => entry && typeof entry.passphrase === 'string').map(entry => ({
        label: `<${entry.email}>`,
        description: entry.description ? `(${entry.description})` : '',
        passphrase: entry.passphrase,
    }));
}

const passphraseInputOptions = {
    prompt: 'Provide your passphrase',
    placeHolder: 'My passphrase',
    validateInput: value => value.length === 0 ? 'Passphrase cannot be empty' : undefined,
};

/** @returns {Promise<string | undefined>} */
async function getPassphrase() {
    const choice = await pickOrEnterCredential(
        getStoredPassphraseItems(),
        { placeHolder: 'Select stored passphrase' },
        passphraseInputOptions
    );
    if (choice) return 'item' in choice ? choice.item.passphrase : choice.value;
}

/** @param {NodeJS.ProcessEnv} [env] */
async function getEncryptionChoice(env) {
    const recipients = await getRecipientItems(env);
    const passphrases = getStoredPassphraseItems().map(item => Object.assign(item, { detail: 'Encrypt with a passphrase' }));
    const choice = await pickOrEnterCredential(
        [...recipients, ...passphrases],
        { placeHolder: 'Select a recipient or passphrase' },
        passphraseInputOptions,
        'Enter passphrase manually…'
    );
    if (choice) return 'item' in choice ? choice.item : { passphrase: choice.value };
}

/** @param {NodeJS.ProcessEnv} [env] */
async function getRecipientItems(env) {
    const publicKeys = await gpg.listKeys(env);
    return publicKeys.map(key => ({
        label: `<${key.email}>`,
        description: `(${key.key_id})`,
        detail: key.name,
        key_id: key.key_id,
        email: key.email,
    }));
}

/**
 * Get recipient selected from public keys in the system
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{label: string; description: string; detail: string; key_id: string; email: string;}>}
 */
async function getRecipient(env) {
    return vscode.window.showQuickPick(await getRecipientItems(env), { placeHolder: 'Select recipient' });
}

/**
 * Sign text selection command
 *
 * @param {vscode.TextEditor} textEditor
 */
async function clearSignSelection(textEditor) {

    let selection = textEditor.selection;
    let text = textEditor.document.getText(selection);

    if (!text || text.length === 0) {
        console.warn("zero length selection");
        vscode.window.setStatusBarMessage('No text selected', 2000);
        vscode.window.showWarningMessage("No text selected");
        return;
    }

    try {
        const env = await getGpgEnvironment(textEditor.document.uri);
        const selected = await getRecipient(env);
        if (!selected) return;

        const signed = await gpg.clearSign(text, selected.email, env);
        textEditor.edit(edit => edit.replace(selection, signed));
        vscode.window.setStatusBarMessage('GPG ClearSigned!', 2000);
    } catch (error) {
        vscode.window.showErrorMessage(error.message || 'Unable to sign text.');
    }
}

/**
 * Validate signature on text selection command
 *
 * @param {vscode.TextEditor} textEditor
 */
async function validateSelectionClearSign(textEditor) {
    let selection = textEditor.selection;
    let text = textEditor.document.getText(selection);

    if (!text || text.length === 0) {
        console.warn("zero length selection");
        vscode.window.setStatusBarMessage('No text selected', 2000);
        vscode.window.showWarningMessage("No text selected");
        return;
    }

    try {
        const env = await getGpgEnvironment(textEditor.document.uri);
        if (await gpg.verifySignature(text, env)) {
            vscode.window.setStatusBarMessage('GPG Valid Signature!', 2000);
        } else {
            vscode.window.setStatusBarMessage('GPG INVALID Signature!', 5000);
            vscode.window.showWarningMessage("INVALID Signature");
        }
    } catch (error) {
        vscode.window.showErrorMessage(error.message || 'Unable to verify signature.');
    }
}
