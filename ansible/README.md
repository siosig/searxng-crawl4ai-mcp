# Deployment

Deploys the stack to a single always-on Linux host.

## What it does, and deliberately does not do

- **Pulls images; never builds.** The target is a low-power machine, so the
  image is built in CI and published to a registry.
- **Blocks the scraping containers from the local network** with a packet
  filter. The check inside the server gives callers a clear error, but only the
  filter actually holds when a name resolves differently a moment later.
- **Reads the Gemini key from the repository-root `.env`**, so the same secret
  is not maintained in two places. That file is gitignored.

## Setup

```sh
cp inventory/hosts.example.yml inventory/hosts.yml
# edit hosts.yml, then create host_vars/<host>/{vars,vault}.yml
ansible-galaxy collection install -r requirements.yml
ansible-vault encrypt host_vars/<host>/vault.yml
```

See `inventory/host_vars.example.md` for the variables.

## Deploy

```sh
ansible-playbook site.yml --check --diff   # dry run first
ansible-playbook site.yml
```

Running it twice should report no changes.

## Update to a new upstream release

Edit the tag in `versions.env`, let the contract tests pass, then run the
playbook again. To roll back, restore the previous `versions.env` and re-run:
image tags are pinned, so the earlier state is reproducible.

## Remove a previous deployment

```sh
ansible-playbook site.yml --tags legacy_cleanup
```

Not part of a normal run: removing a working deployment should be asked for by
name.
