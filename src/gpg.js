const gpg = require('gpg');
const { spawn } = require('child_process');
const { constants, promises: fs } = require('fs');
const path = require('path');
const { getCommandArguments } = require('./gpgArguments.js');

/**
 * Returns a list of public keys available for encryption
 *
 * @returns {Promise<Array<PublicKey>>}
 */
async function listKeys() {
    const args = getCommandArguments('listkeyscmd');

    return new Promise(function (resolve, reject) {
        gpg.call('', args, function (err, result) {
            if (err) {
                reject(err);
            } else {
                try {
                    resolve(parseKeys(result.toString()));
                } catch (error) {
                    reject(new Error('GPG returned an invalid key listing. Check cryptor.gpg.listkeyscmd.'));
                }
            }
        });
    });
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
 * @returns {Promise<String>} returns a promise for a encrypted string
 */
async function encrypt(text, recipientID) {
    const args = getCommandArguments('encryptcmd', { recipientID });

    return new Promise(function (resolve, reject) {

        gpg.encrypt(text, args, function (err, result) {
            if (err) {
                reject(err);
            } else {
                resolve(result.toString());
            }
        });

    });
}

/**
 * Decrypt a text given the passphrase
 *
 * @param {string} text
 * @returns {Promise<String>} returns a promise for a decrypted string
 */
async function decrypt(text) {
    const args = getCommandArguments('decryptcmd');
    return new Promise(function (resolve, reject) {
        gpg.call(text, args, function (err, result) {
            if (err) {
                reject(err);
            } else {
                resolve(result.toString());
            }
        });
    });
}

/**
 * Encrypt source file in dest file path
 *
 * @param {string} source
 * @param {string} dest
 * @param {string} recipientID
 * @param {boolean=} armored
 * @returns {Promise<String>} returns a promise with encrypted file path
 */
async function encryptFile(source, dest, recipientID, armored = true) {
    const options = getCommandArguments('encryptfilecmd', {
        recipientID,
        encryptcmd: () => getCommandArguments('encryptcmd', { recipientID }),
    });
    const args = armored ? options : options.filter(arg => arg !== '--armor' && arg !== '-a');

    return writeGpgOutput(dest, true, async temporaryOutput => {
        let input;
        let output;
        try {
            input = await fs.open(source, 'r');
            output = await fs.open(temporaryOutput, 'wx', 0o600);
            await runFileEncryption(args, input.fd, output.fd);
        } finally {
            await Promise.all([input && input.close(), output && output.close()]);
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

function runFileEncryption(args, input, output) {
    // The gpg dependency's streaming wrapper does not report a nonzero exit status.
    return new Promise((resolve, reject) => {
        const child = spawn('gpg', args, {
            stdio: [input, output, 'pipe'],
            windowsHide: true,
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', code => {
            if (code === 0) {
                resolve(undefined);
            } else {
                reject(new Error(stderr.trim() || `GPG encryption failed (exit code ${code}).`));
            }
        });
    });
}

/**
 * Decrypt source file in dest file path
 *
 * @param {string} source
 * @param {string} dest
 * @param {string} passphrase
 * @param {boolean} [overwrite]
 * @returns {Promise<String>} returns a promise with decrypted file path
 */
function decryptFile(source, dest, passphrase, overwrite = false) {
    return writeGpgOutput(dest, overwrite, temporaryOutput => {
        const args = getCommandArguments('decryptfilecmd', {
            source,
            destination: temporaryOutput,
            decryptcmd: () => getCommandArguments('decryptcmd'),
        });

        return new Promise((resolve, reject) => {
            gpg.call(passphrase, args, error => {
                if (error) reject(error);
                else resolve(undefined);
            });
        });
    });
}

/**
 * validate clear-signed text
 *
 * @param {string} text
 * @returns {Promise<boolean>} returns if is a valid signature
 */
function verifySignature(text) {

    let args = [
        '--trust-model', 'always' // so we don't get "no assurance this key belongs to the given user"
    ];

    return new Promise(function (resolve, reject) {

        gpg.verifySignature(text, args, function (err, result) {
            if (err) {
                resolve(false);
            } else {
                resolve(result.toString().search(/good signature/i) > 0);
            }
        });

    });
}

/**
 * clear-sign a text for the given recipient (email address)
 *
 * @param {string} text
 * @param {string} recipientID
 * @returns {Promise<String>} returns a promise for a encrypted string
 */
async function clearSign(text, recipientID) {
    const args = getCommandArguments('signcmd', { recipientID });

    return new Promise(function (resolve, reject) {

        gpg.clearsign(text, args, function (err, result) {
            if (err) {
                reject(err);
            } else {
                resolve(result.toString());
            }
        });

    });
}

// export the module
module.exports = {
    listKeys: listKeys,
    encrypt: encrypt,
    decrypt: decrypt,
    encryptFile: encryptFile,
    decryptFile: decryptFile,
    clearSign: clearSign,
    verifySignature: verifySignature,
};
