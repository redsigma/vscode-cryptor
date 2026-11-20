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
    "cryptor.gpg.encryptfilecmd": "--batch --encrypt ${encryptcmd}",
    "cryptor.gpg.decryptcmd": "--decrypt",
    "cryptor.gpg.decryptfilecmd": "--batch --passphrase-fd 0 --pinentry-mode loopback --no-tty --quiet --output ${destination} ${decryptcmd} ${source}",
    "cryptor.gpg.signcmd": "--default-key ${recipientID} --trust-model always",
    "cryptor.gpg.listkeyscmd": "--list-keys --fixed-list-mode --fingerprint --with-colons"
}
```

- Hover over a placeholder in `settings.json` to see what it expands to. Keep `${encryptcmd}` and `${decryptcmd}` as separate arguments when using them in file templates.
- `encryptfilecmd` reads the source file from standard input and writes encrypted data to standard output. In `decryptfilecmd`, keep `${source}` and `--output ${destination}` so Cryptor can write the decrypted file to its destination after GPG succeeds.
- Keep `--list-keys` and `--with-colons` in `listkeyscmd` for the key picker.
- Use single or double quotes around literal arguments containing spaces. Substituted keys and paths already stay together as single arguments. Cryptor passes the arguments directly to GPG and sends file decryption passphrases through standard input.

### SOPS files

Right-click a file in Explorer and choose **SOPS: Encrypt file** or **SOPS: Decrypt file**. For example, encrypting `settings.yaml` writes `settings.sops.yaml`, and decrypting `settings.sops.yaml` writes the plaintext to `settings.dec.yaml`. Cryptor leaves the input in place and refuses to overwrite an existing output.

Cryptor runs SOPS from the selected file's directory, so SOPS can find `.sops.yaml` there or in a parent directory. SOPS matches creation rules against the selected input path. Key providers and credentials use the usual SOPS configuration and environment.

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
