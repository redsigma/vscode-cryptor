# Cryptor

Use GnuPG and SOPS to encrypt and decrypt files in VS Code. GnuPG also supports text selections and signing.

## Features

- Listing public key available in the system for encryption.
- Text encryption producing ASCII-armored output (ready for sharing).
- Ciphertext decryption.
- Storing passphrases in local settings.
- Encrypting and decrypting files or selected text.

## Usage

**Note:** The extension allows encryption/decryption on the text editor as follows:

- To encrypt text, select it and open the Command Palette (`Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows and Linux). Choose `GPG: Encrypt Selection` and follow the prompts.
- To decrypt text, select it and choose `GPG: Decrypt Selection` from the Command Palette.

### Using stored passphrase in settings
- Edit your local `settings.json` and add the following:
  ```json
  {
      "cryptor.gpg.passphrases": [
          {
              "email": "test@test.com",
              "description": "My PGP Test Key",
              "passphrase": "MyPassphrase"
          }
      ]
  }
  ```
- The stored passphrase will be listed to chose to use for decryption.

> If no stored passphrase is chosen then the regular prompt will appear.

### GPG argument templates

Override these defaults in VS Code user settings. Leaving the settings unset uses the values shown here.

```json
{
    "cryptor.gpg.encryptcmd": "--trust-model always --recipient ${recipientID} --armor --trust-model always",
    "cryptor.gpg.encryptselectioncmd": "--batch ${encryptcmd} --encrypt",
    "cryptor.gpg.encryptfilecmd": "--batch --encrypt ${encryptcmd}",
    "cryptor.gpg.decryptcmd": "--decrypt",
    "cryptor.gpg.decryptselectioncmd": "--batch ${decryptcmd}",
    "cryptor.gpg.decryptfilecmd": "--batch --passphrase-fd 0 --pinentry-mode loopback --no-tty --quiet --output ${destination} ${decryptcmd} ${source}",
    "cryptor.gpg.signcmd": "--default-key ${recipientID} --trust-model always",
    "cryptor.gpg.signselectioncmd": "--batch ${signcmd} --clearsign",
    "cryptor.gpg.verifycmd": "--batch --trust-model always --status-fd 1 --verify",
    "cryptor.gpg.listkeyscmd": "--batch --list-keys --fixed-list-mode --fingerprint --with-colons"
}
```

- Hover over a placeholder in `settings.json` to see what it expands to. Use `${encryptcmd}`, `${decryptcmd}`, and `${signcmd}` as separate arguments in the templates that include them.
- If you previously customized `listkeyscmd` or `decryptfilecmd`, include `--batch` in that setting to retain batch mode.
- `encryptfilecmd` reads the source file from standard input and writes encrypted data to standard output. In `decryptfilecmd`, keep `${source}` and `--output ${destination}` so Cryptor can write the decrypted file to its destination after GPG succeeds.
- Keep `--list-keys` and `--with-colons` in `listkeyscmd` for the key picker.
- Keep `--verify` and `--status-fd 1` in `verifycmd` so Cryptor can read GPG's signature status.
- Use single or double quotes around literal arguments containing spaces. Substituted keys and paths already stay together as single arguments. Cryptor passes the arguments directly to GPG and sends file decryption passphrases through standard input.

Use `cryptor.gpg.env` to set environment variables for GPG commands. For example, set `GNUPGHOME` to use a separate keyring for the recipient picker, encryption, decryption, signing, and verification.

```json
{
    "cryptor.gpg.env": {
        "GNUPGHOME": "${userHome}/.gnupg-work"
    }
}
```

### SOPS files

Right-click a file in Explorer and choose **SOPS: Encrypt file** or **SOPS: Decrypt file**. For example, encrypting `settings.yaml` writes `settings.sops.yaml`, and decrypting `settings.sops.yaml` writes the plaintext to `settings.dec.yaml`. Cryptor leaves the input in place and refuses to overwrite an existing output.

Cryptor runs SOPS from the selected file's directory, so SOPS can find `.sops.yaml` there or in a parent directory. SOPS matches creation rules against the selected input path. Key providers and credentials use the usual SOPS configuration and environment.

Set `cryptor.sops.env` in VS Code user settings on the extension host to override environment variables for SOPS encryption and decryption. For example:

```json
{
    "cryptor.sops.env": {
        "SOPS_AGE_KEY_FILE": "${workspaceFolder}/.keys/age.txt",
        "SOPS_AGE_SSH_PRIVATE_KEY_FILE": "${userHome}/.ssh/id_ed25519"
    }
}
```

Both `cryptor.gpg.env` and `cryptor.sops.env` use standard VS Code `${…}` syntax. Workspace and file variables use the file selected in Explorer or the document targeted by an editor command. `${workspaceFolder:Name}` selects a named root in a multi-root workspace. `${cwd}` resolves to the workspace folder when available. Editor variables such as `${lineNumber}` and `${selectedText}` use the active editor. Cryptor also resolves `${userHome}`, `${env:NAME}`, `${config:setting}`, `${execPath}`, `${extensionInstallFolder:publisher.extension}`, and `${defaultBuildTask}`. `${env:NAME}` reads the extension host's inherited environment.

`${command:…}` and `${input:…}` use task and debug configuration and are resolved there by VS Code.

The VSIX build checks Cryptor's predefined variables against the published VS Code reference and reports additions or removals as warnings.

If SOPS cannot find a matching age identity, Cryptor shows your configured lookup groups. Select a group or press **Esc** to paste a private `AGE-SECRET-KEY-1…` identity into the masked prompt. With no groups configured, the masked prompt opens directly. Each group has a unique name.

```json
{
    "cryptor.sops.ageKeyLookups": [
        {
            "group": "Work",
            "directories": [
                "./",
                "${workspaceFolder}/.vscode",
                "regex:^keys(?:-.+)?$"
            ],
            "filenames": [".age-key", "regex:^age\\.txt$"],
            "overrides": {
                "gpgExtensions": [".gpg", "regex:\\.(?:pgp|myowngpgcustom)$"]
            }
        }
    ]
}
```

Start a string with `regex:` to use the remainder as a regular expression. Cryptor searches only the group you select. Literal directory paths support the same variables as the environment settings. Relative paths start beside the selected SOPS file.

Cryptor searches the literal directory paths and uses directory regexes to match their immediate child directory names. With only regex entries, it matches immediate child directories beside the selected SOPS file. Cryptor scans the resulting directories for files, uses a single match directly, and shows a picker for multiple matches.

Plain strings in `filenames` match substrings, and plain strings in `overrides.gpgExtensions` match suffixes. Directory and filename matching is case-sensitive. GPG extension matching is case-insensitive for both literals and regexes. A regex matches the filename, so use `$` to anchor a suffix at the end.

If the chosen filename matches an entry in `overrides.gpgExtensions`, Cryptor opens the usual GPG passphrase prompt and reads the decrypted identities in memory. It uses a single distinct key automatically. If there are several keys, the picker shows only a short suffix for each. The selected key is passed to SOPS for that attempt. Omit `gpgExtensions` or set it to `[]` to pass the chosen file directly to SOPS.

Cryptor looks for SOPS on the extension host's `PATH`. To use a specific executable, set `cryptor.sops.path` to its absolute path in VS Code's user settings.

## Requirements

- VS Code 1.74 or later.
- [GnuPG](https://www.gnupg.org) 2.0 or later for GPG commands.
- [SOPS](https://getsops.io/docs/installation/) 3.9 or later on the extension host for SOPS commands.

### For more information

- [OpenPGP](https://en.wikipedia.org/wiki/Pretty_Good_Privacy#OpenPGP)
- [The GNU Privacy Guard Project](https://www.gnupg.org)
- [GPGTools GPG Suite for OS X](https://gpgtools.org/)

-----------------------------------------------------------------------------------------------------------

**Enjoy!**
