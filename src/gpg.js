const { spawn } = require('child_process');
const { constants, promises: fs } = require('fs');
const path = require('path');
const { getCommandArguments } = require('./gpgArguments.js');

const symmetricCacheOption = '--no-symkey-cache';

/**
 * Returns a list of public keys available for encryption
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Array<PublicKey>>}
 */
async function listKeys(env) {
    const args = getCommandArguments('listkeyscmd');
    const output = await runGpg(args, '', env);
    try {
        return parseKeys(output);
    } catch (error) {
        throw new Error('GPG returned an invalid key listing. Check cryptor.gpg.listkeyscmd.');
    }
}

/**
  @typedef {object} PublicKey
  @property {string} key_id Key short id
  @property {string} fingerprint Key fingerprint
  @property {string} email Key ownner email
  @property {string} name Key ownner name
  @property {number} creation_date Creation date timestamp
  @property {number} expiration_date Expiration date timestamp
  @property {boolean} encrypt Encryption capability
  @property {boolean} sign Signing capability
 */

/**
 * Parses the output of `gpg --list-keys --fixed-list-mode --fingerprint --with-colons`
 * 
 * http://git.gnupg.org/cgi-bin/gitweb.cgi?p=gnupg.git;a=blob_plain;f=doc/DETAILS
 *
 * @param {string} stdout
 * @returns {Array<PublicKey>} array of public keys
 */
function parseKeys(stdout) {

    let nameEmailRegex = /(.+)\s+<(.+)>/;

    let lines = stdout.trim().split(/\s*[\r\n]+\s*/g);

    let result = {};
    let currentKey = '';

    for (var i = 0; i < lines.length; i++) {

        let currentLine = lines[i].trim();

        if (currentLine.length <= 0) {
            continue;
        }

        let parts = currentLine.split(':');

        switch (parts[0]) {
            case 'pub':
                currentKey = parts[4];
                let encrypt_cap = (parts[11].match(/e/i) !== null)
                let sign_cap = (parts[11].match(/e/i) !== null)
                result[currentKey] = {
                    key_id: currentKey,
                    cretion_date: parts[5],
                    expiration_date: parts[6],
                    encrypt: encrypt_cap,
                    sign: sign_cap,
                };
                break;
            case 'fpr':
                // parts[9] fingerprint
                if (currentKey && parts[9].includes(currentKey)) {
                    result[currentKey].fingerprint = parts[9];
                }
                break;
            case 'uid':
                // parts[5] uid
                // parts[9] name [(description)] <email>
                let matches = nameEmailRegex.exec(parts[9]);
                if (matches && matches.length >= 3) {
                    result[currentKey].name = matches[1];
                    result[currentKey].email = matches[2];
                }
                break;
            case 'sub':
                // Subkeys could be process here
                break;
            default:
                continue;
        }
    }

    // Flatten object to array of objects
    // More verbose than Object.keys(result).map(k => result[k]); yet more efficient
    let output = [];
    for (let k in result) {
        if (result.hasOwnProperty(k)) {
            output.push(result[k]);
        }
    }

    return output;
}

/**
 * Encrypt a text for the given recipient (email address)
 *
 * @param {string} text
 * @param {string} recipientID
 * @param {NodeJS.ProcessEnv} [env]
 */
async function encrypt(text, recipientID, env) {
    const args = getCommandArguments('encryptselectioncmd', {
        recipientID,
        encryptcmd: () => getCommandArguments('encryptcmd', { recipientID }),
    });
    return runGpg(args, text, env);
}

/**
 * Decrypt a text given the passphrase
 *
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 */
async function decrypt(text, env) {
    const args = getCommandArguments('decryptselectioncmd', {
        decryptcmd: () => getCommandArguments('decryptcmd'),
    });
    return runGpg(args, text, env);
}

/**
 * Encrypt source file in dest file path
 *
 * @param {string} source
 * @param {string} dest
 * @param {string} recipientID
 * @param {NodeJS.ProcessEnv} [env]
 * @param {boolean} [overwrite]
 * @param {'armored' | 'binary'} [format]
 * @returns {Promise<String>} returns a promise with encrypted file path
 */
async function encryptFile(source, dest, recipientID, env, overwrite = true, format = 'armored') {
    const command = format === 'binary' ? 'encryptbinaryfilecmd' : 'encryptfilecmd';
    const args = getCommandArguments(command, {
        recipientID,
        encryptcmd: () => getCommandArguments('encryptcmd', { recipientID }),
    });

    return writeEncryptedFile(dest, overwrite, async output => {
        const input = await fs.open(source, 'r');
        try {
            await runGpg(args, input.fd, env, output);
        } finally {
            await input.close();
        }
    });
}

/**
 * @param {string} text
 * @param {string} passphrase
 * @param {NodeJS.ProcessEnv} [env]
 */
async function encryptWithPassphrase(text, passphrase, env) {
    return runSymmetricEncryption('-', passphrase, text, env);
}

/**
 * @param {string} source
 * @param {string} dest
 * @param {string} passphrase
 * @param {NodeJS.ProcessEnv} [env]
 * @param {boolean} [overwrite]
 * @param {'armored' | 'binary'} [format]
 */
async function encryptFileWithPassphrase(source, dest, passphrase, env, overwrite = true, format = 'armored') {
    return writeEncryptedFile(dest, overwrite, output => runSymmetricEncryption(source, passphrase, '', env, output, format));
}

/**
 * @param {string} source A file path or '-' to read the plaintext from stdin.
 * @param {string} passphrase
 * @param {string} plaintext
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number} [output]
 * @param {'armored' | 'binary'} [format]
 */
function runSymmetricEncryption(source, passphrase, plaintext, env, output, format = 'armored') {
    if (!passphrase || /[\r\n\0]/.test(passphrase)) {
        throw new Error('Provide a non-empty, single-line passphrase for GPG encryption.');
    }
    const command = format === 'binary' ? 'symmetricencryptbinaryfilecmd' : 'symmetricencryptcmd';
    const args = getCommandArguments(command, { source });
    // GPG reads one passphrase line from stdin before reading any plaintext from it.
    return runGpg(args, `${passphrase}\n${plaintext}`, env, output);
}

/**
 * @param {string} dest
 * @param {boolean} overwrite
 * @param {(output: number) => Promise<unknown>} encrypt
 */
function writeEncryptedFile(dest, overwrite, encrypt) {
    return writeGpgOutput(dest, overwrite, async temporaryOutput => {
        const output = await fs.open(temporaryOutput, 'wx', 0o600);
        try {
            await encrypt(output.fd);
        } finally {
            await output.close();
        }

        if ((await fs.stat(temporaryOutput)).size === 0) {
            throw new Error('GPG produced no encrypted output. Check the file encryption arguments.');
        }
    });
}

/**
 * @param {string} dest
 * @param {boolean} overwrite
 * @param {(temporaryOutput: string) => Promise<void>} produceOutput
 */
async function writeGpgOutput(dest, overwrite, produceOutput) {
    const temporaryDirectory = await fs.mkdtemp(path.join(path.dirname(dest), '.cryptor-gpg-'));
    const temporaryOutput = path.join(temporaryDirectory, 'output');

    try {
        await produceOutput(temporaryOutput);
        if (overwrite) {
            await fs.rename(temporaryOutput, dest);
        } else {
            await fs.copyFile(temporaryOutput, dest, constants.COPYFILE_EXCL);
        }
        return dest;
    } finally {
        await fs.unlink(temporaryOutput).catch(error => {
            if (error.code !== 'ENOENT') throw error;
        });
        await fs.rmdir(temporaryDirectory);
    }
}

/**
 * @param {string[]} args
 * @param {string | Buffer | number} input Text or a file descriptor for stdin.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number | 'pipe'} [output] File descriptor or captured stdout.
 * @returns {Promise<string>}
 */
async function runGpg(args, input, env, output) {
    if (args.includes(symmetricCacheOption)) {
        // GnuPG added this option in 2.2.7. Check the executable used by this operation.
        const options = await spawnGpg(['--no-options', '--dump-options'], '', env);
        if (!options.split(/\r?\n/).includes(symmetricCacheOption)) {
            args = args.filter(arg => arg !== symmetricCacheOption);
        }
    }
    return spawnGpg(args, input, env, output);
}

/**
 * @param {string[]} args
 * @param {string | Buffer | number} input
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number | 'pipe'} [output]
 * @returns {Promise<string>}
 */
function spawnGpg(args, input, env, output = 'pipe') {
    return new Promise((resolve, reject) => {
        const child = spawn('gpg', args, {
            stdio: [typeof input === 'number' ? input : 'pipe', output, 'pipe'],
            windowsHide: true,
            env,
        });
        let stdout = '';
        let stderr = '';
        let inputError;
        if (child.stdout) {
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', chunk => { stdout += chunk; });
        }
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code, signal) => {
            if (code !== 0) {
                const status = signal ? `signal ${signal}` : `exit code ${code}`;
                reject(new Error(stderr.trim() || `GPG failed (${status}).`));
            } else if (inputError && inputError.code !== 'EPIPE') {
                reject(inputError);
            } else {
                resolve(stdout);
            }
        });
        if (child.stdin && typeof input !== 'number') {
            child.stdin.on('error', error => { inputError = error; });
            child.stdin.end(input);
        }
    });
}

/**
 * Decrypt source file in dest file path
 *
 * @param {string} source
 * @param {string} dest
 * @param {string} passphrase
 * @param {boolean} [overwrite]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<String>} returns a promise with decrypted file path
 */
function decryptFile(source, dest, passphrase, overwrite = false, env) {
    return writeGpgOutput(dest, overwrite, temporaryOutput => runFileDecryption(source, temporaryOutput, passphrase, env));
}

/**
 * @param {string} source
 * @param {string} destination GPG uses '-' for standard output.
 * @param {string} passphrase
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>}
 */
function runFileDecryption(source, destination, passphrase, env) {
    const args = getCommandArguments('decryptfilecmd', {
        source,
        destination,
        decryptcmd: () => getCommandArguments('decryptcmd'),
    });
    return runGpg(args, passphrase, env);
}

/**
 * @param {string} source
 * @param {string} passphrase
 * @param {NodeJS.ProcessEnv} [env]
 */
function decryptFileToText(source, passphrase, env) {
    return runFileDecryption(source, '-', passphrase, env);
}

/**
 * validate clear-signed text
 *
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 */
async function verifySignature(text, env) {
    const args = getCommandArguments('verifycmd');
    try {
        const status = await runGpg(args, text, env);
        return /^\[GNUPG:\] GOODSIG\b/m.test(status);
    } catch (error) {
        return false;
    }
}

/**
 * clear-sign a text for the given recipient (email address)
 *
 * @param {string} text
 * @param {string} recipientID
 * @param {NodeJS.ProcessEnv} [env]
 */
async function clearSign(text, recipientID, env) {
    const args = getCommandArguments('signselectioncmd', {
        recipientID,
        signcmd: () => getCommandArguments('signcmd', { recipientID }),
    });
    return runGpg(args, text, env);
}

// export the module
module.exports = {
    listKeys: listKeys,
    encrypt: encrypt,
    encryptWithPassphrase: encryptWithPassphrase,
    decrypt: decrypt,
    encryptFile: encryptFile,
    encryptFileWithPassphrase: encryptFileWithPassphrase,
    decryptFile: decryptFile,
    decryptFileToText: decryptFileToText,
    clearSign: clearSign,
    verifySignature: verifySignature,
};
