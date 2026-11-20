const { execFile } = require('child_process');
const { constants, promises: fs } = require('fs');
const os = require('os');
const path = require('path');
const { mergeToolEnvironment } = require('./toolEnvironment.js');

class AgeIdentityError extends Error {}

/** @typedef {{ key: string } | { file: string }} AgeIdentity */

async function findExecutable(configuredPath, env) {
    if (configuredPath) {
        if (!path.isAbsolute(configuredPath)) {
            throw new Error('Set cryptor.sops.path to the absolute path of the SOPS executable.');
        }
        return configuredPath;
    }

    // Search PATH directly so the source file's directory cannot shadow SOPS on Windows.
    const executableName = process.platform === 'win32' ? 'sops.exe' : 'sops';
    for (const entry of (env.PATH || '').split(path.delimiter)) {
        const directory = entry.replace(/^"(.*)"$/, '$1');
        if (path.isAbsolute(directory)) {
            const candidate = path.join(directory, executableName);
            const stat = await fs.stat(candidate).catch(() => undefined);
            if (stat && stat.isFile() && await fs.access(candidate, constants.X_OK).then(() => true, () => false)) {
                return candidate;
            }
        }
    }

    throw new Error('SOPS was not found on PATH. Set cryptor.sops.path to its executable.');
}

function getOutputPath(operation, source) {
    const { dir, base, ext, name } = path.parse(source);
    // Keep the format suffix, including a bare .env file that path.extname treats as a dotfile.
    const format = base.toLowerCase() === '.env' ? base : ext;
    const stem = base.slice(0, base.length - format.length);
    if (operation === 'encrypt') {
        return path.join(dir, `${stem}.sops${format}`);
    }
    if (ext === '.sops') {
        return path.join(dir, `${name}.dec`);
    }
    return path.join(dir, `${stem.replace(/\.sops$/, '')}.dec${format}`);
}

/**
 * @param {Record<string, string>} [overrides]
 * @param {AgeIdentity} [identity]
 */
function getSopsProcessEnvironment(overrides = {}, identity) {
    if (!identity && !Object.keys(overrides).length) return undefined;

    const env = mergeToolEnvironment(overrides);
    if (!identity) return env;

    // Older SOPS versions may stop on an invalid configured identity before trying the chosen one.
    delete env.SOPS_AGE_KEY;
    delete env.SOPS_AGE_KEY_FILE;
    if ('key' in identity) env.SOPS_AGE_KEY = identity.key;
    else env.SOPS_AGE_KEY_FILE = identity.file;
    return env;
}

/**
 * @param {string} executable
 * @param {'encrypt' | 'decrypt'} operation
 * @param {string} source
 * @param {string} output
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(executable, operation, source, output, env) {
    const args = [`--${operation}`, '--output', output, '--', source];
    const options = { cwd: path.dirname(source), windowsHide: true, env };
    return new Promise((resolve, reject) => {
        execFile(executable, args, options, (error, stdout, stderr) => {
            if (error && error.code === 'ENOENT') {
                reject(new Error(`Could not run SOPS at ${executable}. Check cryptor.sops.path.`));
            } else if (error) {
                const message = stderr.trim() || error.message;
                const keys = ((env || process.env).SOPS_AGE_KEY || '').match(/AGE-[A-Z0-9-]+/gi) || [];
                const redacted = keys.reduce((text, key) => text.split(key).join('[redacted]'), message);
                const unwrapped = redacted.replace(/\r?\n[ \t]*[|│][ \t]*/g, ' ').replace(/\s+/g, ' ');
                const ErrorType = /failed to load age identities|no identity matched any of the recipients/i.test(unwrapped)
                    ? AgeIdentityError
                    : Error;
                reject(new ErrorType(redacted));
            } else {
                resolve(undefined);
            }
        });
    });
}

/**
 * @param {'encrypt' | 'decrypt'} operation
 * @param {string} source
 * @param {string} configuredPath
 * @param {{ env?: Record<string, string>, identity?: AgeIdentity }} [options]
 */
async function transformFile(operation, source, configuredPath, options = {}) {
    if (!(await fs.stat(source)).isFile()) {
        throw new Error('Select a file to run SOPS.');
    }

    const env = getSopsProcessEnvironment(options.env, options.identity);
    const executable = await findExecutable(configuredPath, env || process.env);
    const output = getOutputPath(operation, source);
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cryptor-sops-'));
    const temporaryOutput = path.join(temporaryDirectory, 'output');
    try {
        await fs.writeFile(temporaryOutput, '', { flag: 'wx', mode: 0o600 });
        await run(executable, operation, source, temporaryOutput, env);
        await fs.copyFile(temporaryOutput, output, constants.COPYFILE_EXCL);
    } catch (error) {
        if (error.code === 'EEXIST' && error.dest === output) {
            throw new Error(`The output file already exists (${output}).`);
        }
        throw error;
    } finally {
        await fs.unlink(temporaryOutput).catch(error => {
            if (error.code !== 'ENOENT') throw error;
        });
        await fs.rmdir(temporaryDirectory);
    }

    return output;
}

module.exports = { AgeIdentityError, transformFile };
