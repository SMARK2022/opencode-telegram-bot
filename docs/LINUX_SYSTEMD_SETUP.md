# Linux systemd setup

## 1. Install and configure the bot

```bash
curl -LO https://github.com/SMARK2022/opencode-telegram-bot/releases/download/v0.22.4/smark2022-opencode-telegram-bot-0.22.4.tgz
curl -LO https://github.com/SMARK2022/opencode-telegram-bot/releases/download/v0.22.4/smark2022-opencode-telegram-bot-0.22.4.tgz.sha256
sha256sum --check smark2022-opencode-telegram-bot-0.22.4.tgz.sha256
npm install -g ./smark2022-opencode-telegram-bot-0.22.4.tgz
opencode-telegram config
```

## 2. Get the required paths

```bash
which node
which opencode-telegram
dirname "$(which node)"
```

Use these values in the service file:

- `<USER>`: your Linux user
- `<NODE_PATH>`: output of `which node`
- `<OPENCODE_TELEGRAM_PATH>`: output of `which opencode-telegram`
- `<NODE_BIN_DIR>`: output of `dirname "$(which node)"`

## 3. Create the service file

Create `/etc/systemd/system/opencode-telegram-bot.service`:

```ini
[Unit]
Description=OpenCode Telegram Bot
After=network.target

[Service]
Type=simple
User=<USER>
Environment=PATH=<NODE_BIN_DIR>:/usr/local/bin:/usr/bin:/bin
ExecStart=<NODE_PATH> <OPENCODE_TELEGRAM_PATH> start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Run the bot in foreground mode. Do not use `--daemon` under `systemd`.

## 4. Enable and start the service

```bash
sudo systemctl daemon-reload
sudo systemctl enable opencode-telegram-bot
sudo systemctl start opencode-telegram-bot
sudo systemctl status opencode-telegram-bot
```

## 5. Optional: recover a lost shared daemon

Leave `OPENCODE_API_URL` unset so the service uses OpenCode's shared-daemon
discovery. For unattended scheduled tasks, allow the bot to recreate an absent
owner after an unexpected disconnect:

```env
OPENCODE_AUTO_RESTART_ENABLED=true
OPENCODE_MONITOR_INTERVAL_SEC=300
```

Run the service as the same OS user and with the same `HOME`, XDG variables, and
`opencode` executable as the TUI. The bot invokes OpenCode's existing daemon
ensure path; it does not start a parallel fixed-port `opencode serve` process.

## 6. View logs

```bash
sudo journalctl -u opencode-telegram-bot -f
```

## Example

This is a working example for an `nvm`-based setup:

`ExecStart` does not include `start` here because `start` is the default CLI command.

```ini
[Unit]
Description=OpenCode Telegram Bot
After=network.target

[Service]
Type=simple
User=admin
Environment=PATH=/home/admin/.nvm/versions/node/v20.20.2/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/admin/.nvm/versions/node/v20.20.2/bin/node /home/admin/.nvm/versions/node/v20.20.2/bin/opencode-telegram
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```
