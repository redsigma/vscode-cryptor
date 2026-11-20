const vscode = require('vscode');

const recipientID = 'Email address of the selected GPG key.';
const encryptcmd = 'Inserts the arguments from `cryptor.gpg.encryptcmd`. Use it as a separate argument.';
const decryptcmd = 'Inserts the arguments from `cryptor.gpg.decryptcmd`. Use it as a separate argument.';
const gpgArgumentHovers = {
    'cryptor.gpg.encryptcmd': { recipientID },
    'cryptor.gpg.signcmd': { recipientID },
    'cryptor.gpg.encryptselectioncmd': { recipientID, encryptcmd },
    'cryptor.gpg.encryptfilecmd': { recipientID, encryptcmd },
    'cryptor.gpg.decryptselectioncmd': { decryptcmd },
    'cryptor.gpg.signselectioncmd': {
        recipientID,
        signcmd: 'Inserts the arguments from `cryptor.gpg.signcmd`. Use it as a separate argument.',
    },
    'cryptor.gpg.decryptfilecmd': {
        source: 'Path to the selected encrypted file.',
        destination: 'Output path for the decrypted file.',
        decryptcmd,
    },
};

function splitArguments(template, setting) {
    const tokens = [];
    let token = '';
    let quote = '';
    let started = false;

    for (const character of template) {
        if (quote) {
            if (character === quote) {
                quote = '';
            } else {
                token += character;
            }
        } else if (character === '"' || character === "'") {
            quote = character;
            started = true;
        } else if (/\s/.test(character)) {
            if (started) tokens.push(token);
            token = '';
            started = false;
        } else {
            token += character;
            started = true;
        }
    }

    if (quote) throw new Error(`${setting} has an unclosed quote.`);
    if (started) tokens.push(token);
    return tokens;
}

/**
 * Expand template variables after splitting so a key or path stays a single argument.
 * @param {string} key
 * @param {Record<string, string | (() => string[])>} variables
 * @returns {string[]}
 */
function getCommandArguments(key, variables = {}) {
    const setting = `cryptor.gpg.${key}`;
    const template = vscode.workspace.getConfiguration('cryptor.gpg').get(key);
    if (typeof template !== 'string') throw new Error(`${setting} must be an argument string.`);

    const replacements = new Map(Object.entries(variables));
    const args = [];
    for (const token of splitArguments(template, setting)) {
        const placeholder = /^\$\{([^{}]*)\}$/.exec(token);
        const value = placeholder && replacements.get(placeholder[1]);
        if (typeof value === 'function') {
            args.push(...value());
        } else {
            args.push(token.replace(/\$\{([^{}]*)\}/g, (match, name) => {
                const replacement = replacements.get(name);
                if (typeof replacement === 'function') {
                    throw new Error(`${setting} requires ${match} to be a separate argument.`);
                }
                if (typeof replacement !== 'string') {
                    throw new Error(`${setting} does not support the placeholder ${match}.`);
                }
                return replacement;
            }));
        }
    }
    return args;
}

module.exports = { getCommandArguments, gpgArgumentHovers };
